import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateLibrary} from '../../scripts/library-migrations.js';
import {runOperationalAlerts} from '../../api/utils/song-library/operational-alerts.js';
import {createReviewReportsHandler} from '../../api/review-reports.js';
import {SongLibraryStore} from '../../api/utils/song-library/store.js';
import {source} from '../helpers/library-db.js';
const env={VERCEL_ENV:'production',LYRA_ALERT_EMAIL_ENABLED:'true',RESEND_API_KEY:'test-secret',LYRA_ALERT_FROM:'alerts@example.com',LYRA_ALERT_TO:'owner@example.com'};
async function fixture(t) {
  const pg=new PGlite();t.after(()=>pg.close());
  const db={query:(...a)=>pg.query(...a),transaction:fn=>pg.transaction(tx=>fn({query:(sql,args)=>args?tx.query(sql,args):tx.exec(sql).then(r=>r.at(-1))}))};
  await migrateLibrary(db);
  await pg.query('UPDATE library_settings SET enabled=true,review_enabled=true,daily_micros=1000000,monthly_micros=5000000,review_daily_micros=250000,review_monthly_micros=1000000');
  let sent=[];
  const run=(options={})=>runOperationalAlerts({db,env,send:async p=>{sent.push(p);return {state:'accepted',id:randomUUID()};},...options});
  return {db,pg,sent,run,rows:async table=>(await pg.query(`SELECT * FROM ${table}`)).rows};
}
test('healthy and semantically deferred work stays quiet; no provider or budget changes',async t=>{
  const f=await fixture(t),before=await f.rows('library_settings');
  assert.deepEqual(await f.run(),{state:'quiet'});assert.equal(f.sent.length,0);
  await f.pg.query("UPDATE correction_worker SET last_outcome='review_completed',last_run_at=now()");
  await f.run();assert.equal((await f.rows('library_alert_incidents')).length,0);
  assert.deepEqual(await f.rows('library_settings'),before);assert.equal((await f.rows('library_spend_operations')).length,0);
});
test('concurrent runs coalesce incident families into one immutable digest and never repeat it',async t=>{
  const f=await fixture(t);await f.pg.query('UPDATE library_settings SET daily_micros=0,review_daily_micros=0');
  await Promise.all(Array.from({length:8},()=>f.run()));
  assert.equal(f.sent.length,1);assert.equal((await f.rows('library_alert_incidents')).length,2);
  assert.match(f.sent[0].payload.text,/Report review/);
  await f.pg.query("UPDATE library_alert_deliveries SET attempted_at=now()-interval '2 days'");
  await f.run();assert.equal(f.sent.length,1);
});
test('resolved incidents stop pending mail; reopening creates a new episode but observes daily and monthly caps',async t=>{
  const f=await fixture(t);await f.pg.query('UPDATE library_settings SET daily_micros=0');await f.run();
  await f.pg.query('UPDATE library_settings SET daily_micros=1000000');await f.run();
  assert.ok((await f.rows('library_alert_incidents'))[0].resolved_at);
  await f.pg.query('UPDATE library_settings SET daily_micros=0');await f.run();assert.equal(f.sent.length,1);
  // Five current-month attempts include today's send, failures and interrupted sends.
  for(let i=0;i<4;i++)await f.pg.query("INSERT INTO library_alert_deliveries(id,state,payload,attempted_at) VALUES($1,'rejected','{}',date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",[randomUUID()]);
  await f.run();assert.equal(f.sent.length,1);assert.equal((await f.rows('library_alert_incidents')).length,2);
  await f.pg.query('UPDATE library_settings SET daily_micros=1000000');await f.run();
  assert.equal((await f.rows('library_alert_incidents')).filter(i=>!i.resolved_at).length,0);
});
test('missing email configuration retains dashboard incidents then sends only still-active incidents once configured',async t=>{
  const f=await fixture(t);await f.pg.query('UPDATE library_settings SET daily_micros=0');await f.run({env:{}});
  assert.equal(f.sent.length,0);assert.equal((await f.rows('library_alert_incidents')).length,1);
  assert.equal((await f.rows('library_alert_monitor'))[0].email_configured,false);
  await f.run();assert.equal(f.sent.length,1);
});
test('lost response and crashed process never resend after the provider idempotency window expires',async t=>{
  const f=await fixture(t);await f.pg.query('UPDATE library_settings SET daily_micros=0');
  let calls=0;await f.run({send:async()=>{calls++;throw new Error('SECRET provider response');}});
  assert.equal((await f.rows('library_alert_deliveries'))[0].state,'unknown');
  await f.pg.query("UPDATE library_alert_deliveries SET state='sending',attempted_at=now()-interval '2 days'");
  await f.run({send:async()=>{calls++;}});assert.equal(calls,1);
  assert.equal((await f.rows('library_alert_deliveries'))[0].state,'unknown');
  assert.ok(!JSON.stringify(await f.rows('library_alert_deliveries')).includes('SECRET'));
});
test('claim commit survives send success followed by storage failure',async t=>{
  const f=await fixture(t);await f.pg.query('UPDATE library_settings SET daily_micros=0');
  await assert.rejects(f.run({db:{...f.db,query:async()=>{throw new Error('storage interrupted');}}}));
  assert.equal(f.sent.length,1);await f.run();assert.equal(f.sent.length,1);
});
test('live dashboard can detect an overdue scheduler without a worker invocation',async t=>{
  const f=await fixture(t);await f.pg.query("UPDATE library_alert_monitor SET initialized_at=now()-interval '37 hours'");
  assert.ok((await f.rows('lyra_dashboard.alert_conditions')).some(x=>x.code==='scheduler_overdue'));
  await f.run();assert.ok(!(await f.rows('lyra_dashboard.alert_conditions')).some(x=>x.code==='scheduler_overdue'));
  assert.equal(f.sent.length,0);
});
test('stalled generation and unknown charges remain held through budget rollover and clear only on recorded recovery',async t=>{
  const f=await fixture(t),store=new SongLibraryStore(f.db);
  await store.createUser('reader-a','token-a');await store.saveDocument(source);
  const {job}=await store.reserve({userID:'reader-a',documentID:source.id,target:'en',recipe:'fixture',reservedMicros:30000});
  await store.claim(job.id);
  await f.pg.query("UPDATE library_spend_operations SET created_at=now()-interval '2 months'");
  assert.ok((await f.rows('library_alert_conditions')).some(i=>i.code==='generation_stalled'));
  await store.fail(job.id,'worker_interrupted',null);
  await f.run();assert.ok((await f.rows('library_alert_conditions')).some(i=>i.code==='billing_uncertain'));
  assert.equal(Number((await store.budget()).held),30000);
  await f.run();assert.equal(f.sent.length,1);assert.equal(Number((await store.budget()).held),30000);
});
test('a review unable to fit its reservation alerts even below the cap; ordinary count limits stay quiet',async t=>{
  const f=await fixture(t);await f.pg.query("UPDATE correction_worker SET last_outcome='review_budget_exhausted',last_run_at=now()");
  await f.run();assert.match(f.sent[0].payload.text,/review has reached its budget/);
  await f.pg.query("UPDATE correction_worker SET last_outcome='review_allowance_exhausted'");
  await f.run();assert.ok((await f.rows('library_alert_incidents'))[0].resolved_at);
  await f.pg.query("UPDATE correction_worker SET last_outcome='review_budget_exhausted',last_run_at=now()-interval '2 days'");
  assert.equal((await f.rows('library_alert_conditions')).length,0);
});
test('a claim transaction failure prevents any email submission',async t=>{
  const f=await fixture(t);await f.pg.query('UPDATE library_settings SET daily_micros=0');
  const db={...f.db,transaction:fn=>f.db.transaction(async tx=>{await fn(tx);throw new Error('rollback claim');})};
  await assert.rejects(f.run({db}));assert.equal(f.sent.length,0);assert.equal((await f.rows('library_alert_deliveries')).length,0);
});
test('worker failures, missing provider key, and recovery use alerts without making model calls',async t=>{
  const f=await fixture(t);let modelCalls=0;const secret='s'.repeat(40);
  const handler=createReviewReportsHandler({db:f.db,env:{...env,CRON_SECRET:secret},run:async()=>{modelCalls++;},alerts:f.run});
  const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  await handler({method:'GET',headers:{authorization:`Bearer ${secret}`}},res);
  assert.equal(res.code,503);assert.equal(res.body.code,'review_not_configured');assert.equal(modelCalls,0);
  assert.equal(f.sent.length,1);assert.match(f.sent[0].payload.text,/worker needs attention/);
  await f.run({workerError:false});assert.ok((await f.rows('library_alert_incidents'))[0].resolved_at);
});
test('reader sees bounded metadata but cannot read email addresses, payloads, keys or mutate incidents',async t=>{
  const f=await fixture(t);await f.pg.exec('CREATE ROLE lyra_dashboard_reader; GRANT USAGE ON SCHEMA lyra_dashboard TO lyra_dashboard_reader; GRANT SELECT ON ALL TABLES IN SCHEMA lyra_dashboard TO lyra_dashboard_reader;');
  await f.pg.query('UPDATE library_settings SET daily_micros=0');await f.run();await f.pg.exec('SET ROLE lyra_dashboard_reader');
  for(const table of ['alert_conditions','alert_incidents','alert_monitor']) {
    const rows=await f.rows(`lyra_dashboard.${table}`);assert.ok(!JSON.stringify(rows).includes('example.com'));assert.ok(!JSON.stringify(rows).includes('test-secret'));
  }
  await assert.rejects(f.rows('library_alert_deliveries'),/permission denied/);
  assert.equal((await f.pg.query("SELECT has_table_privilege(current_user,'lyra_dashboard.alert_incidents','DELETE') AS allowed")).rows[0].allowed,false);
  await assert.rejects(f.pg.query('DELETE FROM library_alert_incidents'),/permission denied/);
});
