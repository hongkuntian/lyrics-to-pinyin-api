import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {libraryDB,source} from '../helpers/library-db.js';
import {SongLibraryStore} from '../../api/utils/song-library/store.js';
import {makeSelectedDocument,selectedTextHash,validateSelectedDocument,SELECTED_SOURCE_REVISION} from '../../api/utils/song-library/selected-source.js';
import {reserveExplanation,claimExplanation,finishExplanation} from '../../api/utils/song-library/study-store.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {appleTimingRequest} from '../../api/utils/song-library/apple-vocal-timing.js';

async function selected({itemID='123',timestamp=3,text='Sing the exact source words.'}={}) {
  const lines=[{text,timestamp}];
  return makeSelectedDocument({provider:'lrclib',itemID,title:'Source title',artist:'Source artist',album:'Source album',duration:180,lines},
    {provider:'lrclib',itemID,expectedTextHash:selectedTextHash(lines)},
    {analyzeLanguageFn:()=>({primary:'en',pronunciation_language:null})});
}
async function fixture(t) {
  const f=await libraryDB();t.after(()=>f.db.close());
  const doc=await selected();await f.store.saveSelectedDocument(doc,'reader-a');return {...f,doc};
}
const request=(doc,extra={})=>({userID:'reader-a',documentID:doc.id,target:'en',recipe:'fixture',reservedMicros:30000,...extra});
const study=(doc,extra={})=>({key:`study:${doc.id}`,doc,translation:null,selection:{sourceID:'L0001',lower:0,upper:4},recipe:'fixture',userID:'reader-a',amount:1000,...extra});
async function ready(store,doc) {
  const result=await store.reserve(request(doc,{allowGeneration:true}));await store.claim(result.job.id);
  await store.complete(result.job.id,{lines:[{sourceID:'L0001',lyricText:doc.response.lines[0].original,text:'Saved meaning.',speakerID:null,startsTurn:false}],sourceNotes:[],rejectedNotes:[]},1000,{});
  return result.job.id;
}
const unavailable={code:'selected_source_unavailable',status:404};

test('selected saves are immutable, idempotent and create no recording or automatic request mappings',async t=>{
  const {db,store,doc}=await fixture(t);
  const saved=await store.saveSelectedDocument({...doc,response:{...doc.response,metadata:{...doc.response.metadata,timestamp:'later'}}},'reader-a');
  assert.equal(saved.id,doc.id);assert.deepEqual(validateSelectedDocument(saved),doc.modelContext);
  assert.deepEqual((await store.document(doc.id)).selectedSource,doc.selectedSource);
  assert.deepEqual((await store.document(doc.id)).selectedSourceCapsule,doc.selectedSourceCapsule);
  assert.equal(appleTimingRequest(saved),undefined);
  assert.equal(saved.sourceCapsule,undefined);assert.equal(saved.requestKey,undefined);assert.equal(saved.recordingBinding,undefined);
  assert.notEqual(saved.response.metadata.timestamp,'later');
  for(const table of ['lyric_documents','selected_source_access'])assert.equal((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,1);
  for(const table of ['lyric_requests','recording_lyric_heads','catalog_recording_bindings'])assert.equal((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,0);
  const row=(await db.query('SELECT * FROM lyric_documents WHERE id=$1',[doc.id])).rows[0];
  assert.deepEqual(row.model_context,doc.modelContext);assert.deepEqual(row.selected_source,doc.selectedSourceCapsule);
  assert.equal(row.text_revision,doc.textRevision);assert.equal(row.timing_revision,doc.timingRevision);assert.equal(row.reading_revision,doc.readingRevision);
  await assert.rejects(store.saveDocument(doc),{code:'invalid_source',status:400});
});

test('selected access is exact and private, independent registrations share documents and switching retains old access',async t=>{
  const {db,store,doc}=await fixture(t);
  await store.assertDocumentAccess('reader-a',doc);await assert.rejects(store.assertDocumentAccess('reader-b',doc),unavailable);
  await store.saveSelectedDocument(doc,'reader-b');await store.assertDocumentAccess('reader-b',await store.document(doc.id));
  const next=await selected({itemID:'124',text:'A different selected source.'});await store.saveSelectedDocument(next,'reader-a');
  await store.assertDocumentAccess('reader-a',doc);await store.assertDocumentAccess('reader-a',next);
  await assert.rejects(store.assertDocumentAccess('reader-b',next),unavailable);
  assert.equal((await db.query('SELECT count(*) AS n FROM selected_source_access')).rows[0].n,3);
  await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");
  await assert.rejects(store.saveSelectedDocument(next,'reader-a'),unavailable);
  await assert.rejects(store.assertDocumentAccess('reader-a',doc),unavailable);
  await store.assertDocumentAccess('reader-a',source); // Automatic documents keep their existing access policy.
});

test('selected saves reject invalid identities and conflicting immutable document IDs without granting access',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());const doc=await selected();
  await assert.rejects(store.saveSelectedDocument({...doc,sourceHash:'wrong'},'reader-a'),{code:'source_context_unavailable'});
  await store.saveDocument({...source,id:doc.id});
  await assert.rejects(store.saveSelectedDocument(doc,'reader-a'),{code:'selected_source_collision'});
  assert.equal((await db.query('SELECT count(*) AS n FROM selected_source_access')).rows[0].n,0);
  assert.equal((await store.document(doc.id)).sourceHash,source.sourceHash);
});

