import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB,source} from '../helpers/library-db.js';
import {translationIdentity,legacySourceCandidates} from '../../api/utils/song-library/translation-identity.js';
import {repairTranslationReuse} from '../../scripts/repair-translation-reuse.js';
import {parseTranslation} from '../../api/utils/song-library/translation.js';
import {reviewContext} from '../../api/utils/song-library/review-context.js';
import {reserveExplanation} from '../../api/utils/song-library/study-store.js';
import {digest} from '../../api/utils/song-library/store.js';

const request={userID:'reader-a',documentID:source.id,target:'en',recipe:'fixture',reservedMicros:30_000};
const candidate={translations:{L0001:'Make a song of today.'},sourceNotes:[]};
async function fixture(t){const f=await libraryDB();t.after(()=>f.db.close());await f.store.saveDocument(source);return f;}
async function ready(store){const r=await store.reserve(request);await store.claim(r.job.id);await store.complete(r.job.id,parseTranslation(JSON.stringify(candidate),source),1000,{});return r.job.id;}
function alias(){const doc=structuredClone(source);doc.id='timing-storefront-alias';doc.requestKey='alias';doc.recordingKey='ca-recording';doc.sourceHash='new-timing-hash';doc.response.lines[0].timestamp=42;doc.response.lines[0].romanized='updated reading';doc.structure.version='future-normalizer';return doc;}

