import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateLibrary,migrationNames} from '../../scripts/library-migrations.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';

// AUTHORED NOT EXECUTED. Apply this file at its repository-relative path first.
// This is a minimal observed-role fixture, NOT the production bootstrap:
// actual public migrations plus a synthetic NOLOGIN role with SELECT(tokens)
// and no token UPDATE. No account/auth service, V2 schema or live pool is used.
const name='032-auth-token-row-locks.sql',anchor='auth_lock_anchor';
const publicNames=[
 '001-song-library.sql','002-dashboard-views.sql','003-correction-foundation.sql',
 '004-correction-dashboard.sql','005-correction-batches.sql','006-batch-dashboard.sql',
 '007-correction-publication.sql','008-publication-dashboard.sql','009-study-explanations.sql',
 '010-dashboard-controls.sql','011-operational-alerts.sql','012-multilingual-content.sql',
 '013-pronunciation-aids.sql','014-lyric-source-refresh.sql','015-gpt6-luna.sql',
 '016-personal-unlimited-access.sql','017-translation-reuse.sql','018-translation-attempts.sql',
 '019-translation-reuse-dashboard.sql','020-catalog-recording-bindings.sql','021-app-auth.sql',
 '022-live-lyrics-push.sql','023-live-lyrics-runtime.sql','024-live-lyrics-cleanup.sql',
 '025-memberships.sql','026-spotify-recordings.sql','027-spotify-background.sql',
 '028-selected-lyrics-learning.sql','029-listening-sessions.sql'
];
const sql=filename=>readFile(new URL(`../../db/${filename}`,import.meta.url),'utf8');
const sha=text=>createHash('sha256').update(text).digest('hex');
const body=text=>text.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
const existingFields=['digest','user_id','revoked','created_at','expires_at'];
const denied=promise=>assert.rejects(promise,{code:'42501'});
const drift=error=>error.code==='23514'&&/auth_token_lock_.*catalog_mismatch/.test(error.message);

