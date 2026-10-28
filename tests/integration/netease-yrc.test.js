import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {yrcService,appleRequest,spotifyRequest,syntheticYRC,catalogProof} from '../helpers/netease-yrc.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {sourceCapsule,spotifyHashes} from '../../api/utils/song-library/spotify-recording.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {libraryDB} from '../helpers/library-db.js';
import {requestBody,generate} from '../../api/utils/song-library/translation.js';
import {generateExplanation} from '../../api/utils/song-library/study-explanation.js';
import {applyTimingCorrection,timingFingerprint} from '../../api/utils/timing-corrections.js';
import {createSongLibraryService} from '../../api/song-library.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';

async function acquired(request=appleRequest,options={}){const f=yrcService(options),r=await f.call(request.provider?{recording:request}:request);assert.equal(r.statusCode,200,JSON.stringify(r.body));return {f,response:r.body,doc:makeDocument(request,r.body,SELECTION_REVISION)};}
async function save(store,doc,replaceID=null){const owner=await store.claimLookup(doc.requestKey,SELECTION_REVISION);assert.ok(owner);try{return await store.saveDocument(doc,{lookupOwner:owner,replaceID});}finally{await store.releaseLookup(doc.requestKey,SELECTION_REVISION,owner);}}
test('synthetic resolver proof retains the required canonical context from the real resolver',async()=>{
 const aliases=await resolveCatalogAliases(appleRequest,{appleCatalog:null,fetchFn:async()=>({ok:true,json:async()=>({results:[{kind:'song',trackId:123,trackName:appleRequest.title,artistName:appleRequest.artist,collectionName:appleRequest.album,trackTimeMillis:appleRequest.duration*1000}]})})});
 assert.ok(aliases.resolution);const expected=aliases.resolution.canonical_context;
 assert.deepEqual(expected,{title:appleRequest.title,artist:appleRequest.artist});
 assert.deepEqual(catalogProof(appleRequest).canonical_context,expected);
 const response=await yrcService().call();assert.deepEqual(response.body.metadata.catalog_resolution.canonical_context,expected);
});
test('Apple and Spotify HTTP -> capsule -> durable public projection use exact frozen word DTO',async()=>{
 const results=[];
 for(const request of [appleRequest,spotifyRequest]){
  const {f,response,doc}=await acquired(request),wire=publicDocument(doc,request);
  assert.deepEqual(response.lines.map(l=>l.original),['!你 😀e\u0301','Synthetic sky','Line without word cues']);
  assert.equal(response.lines[0].timestamp,10);assert.equal(response.lines[0].vocalTiming.segments[0].utf16Start,1);
  assert.equal(response.lines[0].vocalTiming.segments[1].utf16Length,2);assert.equal(response.lines[2].vocalTiming,undefined);
  assert.equal(response.metadata.lyric_timing.recordingID,request.item_id??request.catalog_id);
  assert.equal(response.metadata.lyric_timing.provider,request.provider??'appleMusic');assert.equal(response.metadata.lyric_timing.source,'netease:42:yrc');
  assert.deepEqual(wire.response.metadata.lyric_timing,response.metadata.lyric_timing);assert.deepEqual(wire.response.lines,response.lines);assert.equal(f.urls.length,1);
  if(request.provider){assert.deepEqual(doc.sourceCapsule,sourceCapsule(response));assert.equal(wire.recordingBinding.sourceHash,doc.sourceHash);assert.deepEqual(doc.sourceCapsule.lyricTiming,response.metadata.lyric_timing);}
  results.push(response);
 }
 assert.equal(results[0].metadata.lyric_timing.revision,results[1].metadata.lyric_timing.revision);
 const f=yrcService(),explicit=await f.call({...appleRequest,music_platform:'netease'});assert.ok(explicit.body.lines[0].vocalTiming);
});
test('negative credit metadata preserves measured Apple and Spotify durable sources instead of selecting sibling LRC',async()=>{
 const credits='{"t":-1000,"c":[{"tx":"Invented credit"}]}\n{"t":-500,"c":[{"tx":"Another credit"}]}\n';
 for(const request of [appleRequest,spotifyRequest]){
  const normal=await acquired(request),signed=await acquired(request,{yrc:credits+syntheticYRC});
  assert.ok(signed.response.lines[0].vocalTiming);
  assert.deepEqual(signed.response.lines,normal.response.lines);
  assert.equal(signed.doc.sourceHash,normal.doc.sourceHash);
  assert.equal(signed.doc.timingRevision,normal.doc.timingRevision);
  assert.deepEqual(publicDocument(signed.doc,request).response.lines,normal.response.lines);
  assert.equal(signed.f.urls.length,1);
 }
});
test('catalog proof is required for words, while outer whitespace preserves exact cues and LRC remains readable',async()=>{
 const {catalog_id,...request}=appleRequest,f=yrcService(),res=await f.call(request);
 assert.equal(res.statusCode,200);assert.equal(res.body.metadata.lyric_timing,undefined);assert.ok(res.body.lines.every(l=>!l.vocalTiming));
 const changed=await acquired(appleRequest,{yrc:'[10000,1000](10000,1000,0)  Synthetic sky  \n[20000,1000](20000,1000,0)other'});
 assert.equal(changed.response.lines[0].original,'Synthetic sky');
 assert.deepEqual(changed.response.lines[0].vocalTiming,{end:11,segments:[{utf16Start:0,utf16Length:13,text:'Synthetic sky',start:10,end:11}]});
 assert.ok(changed.response.lines[1].vocalTiming);
 const legacy=await acquired(appleRequest,{yrc:'malformed'});assert.equal(legacy.response.lines[0].original,'Old synthetic LRC');assert.equal(legacy.response.metadata.lyric_timing,undefined);
});
test('new timed Apple hashes use canonical JSON; legacy Apple digest bytes remain frozen',async()=>{
 const baseline=JSON.parse(await readFile(new URL('../fixtures/yrc-legacy-apple-hashes.json',import.meta.url),'utf8'));
 const legacy=makeDocument(baseline.request,baseline.response,SELECTION_REVISION);for(const [k,v] of Object.entries(baseline.hashes))assert.equal(legacy[k],v,k);
 const {response,doc}=await acquired();
 for(const mutate of [r=>r.lines[0].vocalTiming.segments[0].end-=.1,r=>r.metadata.lyric_timing.revision='a'.repeat(64)]){
  const changed=structuredClone(response);mutate(changed);const next=makeDocument(appleRequest,changed,SELECTION_REVISION);
  for(const key of ['sourceHash','timingRevision','id'])assert.notEqual(next[key],doc[key],key);
  assert.equal(next.textRevision,doc.textRevision);assert.equal(next.readingRevision,doc.readingRevision);
 }
 const reordered=JSON.parse(JSON.stringify(response,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v));
 const next=makeDocument(appleRequest,reordered,SELECTION_REVISION);assert.equal(next.sourceHash,doc.sourceHash);assert.equal(next.timingRevision,doc.timingRevision);
 const invalid=structuredClone(doc);invalid.response.lines[0].vocalTiming.segments[0].end-=.1;
 assert.throws(()=>publicDocument(invalid,appleRequest),{code:'recording_mismatch'});
});
test('Spotify published hash recipes stay exact; same observed ID hints stay stable and other observed IDs rotate timing provenance',async()=>{
 const a=await acquired(spotifyRequest),r={...spotifyRequest,market:'US',requested_item_id:'0123456789ABCDEFGHIJKM'};
 const b=await acquired(r),other=await acquired({...spotifyRequest,item_id:'0123456789ABCDEFGHIJKM'});
 assert.equal(a.doc.sourceHash,b.doc.sourceHash);assert.equal(a.doc.timingRevision,b.doc.timingRevision);assert.notEqual(a.doc.requestKey,b.doc.requestKey);
 assert.notEqual(a.doc.sourceHash,other.doc.sourceHash);assert.notEqual(a.doc.timingRevision,other.doc.timingRevision);
 const hashes=spotifyHashes(spotifyRequest,sourceCapsule(a.response),SELECTION_REVISION);assert.equal(hashes.sourceHash,a.doc.sourceHash);
 const changed=structuredClone(a.doc);changed.response.metadata.lyric_timing.recordingID=r.requested_item_id;
 assert.throws(()=>publicDocument(changed,spotifyRequest),{code:'recording_mismatch'});
});
test('ordinary/canonical acquisition keys carry only internal provider capability; aliases bind current catalog proof',async()=>{
 const keys=[],f=yrcService({speculativeDiscovery:false,getCacheKeyFn:(raw)=>{keys.push(JSON.parse(raw));return raw;}});
 const a=await f.call(),b=await f.call({...appleRequest,storefront:'ca'});assert.equal(a.statusCode,200);assert.equal(b.statusCode,200);
 assert.ok(keys.every(k=>k.providerCapability==='netease-yrc-1:signed-credits-1:structured-lrc-2:structured-yrc-2:measured-releases-1:artist-diacritics-1:artist-identities-1'));assert.equal(f.queries.length,1);assert.equal(b.body.metadata.lyric_timing.recordingID,'123');
 const sameMetadataAlias={...appleRequest,catalog_id:'456',storefront:'ca'},c=await f.call(sameMetadataAlias);
 assert.equal(c.statusCode,200);assert.equal(c.body.metadata.lyric_timing.recordingID,'456');
 assert.equal(c.body.metadata.lyric_timing.revision,a.body.metadata.lyric_timing.revision);
});
test('timing corrections remove optional cues on untimed fallback without changing readable words',async()=>{
 const {parseYRC}=await import('../../api/utils/netease-yrc.js'),lyrics=parseYRC(syntheticYRC,{songId:42,duration:240});
 const rule={id:'synthetic-rule',catalog_id:'123',artists:[appleRequest.artist],title:appleRequest.title,album:appleRequest.album,duration:240,rejected:[timingFingerprint(lyrics)],replacementID:99};
 const result=await applyTimingCorrection({song:{duration:240},lyrics},appleRequest,{deadline:0},{rules:[rule]});
 assert.equal(result.timingCorrection.status,'untimed_fallback');assert.ok(result.lyrics.lines.every(l=>!l.vocalTiming));assert.equal(result.lyrics.timingSource,undefined);
});
test('oversized optional extension falls back to complete readable edition after metadata formatting',async()=>{
 const yrc=Array.from({length:20},(_,i)=>`[${i*2000},1000]`+Array.from({length:100},(_,j)=>`(${i*2000+j*10},10,0)x`).join('')).join('\n');
 for(const request of [appleRequest,spotifyRequest]){
  const {response}=await acquired(request,{yrc});assert.equal(response.lines.length,20);assert.ok(response.lines.every(l=>!l.vocalTiming));assert.equal(response.metadata.lyric_timing,undefined);assert.ok(Buffer.byteLength(JSON.stringify(response))<=160000);
 }
});
test('timed Apple and Spotify survive JSONB close/reopen with immutable source, saved jobs and leased isolation',async t=>{
 const path=await mkdtemp(join(tmpdir(),'yrc-library-'));t.after(()=>rm(path,{recursive:true,force:true}));
 let {db,store}=await libraryDB(path);t.after(()=>db.close());const apple=await acquired(),sp=await acquired(spotifyRequest);
 const a=await save(store,apple.doc),s=await save(store,sp.doc);
 const job=await store.reserve({userID:'reader-a',documentID:s.id,target:'en',recipe:'fixture',reservedMicros:10000,generationRequest:requestBody(s,'en')});
 const hint={...spotifyRequest,market:'US'},hintDoc=(await acquired(hint)).doc;await save(store,hintDoc);
 const replacement=(await acquired(spotifyRequest,{yrc:syntheticYRC.replace('10000,500,9','10000,400,9')})).doc;
 await assert.rejects(store.saveDocument(replacement,{replaceID:s.id,lookupOwner:'00000000-0000-4000-8000-000000000001'}),{code:'lookup_superseded'});
 await save(store,replacement,s.id);assert.equal((await store.documentForRequest(requestKey(hint),SELECTION_REVISION)).id,s.id);
 await db.close();({db,store}=await libraryDB(path));
 for(const [r,d] of [[appleRequest,a],[hint,s]]){const loaded=await store.documentForRequest(requestKey(r),SELECTION_REVISION),wire=publicDocument(loaded,r);assert.equal(wire.id,d.id);assert.deepEqual(wire.response.lines,d.response.lines);assert.deepEqual(wire.response.metadata.lyric_timing,d.response.metadata.lyric_timing);assert.equal(loaded.timingRevision,d.timingRevision);}
 const saved=await store.document(s.id);assert.equal(saved.id,s.id);assert.deepEqual(saved.sourceCapsule,s.sourceCapsule);assert.equal((await store.existingTranslationJob(saved,'en')).id,job.job.id);
 assert.equal((await store.documentForRequest(requestKey(spotifyRequest),SELECTION_REVISION)).id,replacement.id);assert.equal(Number((await store.usage()).accounted_micros),10000);
});
test('actual translation and Study outbound model bodies contain no timing/provenance or request IDs',async()=>{
 const {doc}=await acquired(spotifyRequest),captured=[];
 const fetchFn=output=>async(url,init)=>{const body=JSON.parse(init.body);captured.push(body);return new Response(JSON.stringify({model:body.model,service_tier:body.service_tier,status:'completed',usage:{input_tokens:10,output_tokens:10},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]}));};
 await generate(doc,{apiKey:'fixture',fetchFn:fetchFn({translations:{L0001:'Invented first.',L0002:'Invented second.',L0003:'Invented third.'},sourceNotes:[]})});
 await generateExplanation(doc,null,{sourceID:'L0002',lower:0,upper:9,text:'Synthetic'},{apiKey:'fixture',fetchFn:fetchFn({meaning:'Invented.',context:'Invented context.',grammar:'Adjective.',uncertainty:'',sourceQuote:'Synthetic'})});
 assert.equal(captured.length,2);for(const body of captured){const raw=JSON.stringify(body);for(const token of ['vocalTiming','lyricTiming','lyric_timing','netease:42:yrc',spotifyRequest.item_id,'recordingID','utf16Start'])assert.ok(!raw.includes(token),token);}
});
test('verified durable Apple alias projection requires a private current request lookup, including after reopen',async t=>{
 const path=await mkdtemp(join(tmpdir(),'yrc-alias-'));t.after(()=>rm(path,{recursive:true,force:true}));
 let {db,store}=await libraryDB(path);t.after(()=>db.close());
 const a=(await acquired()).doc,bRequest={...appleRequest,catalog_id:'456',storefront:'ca'},b=(await acquired(bRequest)).doc;
 await save(store,a);await save(store,b,a.id);
 // Existing explicit refresh moves the verified aliases together; the source
 // remains the immutable edition bound to the refreshed B request.
 const check=async()=>{
  const loaded=await store.documentForRequest(requestKey(appleRequest),SELECTION_REVISION),wire=publicDocument(loaded,appleRequest);
  assert.equal(loaded.id,b.id);assert.equal(loaded.response.metadata.lyric_timing.recordingID,'456');assert.equal(wire.response.metadata.lyric_timing.recordingID,'123');
  for(const k of ['id','sourceHash','timingRevision','textRevision','readingRevision'])assert.equal(wire[k],loaded[k],k);
  assert.deepEqual(wire.response.lines,loaded.response.lines);assert.equal(wire.response.metadata.lyric_timing.revision,loaded.response.metadata.lyric_timing.revision);
  for(const wrong of [{...appleRequest,title:'Different'},bRequest,{...appleRequest,catalog_id:'789'}])assert.throws(()=>publicDocument(loaded,wrong),{code:'recording_mismatch'});
  const clone=structuredClone(loaded);clone.requestKey=requestKey(appleRequest);clone.timingRequestKey=requestKey(appleRequest);clone.requestEvidence={requestKey:requestKey(appleRequest)};
  assert.throws(()=>publicDocument(clone,appleRequest),{code:'recording_mismatch'});
  assert.throws(()=>publicDocument({...loaded,requestKey:requestKey(appleRequest)},appleRequest),{code:'recording_mismatch'});
  loaded.requestKey=requestKey(bRequest);assert.throws(()=>publicDocument(loaded,bRequest),{code:'recording_mismatch'});
  const wrongProof=await store.documentForRequest(requestKey(appleRequest),SELECTION_REVISION);wrongProof.response.metadata.catalog_resolution.canonical_recording_id='apple:789';assert.throws(()=>publicDocument(wrongProof,appleRequest),{code:'recording_mismatch'});
  const unbound=await store.document(b.id);assert.throws(()=>publicDocument(unbound,appleRequest),{code:'recording_mismatch'});
 };
 await check();await db.close();({db,store}=await libraryDB(path));await check();
 const service=createSongLibraryService({store,selectionRevision:SELECTION_REVISION,loadLyrics:()=>assert.fail('ready alias must not reacquire'),apiKey:null,logger:{error(){}}});
 const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
 await service({method:'POST',lyricaUser:{id:'reader-a'},body:{action:'lyrics',recording:appleRequest}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.document.response.metadata.lyric_timing.recordingID,'123');assert.equal(res.body.document.id,b.id);
});
test('timed noncanonical Apple stores existing revision columns; unrelated providers and mismatches gain no YRC',async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());const {doc}=await acquired(appleRequest,{resolution:false});assert.equal(doc.canonicalRecordingID,null);
 await save(store,doc);const loaded=await store.documentForRequest(requestKey(appleRequest),SELECTION_REVISION);assert.equal(loaded.timingRevision,doc.timingRevision);assert.equal(publicDocument(loaded,appleRequest).sourceHash,doc.sourceHash);
 const f=yrcService();f.api.name='LRCAPI';f.api.getLyrics=async()=>({lines:[{text:'Other provider text',timestamp:10}]});
 const other=await f.call();assert.equal(other.statusCode,200);assert.equal(other.body.metadata.lyric_timing,undefined);
 const mismatch=yrcService();mismatch.api.searchSong=async()=>({id:42,title:appleRequest.title,artist:'Different singer',duration:240,source:'netease'});
 const rejected=await mismatch.call();assert.equal(rejected.statusCode,409);assert.equal(mismatch.urls.length,0);
});
test('accepted old untimed source, translation and job stay pinned until explicit refresh',async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());const old=(await acquired(appleRequest,{yrc:'malformed'})).doc,newDoc=(await acquired()).doc;
 await save(store,old);
 const job=await store.reserve({userID:'reader-a',documentID:old.id,target:'en',recipe:'fixture',reservedMicros:10000});await store.claim(job.job.id);
 await store.complete(job.job.id,{lines:old.structure.occurrences.map(o=>({sourceID:o.sourceID,text:'Invented translation.'})),sourceNotes:[],rejectedNotes:[]},1000,{});
 let loads=0;const service=createSongLibraryService({store,selectionRevision:SELECTION_REVISION,loadLyrics:async()=>{loads++;return newDoc.response;},apiKey:null,logger:{error(){}}});
 const call=async refresh=>{const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await service({method:'POST',lyricaUser:{id:'reader-a'},body:{action:'lyrics',recording:appleRequest,...(refresh?{refresh:true}:{})}},res);assert.equal(res.statusCode,200,JSON.stringify(res.body));return res.body.document;};
 assert.equal((await call()).id,old.id);assert.equal(loads,0);assert.equal((await call(true)).id,newDoc.id);assert.equal(loads,1);
 assert.equal((await store.document(old.id)).response.metadata.lyric_timing,undefined);assert.equal((await store.translation(old.id,'en')).id,job.job.id);assert.equal(await store.translation(newDoc.id,'en'),null);
 assert.equal(await store.existingTranslationJob(newDoc,'en'),null);assert.equal((await store.existingTranslationJob(old,'en')).id,job.job.id);
});
