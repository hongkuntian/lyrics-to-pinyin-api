import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateLibrary as migrateRegistered,migrationNames as registeredNames} from '../../scripts/library-migrations.js';
import {verifyBuildSchema} from '../../scripts/vercel-library-build.js';
import {recordStarterEvent} from '../../api/utils/song-library/starter-songs.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';

// Starter-song totals: shown and picked per pool song, nothing about a person.
const starters='040-starter-song-totals.sql',table='public.starter_song_totals';
// Isolate historical 040 behavior; the current build gate follows the full registry.
const migrationNames=registeredNames.slice(0,registeredNames.indexOf(starters)+1);
async function migrateLibrary(db,options){
 const saved=[...registeredNames];registeredNames.splice(0,registeredNames.length,...migrationNames);
 try{return await migrateRegistered(db,options);}finally{registeredNames.splice(0,registeredNames.length,...saved);}
}
const sql=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const adapter=db=>({transaction:fn=>db.transaction(tx=>fn({query:async(text,args)=>args?tx.query(text,args):(await tx.exec(text)).at(-1)}))});
const system="n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'";
const prior=migrationNames.slice(0,migrationNames.indexOf(starters));
const roles=['lyrica_runtime_v1','lyrica_account_v1'];

async function migrateThrough(db,names){
 const saved=[...migrationNames];migrationNames.splice(0,migrationNames.length,...names);
 try{return await migrateLibrary(adapter(db));}finally{migrationNames.splice(0,migrationNames.length,...saved);}
}
async function database(t,{withRoles=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 if(withRoles)for(const role of roles)await db.exec(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
 return db;
}
async function catalog(db){
 const rows=async text=>(await db.query(text)).rows;
 return {
  relations:await rows(`SELECT n.nspname,c.relname,c.relkind,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${system} ORDER BY 1,2`),
  columns:await rows(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attacl::text AS acl
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE ${system} AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2`),
  constraints:await rows(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(c.oid) AS definition
   FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE ${system} ORDER BY 1,2`),
  functions:await rows(`SELECT n.nspname,p.proname,md5(p.prosrc) AS source,p.proacl::text AS acl FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${system} ORDER BY 1,2,3`)
 };
}
const can=async(db,role,privilege)=>(await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',[role,table,privilege])).rows[0].ok;
const totals=async db=>(await db.query('SELECT song_id,shown::int AS shown,picked::int AS picked FROM starter_song_totals ORDER BY song_id')).rows;

test('040 follows 039 and the production build requires the latest registered receipt',async()=>{
 assert.deepEqual(migrationNames.slice(-2),['039-anonymous-accounts.sql',starters]);
 assert.equal(migrationNames.filter(name=>name.startsWith('040-')).length,1);
 const text=await sql(starters);
 // The runner strips only a leading BEGIN and trailing COMMIT.
 assert.match(text,/^BEGIN;\n/);assert.match(text,/\nCOMMIT;\n$/);
 // Additive only: no statement removes or rewrites anything.
 const statements=text.split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');
 assert.doesNotMatch(statements,/\b(CASCADE|DROP|DELETE|TRUNCATE|ALTER|UPDATE(?! ON))\b/);
 const asked=[],production={VERCEL:'1',VERCEL_ENV:'production'};
 await verifyBuildSchema({env:production,open:()=>({query:async(_,args)=>{asked.push(args[0]);return {rows:[{name:args[0]}]};},close:async()=>{}}),log:()=>{}});
 assert.deepEqual(asked,[registeredNames.at(-1)]);
 // A database migrated only through 039 does not pass the build.
 await assert.rejects(verifyBuildSchema({env:production,open:()=>({query:async(_,args)=>({rows:args[0]===registeredNames.at(-1)?[]:[{name:args[0]}]}),close:async()=>{}}),log:()=>{}}),
  /library_schema_migration_required/);
});

test('upgrade adds only the totals table, with counters that cannot go negative and no column for a person',async t=>{
 const db=await database(t);
 assert.deepEqual(await migrateThrough(db,prior),prior);
 const before=await catalog(db);
 assert.deepEqual(await migrateLibrary(adapter(db),{expectedPending:[{name:starters,sha256:hash(await sql(starters))}]}),[starters]);
 const after=await catalog(db),added=row=>(row.relname??row.relation)?.startsWith('starter_song_totals');
 for(const key of ['relations','columns','constraints'])assert.deepEqual(after[key].filter(row=>!added(row)),before[key],key);
 assert.deepEqual(after.functions,before.functions);
 assert.deepEqual(after.relations.filter(added).map(row=>[row.relname,row.relkind]),[['starter_song_totals','r'],['starter_song_totals_pkey','i']]);
 assert.deepEqual(after.columns.filter(row=>row.relname==='starter_song_totals').map(row=>[row.attname,row.type,row.attnotnull]),
  [['picked','bigint',true],['shown','bigint',true],['song_id','text',true]]);
 // Checks and the key only (PostgreSQL 18 also catalogs NOT NULL, already asserted per column).
 assert.deepEqual((await db.query(`SELECT conname FROM pg_constraint WHERE conrelid='${table}'::regclass AND contype IN ('c','p','f','u') ORDER BY 1`)).rows.map(row=>row.conname),
  ['starter_song_totals_picked_check','starter_song_totals_pkey','starter_song_totals_shown_check','starter_song_totals_song_id_check']);
 // No foreign key: a total is tied to no account, key, session or document.
 assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND (conrelid='${table}'::regclass OR confrelid='${table}'::regclass)`)).rows[0].n,0);

 await db.query("INSERT INTO starter_song_totals(song_id) VALUES('cmn-1')");
 assert.deepEqual(await totals(db),[{song_id:'cmn-1',shown:0,picked:0}]);
 for(const statement of ["UPDATE starter_song_totals SET shown=-1","UPDATE starter_song_totals SET picked=-1",
  "INSERT INTO starter_song_totals(song_id) VALUES('')",`INSERT INTO starter_song_totals(song_id) VALUES('${'x'.repeat(65)}')`])
  await assert.rejects(db.query(statement),{code:'23514'},statement);
 await assert.rejects(db.query("INSERT INTO starter_song_totals(song_id) VALUES('cmn-1')"),{code:'23505'});
 await db.query(`INSERT INTO starter_song_totals(song_id) VALUES('${'x'.repeat(64)}')`);
 await db.query("UPDATE starter_song_totals SET shown=9007199254740993 WHERE song_id='cmn-1'");
 assert.equal((await db.query("SELECT shown::text AS shown FROM starter_song_totals WHERE song_id='cmn-1'")).rows[0].shown,'9007199254740993');
});

test('the runtime login can read, insert and update the totals and nothing broader; the account login gets nothing',async t=>{
 const db=await database(t);await migrateLibrary(adapter(db));
 for(const [privilege,allowed] of [['SELECT',true],['INSERT',true],['UPDATE',true],['DELETE',false],['TRUNCATE',false],['REFERENCES',false],['TRIGGER',false]])
  assert.equal(await can(db,'lyrica_runtime_v1',privilege),allowed,privilege);
 for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal(await can(db,'lyrica_account_v1',privilege),false,privilege);
 assert.equal((await db.query("SELECT has_table_privilege('lyrica_runtime_v1',$1,'SELECT WITH GRANT OPTION') AS ok",[table])).rows[0].ok,false);
 assert.equal((await db.query(`SELECT relacl::text AS acl FROM pg_class WHERE oid='${table}'::regclass`)).rows[0].acl.includes('=r/'),false,'no PUBLIC grant');
 // The handler's own statement runs as the runtime login.
 await db.exec('SET ROLE lyrica_runtime_v1');
 try{
  const runtime={query:(text,args)=>db.query(text,args)};
  await recordStarterEvent(runtime,{ids:['ja-2','cmn-1'],shown:1,picked:0});
  await recordStarterEvent(runtime,{ids:['cmn-1'],shown:0,picked:1});
  assert.deepEqual(await totals(db),[{song_id:'cmn-1',shown:1,picked:1},{song_id:'ja-2',shown:1,picked:0}]);
  await assert.rejects(db.query('DELETE FROM starter_song_totals'),{code:'42501'});
  await assert.rejects(db.query('TRUNCATE starter_song_totals'),{code:'42501'});
 }finally{await db.exec('RESET ROLE');}
 await db.exec('SET ROLE lyrica_account_v1');
 try{await assert.rejects(db.query('SELECT 1 FROM starter_song_totals'),{code:'42501'});}finally{await db.exec('RESET ROLE');}
});

test('040 is idempotent and keeps recorded totals on a rerun',async t=>{
 const db=await database(t);await migrateThrough(db,prior);
 assert.deepEqual(await migrateLibrary(adapter(db)),[starters]);
 await db.query("INSERT INTO starter_song_totals(song_id,shown,picked) VALUES('cmn-1',5,2)");
 const shape=await catalog(db),image=(await db.query('SELECT * FROM starter_song_totals')).rows;
 await db.exec(await sql(starters));await db.exec(await sql(starters));
 assert.deepEqual(await catalog(db),shape);assert.deepEqual((await db.query('SELECT * FROM starter_song_totals')).rows,image);
 assert.deepEqual(await migrateLibrary(adapter(db)),[]);
});

test('a fresh installation without the runtime role still gets the table, and no grant',async t=>{
 const db=await database(t,{withRoles:false});
 assert.deepEqual(await migrateLibrary(adapter(db)),migrationNames);
 assert.equal((await db.query("SELECT to_regclass($1)::text AS name",[table])).rows[0].name,'starter_song_totals');
 assert.equal((await db.query(`SELECT relacl::text AS acl FROM pg_class WHERE oid='${table}'::regclass`)).rows[0].acl,null);
});

test('a runtime login provisioned after 040 gets the same three rights from the role replay',async t=>{
 const db=await database(t,{withRoles:false});await migrateLibrary(adapter(db));
 for(const role of roles)await db.exec(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
 for(const privilege of ['SELECT','INSERT','UPDATE'])assert.equal(await can(db,'lyrica_runtime_v1',privilege),false,privilege);
 const replay={query:text=>db.exec(text)};
 await replayMembershipRoleGrants(replay);await replayMembershipRoleGrants(replay);
 for(const [privilege,allowed] of [['SELECT',true],['INSERT',true],['UPDATE',true],['DELETE',false],['TRUNCATE',false]])
  assert.equal(await can(db,'lyrica_runtime_v1',privilege),allowed,privilege);
 for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal(await can(db,'lyrica_account_v1',privilege),false,privilege);
 await db.exec('SET ROLE lyrica_runtime_v1');
 try{await recordStarterEvent({query:(text,args)=>db.query(text,args)},{ids:['cmn-1'],shown:1,picked:0});}finally{await db.exec('RESET ROLE');}
 assert.deepEqual(await totals(db),[{song_id:'cmn-1',shown:1,picked:0}]);
 // Without the runtime role the replay still succeeds and grants nothing here.
 const plain=await database(t,{withRoles:false});await migrateLibrary(adapter(plain));
 await plain.exec('CREATE ROLE lyrica_account_v1 NOLOGIN');
 await replayMembershipRoleGrants({query:text=>plain.exec(text)});
 assert.equal((await plain.query(`SELECT relacl::text AS acl FROM pg_class WHERE oid='${table}'::regclass`)).rows[0].acl,null);
});