test('timing, reading, normalization and storefront changes reuse the same revision without spending',async t=>{
 const {db,store}=await fixture(t);const id=await ready(store),doc=alias();await store.saveDocument(doc);
 await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
 const saved=await store.translation(doc.id,'en');assert.equal(saved.id,id);assert.equal(saved.documentID,doc.id);assert.equal(saved.sourceHash,doc.sourceHash);
 assert.equal((await store.reserve({...request,documentID:doc.id,userID:'reader-b'})).kind,'ready');
 assert.equal(Number((await store.usage()).jobs),1);assert.equal(Number((await store.usage()).accounted_micros),1000);
 assert.equal((await store.document(doc.id)).response.lines[0].timestamp,42);
 assert.equal((await db.query('SELECT count(*) AS n FROM translation_reuse_events')).rows[0].n,1);
});
test('verified catalog evidence bridges translated names without timing or reading identity',async t=>{
 const {store,db}=await fixture(t),id=await ready(store);
 const recordingKey=digest({catalogID:'123',storefront:'hk'});
 await db.query('UPDATE lyric_documents SET recording_key=$2 WHERE id=$1',[source.id,recordingKey]);
 const doc=alias();doc.canonicalRecordingID='apple:123';doc.textRevision='text';doc.timingRevision='clock';doc.readingRevision='reading';
 doc.response.song.title.original='Localized title';
 doc.response.metadata.catalog_resolution={canonical_context:{title:'International title',artist:'International artist'},
  catalog_items:[{catalog_id:'123',storefront:'hk'}]};
 await store.saveDocument(doc);
 await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
 assert.equal((await store.translation(doc.id,'en')).id,id);
 assert.equal((await store.reserve({...request,documentID:doc.id})).kind,'ready');
 assert.equal(Number((await store.usage()).jobs),1);
 const changed=structuredClone(doc);changed.id='changed-source';changed.requestKey='changed-source';changed.structure.occurrences[0].sourceText+='改';
 await store.saveDocument(changed);assert.equal(await store.translation(changed.id,'en'),null);
});
test('changed lyrics, repeated occurrence order, speaker turns, language and song context never share an identity',()=>{
 const identity=translationIdentity(source);
 for(const change of [d=>d.structure.occurrences[0].sourceText+='啊',d=>d.structure.occurrences.push({...d.structure.occurrences[0],sourceID:'L0002'}),d=>d.structure.occurrences[0].startsTurn=true,d=>d.response.song.language='ja',d=>d.response.song.artist.original='Different artist',d=>d.response.song.title.original='Different title']){
  const d=structuredClone(source);change(d);assert.notEqual(translationIdentity(d),identity);
 }
 const two=structuredClone(source);two.structure.occurrences.push({...two.structure.occurrences[0],sourceID:'L0002',sourceText:'明天'});
 assert.notEqual(translationIdentity(two),translationIdentity({...two,structure:{...two.structure,occurrences:[...two.structure.occurrences].reverse()}}));
});
test('concurrent storefront aliases share one provider claim but keep client document and job identities',async t=>{
 const {store}=await fixture(t);const doc=alias();await store.saveDocument(doc);
 const results=await Promise.all([store.reserve(request),store.reserve({...request,documentID:doc.id,userID:'reader-b'})]);
 assert.equal(results.filter(r=>r.kind==='created').length,1);assert.notEqual(results[0].job.id,results[1].job.id);
 assert.equal(results[1].job.documentID,doc.id);
 const claims=await Promise.all(results.map(r=>store.claim(r.job.id)));assert.equal(claims.filter(Boolean).length,1);
 const claimed=claims.find(Boolean);await store.complete(claimed.id,parseTranslation(JSON.stringify(candidate),source),1000,{});
 assert.equal((await store.job(results[1].job.id)).state,'ready');assert.equal((await store.job(results[1].job.id)).documentID,doc.id);
 assert.equal((await store.translation(doc.id,'en')).id,claimed.id);assert.equal(Number((await store.usage()).jobs),1);
});
test('reuse retains correction heads, report validation and translated Study admission',async t=>{
 const {db,store}=await fixture(t);const id=await ready(store),doc=alias();await store.saveDocument(doc);await store.translation(doc.id,'en');
 const published=await store.publishRevision({expectedRevisionID:id,sourceHash:source.sourceHash,publicationKey:'correction',actor:'test',reason:'Improve wording',candidate:{...candidate,translations:{L0001:'Sing today into a song.'}}});
 assert.equal((await store.translation(doc.id,'en')).id,published.id);assert.equal((await store.revisions(doc.id,'en')).length,2);
 await store.report({userID:'reader-b',documentID:doc.id,translationID:published.id,sourceID:'L0001',category:'translation',detail:'Review this wording.'});
 const result=await reserveExplanation(db,{key:'alias-study',doc,translation:await store.translation(doc.id,'en'),selection:{sourceID:'L0001',lower:0,upper:1},recipe:'fixture',userID:'reader-b',amount:100});
 assert.equal(result.created,true);
});
test('retired translations require a cryptographically verified unchanged source and remain reviewable',async t=>{
 const {db,store}=await fixture(t),next=alias();next.recordingKey=source.recordingKey;
 const proof=legacySourceCandidates(next)[0];
 const old={...source,id:'legacy',requestKey:'legacy-request',sourceHash:proof.hash,response:next.response,structure:proof.source.structure};await store.saveDocument(old);
 const oldJob=await store.reserve({...request,documentID:old.id});await store.claim(oldJob.job.id);await store.complete(oldJob.job.id,parseTranslation(JSON.stringify(candidate),old),500,{});
 await store.saveDocument(next);await db.query('UPDATE lyric_documents SET superseded_by=$2,response=$3,structure=$3,translation_identity=NULL WHERE id=$1',[old.id,next.id,JSON.stringify({retired:true,replacement_id:next.id})]);
 const preview=await repairTranslationReuse(db,{dryRun:true});assert.equal(preview.recovered,1);assert.equal(await store.translation(next.id,'en'),null);
 const repaired=await repairTranslationReuse(db);assert.equal(repaired.recovered,1);assert.equal((await store.translation(next.id,'en')).id,oldJob.job.id);
 assert.equal((await repairTranslationReuse(db)).recovered,1);
 const context=await reviewContext(db,oldJob.job.id);assert.equal(context.doc.structure.occurrences[0].sourceText,source.structure.occurrences[0].sourceText);assert.equal(context.doc.response.song.title.original,source.response.song.title.original);
 const published=await store.publishRevision({expectedRevisionID:oldJob.job.id,sourceHash:proof.hash,publicationKey:'legacy-correction',actor:'test',reason:'Improve wording',candidate:{...candidate,translations:{L0001:'Sing today into a song.'}}});
 assert.equal((await store.translation(next.id,'en')).id,published.id);
 // A later retirement follows the same physical recording's verified lineage.
 const newest={...next,id:'newest',requestKey:'newest'};await store.saveDocument(newest);
 await db.query('UPDATE lyric_documents SET superseded_by=$2 WHERE id=$1',[next.id,newest.id]);
 assert.equal((await repairTranslationReuse(db)).recovered,1);assert.equal((await store.translation(newest.id,'en')).id,published.id);
});
test('unproven retired source hashes never attach a translation',async t=>{
 const {db,store}=await fixture(t);await ready(store);const next=alias();next.recordingKey=source.recordingKey;await store.saveDocument(next);
 await db.query('UPDATE lyric_documents SET superseded_by=$2,response=$3,structure=$3,translation_identity=NULL WHERE id=$1',[source.id,next.id,JSON.stringify({retired:true,replacement_id:next.id})]);
 const result=await repairTranslationReuse(db);assert.equal(result.recovered,0);assert.equal(result.deferred[0].reason,'source_equivalence_unproven');assert.equal(await store.translation(next.id,'en'),null);
});
