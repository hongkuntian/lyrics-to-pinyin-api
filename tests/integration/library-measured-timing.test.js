import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSongLibraryService,lyricLoader} from '../../api/song-library.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {requestKey} from '../../api/utils/song-library/document.js';
import {executeTranslationJob} from '../../api/utils/song-library/translation-worker.js';
import {requestBody} from '../../api/utils/song-library/translation.js';
import {sourceCapsule,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {measuredService} from '../helpers/measured-sources.js';
import {appleRequest,spotifyRequest} from '../helpers/netease-yrc.js';
import {libraryDB} from '../helpers/library-db.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {streamResponse,frames} from '../helpers/stream-http.js';
import {validateSchema} from '../contracts/schema-validator.js';

const cueCount=response=>response.lines.reduce((n,line)=>n+(line.vocalTiming?.segments?.length??0),0);
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
const translation=doc=>({lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:'A synthetic meaning.',text:'A synthetic meaning.',speakerID:null,startsTurn:false})),sourceNotes:[]});
async function fixture(t,{mode='words',gate=null}={}) {
 const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[];let qqCalls=0,sourceLoads=0;
 const state={mode,studyQuote:''};
 const plain={name:'LRCAPI',searchSong:async()=>({id:7,source:'lrclib',title:appleRequest.title,artist:appleRequest.artist,creditedArtistNames:[appleRequest.artist],album:appleRequest.album,duration:240}),
  getLyrics:async()=>({source:'lrclib',songId:7,lines:[{text:'Invented first verse',timestamp:10},{text:'Invented second verse',timestamp:60},{text:'Invented closing verse',timestamp:120}]})};
 const f=measuredService('qq',{detectLanguageFn:async()=> 'zh',hedgeDelayMs:0,getAvailableAPIsFn:()=>[plain,f.measuredAPI]});
 const search=f.measuredAPI.searchSong;
 f.measuredAPI.searchSong=async(...args)=>{qqCalls++;if(gate)await gate.promise;
  if(state.mode==='absent')return null;if(state.mode==='offline')throw new Error('fixture provider offline');
  const song=await search(...args);return state.mode==='mismatch'?{...song,title:appleRequest.title+' (Live)'}:song;};
 const loader=lyricLoader(f.service);
 const options={store,selectionRevision:SELECTION_REVISION,loadLyrics:async(...args)=>{sourceLoads++;return loader(...args);},apiKey:'fixture',
  generateFn:async doc=>({content:translation(doc),actualMicros:100,response:{id:'fixture-translation'}}),
  explainFn:async()=>({content:{meaning:'A fixture explanation.',context:'A synthetic verse.',grammar:'A fixture construction.',uncertainty:'',sourceQuote:state.studyQuote},actualMicros:100,response:{id:'fixture-study'}}),
  waitUntilFn:p=>pending.push(p),logger:{info(){},error(){}}};
 const service=createSongLibraryService(options);
 const call=async(body,token='token-a',res=createMockRes(),target=service)=>{const req=createMockReq({body});req.lyricaUser=await store.authenticate(token);await target(req,res);return res;};
 return {db,store,pending,state,call,service,instance:overrides=>createSongLibraryService({...options,...overrides}),get qqCalls(){return qqCalls;},get sourceLoads(){return sourceLoads;}};
}