test('selected currentness has its own revision and capsule, without an automatic request dependency',async t=>{
  const {db,store,doc}=await fixture(t);
  assert.equal(await store.isGenerationDocumentCurrent(doc,'unrelated-automatic-revision'),true);
  assert.equal(await store.isCurrentDocument(doc.id,SELECTED_SOURCE_REVISION),false);
  assert.equal(await store.isGenerationDocumentCurrent({...doc,selectionRevision:'retired-selected-policy'},'anything'),false);
  assert.equal(await store.isGenerationDocumentCurrent({...doc,modelContext:{title:'Forged'}},'anything'),false);
  await store.saveDocument(source);assert.equal(await store.isGenerationDocumentCurrent(source,source.selectionRevision),true);
  assert.equal(await store.isGenerationDocumentCurrent(source,'different'),false);
  await db.query('UPDATE lyric_documents SET superseded_by=$2 WHERE id=$1',[doc.id,source.id]);
  assert.equal(await store.isGenerationDocumentCurrent(doc,'anything'),false);
  await assert.rejects(store.reserve(request(doc,{allowGeneration:true})),{code:'source_revision_superseded'});
  await assert.rejects(reserveExplanation(store.db,study(doc,{allowGeneration:true})),{code:'source_revision_superseded'});
});

test('selected translation and Study need explicit consent for beta and unlimited users, while automatic beta behavior remains',async t=>{
  const {db,store,doc}=await fixture(t);
  for(const unlimited of [false,true]) {
    await store.configureUserAccess('reader-a',{unlimitedGeneration:unlimited});
    await assert.rejects(store.reserve(request(doc)),{code:'generation_required'});
    await assert.rejects(reserveExplanation(store.db,study(doc)),{code:'generation_required'});
    await assert.rejects(store.reserve(request(doc,{allowGeneration:1})),{code:'generation_required'});
    await assert.rejects(reserveExplanation(store.db,study(doc,{allowGeneration:'true'})),{code:'generation_required'});
  }
  assert.equal((await db.query('SELECT count(*) AS n FROM translation_jobs')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*) AS n FROM study_explanations')).rows[0].n,0);
  assert.equal(Number((await store.usage()).accounted_micros),0);
  await store.saveDocument(source);assert.equal((await store.reserve(request(source))).kind,'created');
});

test('authorized selected prior work and saved translations recover without fresh consent, after access is checked',async t=>{
  const {db,store,doc}=await fixture(t);
  const job=await store.reserve(request(doc,{allowGeneration:true}));
  assert.equal((await store.reserve(request(doc))).kind,'pending');
  await assert.rejects(store.reserve(request(doc,{userID:'reader-b'})),unavailable);
  await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");
  await assert.rejects(store.reserve(request(doc)),unavailable);
  await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");
  await store.claim(job.job.id);await store.complete(job.job.id,{lines:[],sourceNotes:[]},1000,{});
  await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
  assert.equal((await store.reserve(request(doc))).kind,'ready');
  await db.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");
  await assert.rejects(store.reserve(request(doc)),unavailable);
  assert.equal(Number((await store.usage()).jobs),1);
});

test('selected Study access precedes queued and ready reuse, including a stale caller preflight',async t=>{
  const {db,store,doc}=await fixture(t),args=study(doc,{allowGeneration:true});
  const result=await reserveExplanation(store.db,args);assert.equal(result.created,true);
  assert.equal((await reserveExplanation(store.db,study(doc))).created,false);
  await assert.rejects(reserveExplanation(store.db,study(doc,{userID:'reader-b'})),unavailable);
  await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");
  await assert.rejects(reserveExplanation(store.db,study(doc)),unavailable);
  await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");
  assert.equal(await claimExplanation(store.db,result.row.id),true);
  await finishExplanation(store.db,result.row.id,{content:{meaning:'Saved study.'},actualMicros:100,response:{}});
  await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
  assert.equal((await reserveExplanation(store.db,study(doc))).row.state,'ready');
  await store.assertDocumentAccess('reader-a',doc);
  const raced={transaction:fn=>db.transaction(async tx=>{
    await tx.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");return fn(tx);
  })};
  await assert.rejects(reserveExplanation(raced,study(doc)),unavailable);
});

test('selected translation admission rechecks access inside its transaction before cached reuse',async t=>{
  const {db,store,doc}=await fixture(t);await ready(store,doc);await store.assertDocumentAccess('reader-a',doc);
  const raced=new SongLibraryStore({transaction:fn=>db.transaction(async tx=>{
    await tx.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");return fn(tx);
  })});
  await assert.rejects(raced.reserve(request(doc)),unavailable);
});

test('concurrent authorized selected callers coalesce one reservation after separate registrations',async t=>{
  const {store,doc}=await fixture(t);await store.saveSelectedDocument(doc,'reader-b');
  const results=await Promise.all(Array.from({length:8},(_,i)=>store.reserve(request(doc,{userID:i%2?'reader-a':'reader-b',allowGeneration:true}))));
  assert.equal(results.filter(x=>x.kind==='created').length,1);
  assert.equal(new Set(results.map(x=>x.job.id)).size,1);
  assert.equal(Number((await store.usage()).jobs),1);assert.equal(Number((await store.usage()).accounted_micros),30000);
});

test('alias job document lookup is nonmutating and resolves the exact selected access scope',async t=>{
  const {db,store,doc}=await fixture(t),aliasDoc=await selected({timestamp:42});await store.saveSelectedDocument(aliasDoc,'reader-b');
  const first=await store.reserve(request(doc,{allowGeneration:true}));
  const alias=await store.reserve(request(aliasDoc,{userID:'reader-b'}));assert.equal(alias.kind,'pending');
  assert.notEqual(alias.job.id,first.job.id);
  assert.equal(await store.jobDocumentID(alias.job.id),aliasDoc.id);assert.equal(await store.jobDocumentID(first.job.id),doc.id);
  assert.equal(await store.jobDocumentID(randomUUID()),null);
  await store.claim(first.job.id);await db.query("UPDATE translation_jobs SET started_at=now()-interval '7 minutes' WHERE id=$1",[first.job.id]);
  await assert.rejects(store.assertDocumentAccess('reader-a',await store.document(await store.jobDocumentID(alias.job.id))),unavailable);
  assert.equal((await db.query('SELECT state FROM translation_jobs WHERE id=$1',[first.job.id])).rows[0].state,'running');
  assert.equal(Number((await store.usage()).jobs),1);
});

test('selected ready reuse retains exact access isolation across timing variants',async t=>{
  const {store,doc}=await fixture(t);const id=await ready(store,doc),other=await selected({timestamp:42});
  await store.saveSelectedDocument(other,'reader-b');await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
  await assert.rejects(store.reserve(request(other)),unavailable);
  assert.equal((await store.reserve(request(other,{userID:'reader-b'}))).translation.id,id);
  assert.equal(Number((await store.usage()).jobs),1);
});

test('queued selected jobs cannot dispatch after access loss or disable, and submitted work still settles',async t=>{
  const {db,store,doc}=await fixture(t);const job=await store.reserve(request(doc,{allowGeneration:true}));
  await db.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");
  assert.equal(await store.claim(job.job.id),null);
  await store.saveSelectedDocument(doc,'reader-a');await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");
  assert.equal(await store.claim(job.job.id),null);
  await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");assert.ok(await store.claim(job.job.id));
  await db.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");
  await store.complete(job.job.id,{lines:[],sourceNotes:[]},1234,{});
  assert.equal((await store.job(job.job.id)).state,'ready');assert.equal(Number((await store.usage()).accounted_micros),1234);
  await store.saveSelectedDocument(doc,'reader-a');const explanation=await reserveExplanation(store.db,study(doc,{allowGeneration:true}));
  await db.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");assert.equal(await claimExplanation(store.db,explanation.row.id),false);
  await store.saveSelectedDocument(doc,'reader-a');await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");
  assert.equal(await claimExplanation(store.db,explanation.row.id),false);
  await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");assert.equal(await claimExplanation(store.db,explanation.row.id),true);
  await db.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");
  await finishExplanation(store.db,explanation.row.id,{content:{meaning:'Saved.'},actualMicros:100,response:{}});
  assert.equal((await db.query('SELECT state FROM study_explanations WHERE id=$1',[explanation.row.id])).rows[0].state,'ready');
  assert.equal(Number((await store.usage()).accounted_micros),1334);
});

test('selected reports recheck exact access in their transaction before deduplication',async t=>{
  const {db,store,doc}=await fixture(t),args={userID:'reader-a',documentID:doc.id,sourceID:'L0001',category:'lyrics',detail:'Source correction.'};
  const report=await store.report(args);assert.equal((await store.report(args)).id,report.id);
  await assert.rejects(store.report({...args,userID:'reader-b'}),unavailable);
  const raced=new SongLibraryStore({query:(...args)=>db.query(...args),transaction:fn=>db.transaction(async tx=>{
    await tx.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");return fn(tx);
  })});
  await assert.rejects(raced.report(args),unavailable);
});

test('queued selected dispatch rejects unsupported revisions and invalid persisted capsules',async t=>{
  const {db,store,doc}=await fixture(t);const translation=await store.reserve(request(doc,{allowGeneration:true}));
  const second=await selected({itemID:'124'});await store.saveSelectedDocument(second,'reader-b');
  const explanation=await reserveExplanation(store.db,study(second,{userID:'reader-b',allowGeneration:true}));
  await db.query('UPDATE lyric_documents SET selection_revision=$2 WHERE id=$1',[doc.id,'retired-selected-policy']);
  await db.query("UPDATE lyric_documents SET selected_source=jsonb_set(selected_source,'{title}','\"Changed source title\"') WHERE id=$1",[second.id]);
  assert.equal(await store.claim(translation.job.id),null);assert.equal(await claimExplanation(store.db,explanation.row.id),false);
  assert.equal((await store.job(translation.job.id)).state,'queued');
  assert.equal((await db.query('SELECT state FROM study_explanations WHERE id=$1',[explanation.row.id])).rows[0].state,'queued');
  assert.equal(Number((await store.usage()).accounted_micros),31000);
});

test('account deletion removes only that account selected links and cannot recover old content after reactivation',async t=>{
  const {db,store,doc}=await fixture(t);await store.saveSelectedDocument(doc,'reader-b');await ready(store,doc);
  const explanation=await reserveExplanation(store.db,study(doc,{allowGeneration:true}));
  await db.query("UPDATE library_users SET access_kind='apple' WHERE id='reader-a'");
  await db.query("INSERT INTO account_identities(subject_hash,user_id,app_account_token) VALUES('selected-subject','reader-a',$1)",[randomUUID()]);
  await db.query('UPDATE membership_settings SET public_access_enabled=true');
  await db.exec(await readFile(new URL('../../db/032-auth-token-row-locks.sql',import.meta.url),'utf8'));
  const policy={audience:'test',environment:'development',prefix:'9ESZX68J8U',bundles:['com.test.Lyrica']},bundleID=policy.bundles[0],keyID=Buffer.alloc(32,31).toString('base64');
  const auth=new AppAuthStore(store.db,{policy,attestFn:()=>({publicKey:'proof',receipt:Buffer.from('proof')}),assertionFn:({assertion})=>Number(assertion.toString())});
  const registration=await auth.challenge('token-a',{keyID,bundleID,purpose:'register'});
  await auth.register('token-a',{keyID,bundleID,...registration,attestation:'cHJvb2Y='});
  const challenge=await auth.challenge('token-a',{keyID,bundleID,purpose:'session'});
  const session=await auth.session('token-a',{keyID,bundleID,...challenge,assertion:Buffer.from('1').toString('base64')});
  const user=await auth.authenticate(session.token);
  const accounts=new AccountStore(store.db,{policy,apple:{authenticate:async()=>({subjectHash:'selected-subject',refreshTokenEncrypted:'proof'}),revoke:async()=>{}},spotifyCleanupFn:async()=>{}});
  const input={bundleID,...(await accounts.challenge({purpose:'delete',bundleID},user))};
  const authentication=await accounts.prepareWriterAuthentication(session.token);
  assert.deepEqual(await accounts.delete(user,input,authentication),{deleted:true});
  assert.deepEqual((await db.query('SELECT user_id FROM selected_source_access')).rows.map(x=>x.user_id),['reader-b']);
  await assert.rejects(store.reserve(request(doc)),unavailable);
  await assert.rejects(reserveExplanation(store.db,study(doc)),unavailable);
  await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");
  await assert.rejects(store.assertDocumentAccess('reader-a',doc),unavailable);
  await assert.rejects(store.reserve(request(doc)),unavailable);
  await assert.rejects(reserveExplanation(store.db,study(doc)),unavailable);
  assert.equal((await db.query('SELECT state FROM study_explanations WHERE id=$1',[explanation.row.id])).rows[0].state,'queued');
  assert.equal((await store.reserve(request(doc,{userID:'reader-b'}))).kind,'ready');
});

test('account runtime can remove selected links under its restricted role',async t=>{
  const {db,store,doc}=await fixture(t);await db.query('CREATE ROLE lyra_account_v1');
  await db.exec(await readFile(new URL('../../db/028-selected-lyrics-learning.sql',import.meta.url),'utf8'));
  await db.query('SET ROLE lyra_account_v1');
  await db.query("DELETE FROM selected_source_access WHERE user_id='reader-a'");
  await db.query('RESET ROLE');await assert.rejects(store.assertDocumentAccess('reader-a',doc),unavailable);
});
