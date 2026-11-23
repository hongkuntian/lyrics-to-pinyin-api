import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateLibrary as migrateRegistered,migrationNames as registeredNames} from '../../scripts/library-migrations.js';
import {replayMembershipRoleGrants,withoutRetiredRelations} from '../../scripts/membership-role-grants.js';

// Contract: Lyrica docs/ANONYMOUS_ACCOUNTS.md, "Reset and removal".
const anonymous='039-anonymous-accounts.sql';
// 039 is qualified on the manifest through itself; 040 has its own test.
const migrationNames=registeredNames.slice(0,registeredNames.indexOf(anonymous)+1);
async function migrateLibrary(database,options){
 const saved=[...registeredNames];registeredNames.splice(0,registeredNames.length,...migrationNames);
 try{return await migrateRegistered(database,options);}finally{registeredNames.splice(0,registeredNames.length,...saved);}
}
const sql=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const adapter=db=>({transaction:fn=>db.transaction(tx=>fn({query:async(text,args)=>args?tx.query(text,args):(await tx.exec(text)).at(-1)}))});
const system="n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'";
const prior=migrationNames.slice(0,migrationNames.indexOf(anonymous));

async function migrateThrough(db,names){
 const saved=[...registeredNames];registeredNames.splice(0,registeredNames.length,...names);
 try{return await migrateRegistered(adapter(db));}finally{registeredNames.splice(0,registeredNames.length,...saved);}
}
async function database(t,{roles=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 // Current role names: 039 grants to them. (Historical grants and the 037
 // rename have their own tests.)
 if(roles)await db.exec(`CREATE ROLE lyrica_runtime_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  CREATE ROLE lyrica_account_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
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
  functions:await rows(`SELECT n.nspname,p.proname,md5(p.prosrc) AS source,p.proacl::text AS acl,p.prosecdef,p.proconfig FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${system} ORDER BY 1,2,3`)
 };
}
async function data(db){
 const tables=(await db.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='r' AND ${system} AND c.relname<>'library_schema_migrations' ORDER BY 1,2`)).rows,image={};
 for(const {nspname,relname} of tables)image[nspname+'.'+relname]=(await db.query(
  `SELECT to_jsonb(t)::text AS row FROM ${nspname}.${relname} t ORDER BY 1`)).rows.map(row=>JSON.parse(row.row));
 return image;
}
// Production on 17 November 2026: 1 apple, 1 active beta, 6 disabled beta,
// 14 guests, 2 expired Sandbox subscriptions owned by the apple user,
// 1 identity and 1 preview claim (only Apple accounts could claim one).
async function seed(db){
 const key=n=>Buffer.alloc(32,n).toString('base64');
 await db.query("INSERT INTO library_users(id,access_kind) VALUES('apple-1','apple'),('beta-1','beta')");
 for(let n=1;n<=6;n++)await db.query("INSERT INTO library_users(id,access_kind,disabled) VALUES($1,'beta',true)",['retired-beta-'+n]);
 for(let n=1;n<=14;n++)await db.query("INSERT INTO library_users(id,access_kind) VALUES($1,'guest')",['guest-'+String(n).padStart(2,'0')]);
 await db.query(`INSERT INTO library_tokens(digest,user_id,expires_at,revoked) VALUES
  ('apple-c','apple-1',now()+interval '300 days',false),('apple-old','apple-1',now()+interval '20 days',true),
  ('beta-c','beta-1',NULL,false),('guest-c','guest-01',now()+interval '60 days',false)`);
 await db.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt) VALUES
  ($1,'apple-1','lyrica-production','com.hongkuntian.Lyrica','production','apple-public',$4),
  ($2,'beta-1','lyrica-production','com.hongkuntian.Lyrica','production','beta-public',$4),
  ($3,'guest-01','lyrica-production','com.hongkuntian.Lyrica','production','guest-public',$4)`,[key(1),key(2),key(3),Buffer.from('receipt')]);
 await db.query(`INSERT INTO app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES
  ('apple-s',$1,'apple-c','lyrica-production',now()+interval '10 minutes'),
  ('beta-s',$2,'beta-c','lyrica-production',now()+interval '10 minutes'),
  ('guest-s',$3,'guest-c','lyrica-production',now()+interval '10 minutes')`,[key(1),key(2),key(3)]);
 await db.query("INSERT INTO account_identities(subject_hash,user_id,app_account_token,apple_client_id,refresh_token_encrypted) VALUES('subject','apple-1','7b140eca-8ed0-4b17-87f9-a2c7de61ca00','com.hongkuntian.Lyrica','sealed')");
 await db.query(`INSERT INTO account_nonces(digest,purpose,bundle_id,key_id,user_id,expires_at) VALUES
  ('n-apple','apple','com.hongkuntian.Lyrica',$1,'apple-1',now()+interval '5 minutes'),
  ('n-delete','delete','com.hongkuntian.Lyrica',$1,'apple-1',now()+interval '5 minutes'),
  ('n-guest','guest','com.hongkuntian.Lyrica',$2,NULL,now()+interval '5 minutes')`,[key(1),key(4)]);
 for(const id of ['2000','2001'])await db.query(`INSERT INTO membership_subscriptions(original_transaction_id,user_id,transaction_id,product_id,tier,environment,
  app_account_token,period_start,expires_at,signed_at) VALUES($1,'apple-1',$1,'com.hongkuntian.Lyrica.pro.monthly','pro','Sandbox',
  '7b140eca-8ed0-4b17-87f9-a2c7de61ca00','2026-01-01','2026-01-02','2026-01-01')`,[id]);
 await db.query("INSERT INTO membership_preview_claims(user_id,activity_id,recording_id,expires_at) VALUES('apple-1','a','r','2026-11-01'),('guest-02','a','r','2026-11-01')");
 await db.query("INSERT INTO membership_relay_usage(user_id,period_start,request_count) VALUES('apple-1','2026-11-01',40),('guest-03','2026-11-01',7)");
 await db.query("INSERT INTO membership_grants(id,user_id,kind,period_key,allowance) VALUES('11111111-1111-1111-1111-111111111111','apple-1','translation','library-free-v1',3)");
 await db.query("INSERT INTO membership_usage(operation_id,user_id,grant_id,kind,state) VALUES('22222222-2222-2222-2222-222222222222','apple-1','11111111-1111-1111-1111-111111111111','translation','consumed')");
 await db.query("INSERT INTO live_lyrics_push_receipts(activity_id,user_id,token_digest,expires_at) VALUES('push','apple-1','d','2099-01-01')");
}
const rows=(image,table)=>image['public.'+table];
const without=(row,fields)=>Object.fromEntries(Object.entries(row).filter(([k])=>!fields.includes(k)));

test('039 is registered once, after 038 and followed only by 040',async()=>{
 assert.deepEqual(registeredNames.slice(registeredNames.indexOf(anonymous)-1),['038-retire-spotify-observer.sql',anonymous,'040-starter-song-totals.sql']);
 assert.equal(registeredNames.filter(name=>name.startsWith('039-')).length,1);
 const text=await sql(anonymous);
 // The runner strips only a leading BEGIN and trailing COMMIT.
 assert.match(text,/^BEGIN;\n/);assert.match(text,/\nCOMMIT;\n$/);
 assert.doesNotMatch(text,/\bCASCADE\b/);
});

test('populated upgrade resets the apple account, removes Sign in with Apple and leaves guest and beta accounts alone',async t=>{
 const db=await database(t);
 assert.deepEqual(await migrateThrough(db,prior),prior);
 await seed(db);
 const before=await data(db);
 assert.deepEqual(await migrateLibrary(adapter(db),{expectedPending:[{name:anonymous,sha256:hash(await sql(anonymous))}]}),[anonymous]);
 const after=await data(db);

 // Every account owns a distinct appAccountToken; nobody is held.
 const users=rows(after,'library_users');
 assert.equal(users.length,22);
 assert.equal(new Set(users.map(u=>u.app_account_token)).size,22);
 for(const user of users){
  assert.match(user.app_account_token,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(user.free_allowance_held_until,null);
  const old=rows(before,'library_users').find(u=>u.id===user.id);
  assert.deepEqual(without(user,['app_account_token','free_allowance_held_until']),user.id==='apple-1'?{...old,disabled:true}:old);
 }
 // The apple account: credentials and keys revoked (material cleared), sessions deleted,
 // subscriptions, preview claim and relay usage deleted. Its ledgers stay.
 const tokens=rows(after,'library_tokens'),keys=rows(after,'app_attest_keys');
 for(const token of tokens){
  const old=rows(before,'library_tokens').find(r=>r.digest===token.digest);
  assert.deepEqual(token,token.user_id==='apple-1'?{...old,revoked:true}:old);
 }
 for(const k of keys){
  const old=rows(before,'app_attest_keys').find(r=>r.key_id===k.key_id);
  assert.deepEqual(k,k.user_id==='apple-1'?{...old,revoked:true,public_key:'',receipt:'\\x'}:old);
 }
 assert.deepEqual(rows(after,'app_auth_sessions').map(s=>s.digest).sort(),['beta-s','guest-s']);
 assert.deepEqual(rows(after,'membership_subscriptions'),[]);
 assert.deepEqual(rows(after,'membership_preview_claims').map(r=>r.user_id),['guest-02']);
 assert.deepEqual(rows(after,'membership_relay_usage').map(r=>r.user_id),['guest-03']);
 for(const table of ['membership_grants','membership_usage','live_lyrics_push_receipts'])assert.deepEqual(rows(after,table),rows(before,table),table);
 // Sign in with Apple identity and nonce purposes are gone.
 assert.equal(after['public.account_identities'],undefined);
 assert.deepEqual(rows(after,'account_nonces').map(n=>n.digest),['n-guest']);
 await assert.rejects(db.query("INSERT INTO account_nonces(digest,purpose,bundle_id,expires_at) VALUES('x','apple','b',now())"),{code:'23514'});
 // Relay access is prerelease 'everyone'; only members/everyone are valid.
 assert.equal((await db.query('SELECT relay_access FROM membership_settings')).rows[0].relay_access,'everyone');
 await assert.rejects(db.query("UPDATE membership_settings SET relay_access='nobody'"),{code:'23514'});
 // The cross-account paid-usage count is indexed.
 assert.equal((await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='membership_grants_period_kind'")).rows[0].indexdef,
  'CREATE INDEX membership_grants_period_kind ON public.membership_grants USING btree (period_key, kind)');
 // Offer-code purchases have no token.
 assert.equal((await db.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='membership_subscriptions' AND column_name='app_account_token'")).rows[0].is_nullable,'YES');
 // A new account gets its own token by default.
 await db.query("INSERT INTO library_users(id,access_kind) VALUES('guest-new','guest')");
 assert.match((await db.query("SELECT app_account_token::text AS t FROM library_users WHERE id='guest-new'")).rows[0].t,/^[0-9a-f-]{36}$/);
 await assert.rejects(db.query("UPDATE library_users SET app_account_token=(SELECT app_account_token FROM library_users WHERE id='beta-1') WHERE id='guest-new'"),{code:'23505'});
 // Grants: the account login may set a hold; the runtime login may only slide via the function.
 const can=async(text,args)=>(await db.query(text,args)).rows[0].ok;
 assert.equal(await can("SELECT has_column_privilege('lyrica_account_v1','public.library_users','free_allowance_held_until','INSERT') AS ok"),true);
 assert.equal(await can("SELECT has_column_privilege('lyrica_account_v1','public.library_users','free_allowance_held_until','UPDATE') AS ok"),false);
 assert.equal(await can("SELECT has_function_privilege('lyrica_runtime_v1','public.slide_guest_credential_expiry(text)','EXECUTE') AS ok"),true);
 assert.equal(await can("SELECT has_function_privilege('lyrica_account_v1','public.slide_guest_credential_expiry(text)','EXECUTE') AS ok"),false);
 assert.equal(await can("SELECT has_column_privilege('lyrica_runtime_v1','public.library_tokens','expires_at','UPDATE') AS ok"),false);
});

test('039 is idempotent: a direct rerun changes nothing, including an operator relay_access change',async t=>{
 const db=await database(t);await migrateThrough(db,prior);await seed(db);
 assert.deepEqual(await migrateLibrary(adapter(db)),[anonymous]);
 await db.query("UPDATE membership_settings SET relay_access='members'");
 const shape=await catalog(db),image=await data(db);
 await db.exec(await sql(anonymous));await db.exec(await sql(anonymous));
 assert.deepEqual(await catalog(db),shape);assert.deepEqual(await data(db),image);
 assert.deepEqual(await migrateLibrary(adapter(db)),[]);
});

test('039 refuses atomically, resetting nothing, when an unexpected object depends on account_identities',async t=>{
 const db=await database(t);await migrateThrough(db,prior);await seed(db);
 await db.exec('CREATE VIEW public.unexpected_identity_dependent AS SELECT user_id FROM public.account_identities');
 const shape=await catalog(db),image=await data(db);
 await assert.rejects(migrateLibrary(adapter(db)),{code:'2BP01'});
 assert.deepEqual(await catalog(db),shape);assert.deepEqual(await data(db),image);
 assert.equal((await db.query("SELECT disabled FROM library_users WHERE id='apple-1'")).rows[0].disabled,false);
});

for(const [label,environment,expires] of [['a Production',"Production","now()-interval '1 day'"],['an unexpired Sandbox',"Sandbox","now()+interval '1 day'"]])
test('039 refuses atomically, resetting nothing, when the apple account owns '+label+' subscription',async t=>{
 const db=await database(t);await migrateThrough(db,prior);await seed(db);
 await db.query(`INSERT INTO membership_subscriptions(original_transaction_id,user_id,transaction_id,product_id,tier,environment,
  app_account_token,period_start,expires_at,signed_at) VALUES('3000','apple-1','3000','com.hongkuntian.Lyrica.pro.annual','pro',$1,
  '7b140eca-8ed0-4b17-87f9-a2c7de61ca00',now()-interval '30 days',${expires},now()-interval '30 days')`,[environment]);
 const shape=await catalog(db),image=await data(db);
 await assert.rejects(migrateLibrary(adapter(db)),e=>e.code==='23514'&&/apple_account_live_subscription/.test(e.message));
 assert.deepEqual(await catalog(db),shape);assert.deepEqual(await data(db),image);
 assert.equal((await db.query("SELECT disabled FROM library_users WHERE id='apple-1'")).rows[0].disabled,false);
});

test('a fresh installation ends with relay_access everyone and no Sign in with Apple schema',async t=>{
 const db=await database(t,{roles:false});
 assert.deepEqual(await migrateLibrary(adapter(db)),migrationNames);
 assert.equal((await db.query('SELECT relay_access FROM membership_settings')).rows[0].relay_access,'everyone');
 assert.equal((await db.query("SELECT to_regclass('public.account_identities') AS name")).rows[0].name,null);
});

test('late role provisioning after 039 replays every grant without the dropped relation',async t=>{
 const db=await database(t,{roles:false});await migrateLibrary(adapter(db));
 await db.exec('CREATE ROLE lyrica_runtime_v1 NOLOGIN; CREATE ROLE lyrica_account_v1 NOLOGIN');
 const replay={query:text=>db.exec(text)};
 await replayMembershipRoleGrants(replay);await replayMembershipRoleGrants(replay);
 const can=async text=>(await db.query(text)).rows[0].ok;
 assert.equal(await can("SELECT has_column_privilege('lyrica_account_v1','public.library_users','free_allowance_held_until','INSERT') AS ok"),true);
 assert.equal(await can("SELECT has_function_privilege('lyrica_runtime_v1','public.slide_guest_credential_expiry(text)','EXECUTE') AS ok"),true);
 assert.equal(await can("SELECT has_table_privilege('lyrica_account_v1','public.account_nonces','DELETE') AS ok"),true);
 // The historical text is checked, never silently trimmed.
 assert.throws(()=>withoutRetiredRelations('GRANT SELECT ON public.library_users TO x'),/membership_privilege_block_mismatch/);
});
