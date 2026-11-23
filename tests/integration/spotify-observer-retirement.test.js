import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateLibrary as migrateRegistered,migrationNames as registeredNames} from '../../scripts/library-migrations.js';

// Spotify is native-only. 038 destroys the retired server observer's grants and
// state; everything else in the database must be byte-for-byte unchanged.
const retirement='038-retire-spotify-observer.sql';
// 038 is qualified on the manifest through itself; 039 and 040 have their own tests.
const migrationNames=registeredNames.slice(0,registeredNames.indexOf(retirement)+1);
async function migrateLibrary(database,options){
 const saved=[...registeredNames];registeredNames.splice(0,registeredNames.length,...migrationNames);
 try{return await migrateRegistered(database,options);}finally{registeredNames.splice(0,registeredNames.length,...saved);}
}
const retiredTables=['spotify_outbox','spotify_snapshot_capabilities','spotify_provider_circuits','spotify_connections'];
const retiredRelations=[...retiredTables,'spotify_connections_owner','spotify_connections_owner_id_key_id_enrollment_id_key',
 'spotify_connections_pkey','spotify_outbox_pending','spotify_outbox_pkey','spotify_provider_circuits_pkey','spotify_snapshot_capabilities_pkey'].sort();
const sql=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const adapter=db=>({transaction:fn=>db.transaction(tx=>fn({query:async(text,args)=>args?tx.query(text,args):(await tx.exec(text)).at(-1)}))});
const system="n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'";

async function migrateThrough(db,names){
 const saved=[...registeredNames];registeredNames.splice(0,registeredNames.length,...names);
 try{return await migrateRegistered(adapter(db));}finally{registeredNames.splice(0,registeredNames.length,...saved);}
}
async function database(t,{roles=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 // Historical role names: 027 grants to them and 037 renames them in place.
 if(roles)await db.exec(`CREATE ROLE lyra_runtime_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  CREATE ROLE lyra_account_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
 return db;
}
async function catalog(db){
 const rows=async text=>(await db.query(text)).rows;
 return {
  relations:await rows(`SELECT n.nspname,c.relname,c.relkind,c.relowner,c.relacl::text AS acl,
   coalesce(i.indrelid::regclass::text,c.relname) AS parent FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   LEFT JOIN pg_index i ON i.indexrelid=c.oid WHERE ${system} ORDER BY 1,2`),
  columns:await rows(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attacl::text AS acl,
   coalesce(i.indrelid::regclass::text,c.relname) AS parent FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indexrelid=c.oid
   WHERE ${system} AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2`),
  constraints:await rows(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(c.oid) AS definition
   FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE ${system} ORDER BY 1,2`),
  functions:await rows(`SELECT n.nspname,p.proname,md5(p.prosrc) AS source,p.proacl::text AS acl FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${system} ORDER BY 1,2,3`),
  namespaces:await rows(`SELECT n.nspname,n.nspacl::text AS acl FROM pg_namespace n WHERE ${system} ORDER BY 1`),
  roles:await rows("SELECT rolname,rolcanlogin,rolsuper,rolinherit,rolbypassrls FROM pg_roles WHERE rolname LIKE 'lyr%' ORDER BY 1")
 };
}
async function data(db){
 const tables=(await db.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='r' AND ${system} ORDER BY 1,2`)).rows,image={};
 for(const {nspname,relname} of tables)image[nspname+'.'+relname]=(await db.query(
  `SELECT to_jsonb(t)::text AS row FROM ${nspname}.${relname} t ORDER BY 1`)).rows.map(row=>row.row);
 return image;
}
async function seed(db){
 await db.query("INSERT INTO library_users(id) VALUES('spotify-owner'),('other-owner')");
 await db.query("INSERT INTO library_tokens(digest,user_id) VALUES('owner-token','spotify-owner')");
 await db.query(`INSERT INTO lyric_documents(id,recording_key,source_hash,selection_revision,response,structure,source_capsule,model_context)
  VALUES('spotify-doc','spotify-recording','source-hash','rev','{}','{}','{"provider":"lrclib"}','{"version":1}')`);
 await db.query("INSERT INTO live_lyrics_push_receipts(activity_id,user_id,token_digest,expires_at) VALUES('activity','spotify-owner','push-digest','2099-01-01T00:00:00Z')");
 for(const n of [1,2]){
  const id='connection-'+n,data={id,status:'connected',refresh:{version:2,ciphertext:'sealed-refresh-'+n},access:{version:2,ciphertext:'sealed-access-'+n}};
  await db.query('INSERT INTO spotify_connections(id,owner_id,key_id,credential_digest,enrollment_id,data) VALUES($1,$2,$3,$4,$5,$6)',[id,'spotify-owner','key-'+n,'owner-token','enrollment-'+n,data]);
  await db.query("INSERT INTO spotify_outbox(id,connection_id,epoch,kind,due_at_ms,data,expires_at) VALUES($1,$2,'epoch','tick',0,'{}','2099-01-01T00:00:00Z')",['poll-'+n,id]);
  await db.query("INSERT INTO spotify_snapshot_capabilities(digest,connection_id,session_id,expires_at_ms) VALUES($1,$2,'live',9007199254740991)",['capability-'+n,id]);
 }
 await db.query("INSERT INTO spotify_provider_circuits(id,not_before_ms,reason) VALUES('developer-bucket',1,'rate_limited')");
}
const present=async(db,name)=>(await db.query('SELECT to_regclass($1)::text AS name',['public.'+name])).rows[0].name;

