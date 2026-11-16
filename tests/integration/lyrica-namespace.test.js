import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateLibrary,migrationNames} from '../../scripts/library-migrations.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';

const cutover='037-lyrica-namespace.sql';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sql=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
const adapter=(db,{failReceipt=false}={})=>({transaction:fn=>db.transaction(tx=>fn({query:async(text,args)=>{
 if(failReceipt&&text.startsWith('INSERT INTO library_schema_migrations')&&args?.[0]===cutover)throw new Error('injected_namespace_receipt_failure');
 return args?tx.query(text,args):(await tx.exec(text)).at(-1);
}}))});
async function prior(t,{roles=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 if(roles)await db.exec(`CREATE ROLE lyra_runtime_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 CREATE ROLE lyra_account_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 CREATE ROLE lyra_dashboard_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 CREATE ROLE lyra_dashboard_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
 const selected=migrationNames.filter(name=>name!==cutover);
 for(const name of selected)await db.exec(await sql(name));
 await db.exec('CREATE TABLE library_schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const name of selected)await db.query('INSERT INTO library_schema_migrations(name,sha256) VALUES($1,$2)',[name,hash(await sql(name))]);
 if(roles)await db.exec(`GRANT USAGE ON SCHEMA lyra_dashboard TO lyra_dashboard_reader;
 GRANT SELECT ON ALL TABLES IN SCHEMA lyra_dashboard TO lyra_dashboard_reader;
 ALTER ROLE lyra_dashboard_reader SET default_transaction_read_only=on;
 ALTER ROLE lyra_dashboard_reader SET search_path=lyra_dashboard,pg_catalog;
 GRANT USAGE ON SCHEMA lyra_dashboard_control TO lyra_dashboard_operator;
 GRANT EXECUTE ON FUNCTION lyra_dashboard_control.set_control(text,uuid,bigint,text,boolean),lyra_dashboard_control.rollback_translation(text,uuid,text,text,uuid,uuid,text) TO lyra_dashboard_operator;
 ALTER ROLE lyra_dashboard_operator SET search_path=pg_catalog;`);
 await db.query("INSERT INTO lyra_dashboard_control.operators(subject) VALUES('owner')");
 return db;
}
const receipts=async db=>(await db.query('SELECT name,sha256,applied_at::text FROM library_schema_migrations ORDER BY name')).rows;
const objects=async db=>(await db.query(`SELECT n.oid,n.nspname,n.nspowner,n.nspacl::text,
 c.oid AS relation,c.relname,c.relowner,c.relacl::text FROM pg_namespace n
 LEFT JOIN pg_class c ON c.relnamespace=n.oid WHERE n.nspname LIKE 'lyr%dashboard%' ORDER BY n.oid,c.oid`)).rows;
const functionIdentity=async db=>(await db.query(`SELECT p.oid,p.proname,p.proowner,p.proacl::text,p.prosecdef,p.proconfig,p.prosrc
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'lyr%dashboard_control' ORDER BY p.oid`)).rows;
const roles=async db=>(await db.query(`SELECT oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,rolconnlimit,rolconfig
 FROM pg_roles WHERE rolname LIKE 'lyr%_%' ORDER BY oid`)).rows;

test('namespace cutover preserves stored rows, schema and role identity, existing receipts and least privilege',async t=>{
 const db=await prior(t),oldObjects=await objects(db),oldRoles=await roles(db),oldReceipts=await receipts(db),oldFunctions=await functionIdentity(db);
 await db.query("INSERT INTO library_users(id) VALUES('retained-owner')");
 const retained=(await db.query('SELECT * FROM library_users ORDER BY id')).rows;
 const reviewed=[{name:cutover,sha256:hash(await sql(cutover))}];
 assert.deepEqual(await migrateLibrary(adapter(db),{expectedPending:reviewed}),[cutover]);
 assert.deepEqual((await db.query('SELECT * FROM library_users ORDER BY id')).rows,retained);
 assert.deepEqual((await receipts(db)).filter(row=>row.name!==cutover),oldReceipts);
 assert.deepEqual(await objects(db),oldObjects.map(row=>({...row,nspname:row.nspname.replace('lyra_','lyrica_'),nspacl:row.nspacl?.replaceAll('lyra_','lyrica_')??null,relacl:row.relacl?.replaceAll('lyra_','lyrica_')??null})));
 assert.deepEqual(await functionIdentity(db),oldFunctions.map(row=>({...row,prosrc:row.prosrc.replaceAll('lyra_dashboard_control','lyrica_dashboard_control'),proacl:row.proacl?.replaceAll('lyra_','lyrica_')??null})));
 assert.deepEqual(await roles(db),oldRoles.map(row=>({...row,rolname:row.rolname.replace('lyra_','lyrica_'),rolconfig:row.rolconfig?.map(value=>value.replaceAll('lyra_dashboard','lyrica_dashboard'))??null})));
 await db.exec('SET ROLE lyrica_dashboard_operator');
 const changed=(await db.query('SELECT lyrica_dashboard_control.set_control($1,$2,1,$3,true) AS result',['owner',randomUUID(),'reviews'])).rows[0].result;
 assert.equal(changed.reviews,true);
 await assert.rejects(db.query('SELECT * FROM public.library_users'),{code:'42501'});
 await assert.rejects(db.query('SELECT * FROM lyrica_dashboard_control.operators'),{code:'42501'});
 await db.exec('RESET ROLE');
 const functions=(await db.query("SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lyrica_dashboard_control'")).rows;
 assert.ok(functions.length>=4);assert.ok(functions.every(row=>!row.prosrc.includes('lyra_dashboard')));
 const afterFunctions=await functionIdentity(db),afterReceipts=await receipts(db);
 await db.exec(await sql(cutover));
 assert.deepEqual(await functionIdentity(db),afterFunctions);assert.deepEqual(await receipts(db),afterReceipts);
 assert.deepEqual(await migrateLibrary(adapter(db),{expectedPending:[]}),[]);
});

test('namespace cutover refuses conflicting targets before changing any schema, role or receipt',async t=>{
 const db=await prior(t);await db.exec('CREATE SCHEMA lyrica_dashboard');
 const beforeObjects=await objects(db),beforeRoles=await roles(db),beforeReceipts=await receipts(db);
 await assert.rejects(migrateLibrary(adapter(db)),/namespace_target_conflict/);
 assert.deepEqual(await objects(db),beforeObjects);assert.deepEqual(await roles(db),beforeRoles);assert.deepEqual(await receipts(db),beforeReceipts);
});

test('namespace receipt failure rolls every rename and function replacement back',async t=>{
 const db=await prior(t),beforeObjects=await objects(db),beforeRoles=await roles(db),beforeReceipts=await receipts(db);
 await assert.rejects(migrateLibrary(adapter(db,{failReceipt:true})),/injected_namespace_receipt_failure/);
 assert.deepEqual(await objects(db),beforeObjects);assert.deepEqual(await roles(db),beforeRoles);assert.deepEqual(await receipts(db),beforeReceipts);
});

test('fresh schema creates only canonical schemas and current late account replay preserves privilege bounds',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 assert.deepEqual(await migrateLibrary(adapter(db)),migrationNames);
 assert.equal((await db.query("SELECT to_regnamespace('lyra_dashboard')::text AS prior,to_regnamespace('lyrica_dashboard')::text AS current")).rows[0].prior,null);
 await db.exec('CREATE ROLE lyrica_account_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
 await replayMembershipRoleGrants(db);await replayMembershipRoleGrants(db);
 assert.equal((await db.query("SELECT has_column_privilege('lyrica_account_v1','library_users','id','INSERT') AS allowed")).rows[0].allowed,true);
 assert.equal((await db.query("SELECT has_column_privilege('lyrica_account_v1','library_users','unlimited_generation','UPDATE') AS allowed")).rows[0].allowed,false);
 assert.equal((await db.query("SELECT has_column_privilege('lyrica_account_v1','membership_settings','purchases_enabled','UPDATE') AS allowed")).rows[0].allowed,false);
 assert.equal((await db.query("SELECT has_schema_privilege('lyrica_account_v1','public','CREATE') AS allowed")).rows[0].allowed,false);
});


test('namespace cutover refuses a canonical role collision without merging authority',async t=>{
 const db=await prior(t);await db.exec('CREATE ROLE lyrica_account_v1');
 const beforeObjects=await objects(db),beforeRoles=await roles(db),beforeReceipts=await receipts(db);
 await assert.rejects(migrateLibrary(adapter(db)),/namespace_target_conflict/);
 assert.deepEqual(await objects(db),beforeObjects);assert.deepEqual(await roles(db),beforeRoles);assert.deepEqual(await receipts(db),beforeReceipts);
});

test('namespace cutover refuses an independently changed owner-control body before any rename',async t=>{
 const db=await prior(t);
 await db.exec(`CREATE OR REPLACE FUNCTION lyra_dashboard_control.immutable_action() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'independent_change'; END $$;`);
 const beforeObjects=await objects(db),beforeRoles=await roles(db),beforeReceipts=await receipts(db),beforeFunctions=await functionIdentity(db);
 await assert.rejects(migrateLibrary(adapter(db)),/namespace_function_drift/);
 assert.deepEqual(await objects(db),beforeObjects);assert.deepEqual(await roles(db),beforeRoles);assert.deepEqual(await receipts(db),beforeReceipts);assert.deepEqual(await functionIdentity(db),beforeFunctions);
});

test('role rename retains an existing SCRAM verifier and login attributes',async t=>{
 const db=await prior(t);await db.exec("SET password_encryption='scram-sha-256'; ALTER ROLE lyra_account_v1 LOGIN PASSWORD 'synthetic-namespace-test-only'");
 const before=(await db.query("SELECT oid,rolpassword,rolcanlogin FROM pg_authid WHERE rolname='lyra_account_v1'")).rows[0];
 assert.ok(before.rolpassword.startsWith('SCRAM-SHA-256$'));
 await migrateLibrary(adapter(db));
 const after=(await db.query("SELECT oid,rolpassword,rolcanlogin FROM pg_authid WHERE rolname='lyrica_account_v1'")).rows[0];
 assert.deepEqual(after,before);
});
