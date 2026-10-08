import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB,source} from '../helpers/library-db.js';
import {createSongLibraryService} from '../../api/song-library.js';
import {generateExplanation} from '../../api/utils/song-library/study-explanation.js';
import {digest} from '../../api/utils/song-library/store.js';
import {MembershipStore} from '../../api/utils/membership/store.js';

async function fixture(t,{invalidEvidence=false}={}) {
 const {db,store}=await libraryDB();t.after(()=>db.close());
 const pending=[];let calls=0;
 await db.query("UPDATE library_users SET access_kind='apple' WHERE id='reader-a'");
 const membership=new MembershipStore(store.db);await membership.claimStarter('reader-a');
 const handler=createSongLibraryService({store,selectionRevision:'test',apiKey:'fixture',loadLyrics:async()=>source.response,
  explainFn:(doc,translation,selection,options)=>generateExplanation(doc,translation,selection,{...options,fetchFn:async(_url,request)=>{
   calls++;const body=JSON.parse(request.body);
   assert.equal(body.text.format.name,'study_explanation_grounded_1');
   const row=doc.structure.occurrences.find(o=>o.sourceID===selection.sourceID);
   const content={meaning:'turn into through singing',context:'The speaker makes today into a song.',grammar:'成 expresses the result of singing.',uncertainty:'',sourceQuote:selection.text,
    evidence:['meaning','context','grammar'].map(field=>({field,sourceID:selection.sourceID,layer:'original',sourceQuote:invalidEvidence?'Invented source row':row.sourceText}))};
   return new Response(JSON.stringify({id:'fixture-response',model:body.model,service_tier:body.service_tier,status:'completed',usage:{input_tokens:100,output_tokens:200},
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(content)}]}]}));
  }}),waitUntilFn:p=>pending.push(p),logger:{error(){}}});
 const call=async body=>{
  const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',lyricaUser:await store.authenticate('token-a'),body},res);return res;
 };
 const doc=(await call({action:'lyrics',recording:{catalog_id:'123',artist:'Test artist',title:'Original test song',duration:12}})).body.document;
 const request={action:'explain',documentID:doc.id,sourceHash:doc.sourceHash,contractVersion:2,explanationLanguage:'en',
  studyText:{layer:'original',revisionID:doc.id,occurrenceID:'L0001'},selection:{offsetUnit:'grapheme',ranges:[{lower:3,upper:5}],textHash:digest('唱成')}};
 return {db,store,membership,call,request,drain:()=>Promise.all(pending),calls:()=>calls};
}

test('English v2 admission validates real generator evidence, persists the unchanged public content and reuses it once',async t=>{
 const f=await fixture(t);assert.equal((await f.call({...f.request,allowGeneration:true})).code,202);await f.drain();
 const ready=(await f.call({...f.request,readOnly:true})).body;
 assert.equal(ready.state,'ready');assert.equal(ready.explanation.sourceQuote,'唱成');assert.equal(ready.explanation.recipe,'study-text-1');
 assert.equal(Object.hasOwn(ready.explanation,'evidence'),false);
 assert.equal((await f.call({...f.request,resumeOnly:true})).body.explanation.id,ready.explanation.id);
 assert.equal(f.calls(),1);assert.equal(Number((await f.store.budget()).held),0);
 assert.equal((await f.membership.snapshot('reader-a')).allowances.study.remaining,9);
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM translation_jobs')).rows[0].n),0);
});

test('unusable generated evidence settles provider spend, refunds Study allowance and cannot regenerate through resume',async t=>{
 const f=await fixture(t,{invalidEvidence:true});assert.equal((await f.call({...f.request,allowGeneration:true})).code,202);await f.drain();
 const failed=(await f.call({...f.request,readOnly:true})).body;
 assert.equal(failed.state,'failed');assert.equal(failed.code,'invalid_explanation_evidence');
 assert.equal((await f.membership.snapshot('reader-a')).allowances.study.remaining,10);
 const budget=await f.store.budget();assert.ok(Number(budget.daily)>0);assert.equal(Number(budget.held),0);
 assert.equal((await f.call({...f.request,resumeOnly:true})).body.state,'failed');assert.equal(f.calls(),1);
 assert.equal((await f.db.query('SELECT content FROM study_explanations')).rows[0].content,null);
});
