import test from 'node:test';
import assert from 'node:assert/strict';
import {ListeningSpotify,hasListeningScopes,listeningScopes} from '../../api/utils/listening/spotify.js';
import {validateSessionInput,createSessionsHandler} from '../../api/sessions.js';
import {createMockRes} from '../helpers/mock-http.js';
import {randomUUID} from 'node:crypto';

test('successful Spotify mutations accept non-JSON bodies while reads remain strict',async()=>{
 const api=new ListeningSpotify({fetchFn:async()=>new Response('accepted',{status:200})});
 assert.deepEqual(await api.request('fixture','PUT','/v1/me/player/play'),{});
 await assert.rejects(api.request('fixture','GET','/v1/me/player'),{code:'spotify_session_invalid_response'});
 assert(hasListeningScopes({scope:listeningScopes}));assert(!hasListeningScopes({scope:listeningScopes.slice(0,2)}));
});
test('Spotify rate limits carry provider retry timing without issuing repeated writes',async()=>{
 let calls=0;const api=new ListeningSpotify({now:()=>1000,fetchFn:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'7'}});}});
 await assert.rejects(api.request('fixture','PUT','/v1/me/player/play'),e=>e.code==='spotify_rate_limited'&&e.notBefore===8000);assert.equal(calls,1);
});
test('Swift uppercase UUIDs normalize at the wire boundary and invalid authority is rejected',()=>{
 const id=randomUUID(),entryID=randomUUID();
 const result=validateSessionInput({version:1,action:'reorder',sessionID:id.toUpperCase(),commandID:randomUUID().toUpperCase(),revision:1,order:[entryID.toUpperCase()]});
 assert.equal(result.sessionID,id);assert.equal(result.order[0],entryID);
 assert.throws(()=>validateSessionInput({version:1,action:'create',provider:'spotify',accessToken:'extra'}),{code:'invalid_request'});
});
test('Sessions uses its bounded polling budget and requires app session authority',async()=>{
 let used=0;const handler=createSessionsHandler({authStore:{authenticate:async()=>({id:'host'}),limit:async()=>{throw Error('general auth limiter must not be used');}},runtime:{store:{rateLimit:async(id,action)=>{assert.equal(id,'host');assert.equal(action,'list');used++;}},send:async()=>({version:1,summaries:[]})}});
 const response=createMockRes();await handler({method:'POST',body:{version:1,action:'list'},headers:{authorization:'Bearer lyra_s_fixture'}},response);assert.equal(response.statusCode,200);assert.equal(used,1);
 const denied=createMockRes();await handler({method:'POST',body:{version:1,action:'list'},headers:{authorization:'Bearer lyra_w_fixture'}},denied);assert.equal(denied.statusCode,401);
});
test('public recap uses escaped consent-filtered text and useful exact provider links',async()=>{
 const {newRoom,applyCommand}=await import('../../api/utils/listening/model.js');
 const host={id:'h',keyID:'k',credentialDigest:'secret'},room=newRoom(host,{sessionID:randomUUID(),provider:'appleMusic',title:'<script>alert(1)</script>',name:'Private name',shareName:false},1000);
 applyCommand(room,host,{action:'add',revision:0,entryID:randomUUID(),track:{provider:'appleMusic',id:'123',title:'<img src=x onerror=1>',artist:'A&B',album:'',durationMS:1000}},1000);
 room.status='ended';room.shared=true;room.history=[{...room.entries[0],entryID:room.entries[0].id,startedAtMS:1000,lastObservedAtMS:1001}];
 const handler=createSessionsHandler({runtime:{store:{byShare:async()=>room,ownerAccountActive:async()=>true}}}),res=createMockRes();res.send=value=>{res.body=value;return res;};
 await handler({method:'GET',query:{recap:'a'.repeat(32)}},res);
 assert.equal(res.statusCode,200);assert(res.body.includes('&lt;script&gt;'));assert(!res.body.includes('Private name'));assert(res.body.includes('Added by Friend'));assert(res.body.includes('https://music.apple.com/us/song/123'));assert(!res.body.includes('<img src=x'));assert(!res.body.includes('secret'));
});
