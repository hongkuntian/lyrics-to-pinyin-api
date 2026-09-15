import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateLibrary} from '../../scripts/library-migrations.js';
import {publishRevision} from '../../api/utils/song-library/revisions.js';

const doc='a'.repeat(64),source='b'.repeat(64),initial='00000000-0000-4000-8000-000000000001';
async function setup(t) {
  const db=new PGlite();t.after(()=>db.close());
  await migrateLibrary({transaction:fn=>db.transaction(tx=>fn({query:(sql,values)=>values?tx.query(sql,values):tx.exec(sql)}))});
  await db.query("INSERT INTO lyra_dashboard_control.operators(subject) VALUES('owner')");
  await db.exec(`CREATE ROLE control_test NOINHERIT; GRANT USAGE ON SCHEMA lyra_dashboard_control TO control_test;
    GRANT EXECUTE ON FUNCTION lyra_dashboard_control.set_control(text,uuid,bigint,text,boolean),
      lyra_dashboard_control.rollback_translation(text,uuid,text,text,uuid,uuid,text) TO control_test`);
  return db;
}
const control=(db,id,version,field,enabled,actor='owner')=>db.query('SELECT lyra_dashboard_control.set_control($1,$2,$3,$4,$5) AS result',[actor,id,version,field,enabled]);
test('controls authorize each operator, preserve budgets, fence old pages, and deduplicate exact retries',async t=> {
  const db=await setup(t),id=randomUUID();
  const before=(await db.query('SELECT * FROM library_settings')).rows[0];
  await db.exec('SET ROLE control_test');
  await assert.rejects(control(db,id,1,'reviews',true,'viewer'),/owner_required/);
  const result=(await control(db,id,1,'reviews',true)).rows[0].result;
  assert.equal(result.reviews,true);
  assert.deepEqual((await control(db,id,1,'reviews',true)).rows[0].result,result);
  await assert.rejects(control(db,id,1,'reviews',false),/action_key_conflict/);
  await assert.rejects(control(db,randomUUID(),1,'paid_work',true),/controls_changed/);
  await assert.rejects(control(db,randomUUID(),2,'daily_micros',true),/invalid_control/);
  await assert.rejects(db.query('UPDATE library_settings SET daily_micros=99999999'),/permission denied/);
  await assert.rejects(db.query('SELECT * FROM library_users'),/permission denied/);
  await assert.rejects(db.query('SELECT * FROM lyra_dashboard_control.operators'),/permission denied/);
  await db.exec('RESET ROLE');
  const after=(await db.query('SELECT * FROM library_settings')).rows[0];
  for(const key of ['daily_micros','monthly_micros','review_daily_micros','review_monthly_micros','review_max_daily','user_daily','user_monthly'])assert.equal(after[key],before[key]);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM lyra_dashboard_control.actions')).rows[0].n,1);
  await assert.rejects(db.exec('DELETE FROM lyra_dashboard_control.actions'),/dashboard_audit_immutable/);
  await db.exec("UPDATE lyra_dashboard_control.operators SET enabled=false");
  await assert.rejects(control(db,randomUUID(),2,'reviews',false),/owner_required/);
});
test('rollback copies the exact saved revision, creates a new head and audit, and cannot overwrite newer work',async t=> {
  const db=await setup(t);
  const structure={version:'source-speakers-1',speakers:[],occurrences:[{sourceID:'L0001',sourceText:'回家',lyricText:'回家',speakerID:null,startsTurn:false,sourcePrefix:''}]};
  await db.query('INSERT INTO lyric_documents(id,recording_key,source_hash,selection_revision,response,structure) VALUES($1,$2,$3,$4,$5,$6)',[doc,'recording',source,'fixture',JSON.stringify({lines:[{original:'回家'}]}),JSON.stringify(structure)]);
  await db.query("INSERT INTO library_users(id) VALUES('fixture')");
  await db.query("INSERT INTO translation_jobs(id,document_id,target,recipe,user_id,state,reserved_micros,accounted_micros) VALUES($1,$2,'en','fixture','fixture','ready',0,0)",[initial,doc]);
  await db.query("INSERT INTO song_translations(id,document_id,target,recipe,content) VALUES($1,$2,'en','fixture',$3)",[initial,doc,JSON.stringify({lines:[{sourceID:'L0001',lyricText:'Go home.',text:'Go home.',speakerID:null,startsTurn:false}],sourceNotes:[],rejectedNotes:[]})]);
  const correction=await publishRevision(db,{expectedRevisionID:initial,sourceHash:source,publicationKey:'correction',actor:'worker',reason:'fixture',candidate:{translations:{L0001:'Return home.'},sourceNotes:[]}});
  const id=randomUUID(),args=['owner',id,doc,source,correction.id,initial,'Restore the earlier wording.'];
  const call=values=>db.query('SELECT lyra_dashboard_control.rollback_translation($1,$2,$3,$4,$5,$6,$7) AS result',values);
  await db.exec('SET ROLE control_test');
  await assert.rejects(call(['viewer',...args.slice(1)]),/owner_required/);
  await assert.rejects(call([...args.slice(0,3),'changed',...args.slice(4)]),/source_changed/);
  const restored=(await call(args)).rows[0].result;
  assert.notEqual(restored.revision_id,initial);assert.equal(restored.sequence,3);
  assert.deepEqual((await call(args)).rows[0].result,restored);
  await assert.rejects(call(['owner',randomUUID(),...args.slice(2)]),/translation_revision_superseded/);
  await assert.rejects(call([...args.slice(0,6),'Different reason']),/action_key_conflict/);
  await assert.rejects(db.exec('SELECT * FROM translation_revisions'),/permission denied/);
  await db.exec('RESET ROLE');
  const rows=(await db.query('SELECT content FROM translation_revisions WHERE id=ANY($1::uuid[]) ORDER BY sequence',[[initial,restored.revision_id]])).rows;
  assert.deepEqual(rows[0].content,rows[1].content);
  assert.equal((await db.query('SELECT revision_id FROM translation_heads')).rows[0].revision_id,restored.revision_id);
  assert.equal((await db.query('SELECT actor FROM lyra_dashboard_control.actions')).rows[0].actor,'owner');
});