function adapt(db,{trace=[],failReceipt=false}={}){
 return {transaction:fn=>db.transaction(tx=>fn({query:async(text,values)=>{
  trace.push({text,values});
  if(failReceipt&&/^INSERT INTO library_schema_migrations/.test(text)&&values?.[0]===name)
   throw Object.assign(new Error('injected_032_receipt_failure'),{code:'injected_032_receipt_failure'});
  return values?tx.query(text,values):(await tx.exec(text)).at(-1);
 }}))};
}
async function database(t){
 const db=new PGlite();t.after(()=>db.close());return db;
}
async function runtime(db){
 await db.exec('CREATE ROLE lyra_runtime_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
}
async function baseline(t,{role=true}={}){
 const db=await database(t);
 if(role)await runtime(db);
 // Temporarily select the exact historical public prefix for the ACTUAL
 // runner. No migration SQL/receipt implementation is copied into a mock.
 // Tests in this file are sequential; always restore the exported manifest.
 const saved=[...migrationNames];
 migrationNames.splice(0,migrationNames.length,...publicNames);
 try{assert.deepEqual(await migrateLibrary(adapt(db)),publicNames);}
 finally{migrationNames.splice(0,migrationNames.length,...saved);}
 if(role)await observedSelect(db);
 await db.query("INSERT INTO public.library_users(id) VALUES('lock-owner'),('other-owner')");
 await db.query(`INSERT INTO public.library_tokens(digest,user_id,revoked,created_at,expires_at) VALUES
  ('lock-token','lock-owner',false,'2026-01-01T00:00:00Z','2099-01-01T00:00:00Z'),
  ('revoked-token','lock-owner',true,'2026-01-02T00:00:00Z','2026-02-01T00:00:00Z'),
  ('unbounded-token','other-owner',false,'2026-01-03T00:00:00Z',NULL)`);
 return db;
}
async function observedSelect(db){
 // The only baseline addition to real migration grants is the measured
 // token SELECT plus schema USAGE. Never add token UPDATE/INSERT/DELETE.
 await db.exec('GRANT USAGE ON SCHEMA public TO lyra_runtime_v1; GRANT SELECT ON public.library_tokens TO lyra_runtime_v1');
}
async function asRuntime(db,fn){
 await db.exec('SET ROLE lyra_runtime_v1');
 try{return await fn();}finally{await db.exec('RESET ROLE');}
}
const tokenState=async db=>(await db.query(`SELECT digest,user_id,revoked,
 created_at::text AS created_at,expires_at::text AS expires_at FROM public.library_tokens ORDER BY digest`)).rows;
const tupleState=async db=>(await db.query('SELECT digest,ctid::text AS ctid,xmin::text AS xmin FROM public.library_tokens ORDER BY digest')).rows;
const receipts=async db=>(await db.query('SELECT name,sha256,applied_at::text AS applied_at FROM public.library_schema_migrations ORDER BY name')).rows;
async function tokenPrivileges(db){
 return (await db.query(`SELECT
  has_table_privilege('lyra_runtime_v1','public.library_tokens','SELECT') AS token_select,
  has_table_privilege('lyra_runtime_v1','public.library_tokens','UPDATE') AS table_update,
  has_any_column_privilege('lyra_runtime_v1','public.library_tokens','UPDATE') AS any_update,
  has_table_privilege('lyra_runtime_v1','public.library_tokens','INSERT') AS token_insert,
  has_table_privilege('lyra_runtime_v1','public.library_tokens','DELETE') AS token_delete,
  has_table_privilege('lyra_runtime_v1','public.library_tokens','TRUNCATE') AS token_truncate,
  has_schema_privilege('lyra_runtime_v1','public','CREATE') AS schema_create`)).rows[0];
}
async function assertLeastPrivilege(db){
 assert.deepEqual(await tokenPrivileges(db),{token_select:true,table_update:false,any_update:true,
  token_insert:false,token_delete:false,token_truncate:false,schema_create:false});
 for(const field of existingFields)for(const action of ['UPDATE','INSERT'])assert.equal((await db.query(
  "SELECT has_column_privilege('lyra_runtime_v1','public.library_tokens',$1,$2) AS allowed",[field,action])).rows[0].allowed,false,`${field}:${action}`);
 assert.equal((await db.query("SELECT has_column_privilege('lyra_runtime_v1','public.library_tokens',$1,'UPDATE') AS allowed",[anchor])).rows[0].allowed,true);
 assert.equal((await db.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='lyra_runtime_v1'")).rows[0].rolcanlogin,false);
}
async function privilegeSnapshot(db){
 return (await db.query(`SELECT c.oid::regclass::text AS relation,c.relacl::text AS table_acl,
  a.attname,a.attacl::text AS column_acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  WHERE n.nspname='public' AND c.relkind='r' ORDER BY relation,a.attnum`)).rows;
}

test('manifest adds only 032 immediately after 029 and leaves 030/031 unregistered',()=>{
 assert.deepEqual(migrationNames,[...publicNames,name]);
});

test('minimal observed-role fixture reproduces 42501 before 032 and admits real row locks afterwards',async t=>{
 const db=await baseline(t),before=await tokenState(db),acl=await privilegeSnapshot(db);
 assert.deepEqual(await tokenPrivileges(db),{token_select:true,table_update:false,any_update:false,
  token_insert:false,token_delete:false,token_truncate:false,schema_create:false});
 await asRuntime(db,async()=>{
  assert.equal((await db.query('SELECT digest FROM public.library_tokens WHERE false')).rows.length,0);
  await denied(db.query('SELECT digest FROM public.library_tokens WHERE false FOR UPDATE'));
  await denied(db.query('SELECT digest FROM public.library_tokens WHERE digest=$1 FOR UPDATE',['lock-token']));
 });
 assert.deepEqual(await migrateLibrary(adapt(db)),[name]);
 await assertLeastPrivilege(db);
 await db.transaction(async tx=>{
  await tx.exec('SET LOCAL ROLE lyra_runtime_v1');
  assert.equal((await tx.query('SELECT digest FROM public.library_tokens WHERE false FOR UPDATE')).rows.length,0);
  assert.deepEqual((await tx.query('SELECT digest FROM public.library_tokens WHERE digest=$1 FOR UPDATE',['lock-token'])).rows,[{digest:'lock-token'}]);
 });
 await asRuntime(db,async()=>{
  assert.equal((await db.query('UPDATE public.library_tokens SET auth_lock_anchor=false WHERE digest=$1 RETURNING auth_lock_anchor',['lock-token'])).rows[0].auth_lock_anchor,false);
  await assert.rejects(db.query('UPDATE public.library_tokens SET auth_lock_anchor=true WHERE digest=$1',['lock-token']),{code:'23514'});
  await assert.rejects(db.query('UPDATE public.library_tokens SET auth_lock_anchor=NULL WHERE digest=$1',['lock-token']),e=>['23502','23514'].includes(e.code));
  for(const field of existingFields)await denied(db.query(`UPDATE public.library_tokens SET ${field}=${field} WHERE digest=$1`,['lock-token']));
  for(const statement of [
   "UPDATE public.library_tokens SET digest='replacement' WHERE digest='lock-token'",
   "UPDATE public.library_tokens SET user_id='other-owner' WHERE digest='lock-token'",
   "UPDATE public.library_tokens SET revoked=false WHERE digest='revoked-token'",
   "UPDATE public.library_tokens SET revoked=true WHERE digest='lock-token'",
   "UPDATE public.library_tokens SET expires_at='2100-01-01' WHERE digest='lock-token'",
   "UPDATE public.library_tokens SET expires_at=NULL WHERE digest='lock-token'",
   "UPDATE public.library_tokens SET created_at=clock_timestamp() WHERE digest='lock-token'",
   "UPDATE public.library_tokens SET auth_lock_anchor=false,revoked=false WHERE digest='revoked-token'",
   "INSERT INTO public.library_tokens(digest,user_id) VALUES('forbidden','lock-owner')",
   'INSERT INTO public.library_tokens(auth_lock_anchor) VALUES(false)',
   "DELETE FROM public.library_tokens WHERE digest='lock-token'",
   'TRUNCATE public.library_tokens CASCADE',
   'ALTER TABLE public.library_tokens DROP CONSTRAINT library_tokens_auth_lock_anchor_false',
   'CREATE TABLE public.forbidden_token_lock_table(id integer)',
   "UPDATE public.library_users SET unlimited_generation=true WHERE id='lock-owner'",
   "UPDATE public.library_users SET disabled=false WHERE id='lock-owner'",
   'UPDATE public.library_settings SET enabled=true',
   'UPDATE public.membership_settings SET public_access_enabled=true'
  ])await denied(db.query(statement));
 });
 assert.deepEqual(await tokenState(db),before);
 const after=await privilegeSnapshot(db);
 assert.deepEqual(after.filter(row=>row.attname!==anchor),acl,'all prior table and column ACLs preserved');
 assert.equal(after.filter(row=>row.attname===anchor).length,1);
 assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.library_tokens WHERE auth_lock_anchor IS DISTINCT FROM false')).rows[0].n,0);
});

test('fresh actual runner commits all checksummed receipts atomically without 030/031',async t=>{
 const db=await database(t);await runtime(db);
 assert.deepEqual(await migrateLibrary(adapt(db)),[...publicNames,name]);
 const first=await receipts(db);
 assert.deepEqual(first.map(row=>row.name),[...publicNames,name]);
 for(const row of first)assert.equal(row.sha256,sha(await sql(row.name)),row.name);
 assert.equal((await db.query("SELECT to_regnamespace('listening_v2')::text AS schema")).rows[0].schema,null);
 const trace=[];
 assert.deepEqual(await migrateLibrary(adapt(db,{trace})),[]);
 assert.deepEqual(await receipts(db),first);
 assert.equal(trace.some(call=>call.text.includes('auth_token_lock_anchor_catalog_mismatch')),false,'receipted migration SQL must not rerun');
 await db.query("UPDATE public.library_schema_migrations SET sha256='changed' WHERE name=$1",[name]);
 await assert.rejects(migrateLibrary(adapt(db)),{code:'migration_changed'});
});

test('failure after 032 DDL/grant but before its receipt rolls back the entire fresh migration transaction',async t=>{
 const db=await database(t);await runtime(db);
 await assert.rejects(migrateLibrary(adapt(db,{failReceipt:true})),{code:'injected_032_receipt_failure'});
 const row=(await db.query(`SELECT to_regclass('public.library_users')::text AS users,
  to_regclass('public.library_tokens')::text AS tokens,
  to_regclass('public.library_schema_migrations')::text AS receipts`)).rows[0];
 assert.deepEqual(row,{users:null,tokens:null,receipts:null});
 assert.deepEqual(await migrateLibrary(adapt(db)),[...publicNames,name]);
});

test('failed upgrade rolls back the anchor/grant/new receipt while retaining every old receipt and token',async t=>{
 const db=await baseline(t),before=await tokenState(db),prior=await receipts(db),privileges=await tokenPrivileges(db);
 await assert.rejects(migrateLibrary(adapt(db,{failReceipt:true})),{code:'injected_032_receipt_failure'});
 assert.deepEqual(await receipts(db),prior);assert.deepEqual(await tokenState(db),before);
 assert.deepEqual(await tokenPrivileges(db),privileges);
 assert.equal((await db.query("SELECT count(*)::integer AS n FROM pg_attribute WHERE attrelid='public.library_tokens'::regclass AND attname=$1 AND NOT attisdropped",[anchor])).rows[0].n,0);
 assert.deepEqual(await migrateLibrary(adapt(db)),[name]);
});

test('direct 032 reapplication is idempotent and resolves only public under a hostile search_path',async t=>{
 const db=await baseline(t),before=await tokenState(db),prior=await receipts(db);
 await db.exec('CREATE SCHEMA lock_shadow; CREATE TABLE lock_shadow.library_tokens(digest text PRIMARY KEY)');
 await db.exec('SET search_path=lock_shadow,public,pg_catalog');
 const text=await sql(name);assert.ok(text.startsWith('BEGIN;'));
 await db.exec(text);const tuples=await tupleState(db),acl=await privilegeSnapshot(db);
 await db.exec(text);await db.exec(text);
 assert.deepEqual(await tokenState(db),before);assert.deepEqual(await tupleState(db),tuples,'reapplication must not backfill/rewrite rows');
 assert.deepEqual(await privilegeSnapshot(db),acl);assert.deepEqual(await receipts(db),prior,'direct apply invents no receipt');
 assert.equal((await db.query("SELECT count(*)::integer AS n FROM pg_attribute WHERE attrelid='lock_shadow.library_tokens'::regclass AND attname=$1 AND NOT attisdropped",[anchor])).rows[0].n,0);
 await db.exec('SET search_path=public,pg_catalog');
 assert.deepEqual(await migrateLibrary(adapt(db)),[name],'runner may safely establish receipt after exact direct apply');
 await assertLeastPrivilege(db);
});

test('role absence creates no login; actual grant replay repairs late provisioning using only privilege blocks',async t=>{
 const db=await baseline(t,{role:false}),before=await tokenState(db);
 const roles=(await db.query('SELECT rolname,rolcanlogin FROM pg_roles ORDER BY rolname')).rows;
 assert.deepEqual(await migrateLibrary(adapt(db)),[name]);
 assert.deepEqual((await db.query('SELECT rolname,rolcanlogin FROM pg_roles ORDER BY rolname')).rows,roles);
 assert.equal((await db.query("SELECT count(*)::integer AS n FROM pg_roles WHERE rolname='lyra_runtime_v1'")).rows[0].n,0);
 const prior=await receipts(db),tuples=await tupleState(db);
 await runtime(db);await observedSelect(db);
 await asRuntime(db,()=>denied(db.query('SELECT digest FROM public.library_tokens WHERE false FOR UPDATE')));
 const calls=[],recording={query:async text=>{calls.push(text);return db.exec(text);}};
 await replayMembershipRoleGrants(recording);await replayMembershipRoleGrants(recording);
 const text=await sql(name),block=text.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g)?.filter(b=>b.includes('pg_roles')&&b.includes('GRANT '));
 assert.equal(block?.length,1);
 const body=block[0].slice('DO $$ '.length,-' $$;'.length)+';';
 assert.equal(calls.length,2,'one atomic statement per actual replay call');
 for(const call of calls){
  assert.equal(call.split(body).length-1,1,'unchanged 032 body occurs exactly once per replay');
  assert.match(call,/^DO \$membership_role_replay\$\nBEGIN\n/);
  assert.ok(call.endsWith('\nEND $membership_role_replay$;'));
  assert.doesNotMatch(call,/\b(?:ALTER TABLE|CREATE (?:TABLE|SCHEMA|ROLE)|INSERT INTO|DELETE FROM|TRUNCATE(?: TABLE)?)\b/);
  assert.doesNotMatch(call,/\bUPDATE\s+(?:public\.)?library_tokens\s+SET\b/);
 }
 await assertLeastPrivilege(db);
 await asRuntime(db,async()=>assert.equal((await db.query('SELECT digest FROM public.library_tokens WHERE digest=$1 FOR UPDATE',['lock-token'])).rows.length,1));
 assert.deepEqual(await tokenState(db),before);assert.deepEqual(await tupleState(db),tuples);assert.deepEqual(await receipts(db),prior);
 assert.equal((await db.query("SELECT to_regnamespace('listening_v2')::text AS schema")).rows[0].schema,null);
});

test('032 fails closed on missing/wrong public relation, column type/default/nullability/generated/check drift',async t=>{
 const db=await baseline(t);await migrateLibrary(adapt(db));
 const text=body(await sql(name)),before=await tokenState(db),prior=await receipts(db);
 const changes=[
  'ALTER TABLE public.library_tokens RENAME TO renamed_tokens',
  'ALTER TABLE public.library_tokens RENAME TO renamed_tokens; CREATE VIEW public.library_tokens AS SELECT * FROM public.renamed_tokens',
  'ALTER TABLE public.library_tokens ALTER COLUMN auth_lock_anchor DROP NOT NULL',
  'ALTER TABLE public.library_tokens ALTER COLUMN auth_lock_anchor DROP DEFAULT',
  'ALTER TABLE public.library_tokens ALTER COLUMN auth_lock_anchor SET DEFAULT true',
  'ALTER TABLE public.library_tokens DROP CONSTRAINT library_tokens_auth_lock_anchor_false',
  'ALTER TABLE public.library_tokens DROP CONSTRAINT library_tokens_auth_lock_anchor_false; ALTER TABLE public.library_tokens ADD CONSTRAINT library_tokens_auth_lock_anchor_false CHECK (true)',
  'ALTER TABLE public.library_tokens DROP CONSTRAINT library_tokens_auth_lock_anchor_false; ALTER TABLE public.library_tokens ADD CONSTRAINT library_tokens_auth_lock_anchor_false CHECK (auth_lock_anchor IS FALSE) NOT VALID',
  'ALTER TABLE public.library_tokens DROP CONSTRAINT library_tokens_auth_lock_anchor_false; ALTER TABLE public.library_tokens ADD CONSTRAINT library_tokens_auth_lock_anchor_false CHECK (revoked IS NOT NULL)',
  'ALTER TABLE public.library_tokens DROP CONSTRAINT library_tokens_auth_lock_anchor_false; ALTER TABLE public.library_tokens ALTER COLUMN auth_lock_anchor DROP DEFAULT; ALTER TABLE public.library_tokens ALTER COLUMN auth_lock_anchor TYPE integer USING 0; ALTER TABLE public.library_tokens ALTER COLUMN auth_lock_anchor SET DEFAULT 0; ALTER TABLE public.library_tokens ADD CONSTRAINT library_tokens_auth_lock_anchor_false CHECK (auth_lock_anchor=0)',
  'ALTER TABLE public.library_tokens DROP COLUMN auth_lock_anchor; ALTER TABLE public.library_tokens ADD COLUMN auth_lock_anchor boolean GENERATED ALWAYS AS (false) STORED NOT NULL; ALTER TABLE public.library_tokens ADD CONSTRAINT library_tokens_auth_lock_anchor_false CHECK (auth_lock_anchor IS FALSE)',
  'ALTER TABLE public.library_tokens DROP COLUMN auth_lock_anchor; ALTER TABLE public.library_tokens ADD CONSTRAINT library_tokens_auth_lock_anchor_false CHECK (revoked IS NOT NULL)'
 ];
 for(const change of changes)await assert.rejects(db.transaction(async tx=>{await tx.exec(change);await tx.exec(text);}),drift,change);
 assert.deepEqual(await tokenState(db),before);assert.deepEqual(await receipts(db),prior);await assertLeastPrivilege(db);
});

test('grant replay refuses anchor drift instead of repairing DDL or bypassing immutable receipts',async t=>{
 const db=await baseline(t);await migrateLibrary(adapt(db));const prior=await receipts(db);
 await assert.rejects(db.transaction(async tx=>{
  await tx.exec('ALTER TABLE public.library_tokens DROP CONSTRAINT library_tokens_auth_lock_anchor_false');
  await replayMembershipRoleGrants({query:text=>tx.exec(text)});
 }),drift);
 assert.deepEqual(await receipts(db),prior);await assertLeastPrivilege(db);
});