for(const [platform,recording] of [['apple',appleRequest],['spotify',spotifyRequest]]) {
 test(`${platform}: actual library loader selects QQ and reopens its whole measured edition`,async t=>{
  const f=await fixture(t),first=await f.call({action:'lyrics',recording});
  assert.equal(first.statusCode,200);const doc=first.body.document;
  assert.equal(doc.response.metadata.source,'QQMusicAPI');assert.ok(cueCount(doc.response)>0);assert.ok(f.qqCalls>0);
  const reopened=await f.call({action:'lyrics',recording});assert.equal(reopened.body.document.id,doc.id);
  assert.deepEqual(reopened.body.document.response.lines,doc.response.lines);assert.equal(f.sourceLoads,1);
  const schema=JSON.parse(readFileSync(new URL('../../contracts/song-library.schema.json',import.meta.url)));
  assert.deepEqual(validateSchema(schema,first.body),[]);
 });

 test(`${platform}: explicit library reload replaces the old edition and preserves immutable history`,async t=>{
  const f=await fixture(t,{mode:'absent'}),old=(await f.call({action:'lyrics',recording})).body.document;
  assert.equal(cueCount(old.response),0);const stored=await f.store.document(old.id);
  f.state.mode='words';const next=await f.call({action:'lyrics',recording,refresh:true});
  assert.equal(next.statusCode,200);assert.ok(cueCount(next.body.document.response)>0);assert.notEqual(next.body.document.id,old.id);
  assert.deepEqual((await f.store.document(old.id)).response,stored.response);
  assert.equal((await f.store.documentForRequest(requestKey(recording),SELECTION_REVISION)).id,next.body.document.id);
 });

 test(`${platform}: unavailable or mismatched QQ keeps a readable line-timed fallback`,async t=>{
  const f=await fixture(t,{mode:'absent'});
  for(const mode of ['absent','offline','mismatch']) {
   f.state.mode=mode;const res=await f.call({action:'lyrics',recording,refresh:true});
   assert.equal(res.statusCode,200,mode);assert.equal(res.body.document.response.metadata.source,'LRCAPI',mode);
   assert.equal(res.body.document.response.quality.synced,true);assert.equal(cueCount(res.body.document.response),0);
  }
 });

 test(`${platform}: a poorer refresh retains measured coverage while an equal-quality edition can replace it`,async t=>{
  const f=await fixture(t),old=(await f.call({action:'lyrics',recording})).body.document;
  assert.ok(cueCount(old.response)>0);f.state.mode='offline';
  const fallback=await f.call({action:'lyrics',recording,refresh:true});
  assert.equal(fallback.statusCode,200);assert.equal(fallback.body.document.id,old.id);
  assert.deepEqual(fallback.body.document.response.lines,old.response.lines);
  const equal=structuredClone(old.response);equal.song.id=43;
  equal.metadata.lyric_timing={...equal.metadata.lyric_timing,source:'qq:43:qrc',revision:'b'.repeat(64)};
  if(equal.song_details)equal.song_details.source_id='43';
  if(platform==='spotify')equal.recordingBinding=spotifyBinding(recording,sourceCapsule(equal),SELECTION_REVISION,equal);
  const reload=await f.call({action:'lyrics',recording,refresh:true},'token-a',createMockRes(),f.instance({loadLyrics:async()=>equal}));
  assert.equal(reload.statusCode,200);assert.notEqual(reload.body.document.id,old.id);
  assert.equal(cueCount(reload.body.document.response),cueCount(old.response));
  assert.equal((await f.store.documentForRequest(requestKey(recording),SELECTION_REVISION)).id,reload.body.document.id);
  assert.deepEqual((await f.store.document(old.id)).response.lines,old.response.lines);
 });

 test(`${platform}: a rejected measured source yields to a valid readable fallback`,async t=>{
  const f=await fixture(t),old=(await f.call({action:'lyrics',recording})).body.document;
  assert.ok(cueCount(old.response)>0);f.state.mode='absent';
  const result=await f.call({action:'lyrics',recording,refresh:true},'token-a',createMockRes(),
   f.instance({lyricSourceNeedsRefreshFn:response=>String(response.song.id)==='42'}));
  assert.equal(result.statusCode,200);assert.notEqual(result.body.document.id,old.id);
  assert.equal(result.body.document.response.metadata.source,'LRCAPI');assert.equal(cueCount(result.body.document.response),0);
  assert.equal((await f.store.documentForRequest(requestKey(recording),SELECTION_REVISION)).id,result.body.document.id);
  assert.deepEqual((await f.store.document(old.id)).response.lines,old.response.lines);
 });

 test(`${platform}: library progress publishes readable lyrics before saving the QQ completion`,async t=>{
  const gate=deferred(),readable=deferred(),f=await fixture(t,{gate}),res=streamResponse(),write=res.write;
  res.write=value=>{const result=write.call(res,value);if(JSON.parse(value).event==='readable')readable.resolve();return result;};
  const work=f.call({action:'lyrics',recording,delivery:'progressive-v1'},'token-a',res);
  let timer;try {
   await Promise.race([readable.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('readable frame missing')),2000);})]);
   assert.equal(frames(res)[0].response.metadata.source,'LRCAPI');assert.equal(res.ended,undefined);
   gate.resolve();await work;const complete=frames(res).at(-1);
   assert.equal(complete.event,'complete');assert.equal(complete.document.response.metadata.source,'QQMusicAPI');
   assert.ok(cueCount(complete.document.response)>0);
   assert.equal((await f.store.documentForRequest(requestKey(recording),SELECTION_REVISION)).id,complete.document.id);
  }finally{clearTimeout(timer);gate.resolve();await work;}
 });
}

