import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateLibrary} from '../../scripts/library-migrations.js';
import {SongLibraryStore} from '../../api/utils/song-library/store.js';
import {source} from '../helpers/library-db.js';
import {parseTranslation} from '../../api/utils/song-library/translation.js';
import {retryTranslation} from '../../api/utils/song-library/translation-retry.js';
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());
 const adapt=c=>({query:(sql,args)=>args?c.query(sql,args):c.exec(sql).then(r=>r.at(-1)),transaction:fn=>db.transaction(c=>fn(adapt(c)))}),database=adapt(db);
 await migrateLibrary(database);const store=new SongLibraryStore(database);await store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000});await store.createUser('reader-a','token-a');await store.saveDocument(source);
 const r=await store.reserve({userID:'reader-a',documentID:source.id,target:'en',recipe:'fixture',reservedMicros:30_000});await store.claim(r.job.id);
 return {db,database,store,id:r.job.id};
}
const content=parseTranslation(JSON.stringify({translations:{L0001:'Make a song of today.'},sourceNotes:[]}),source);
test('dashboard bindings expose shared heads and owner rollback preserves the original revision anchor',async t=>{
 const {db,store,id}=await fixture(t);await store.complete(id,content,1000,{});
 const alias={...source,id:'alias',requestKey:'alias',sourceHash:'different-timing-hash'};await store.saveDocument(alias);await store.translation(alias.id,'en');
 assert.equal((await db.query('SELECT translation_id FROM lyra_dashboard.songs WHERE id=$1',[alias.id])).rows[0].translation_id,id);
 assert.equal((await db.query('SELECT translation FROM lyra_dashboard.lines WHERE document_id=$1',[alias.id])).rows[0].translation,'Make a song of today.');
 assert.equal((await db.query('SELECT translation_id FROM lyra_dashboard.revision_lines WHERE document_id=$1',[alias.id])).rows[0].translation_id,id);
 const correction=await store.publishRevision({expectedRevisionID:id,sourceHash:source.sourceHash,publicationKey:'dashboard-shared',actor:'test',reason:'Improve wording',candidate:{translations:{L0001:'Sing today into a song.'},sourceNotes:[]}});
 assert.equal((await db.query('SELECT id FROM lyra_dashboard.revisions WHERE document_id=$1 AND current',[alias.id])).rows[0].id,correction.id);
 await db.query("INSERT INTO lyra_dashboard_control.operators(subject) VALUES('owner')");
 await db.exec('CREATE ROLE binding_reader NOINHERIT; GRANT USAGE ON SCHEMA lyra_dashboard,lyra_dashboard_control TO binding_reader; GRANT SELECT ON ALL TABLES IN SCHEMA lyra_dashboard TO binding_reader; GRANT EXECUTE ON FUNCTION lyra_dashboard_control.rollback_translation(text,uuid,text,text,uuid,uuid,text) TO binding_reader; SET ROLE binding_reader');
 const args=['owner',randomUUID(),alias.id,alias.sourceHash,correction.id,id,'Restore the earlier wording.'];
 const rollback=await db.query('SELECT lyra_dashboard_control.rollback_translation($1,$2,$3,$4,$5,$6,$7) AS result',args);
 assert.equal((await db.query('SELECT translation FROM lyra_dashboard.lines WHERE document_id=$1',[alias.id])).rows[0].translation,'Make a song of today.');
 await assert.rejects(db.query('SELECT * FROM translation_attempt_history'),/permission denied/);
 await assert.rejects(db.query('SELECT * FROM translation_document_bindings'),/permission denied/);
 await db.exec('RESET ROLE');
 assert.equal((await store.translation(source.id,'en')).id,rollback.rows[0].result.revision_id);
 assert.equal((await db.query('SELECT source_hash FROM translation_revisions WHERE id=$1',[rollback.rows[0].result.revision_id])).rows[0].source_hash,source.sourceHash);
});
test('dashboard job costs include every attempt and a fresh retry is not marked stalled',async t=>{
 const {db,database,store,id}=await fixture(t);await store.fail(id,'provider_incomplete',8610,{});
 await db.query("UPDATE translation_jobs SET created_at=now()-interval '40 days' WHERE id=$1",[id]);
 await retryTranslation(database,{jobID:id,expectedAttempt:1,requestKey:'dashboard-retry',actor:'owner',reason:'Increase output budget'});
 const queued=(await db.query('SELECT * FROM lyra_dashboard.jobs WHERE id=$1',[id])).rows[0];assert.equal(queued.stalled,false);assert.equal(queued.cost_kind,'reserved');
 const claimed=await store.claim(id);await store.complete(id,content,2000,{},claimed.attempt);
 const settled=(await db.query('SELECT * FROM lyra_dashboard.jobs WHERE id=$1',[id])).rows[0];assert.equal(Number(settled.accounted_micros),10610);assert.equal(settled.cost_kind,'estimated');
});
