import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {libraryDB} from '../helpers/library-db.js';
import {readingInputs,readingBundle} from '../helpers/prepared-reading-edition.js';
import {allDirections} from '../helpers/prepared-edition.js';
import {PreparedEditionStore} from '../../api/utils/prepared-editions/store.js';
import {artifact,editionIdentity,validateBundle} from '../../api/utils/prepared-editions/core.js';
import {prepareAcquiredReadingAids,nativeExporterInput,stagePlan,executeStage,finishTranslations,finishEdition} from '../../api/utils/prepared-editions/preparation.js';
import {inspectorManifest} from '../../api/utils/prepared-editions/compiler.js';
import {preparedRequest} from '../../api/utils/prepared-editions/service.js';
import {digest} from '../../api/utils/song-library/store.js';
const exec=promisify(execFile);
async function setup(t){const {db,store}=await libraryDB();t.after(()=>db.close());await db.exec(await readFile(new URL('../../db/041-prepared-editions.sql',import.meta.url),'utf8'));return {db,database:store.db,store:new PreparedEditionStore(store.db)};}
const review=stage=>({reviewer:'test',reference:'synthetic-only',planID:stage.plan.id,currency:'USD',retryAllowance:0,ceilingMicros:1000000,...(stage.manifest?{nativeManifestHash:artifact('manifest',stage.manifest).id}:{})});
test('synthetic JA/KO offline pipelines retain source-bound aids through operator/native export and authenticated artifact projection',async t=>{
 const {db,database,store}=await setup(t),dir=await mkdtemp(join(tmpdir(),'prepared-readings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let head=null;
 for(const language of ['ja','ko']){
  const f=await readingInputs(language),raw=structuredClone(f.doc);delete raw.preparedReadingAids;
  const acquired=await prepareAcquiredReadingAids({doc:raw,spec:f.spec,acquisitionHash:digest(language)});
  const translationStage=stagePlan(acquired,{stage:'translations',policy:allDirections});assert.equal(translationStage.documentArtifactID,artifact('document',(await nativeExporterInput(acquired,f.translations)).document).id);
  const translated=await executeStage(acquired,translationStage,{path:join(dir,language+'-translations.json'),review:review(translationStage),database,apiKey:'synthetic',policy:allDirections,generateTranslation:async(doc,{target})=>({content:{lines:f.translations[target].lines,sourceNotes:[]},actualMicros:0})});
  const translations=finishTranslations(acquired,translationStage,translated),input=await nativeExporterInput(acquired,translations);
  assert.deepEqual(input.document.preparedReadingAids,acquired.doc.preparedReadingAids);
  const {rows,...manifest}=inspectorManifest(acquired.doc,translations),study=stagePlan(acquired,{stage:'study',translations,rows:JSON.parse(JSON.stringify(manifest)),policy:allDirections});
  const completed=await executeStage(acquired,study,{path:join(dir,language+'-study.json'),review:review(study),database,apiKey:'synthetic',policy:allDirections,translations,
   generateBatch:async(doc,t,selections)=>({content:{items:selections.map(s=>({id:s.id,meaning:'Synthetic help.',context:'Original synthetic sentence.',sourceQuote:s.text,uncertainty:'',grammar:''}))},actualMicros:0}),
   generateSingleton:async(doc,t,s)=>({content:{meaning:'Synthetic help.',context:'Original synthetic sentence.',sourceQuote:s.text,uncertainty:'',grammar:''},actualMicros:0})});
  const b=finishEdition(acquired,study,completed,translations),published=await store.publish(b,{expectedHead:head});head=published.generation;
  const a=b.artifacts.find(a=>a.kind==='document'),reply=await preparedRequest({action:'prepared_artifact',editionID:b.editionID,generation:published.generation,use:'read',artifactID:a.id},{store});
  assert.deepEqual(reply.artifact.content.preparedReadingAids,input.document.preparedReadingAids);
  for(const name of ['acquired','translations'])await writeFile(join(dir,language+'-'+name+'.json'),JSON.stringify(name==='acquired'?acquired:translations));
  const cli=JSON.parse((await exec(process.execPath,['scripts/prepared-editions.mjs','native-input','--input',join(dir,language+'-acquired.json'),'--translations',join(dir,language+'-translations.json')],{maxBuffer:10000000})).stdout);
  assert.deepEqual(cli,input);
 }
 assert.equal(Number((await db.query('SELECT sum(accounted_micros) AS n FROM prepared_generation_runs')).rows[0].n),0);
 for(const table of ['membership_usage','membership_grants','library_spend_operations'])assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
});
test('JA/KO publication fails closed without aids or on forged deterministic output; aid changes alter document artifact identity',async t=>{
 const {store,database}=await setup(t);
 for(const language of ['ja','ko']){
  const b=await readingBundle(language);validateBundle(b);
  const doc=b.artifacts.find(a=>a.kind==='document'),missing=structuredClone(b),i=missing.artifacts.findIndex(a=>a.kind==='document');delete missing.artifacts[i].content.preparedReadingAids;
  missing.artifacts[i]=artifact('document',missing.artifacts[i].content);missing.coverage.requiredArtifactIDs=missing.artifacts.map(a=>a.id);missing.editionID=editionIdentity(missing);
  assert.notEqual(missing.artifacts[i].id,doc.id);assert.throws(()=>validateBundle(missing),/invalid_publication/);
  const raw={doc:missing.artifacts[i].content,spec:b.spec,acquisitionHash:digest('missing')};assert.throws(()=>stagePlan(raw,{stage:'translations',policy:allDirections}),/prepared_reading_aids_required/);
 }
 const b=await readingBundle('ko'),i=b.artifacts.findIndex(a=>a.kind==='document'),aid=b.artifacts[i].content.preparedReadingAids['ko-revised'],line=aid.lines[0];
 line.segments[0].aid='wrong';line.text=line.segments.map(s=>s.aid??s.source).join('');
 b.artifacts[i]=artifact('document',b.artifacts[i].content);b.coverage.requiredArtifactIDs=b.artifacts.map(a=>a.id);b.editionID=editionIdentity(b);validateBundle(b);
 await assert.rejects(store.publish(b),/prepared_reading_aids_changed/);
 assert.equal((await database.query('SELECT count(*)::int AS n FROM prepared_editions')).rows[0].n,0);
});
