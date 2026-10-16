import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB} from '../helpers/library-db.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {sourceCapsule,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {requestBody,generate,parseTranslation} from '../../api/utils/song-library/translation.js';
import {explanationBody,generateExplanation} from '../../api/utils/song-library/study-explanation.js';
import {assessmentBody} from '../../api/utils/song-library/review-assessment.js';
import {reviewContext} from '../../api/utils/song-library/review-context.js';
import {translationIdentity} from '../../api/utils/song-library/translation-identity.js';
import {retryTranslation} from '../../api/utils/song-library/translation-retry.js';
import {batchInput} from '../../api/utils/song-library/batch-provider.js';
import {executeTranslationJob} from '../../api/utils/song-library/translation-worker.js';
const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',market:'US',metadata:{origin:'spotify',title:'SPOTIFY_PRIVATE_TITLE',artists:['SPOTIFY_PRIVATE_ARTIST'],album:'SPOTIFY_PRIVATE_ALBUM',duration_ms:240001,isrc:'USABC2600001',explicit:false}};
function document({names=true,r=recording,timestamp=12.5}={}) {
  const value={song:{id:'independent-source-42',title:{original:names?'Independent title':''},artist:{original:names?'Independent artist':''},album:names?'Independent album':null,language:'zh',romanization_system:'pinyin',duration:240},
    lines:[{original:'風來了',romanized:'fēng lái le',timestamp}],quality:{synced:true,partial:false,instrumental:false},metadata:{source:'LRCAPI',selection_revision:'test'}};
  value.recordingBinding=spotifyBinding(r,sourceCapsule(value),'test',value);return makeDocument(r,value,'test');
}
const translated=doc=>parseTranslation(JSON.stringify({translations:{L0001:'The wind comes.'},sourceNotes:[]}),doc);
const selection={sourceID:'L0001',lower:0,upper:1,text:'風'};
const payload=body=>JSON.parse(body.input[0].content);
function sourceOnly(body,{names=true}={}) {
  const data=payload(body),json=JSON.stringify(data);
  if(names) {assert.equal(data.title,'Independent title');assert.equal(data.artist,'Independent artist');assert.equal(data.album,'Independent album');}
  else for(const key of ['title','artist','album'])assert.equal(Object.hasOwn(data,key),false);
  for(const token of ['SPOTIFY_PRIVATE','0123456789ABCDEFGHIJKL','USABC2600001','independent-source-42','independent_lyric_source','recordingBinding','contextHash','modelContext','requestHash','documentID','sourceHash'])assert.equal(json.includes(token),false,token);
}
const provider=(body,output)=>new Response(JSON.stringify({model:body.model,service_tier:body.service_tier,status:'completed',usage:{input_tokens:10,output_tokens:10},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]}));
async function saved(store,doc) {const owner=await store.claimLookup(doc.requestKey,'test');try{return await store.saveDocument(doc,{lookupOwner:owner});}finally{await store.releaseLookup(doc.requestKey,'test',owner);}}
test('captured translation and Study HTTP payloads use only independent labels, including omitted source names',async()=>{
  for(const names of [true,false]) {
    const doc=document({names}),body=requestBody(doc);
    const result=await generate(doc,{apiKey:'fixture',fetchFn:async(url,init)=>{const sent=JSON.parse(init.body);sourceOnly(sent,{names});return provider(sent,{translations:{L0001:'The wind comes.'},sourceNotes:[]});}});
    assert.equal(result.content.lines[0].lyricText,'The wind comes.');
    const translation={...result.content,id:doc.id,documentID:doc.id,sourceHash:doc.sourceHash,target:'en'};
    await generateExplanation(doc,translation,selection,{apiKey:'fixture',fetchFn:async(url,init)=>{const sent=JSON.parse(init.body);sourceOnly(sent,{names});return provider(sent,{meaning:'wind',context:'Wind arrives.',grammar:'Noun.',uncertainty:'',sourceQuote:'風'});}});
    const review=assessmentBody(doc,result.content,[]);sourceOnly(review,{names});
    const batch=JSON.parse(batchInput([{operation_id:'fixture-op',request_body:review}]).trim());sourceOnly(batch.body,{names});
  }
});
test('copied request metadata with a renamed origin cannot become model context or translation identity',()=>{
  const good=document(),forged={...good,sourceCapsule:undefined,modelContext:{version:1,origin:'independent_lyric_source',source:{provider:'lrclib',itemID:'42'},title:recording.metadata.title}};
  assert.throws(()=>requestBody(forged),{code:'source_context_unavailable'});assert.throws(()=>explanationBody(forged,null,selection),{code:'source_context_unavailable'});
  assert.throws(()=>translationIdentity(forged),{code:'source_context_unavailable'});
  const changed={...good,modelContext:{...good.modelContext,title:recording.metadata.title}};
  assert.throws(()=>requestBody(changed),{code:'source_context_unavailable'});
  const identical=document();identical.requestRecording={...recording,metadata:{...recording.metadata,title:'Independent title',artists:['Independent artist']}};
  sourceOnly(requestBody(identical));
});
test('persisted job, operator retry, review and timing reuse retain source context without new automatic admission',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());const doc=await saved(store,document());
  const body=requestBody(doc),r=await store.reserve({userID:'reader-a',documentID:doc.id,target:'en',recipe:'test',reservedMicros:10000,generationRequest:body});
  await store.claim(r.job.id);await store.fail(r.job.id,'provider_incomplete',500,{id:'first'});
  await retryTranslation(db,{jobID:r.job.id,expectedAttempt:1,requestKey:'operator-retry',actor:'fixture',reason:'Known failed fixture'});
  await executeTranslationJob(store,r.job.id,{apiKey:'fixture',generateFn:(d,options)=>generate(d,{...options,fetchFn:async(url,init)=>{
    const sent=JSON.parse(init.body);sourceOnly(sent);return provider(sent,{translations:{L0001:'The wind comes.'},sourceNotes:[]});}})});
  assert.equal((await store.job(r.job.id)).state,'ready');
  const content=await store.translation(doc.id,'en'),review=await reviewContext(db,content.id);
  sourceOnly(assessmentBody(review.doc,review.content,[]));
  const r2={...recording,item_id:'0123456789ABCDEFGHIJKM',metadata:{...recording.metadata,title:'DIFFERENT_SPOTIFY_TITLE'}};
  const timed=await saved(store,document({r:r2,timestamp:14}));
  assert.equal(translationIdentity(timed),translationIdentity(doc));
  assert.equal((await store.translation(timed.id,'en')).id,content.id);assert.equal(Number((await store.usage()).jobs),2);
  const restored=await store.documentForRequest(requestKey(recording),'test');assert.equal((await store.existingTranslationJob(restored,'en')).id,r.job.id);
});

test('persisted supplied model requests cannot smuggle Spotify data into outbound retries',async()=>{
  const doc=document();let calls=0;
  const body=requestBody(doc),data=payload(body);data.title=recording.metadata.title;
  const forged={...body,input:[{role:'user',content:JSON.stringify(data)}]};
  await assert.rejects(generate(doc,{apiKey:'fixture',generationRequest:forged,fetchFn:async()=>{calls++;}}),{code:'source_context_unavailable'});
  const study=explanationBody(doc,null,selection),studyData=payload(study);studyData.rawRecording=recording;
  await assert.rejects(generateExplanation(doc,null,selection,{apiKey:'fixture',generationRequest:{...study,input:[{role:'user',content:JSON.stringify(studyData)}]},fetchFn:async()=>{calls++;}}),{code:'source_context_unavailable'});
  await assert.rejects(generate({...doc,sourceCapsule:undefined},{apiKey:'fixture',generationRequest:forged,fetchFn:async()=>{calls++;}}),{code:'source_context_unavailable'});
  assert.equal(calls,0);
});