test('038 is registered once, followed only by 039 and 040, and drops exactly the retired observer tables without CASCADE',async()=>{
 assert.deepEqual(registeredNames.slice(registeredNames.indexOf(retirement)),[retirement,'039-anonymous-accounts.sql','040-starter-song-totals.sql']);
 assert.equal(registeredNames.filter(name=>name.startsWith('038-')).length,1);
 const text=await sql(retirement);
 // The runner strips only a leading BEGIN and trailing COMMIT.
 assert.match(text,/^BEGIN;\n/);assert.match(text,/\nCOMMIT;\n$/);
 const statements=text.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('--'));
 assert.deepEqual(statements,['BEGIN;',...retiredTables.map(table=>`DROP TABLE IF EXISTS public.${table};`),'COMMIT;']);
 // 026 recording identity, 027 history and the Live Lyrics relay remain registered.
 for(const name of ['026-spotify-recordings.sql','027-spotify-background.sql','022-live-lyrics-push.sql','023-live-lyrics-runtime.sql','024-live-lyrics-cleanup.sql'])
  assert.ok(migrationNames.indexOf(name)>=0&&migrationNames.indexOf(name)<migrationNames.indexOf(retirement),name);
});

test('populated upgrade destroys Spotify grants and state and leaves every other object, grant and row unchanged',async t=>{
 const db=await database(t),prior=migrationNames.filter(name=>name!==retirement);
 assert.deepEqual(await migrateThrough(db,prior),prior);
 await seed(db);
 const before=await catalog(db),rows=await data(db);
 for(const table of retiredTables)assert.ok(rows['public.'+table].length>0,table);
 assert.ok(before.relations.some(r=>r.relname==='spotify_connections'&&r.acl.includes('lyrica_runtime_v1')&&r.acl.includes('lyrica_account_v1')));
 assert.deepEqual(before.relations.filter(r=>retiredTables.includes(r.parent)).map(r=>r.relname).sort(),retiredRelations);

 assert.deepEqual(await migrateLibrary(adapter(db),{expectedPending:[{name:retirement,sha256:hash(await sql(retirement))}]}),[retirement]);
 const after=await catalog(db),remaining=await data(db);
 for(const table of retiredTables)assert.equal(await present(db,table),null,table);
 const kept=row=>!retiredTables.includes(row.parent??row.relation??row.relname);
 assert.deepEqual(after.relations,before.relations.filter(kept));
 assert.deepEqual(after.columns,before.columns.filter(kept));
 assert.deepEqual(after.constraints,before.constraints.filter(kept));
 for(const key of ['functions','namespaces','roles'])assert.deepEqual(after[key],before[key],key);
 assert.equal(JSON.stringify(after).includes('spotify_'),false,'no retired relation, index, constraint or grant survives');
 const expected={...rows};for(const table of retiredTables)delete expected['public.'+table];
 delete expected['public.library_schema_migrations'];const receipts=remaining['public.library_schema_migrations'];
 delete remaining['public.library_schema_migrations'];
 assert.deepEqual(remaining,expected,'accounts, memberships, relay, recordings and documents keep their exact rows');
 assert.equal(JSON.stringify(remaining).includes('sealed-refresh'),false);
 assert.deepEqual(receipts.map(row=>JSON.parse(row).name).sort(),[...migrationNames].sort());
 // 026 Spotify recording identity columns survive with their stored values.
 assert.deepEqual((await db.query("SELECT source_capsule,model_context FROM lyric_documents WHERE id='spotify-doc'")).rows,[{source_capsule:{provider:'lrclib'},model_context:{version:1}}]);
 for(const role of ['lyrica_runtime_v1','lyrica_account_v1'])
  assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,'public.live_lyrics_push_receipts','SELECT'])).rows[0].allowed,role==='lyrica_runtime_v1');

 // Idempotent: a direct repeat and a second runner pass change nothing.
 await db.exec(await sql(retirement));
 assert.deepEqual(await catalog(db),after);
 assert.deepEqual(await migrateLibrary(adapter(db)),[]);
});

test('038 refuses atomically, dropping nothing, when an unexpected object depends on a retired table',async t=>{
 const db=await database(t),prior=migrationNames.filter(name=>name!==retirement);
 await migrateThrough(db,prior);await seed(db);
 await db.exec('CREATE VIEW public.unexpected_spotify_dependent AS SELECT id FROM public.spotify_connections');
 const before=await catalog(db),rows=await data(db);
 await assert.rejects(migrateLibrary(adapter(db)),{code:'2BP01'});
 assert.deepEqual(await catalog(db),before);assert.deepEqual(await data(db),rows);
 for(const table of retiredTables)assert.equal(await present(db,table),table);
});

test('fresh installation and a never-provisioned observer schema both end without retired tables',async t=>{
 const fresh=await database(t,{roles:false});
 assert.deepEqual(await migrateLibrary(adapter(fresh)),migrationNames);
 for(const table of retiredTables)assert.equal(await present(fresh,table),null,table);
 assert.equal(await present(fresh,'live_lyrics_push_receipts'),'live_lyrics_push_receipts');
 assert.equal((await fresh.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='lyric_documents' AND column_name IN ('source_capsule','model_context')")).rows[0].n,2);

 const absent=await database(t),prior=migrationNames.filter(name=>name!==retirement);
 await migrateThrough(absent,prior);
 await absent.exec(retiredTables.map(table=>`DROP TABLE public.${table};`).join('\n'));
 const before=await catalog(absent);
 assert.deepEqual(await migrateLibrary(adapter(absent)),[retirement]);
 assert.deepEqual(await catalog(absent),before);
});