test('Spotify source replacement leaves peer fingerprints, learning records and a running completion on the original document',async t=>{
 const f=await fixture(t,{mode:'absent'}),recording=spotifyRequest,peer={...recording,market:'US'};
 const old=(await f.call({action:'lyrics',recording})).body.document;
 assert.equal((await f.call({action:'lyrics',recording:peer})).body.document.id,old.id);
 const requested=await f.call({action:'translate',documentID:old.id,sourceHash:old.sourceHash,target:'en',allowGeneration:true});
 assert.equal(requested.statusCode,202);await Promise.all(f.pending);
 const meaning=(await f.call({action:'current',documentID:old.id,sourceHash:old.sourceHash,target:'en'})).body.translation;
 assert.ok(meaning?.id);
 f.state.studyQuote=Array.from(old.response.lines[0].original).slice(0,3).join('');
 const study=await f.call({action:'explain',documentID:old.id,sourceHash:old.sourceHash,translationID:meaning.id,sourceID:'L0001',lower:'0',upper:'3',allowGeneration:true});
 assert.equal(study.statusCode,202);await Promise.all(f.pending);
 const report=await f.call({action:'report',documentID:old.id,translationID:meaning.id,sourceID:'L0001',category:'timing',detail:'Synthetic timing report.'});assert.equal(report.statusCode,200);
 const original=await f.store.document(old.id),generationRequest=requestBody(original,'fr');
 const reserved=await f.store.reserve({userID:'reader-b',documentID:old.id,target:'fr',recipe:'fixture-held',reservedMicros:1000,generationRequest,allowGeneration:true});
 const started=deferred(),finish=deferred();
 const worker=executeTranslationJob(f.store,reserved.job.id,{doc:original,generateFn:async doc=>{assert.equal(doc.id,old.id);started.resolve();await finish.promise;return {content:translation(doc),actualMicros:100,response:{id:'held-fixture'}};}});
 try {
  await started.promise;f.state.mode='words';const current=(await f.call({action:'lyrics',recording,refresh:true})).body.document;
  assert.notEqual(current.id,old.id);assert.ok(cueCount(current.response)>0);
  assert.equal((await f.store.documentForRequest(requestKey(peer),SELECTION_REVISION)).id,old.id);
  finish.resolve();await worker;
  assert.equal((await f.store.job(reserved.job.id)).documentID,old.id);
  assert.equal((await f.db.query('SELECT document_id FROM song_translations WHERE id=$1',[reserved.job.id])).rows[0].document_id,old.id);
  assert.equal((await f.db.query('SELECT document_id FROM study_explanations')).rows[0].document_id,old.id);
  assert.equal((await f.db.query('SELECT document_id FROM correction_reports WHERE id=$1',[report.body.report.id])).rows[0].document_id,old.id);
  assert.equal((await f.store.translation(old.id,'en')).id,meaning.id);
  assert.equal(await f.store.translation(current.id,'en'),null);
  assert.deepEqual((await f.store.document(old.id)).response,original.response);
 }finally{finish.resolve();await worker;}
});
