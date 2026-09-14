import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {libraryDB,source} from '../helpers/library-db.js';
import {SongLibraryStore} from '../../api/utils/song-library/store.js';
import {parseTranslation} from '../../api/utils/song-library/translation.js';
import {migrateLibrary,migrationNames} from '../../scripts/library-migrations.js';

const input={translations:{L0001:'Make a song of today.'},sourceNotes:[]};
const corrected={translations:{L0001:'Turn today into a song.'},sourceNotes:[]};
async function fixture(t) {
  const f=await libraryDB();t.after(()=>f.db.close());await f.store.saveDocument(source);
  const job=await f.store.reserve({userID:'reader-a',documentID:source.id,target:'en',recipe:'fixture',reservedMicros:30_000});
  await f.store.claim(job.job.id);
  await f.store.complete(job.job.id,parseTranslation(JSON.stringify(input),source),1000,{id:'fixture'});
  await f.store.configureReviews({enabled:true,dailyMicros:250_000,monthlyMicros:1_000_000,maxDaily:5});
  return {...f,revisionID:job.job.id};
}
const review=revisionID=>({revisionID,policyVersion:'fixture-v1',assessmentMicros:10_000,verificationMicros:20_000});
const publication=revisionID=>({expectedRevisionID:revisionID,sourceHash:source.sourceHash,
  publicationKey:'correction-fixture',actor:'test-policy',reason:'Preserve the source image.',candidate:corrected});

test('original IDs survive migration, revisions are immutable, and rollback creates a new head',async t=> {
  const {db,store,revisionID}=await fixture(t);
  assert.equal((await store.translation(source.id,'en')).id,revisionID);
  const report={userID:'reader-a',documentID:source.id,translationID:revisionID,sourceID:'L0001',category:'translation',detail:'Check the image.'};
  await store.report(report);
  const revised=await store.publishRevision(publication(revisionID));
  assert.notEqual(revised.id,revisionID);
  assert.equal((await store.translation(source.id,'en')).lines[0].lyricText,corrected.translations.L0001);
  assert.equal((await store.reserve({userID:'reader-b',documentID:source.id,target:'en',recipe:'fixture',reservedMicros:1})).translation.id,revised.id);
  // Old cached versions can still be reported after publication.
  await store.report({...report,detail:'A report from the older app cache.'});
  await store.report({...report,translationID:revised.id});
  await assert.rejects(db.query('UPDATE translation_revisions SET content=$1 WHERE id=$2',['{}',revised.id]));
  await assert.rejects(db.query('DELETE FROM translation_revisions WHERE id=$1',[revised.id]));
  const restored=await store.rollbackRevision({expectedRevisionID:revised.id,restoreRevisionID:revisionID,
    sourceHash:source.sourceHash,publicationKey:'rollback-fixture',actor:'test-operator',reason:'Revert the fixture.'});
  assert.notEqual(restored.id,revisionID);assert.notEqual(restored.id,revised.id);
  assert.equal((await store.translation(source.id,'en')).lines[0].lyricText,input.translations.L0001);
  const history=await store.revisions(source.id,'en');
  assert.deepEqual(history.map(r=>Number(r.sequence)),[3,2,1]);
  assert.equal(history[0].restored_from,revisionID);
  assert.equal(Number((await store.usage()).accounted_micros),1000);
});

test('publication is idempotent, checks its exact base, and rejects conflicting reuse',async t=> {
  const {store,revisionID}=await fixture(t);
  const args=publication(revisionID);
  const results=await Promise.all(Array.from({length:10},()=>store.publishRevision(args)));
  assert.equal(new Set(results.map(r=>r.id)).size,1);
  await assert.rejects(store.publishRevision({...args,candidate:input}),{code:'publication_key_conflict'});
  await assert.rejects(store.publishRevision({...args,publicationKey:'another'}),{code:'translation_revision_superseded'});
  assert.equal((await store.revisions(source.id,'en')).length,2);
});

test('publication rejects source edits, missing occurrences, invented evidence and cross-song rollback',async t=> {
  const {store,revisionID}=await fixture(t);
  await assert.rejects(store.publishRevision({...publication(revisionID),sourceHash:'changed'}),{code:'source_changed'});
  await assert.rejects(store.publishRevision({...publication(revisionID),candidate:{translations:{L9999:'Oops'},sourceNotes:[]}}),{code:'invalid_translation_coverage'});
  await assert.rejects(store.publishRevision({...publication(revisionID),candidate:{...corrected,sourceNotes:[{sourceID:'L0001',sourceQuote:'invented',kind:'ambiguous_reading',explanation:'Untrusted.'}]}}),{code:'invalid_source_evidence'});
  await assert.rejects(store.rollbackRevision({expectedRevisionID:revisionID,restoreRevisionID:randomUUID(),sourceHash:source.sourceHash,
    publicationKey:'invalid-rollback',actor:'test',reason:'Invalid.'}),{code:'invalid_restore_revision'});
  assert.equal((await store.revisions(source.id,'en')).length,1);
});

