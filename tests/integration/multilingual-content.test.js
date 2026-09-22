import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {validateSchema} from '../contracts/schema-validator.js';
const responseSchema=JSON.parse(await readFile(new URL('../../contracts/song-library.schema.json',import.meta.url),'utf8'));
const requestSchema=JSON.parse(await readFile(new URL('../../contracts/study-v2-request.schema.json',import.meta.url),'utf8'));
import assert from 'node:assert/strict';
import {libraryDB,source} from '../helpers/library-db.js';
import {createSongLibraryHandler} from '../../api/song-library.js';
import {languagePolicy} from '../../api/utils/song-library/languages.js';
import {digest} from '../../api/utils/song-library/store.js';
import {LEGACY_RECIPE} from '../../api/utils/song-library/translation.js';
import {reviewContext} from '../../api/utils/song-library/review-context.js';

async function fixture(t,{sourceLanguage='zh',policy=languagePolicy({translation:['*:en','zh:fr','en:zh-Hans'],explanation:['*:en','zh:fr','zh-Hans:fr']})}={}) {
 const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[],translations=[],explanations=[];
 const response=structuredClone(source.response);response.song.language=sourceLanguage;
 if(sourceLanguage==='en'){response.lines[0].original='Sing today together.';response.lines[0].romanized='';}
 const options={store,languagePolicy:policy,selectionRevision:'multilingual',apiKey:'test',loadLyrics:async()=>response,
  generateFn:async(doc,options)=>{translations.push(options);const text={en:'Sing today together.',fr:"Chantons ensemble aujourd’hui.",'zh-Hans':'今天一起唱'}[options.target];
   return {content:{lines:[{sourceID:'L0001',lyricText:text,text,speakerID:null,startsTurn:false}],sourceNotes:[]},actualMicros:1000,response:{id:'test'}};},
  explainFn:async(doc,translation,selection,options)=>{explanations.push({selection,translation,options});return {content:{meaning:'A phrase',context:'In this song',grammar:'',uncertainty:'',sourceQuote:selection.text},actualMicros:500,response:{id:'test'}};},
  waitUntilFn:p=>pending.push(p),logger:{error(...x){throw new Error(JSON.stringify(x));}}};
 const caller=handler=>async body=>{const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',headers:{authorization:'Bearer token-a'},body},res);assert.deepEqual(validateSchema(responseSchema,res.body),[],JSON.stringify(res.body));return res;};
 const call=caller(createSongLibraryHandler(options));
 const {body:{document:doc}}=await call({action:'lyrics',recording:{catalog_id:'123',artist:'Test artist',title:'Original test song',duration:12}});
 const base={documentID:doc.id,sourceHash:doc.sourceHash};
 const drain=()=>Promise.all(pending);
 const translate=async target=>{const first=await call({...base,action:'translate',target});assert.equal(first.code,202,JSON.stringify(first.body));await drain();return (await call({...base,action:'translate',target})).body.translation;};
 const study=(text,{layer='original',revisionID=doc.id,target,language='en',lower=0,upper=2}={})=>({...base,action:'explain',contractVersion:2,
  studyText:{layer,revisionID,occurrenceID:'L0001',...(target?{target}:{})},selection:{offsetUnit:'grapheme',ranges:[{lower,upper}],textHash:digest(text)},explanationLanguage:language});
 return {db,store,doc,base,call,translate,study,drain,translations,explanations,instance:patch=>caller(createSongLibraryHandler({...options,...patch}))};
}

test('target jobs, current checks, revision publication, rollback and reporting remain isolated',async t=>{
 const f=await fixture(t);const english=await f.translate('en'),french=await f.translate('fr-CA');
 assert.notEqual(english.id,french.id);assert.equal(french.target,'fr');assert.equal(french.notesLanguage,'fr');
 assert.equal(french.documentID,f.doc.id);assert.equal(french.sourceHash,f.doc.sourceHash);
 assert.equal((await f.call({...f.base,action:'current',target:'fr',revisionID:english.id})).body.state,'ready');
 assert.equal((await f.call({...f.base,action:'current',target:'fr',revisionID:french.id})).body.state,'unchanged');
 const changed=await f.store.publishRevision({expectedRevisionID:french.id,sourceHash:f.doc.sourceHash,publicationKey:'fr-revision',actor:'test',reason:'Fixture correction',candidate:{translations:{L0001:'Faisons une chanson de ce jour.'},sourceNotes:[]}});
 assert.equal((await f.store.translation(f.doc.id,'en')).id,english.id);assert.equal((await f.store.translation(f.doc.id,'fr')).id,changed.id);
 const report=await f.call({...f.base,action:'report',sourceHash:undefined,translationID:changed.id,sourceID:'L0001',category:'translation',detail:'Check the French.'});
 // Send only fields permitted by the report contract.
 assert.equal(report.code,400);
 assert.equal((await f.call({action:'report',documentID:f.doc.id,translationID:changed.id,sourceID:'L0001',category:'translation',detail:'Check the French.'})).code,200);
 await assert.rejects(reviewContext(f.db,changed.id),{code:'review_context_unavailable'});
 await f.store.rollbackRevision({expectedRevisionID:changed.id,restoreRevisionID:french.id,sourceHash:f.doc.sourceHash,publicationKey:'fr-rollback',actor:'test',reason:'Fixture rollback'});
 assert.equal((await f.store.translation(f.doc.id,'fr')).lines[0].lyricText,french.lines[0].lyricText);
 const disabled=f.instance({languagePolicy:languagePolicy(),apiKey:null});
 assert.equal((await disabled({...f.base,action:'translate',target:'fr'})).body.translation.target,'fr');
 assert.equal(f.translations.length,2);
});

test('disabled directions, invalid targets and shared allowances cannot dispatch new paid work',async t=>{
 const f=await fixture(t,{policy:languagePolicy()});
 assert.equal((await f.call({...f.base,action:'translate',target:'fr'})).body.code,'unsupported_direction');
 assert.equal((await f.call({...f.base,action:'translate',target:'zh'})).body.code,'unsupported_target');
 assert.deepEqual((await f.call({action:'capabilities'})).body.capabilities.translationDirections,['*:en']);
 assert.equal(f.translations.length,0);assert.equal(Number((await f.store.budget()).held),0);
 await f.translate('en');await f.store.configure({enabled:true,dailyMicros:1000000,monthlyMicros:5000000,userDaily:1,userMonthly:1});
 const enabled=f.instance({languagePolicy:languagePolicy({translation:['*:en','zh:fr']})});
 assert.equal((await enabled({...f.base,action:'translate',target:'fr'})).body.code,'generation_allowance_exhausted');
 assert.equal(f.translations.length,1);
});

test('a resumed job executes its admitted request across handler deployments',async t=>{
 const f=await fixture(t);const pinned={model:'gpt-5.6-luna',service_tier:'default',max_output_tokens:123,instructions:'frozen French recipe',input:[]};
 const admitted=await f.store.reserve({userID:'reader-a',documentID:f.doc.id,target:'fr',recipe:'older-multilingual',reservedMicros:40000,generationRequest:pinned});
 await f.call({...f.base,action:'translate',target:'fr'});await f.drain();
 assert.equal(f.translations.length,1);assert.deepEqual(f.translations[0].generationRequest,pinned);
 assert.equal((await f.call({action:'status',jobID:admitted.job.id})).body.translation.target,'fr');
});

test('legacy queued English jobs and legacy request defaults survive the migration',async t=>{
 const f=await fixture(t);
 await f.store.reserve({userID:'reader-a',documentID:f.doc.id,target:'en',recipe:LEGACY_RECIPE,reservedMicros:40000});
 await f.call({...f.base,action:'translate'});await f.drain();
 assert.equal(f.translations[0].target,'en');assert.match(f.translations[0].generationRequest.instructions,/idiomatic English/);
 assert.equal((await f.call({...f.base,action:'translate'})).body.translation.target,'en');
});

test('source-only Study generates no translation, and explanation languages have independent cache entries',async t=>{
 const f=await fixture(t);const english=f.study('把今'),french=f.study('把今',{language:'fr'});
 assert.equal((await f.call(english)).code,202);await f.drain();
 assert.equal((await f.call(french)).code,202);await f.drain();
 const en=(await f.call(english)).body.explanation,fr=(await f.call(french)).body.explanation;
 assert.equal(en.translationID,null);assert.equal(en.contractVersion,2);assert.equal(fr.explanationLanguage,'fr');assert.notEqual(en.id,fr.id);
 assert.equal(f.translations.length,0);assert.equal(f.explanations.length,2);
 assert.match(f.explanations[1].options.generationRequest.instructions,/natural French/);
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM translation_jobs')).rows[0].n),0);
});

test('English to Chinese translated-text Study binds exact text and invalidates stale revisions',async t=>{
 const f=await fixture(t,{sourceLanguage:'en'}),translation=await f.translate('zh-Hans');
 const request=f.study('一起',{layer:'translation',revisionID:translation.id,target:'zh-Hans',lower:2,upper:4});
 assert.deepEqual(validateSchema(requestSchema,request),[]);
 assert.equal((await f.call(request)).code,202);await f.drain();
 const ready=(await f.call(request)).body.explanation;
 assert.equal(ready.sourceQuote,'一起');assert.equal(ready.studyText.layer,'translation');assert.equal(ready.explanationLanguage,'en');
 assert.match(f.explanations[0].options.generationRequest.instructions,/Do not imply translated words are sung/);
 await f.store.publishRevision({expectedRevisionID:translation.id,sourceHash:f.doc.sourceHash,publicationKey:'chinese-correction',actor:'test',reason:'Fixture change',candidate:{translations:{L0001:'今天共同歌唱'},sourceNotes:[]}});
 assert.equal((await f.call(request)).body.code,'translation_revision_superseded');
 assert.equal(f.explanations.length,1);assert.equal(f.translations.length,1);
});

test('source Study context is optional but every supplied context revision is fenced',async t=>{
 const f=await fixture(t),translation=await f.translate('fr');
 const request={...f.study('把今'),contextTranslation:{target:'fr',revisionID:translation.id}};
 assert.equal((await f.call(request)).code,202);await f.drain();
 assert.equal((await f.call(request)).body.explanation.translationID,translation.id);
 await f.store.publishRevision({expectedRevisionID:translation.id,sourceHash:f.doc.sourceHash,publicationKey:'context-change',actor:'test',reason:'Fixture change',candidate:{translations:{L0001:'Chante ce jour.'},sourceNotes:[]}});
 assert.equal((await f.call(request)).body.code,'translation_revision_superseded');
 for(const patch of [{selection:{...request.selection,textHash:digest('wrong')}},{translationID:translation.id},{studyText:{...request.studyText,revisionID:'old'}}]){
  const invalid={...f.study('把今'),...patch};assert.notEqual((await f.call(invalid)).code,202);
 }
 assert.equal(f.explanations.length,1);
});

test('migration preserves legacy explanation IDs and permits old worker inserts',async t=>{
 const {PGlite}=await import('@electric-sql/pglite');const {randomUUID}=await import('node:crypto');
 const db=new PGlite();t.after(()=>db.close());
 for(const name of ['001-song-library.sql','003-correction-foundation.sql','005-correction-batches.sql','007-correction-publication.sql','009-study-explanations.sql'])
  await db.exec(await readFile(new URL(`../../db/${name}`,import.meta.url),'utf8'));
 await db.query("INSERT INTO library_users(id) VALUES('legacy')");
 await db.query('INSERT INTO lyric_documents(id,recording_key,source_hash,selection_revision,response,structure) VALUES($1,$2,$3,$4,$5,$6)',
  [source.id,source.recordingKey,source.sourceHash,source.selectionRevision,JSON.stringify(source.response),JSON.stringify(source.structure)]);
 const translationID=randomUUID(),explanationID=randomUUID();
 await db.query("INSERT INTO translation_jobs(id,document_id,target,recipe,user_id,state,reserved_micros,accounted_micros) VALUES($1,$2,'en','legacy','legacy','ready',1000,1000)",[translationID,source.id]);
 await db.query("INSERT INTO song_translations(id,document_id,target,recipe,content) VALUES($1,$2,'en','legacy',$3)",[translationID,source.id,JSON.stringify({lines:[],sourceNotes:[]})]);
 const oldInsert="INSERT INTO study_explanations(id,cache_key,document_id,revision_id,source_id,lower_offset,upper_offset,recipe,user_id,state,content) VALUES($1,$2,$3,$4,'L0001',0,2,'study-occurrence-2','legacy','ready',$5)";
 const content={meaning:'Existing explanation',context:'Existing context',grammar:'',uncertainty:'',sourceQuote:'把今'};
 await db.query(oldInsert,[explanationID,'old-key',source.id,translationID,JSON.stringify(content)]);
 await db.exec(await readFile(new URL('../../db/012-multilingual-content.sql',import.meta.url),'utf8'));
 const row=(await db.query('SELECT * FROM study_explanations WHERE id=$1',[explanationID])).rows[0];
 assert.equal(row.id,explanationID);assert.equal(row.explanation_language,'en');assert.equal(row.contract_version,1);assert.deepEqual(row.content,content);
 await db.query(oldInsert,[randomUUID(),'old-worker-after-migration',source.id,translationID,JSON.stringify(content)]);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM study_explanations')).rows[0].n),2);
});

test('bad v2 identity and disjoint or client-authored selections cannot reserve money',async t=>{
 const f=await fixture(t);const valid=f.study('把今');
 for(const patch of [
  {explanationLanguage:undefined},{studyText:{...valid.studyText,extra:'data'}},
  {selection:{...valid.selection,ranges:[{lower:0,upper:1},{lower:2,upper:3}]}},
  {selection:{...valid.selection,offsetUnit:'utf16'}},{selection:{...valid.selection,text:'replacement'}},
  {selection:{...valid.selection,ranges:[{lower:0.5,upper:2}]}},
  {contextTranslation:{target:'fr',revisionID:'unknown'}},
  {studyText:{layer:'translation',revisionID:'unknown',occurrenceID:'L0001',target:'fr'}}
 ])assert.ok((await f.call({...valid,...patch})).code>=400);
 assert.equal(f.explanations.length,0);assert.equal(Number((await f.store.budget()).held),0);
});
