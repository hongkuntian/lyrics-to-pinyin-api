import test from 'node:test';
import assert from 'node:assert/strict';
import {createArtistDiscoveryResolver,validArtistDiscovery,artistDiscoveryNames,buildArtistDiscoveryEvidence,recoveredDiscoveryNames} from '../../api/utils/artist-discovery.js';
import {spotifySearchRequest} from '../../api/utils/song-library/spotify-recording.js';
import {recordingScore} from '../../api/utils/recording-match.js';
import {buildArtistIdentityEvidence} from '../../api/utils/artist-alias-recovery.js';
import {recording,discoveryFixture,mbID,source} from '../helpers/artist-discovery.js';
const target=spotifySearchRequest(recording),start=1800000000000;
const resolver=(f,options={})=>createArtistDiscoveryResolver({fetchFn:f.fetchFn,rateGate:async signal=>signal.throwIfAborted(),appleCatalog:null,now:()=>start,...options});
test('missing Wikidata Spotify linkage resolves through exact reciprocal MusicBrainz IDs and caches its names',async()=>{
 const f=discoveryFixture(),resolve=resolver(f),plan=await resolve(target);
 assert.ok(validArtistDiscovery(plan,target));assert.deepEqual(artistDiscoveryNames(plan,target),['陳芳語']);
 assert.equal(f.calls.length,3);assert.equal(f.calls[0].searchParams.get('resource'),'https://open.spotify.com/artist/'+target.creditedArtistIDs[0]);
 plan.identities[0].names.push('tampered');assert.equal(validArtistDiscovery(plan,target),false);
 assert.ok(validArtistDiscovery(await resolve(target),target));assert.equal(f.calls.length,3);
});
test('ambiguous, redirected, ended, mismatched and uncorroborated artist links cannot authorize aliases',async()=>{
 for(const mutate of [
  f=>f.reverse.resource='https://open.spotify.com/artist/0000000000000000000000',
  f=>f.reverse.relations.push({...f.reverse.relations[0],artist:{id:'11111111-1111-4111-8111-111111111111'}}),
  f=>f.reverse.relations[0].ended=true,
  f=>f.artist.id='11111111-1111-4111-8111-111111111111',
  f=>f.artist.relations[0].url.resource='https://attacker.invalid/artist',
  f=>f.entity.claims.P434[0].mainsnak.datavalue.value='11111111-1111-4111-8111-111111111111',
  f=>f.entity.labels.en.value='Other Singer',
  f=>f.artist.aliases.push({name:'Kimberley Chen',type:'Search hint'}),
  f=>f.artist.name='bad\ud800',
 ]) {
  const f=discoveryFixture();mutate(f);
  if(f.artist.aliases.some(a=>a.type==='Search hint'))f.entity.labels.en.value='Other Singer';
  assert.equal(await resolver(f)(target),null);
 }
});
test('discovery evidence binds the original request, exact source and complete contributors without weakening recording gates',async()=>{
 const plan=await resolver(discoveryFixture())(target),song={id:source.id,source:'lrclib',title:source.trackName,artist:source.artistName,album:source.albumName,duration:source.duration};
 const evidence=buildArtistDiscoveryEvidence(song,target,plan);assert.ok(evidence);
 const bound={...song,artistAliasEvidence:evidence};assert.deepEqual(recoveredDiscoveryNames(bound,target),['Kimberley Chen']);assert.ok(recordingScore(bound,target)>=0);
 assert.ok(recordingScore({...bound,id:999},target)<0,'accepted evidence cannot move to a different source ID');
 for(const change of [{title:'愛你 (Live)'},{album:'Another Album'},{duration:215},{artist:'Other Singer'},{artist:'陳芳語 & Guest'},{creditedArtistNames:['陳芳語','陳芳語']},{isrc:'TWABC1200001',explicit:true}]) {
  const request=change.isrc?{...target,isrc:'TWABC1200002',explicit:false}:target;
  assert.equal(buildArtistDiscoveryEvidence({...song,...change},request,plan),null);
  assert.ok(recordingScore({...bound,...change},request)<0);
 }
 assert.equal(recoveredDiscoveryNames(bound,{...target,recordingItemID:'0123456789ABCDEFGHIJKL'}),null);
 assert.equal(buildArtistDiscoveryEvidence({...song,source:'qq'},target,plan),null,'QQ still requires fresh singer MID identity');
});
test('transient failures and cancellation never become confirmed artist absence',async()=>{
 const f=discoveryFixture();let fail=true;
 const resolve=resolver(f,{fetchFn:async(...args)=>{if(fail){fail=false;throw new Error('offline');}return f.fetchFn(...args);}});
 assert.equal(await resolve(target),null);assert.ok(await resolve(target));
 const controller=new AbortController();controller.abort();assert.equal(await resolve(target,{signal:controller.signal,refresh:true}),null);
 const slow=resolver(f,{budgetMs:15,fetchFn:async(_,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
 assert.equal(await slow(target),null);
});
test('shared caches preserve verified identities and expiry; confirmed absence expires sooner than a transient 503',async()=>{
 const f=discoveryFixture(),disk=new Map();let time=start,writes=0;
 const options={redis:{},getFn:async(_,key)=>disk.get(key),setFn:async(_,key,value)=>{writes++;disk.set(key,structuredClone(value));},now:()=>time};
 const first=await resolver(f,options)(target);assert.ok(first);assert.equal(writes,1);
 assert.ok(await resolver(f,options)(target));assert.equal(f.calls.length,3);
 time+=86400001;assert.ok(await resolver(f,options)(target));assert.equal(f.calls.length,6);
 const absent=discoveryFixture();absent.reverse.relations=[];const missing=resolver(absent,{now:()=>time});
 assert.equal(await missing(target),null);assert.equal(await missing(target),null);assert.equal(absent.calls.length,1);
 time+=300001;assert.equal(await missing(target),null);assert.equal(absent.calls.length,2);
 let busy=0,gates=0;const retry=discoveryFixture();
 const recover=resolver(retry,{rateGate:async()=>{gates++;},fetchFn:async(...args)=>++busy===1?new Response('{}',{status:503}):retry.fetchFn(...args)});
 assert.ok(await recover(target));assert.equal(gates,3,'both MusicBrainz attempts and the fresh artist read acquire the rate gate');
 assert.ok(await recover(target));assert.equal(gates,3);
});
test('a failed or occupied distributed MusicBrainz gate cannot fall through to an unthrottled read',async()=>{
 for(const set of [async()=>{throw new Error('redis unavailable');},async()=>null]) {
  const f=discoveryFixture();
  const resolve=createArtistDiscoveryResolver({fetchFn:f.fetchFn,redis:{set},getFn:async()=>null,setFn:async()=>assert.fail('no absence cache after a failed gate'),budgetMs:20,appleCatalog:null});
  assert.equal(await resolve(target),null);assert.equal(f.calls.length,0);
 }
});
test('a server Retry-After longer than the discovery budget never triggers an early retry or a negative cache',async()=>{
 const f=discoveryFixture();let calls=0;
 const resolve=resolver(f,{fetchFn:async()=>{calls++;return new Response('{}',{status:503,headers:{'Retry-After':'60'}});}});
 assert.equal(await resolve(target),null);assert.equal(calls,1);assert.equal(await resolve(target),null);assert.equal(calls,2);
});
test('MusicBrainz-bound Wikidata claims retain fresh QQ MID and NetEase ID admission requirements',async()=>{
 const claim=value=>({rank:'normal',mainsnak:{snaktype:'value',datavalue:{value}}});
 for(const provider of ['qq','netease']){
  const f=discoveryFixture();f.entity.claims.P10410=[claim('001123456789AB')];f.entity.claims.P10445=[claim('8321')];
  const plan=await resolver(f)(target),song={source:provider,id:'123',title:target.title,artist:'陳芳語',album:target.album,duration:207.84,
   creditedArtistNames:['陳芳語'],creditedArtistIDs:['8321'],...(provider==='qq'?{creditedArtistMIDs:['001123456789AB']}:{})};
  const performer={id:'8321',name:'陳芳語',...(provider==='qq'?{mid:'001123456789AB'}:{})},profiles=new Map([['8321',['陳芳語']]]);
  const evidence=buildArtistIdentityEvidence(song,[performer],target,profiles,plan.identities);assert.ok(evidence);
  assert.ok(recordingScore({...song,artistAliasEvidence:evidence},target)>=0);
  const changed=provider==='qq'?{...song,creditedArtistMIDs:['009123456789AB']}:{...song,creditedArtistIDs:['999']};
  assert.ok(recordingScore({...changed,artistAliasEvidence:evidence},target)<0);
  const missing=discoveryFixture(),withoutClaims=await resolver(missing)(target);
  assert.equal(buildArtistIdentityEvidence(song,[performer],target,profiles,withoutClaims.identities),null);
 }
});
test('verified names prefer the title script and ambiguous contributor assignments abstain',async()=>{
 const f=discoveryFixture();f.entity.labels.ar={value:'كيمبرلي تشين'};
 const plan=await resolver(f)(target);assert.deepEqual(artistDiscoveryNames(plan,target),['陳芳語']);
 const duo={...target,creditedArtistNames:['Kimberley Chen','Other Singer'],creditedArtistIDs:[...target.creditedArtistIDs,'0123456789ABCDEFGHIJKL']};
 assert.equal(await resolver(f)(duo),null,'one Spotify URL cannot supply two requested artists');
});
test('Apple ISRC localization binds the same recording and artist IDs; it never borrows Apple lyrics or document identity',async()=>{
 const request={...target,isrc:'TWABC1200001'},base={catalog_id:'520208666',title:target.title,album:target.album,duration:target.duration,isrc:request.isrc,artist_ids:['520340425'],artist_entities:[{id:'520340425',name:'Kimberley'}],artist:'Kimberley',content_rating:null};
 const native={...base,artist:'陳芳語',artist_entities:[{id:'520340425',name:'陳芳語'}]};
 for(const [change,accepted] of [[{},true],[{catalog_id:'520208666',artist_ids:['999'],artist_entities:[{id:'999',name:'陳芳語'}]},false],[{isrc:'TWABC1200002'},false],[{duration:210},false],[{title:'愛你 (Live)'},false],[{artist_ids:['999'],artist_entities:[{id:'999',name:'陳芳語'}]},false],[{content_rating:'explicit'},false]]) {
  const f=discoveryFixture();f.reverse.relations=[];
  const appleCatalog={byISRC:async(_isrc,country)=>country==='us'?[base]:[{...native,...change}]};
  const plan=await resolver(f,{appleCatalog})(request);
  assert.equal(!!plan,accepted);if(plan)assert.deepEqual(artistDiscoveryNames(plan,request),['陳芳語']);
 }
 const f=discoveryFixture();f.reverse.relations=[];
 assert.equal(await resolver(f,{appleCatalog:{byISRC:async()=>[native]}})(target),null,'no cross-catalog bridge without an ISRC');
});