test('concurrent review reservations coalesce and reserve both Luna stages once',async t=> {
  const {db,store,revisionID}=await fixture(t);
  const results=await Promise.all(Array.from({length:20},()=>store.reserveReview(review(revisionID))));
  assert.equal(results.filter(r=>r.created).length,1);
  assert.equal(new Set(results.map(r=>r.id)).size,1);
  assert.equal(Number((await store.usage()).accounted_micros),31_000);
  assert.equal((await db.query("SELECT count(*) FROM library_spend_operations WHERE kind<>'generation'")).rows[0].count,2);
  // Changing the policy string cannot turn a repeat report into another paid review.
  assert.equal((await store.reserveReview({...review(revisionID),policyVersion:'another-version'})).created,false);
  await assert.rejects(store.reserveReview({...review(revisionID),model:'gpt-6-astra'}),{code:'invalid_review'});
});

test('review and generation compete for the same cap, including old outstanding reservations',async t=> {
  const {db,store,revisionID}=await fixture(t);
  await store.configure({enabled:true,dailyMicros:45_000,monthlyMicros:45_000});
  await store.reserveReview(review(revisionID));
  // A month-old reservation still consumes both the daily and monthly headroom.
  await db.query("UPDATE library_spend_operations SET created_at=now()-interval '40 days' WHERE kind<>'generation'");
  await store.saveDocument({...source,id:'other-doc',requestKey:'other-request'});
  await assert.rejects(store.reserve({userID:'reader-b',documentID:'other-doc',target:'en',recipe:'fixture',reservedMicros:20_000}),{code:'budget_exhausted'});
  const budget=await store.budget();
  assert.equal(Number(budget.daily),31_000);assert.equal(Number(budget.monthly),31_000);
  assert.equal(Number(budget.held),30_000);
});

test('review sublimit refuses the entire two-stage reservation atomically',async t=> {
  const {db,store,revisionID}=await fixture(t);
  await store.configureReviews({enabled:true,dailyMicros:25_000,monthlyMicros:1_000_000,maxDaily:5});
  await assert.rejects(store.reserveReview(review(revisionID)),{code:'review_budget_exhausted'});
  assert.equal((await db.query('SELECT count(*) FROM translation_reviews')).rows[0].count,0);
  assert.equal(Number((await store.usage()).accounted_micros),1000);
  await store.configureReviews({enabled:true,dailyMicros:250_000,monthlyMicros:25_000,maxDaily:5});
  await assert.rejects(store.reserveReview(review(revisionID)),{code:'review_budget_exhausted'});
});

test('review calls can be claimed once; uncertain submissions hold funds and cannot be retried or released',async t=> {
  const {store,revisionID}=await fixture(t);
  const r=await store.reserveReview(review(revisionID));
  const claims=await Promise.all(Array.from({length:10},()=>store.claimReviewOperation(r.assessmentID)));
  assert.equal(claims.filter(Boolean).length,1);
  await store.finishReviewOperation(r.assessmentID,{actualMicros:null,errorCode:'submission_unknown'});
  assert.equal(await store.claimReviewOperation(r.assessmentID),null);
  await assert.rejects(store.releaseReviewOperation(r.assessmentID),{code:'operation_not_releasable'});
  assert.equal(Number((await store.budget()).held),30_000);
  // The unused verification reservation is safe to release before submission.
  await store.releaseReviewOperation(r.verificationID);
  assert.equal(Number((await store.budget()).held),10_000);
});

test('settlement is idempotent and usage belongs to the completion window',async t=> {
  const {db,store,revisionID}=await fixture(t);
  const r=await store.reserveReview(review(revisionID));
  await db.query("UPDATE library_spend_operations SET created_at=now()-interval '40 days' WHERE kind<>'generation'");
  await store.claimReviewOperation(r.assessmentID);
  await store.finishReviewOperation(r.assessmentID,{actualMicros:2500,providerID:'batch-result-1'});
  await store.finishReviewOperation(r.assessmentID,{actualMicros:2500,providerID:'batch-result-1'});
  await assert.rejects(store.finishReviewOperation(r.assessmentID,{actualMicros:0}),{code:'operation_settlement_conflict'});
  await store.releaseReviewOperation(r.verificationID);
  assert.equal(Number((await store.budget()).daily),3500);
  assert.equal(Number((await store.budget()).monthly),3500);
  assert.equal(Number((await store.budget()).held),0);
});

test('unexpected review cost records the full charge and pauses all new paid work',async t=> {
  const {db,store,revisionID}=await fixture(t);
  const r=await store.reserveReview(review(revisionID));await store.claimReviewOperation(r.assessmentID);
  await store.finishReviewOperation(r.assessmentID,{actualMicros:10_001,providerID:'overage'});
  assert.equal((await db.query('SELECT enabled FROM library_settings')).rows[0].enabled,false);
  assert.equal(Number((await store.usage()).accounted_micros),31_001);
});

test('migration backfills legacy records, tolerates reruns and captures writes from the old deployed worker',async t=> {
  const db=new PGlite();t.after(()=>db.close());
  const sql=async name=>readFile(new URL(`../../db/${name}`,import.meta.url),'utf8');
  await db.exec(await sql('001-song-library.sql'));
  await db.query("INSERT INTO library_users(id) VALUES('legacy')");
  await db.query('INSERT INTO lyric_documents(id,recording_key,source_hash,selection_revision,response,structure) VALUES($1,$2,$3,$4,$5,$6)',
    [source.id,source.recordingKey,source.sourceHash,source.selectionRevision,JSON.stringify(source.response),JSON.stringify(source.structure)]);
  const id=randomUUID();
  await db.query("INSERT INTO translation_jobs(id,document_id,target,recipe,user_id,state,reserved_micros,accounted_micros,created_at) VALUES($1,$2,'en','legacy','legacy','running',30000,30000,now()-interval '40 days')",[id,source.id]);
  await db.exec(await sql('003-correction-foundation.sql'));
  const store=new SongLibraryStore({query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn)});
  assert.equal(Number((await store.budget()).daily),30_000);
  // This is the original worker's SQL, after migration but before the new deployment.
  await db.query("INSERT INTO song_translations(id,document_id,target,recipe,content) VALUES($1,$2,'en','legacy',$3)",[id,source.id,JSON.stringify(parseTranslation(JSON.stringify(input),source))]);
  await db.query("UPDATE translation_jobs SET state='ready',accounted_micros=1500,provider_response=$2,finished_at=now() WHERE id=$1",[id,JSON.stringify({usage:{input_tokens:1000,output_tokens:1000}})]);
  await db.exec(await sql('003-correction-foundation.sql'));
  assert.equal((await store.translation(source.id,'en')).id,id);
  assert.equal((await store.revisions(source.id,'en')).length,1);
  assert.equal(Number((await store.budget()).daily),1500);
  assert.equal(Number((await store.budget()).held),0);
  assert.equal((await db.query('SELECT review_enabled FROM library_settings')).rows[0].review_enabled,false);
});

test('the migration runner records checksums, reruns safely, and fails closed on altered history',async t=> {
  const db=new PGlite();t.after(()=>db.close());
  const adapt=client=>({query:(sql,args)=>args?client.query(sql,args):client.exec(sql).then(r=>r.at(-1)),
    transaction:fn=>db.transaction(client=>fn(adapt(client)))});
  const database=adapt(db);
  assert.deepEqual(await migrateLibrary(database),migrationNames);
  assert.deepEqual(await migrateLibrary(database),[]);
  await db.query("UPDATE library_schema_migrations SET sha256='changed' WHERE name='003-correction-foundation.sql'");
  await assert.rejects(migrateLibrary(database),{code:'migration_changed'});
});

test('review daily allowance, disable switch and stale revision checks fail before reserving money',async t=> {
  const {db,store,revisionID}=await fixture(t);
  await store.configureReviews({enabled:false,dailyMicros:250_000,monthlyMicros:1_000_000,maxDaily:5});
  await assert.rejects(store.reserveReview(review(revisionID)),{code:'review_disabled'});
  await store.configureReviews({enabled:true,dailyMicros:250_000,monthlyMicros:1_000_000,maxDaily:0});
  await assert.rejects(store.reserveReview(review(revisionID)),{code:'review_allowance_exhausted'});
  await store.configureReviews({enabled:true,dailyMicros:250_000,monthlyMicros:1_000_000,maxDaily:5});
  const changed=await store.publishRevision(publication(revisionID));
  await assert.rejects(store.reserveReview(review(revisionID)),{code:'translation_revision_superseded'});
  const r=await store.reserveReview(review(changed.id));
  await db.query('UPDATE library_settings SET enabled=false');
  assert.equal(await store.claimReviewOperation(r.assessmentID),null);
  assert.equal(Number((await store.budget()).held),30_000);
});

test('database admission also stops an older worker whose JS ignores review spending',async t=> {
  const {db,store,revisionID}=await fixture(t);
  await store.configure({enabled:true,dailyMicros:45_000,monthlyMicros:45_000});
  await store.reserveReview(review(revisionID));
  await store.saveDocument({...source,id:'old-worker-doc',requestKey:'old-worker-request'});
  await assert.rejects(db.query(`INSERT INTO translation_jobs(id,document_id,target,recipe,user_id,state,reserved_micros,accounted_micros)
    VALUES($1,'old-worker-doc','en','legacy','reader-b','queued',20000,20000)`,[randomUUID()]),/budget_exhausted/);
  assert.equal(Number((await store.budget()).daily),31_000);
});
