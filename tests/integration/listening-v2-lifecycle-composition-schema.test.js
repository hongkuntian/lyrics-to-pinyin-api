import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

// AUTHORED ONLY. The bounded worker must not execute/import this suite.
// Apply these exact bytes at the repository-relative path before Root runs it.
// Real migration SQL on the PGlite engine; no fake query-success adapter.
// No service/auth/consent, actual PostgreSQL, concurrency or deployment claim.
const migrationName='033-listening-v2-lifecycle-composition.sql';
const names=['001-song-library.sql','021-app-auth.sql','022-live-lyrics-push.sql',
  '025-memberships.sql','029-listening-sessions.sql','030-listening-v2-schema.sql',
  '031-listening-v2-lifecycle-support.sql','032-auth-token-row-locks.sql'];
const readSQL=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
const sources=await Promise.all(names.map(readSQL));
// Deliberately no fallback, environment switch or missing-file skip. Root's
// red control supplies an explicit no-op 033 on the pinned 030/031 base.
const migration=await readSQL(migrationName);
const env='preview:composition-schema',now=1800000000000,day=86400000;
const max='9007199254740991';
const hash=n=>n.toString(16).padStart(64,'0');
const sha=text=>createHash('sha256').update(text).digest('hex');
const relations=['command_receipts','outbox','output_guards','privacy_personas',
  'private_profile_assets','returning_grants','rooms','semantic_events'];
const fields=['environment','persona_id','original_principal_id','original_key_id',
  'controller_kind','controller_principal_id','controller_key_id','privacy_generation','status',
  'guest_credential_digest','guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms',
  'scrub_cursor','created_at_ms','updated_at_ms','controller_privacy_epoch','private_transfer_from_generation'];
const casts=['text','uuid','text','text','text','text','text','bigint','text','text',
  'bigint','bigint','bigint','text','bigint','bigint','bigint','bigint'];
const rejected=p=>assert.rejects(p,e=>['23514','23502','22003','22P02'].includes(e.code));
const denied=p=>assert.rejects(p,{code:'42501'});
let db,baseline;
async function asRole(client,role,fn){
  await client.exec('SET ROLE '+role);
  try{return await fn();}finally{await client.exec('RESET ROLE');}
}
async function fixture({roles=true,apply=true}={}){
  const client=new PGlite();
  try{
    if(roles)await client.exec(`CREATE ROLE lyra_runtime_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      CREATE ROLE lyra_account_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      CREATE ROLE composition_untrusted NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
    for(const source of sources)await client.exec(source);
    if(apply)await client.exec(migration);
    return client;
  }catch(error){await client.close();throw error;}
}
async function insert(table,row,client=db){
  const keys=Object.keys(row);
  return client.query(`INSERT INTO listening_v2.${table}(${keys.join(',')})
    VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row));
}
function guest(overrides={}){
  const id=randomUUID();
  return {environment:env,persona_id:id,original_principal_id:'g-'+id,original_key_id:'k',
    controller_kind:'guest',controller_principal_id:'g-'+id,controller_key_id:'k',
    guest_credential_digest:hash(1),guest_credential_expires_at_ms:now+day,
    created_at_ms:now,updated_at_ms:now,...overrides};
}
function apple(overrides={}){
  return guest({controller_kind:'apple',controller_principal_id:'apple-A',controller_key_id:null,
    guest_credential_digest:null,guest_credential_expires_at_ms:null,...overrides});
}
function normalized(row){
  return {privacy_generation:0,status:'live',withdrawn_at_ms:null,scrub_due_at_ms:null,
    scrub_cursor:null,controller_privacy_epoch:0,private_transfer_from_generation:null,...row};
}
async function tupleBytes(row,{client=db,count=18}={}){
  const r=normalized(row),selected=fields.slice(0,count);
  return (await client.query(`SELECT octet_length(jsonb_build_array(${selected.map((_,i)=>
    '$'+(i+1)+'::'+casts[i]).join(',')})::text)::int AS n`,selected.map(k=>r[k]))).rows[0].n;
}
async function fillTo(row,target,{client=db,count=18}={}){
  const value={...row};let size=await tupleBytes(value,{client,count});
  assert.ok(size<=target,'boundary seed must fit');
  for(const field of ['original_principal_id','original_key_id','controller_principal_id']){
    const extra=Math.min(target-size,160-Buffer.byteLength(value[field]));
    value[field]+='z'.repeat(extra);size=await tupleBytes(value,{client,count});
  }
  assert.equal(size,target,'boundary fixture must reach the exact SQL JSON byte size');return value;
}
async function update(row,changes,client=db){
  const keys=Object.keys(changes);
  return client.query(`UPDATE listening_v2.privacy_personas SET ${keys.map((k,i)=>k+'=$'+(i+1)).join(',')}
    WHERE environment=$${keys.length+1} AND persona_id=$${keys.length+2} RETURNING *`,
  [...Object.values(changes),row.environment,row.persona_id]);
}
function transferChanges(row,{generation=Number(row.privacy_generation??0)+1,epoch=7,bridge=row.privacy_generation??0}={}){
  return {controller_kind:'apple',controller_principal_id:'apple-A',controller_key_id:null,
    guest_credential_digest:null,guest_credential_expires_at_ms:null,privacy_generation:generation,
    controller_privacy_epoch:epoch,private_transfer_from_generation:bridge};
}
async function catalog(client){
  const queries={
    columns:`SELECT n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname IN ('public','listening_v2') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,3`,
    constraints:`SELECT n.nspname,c.conrelid::regclass::text AS relation,c.conname,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname IN ('public','listening_v2') ORDER BY 1,2,3`,
    indexes:`SELECT schemaname,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','listening_v2') ORDER BY 1,2`,
    triggers:`SELECT t.tgrelid::regclass::text AS relation,t.tgname,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','listening_v2') AND NOT t.tgisinternal ORDER BY 1,2`,
    functions:`SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='listening_v2' ORDER BY 1`,
    acl:`SELECT table_schema,table_name,column_name,grantee,privilege_type FROM information_schema.column_privileges
      WHERE table_schema IN ('public','listening_v2') ORDER BY 1,2,3,4,5`,
    roles:'SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles ORDER BY rolname'
  };
  const result={};for(const [key,sql] of Object.entries(queries))result[key]=(await client.query(sql)).rows;
  return result;
}
const newColumn=r=>(r.nspname==='public'&&r.relname==='library_users'&&r.attname==='sessions_privacy_epoch')
  ||(r.nspname==='listening_v2'&&r.relname==='privacy_personas'
    &&['controller_privacy_epoch','private_transfer_from_generation'].includes(r.attname));
before(async()=>{
  db=await fixture({apply:false});baseline=await catalog(db);await db.exec(migration);
});
after(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec(`TRUNCATE ${relations.map(t=>'listening_v2.'+t).join(',')} CASCADE;
    TRUNCATE public.library_users CASCADE;`);
});

test('historical SQL and approved R5 stay byte pinned; 033 uses the actual runner transaction framing',async()=>{
  const pins={
    '030-listening-v2-schema.sql':'4cd413d4fe3d38ab62695ec8898e9532326e85e8d60c9a5f358dc9b911f5e0c6',
    '031-listening-v2-lifecycle-support.sql':'111032345679f02d00fb0df0d85ba8d11d48fc836159fffe316908007912e9ec',
    '032-auth-token-row-locks.sql':'c19650a29438ebeea186203d954fee8e144a65ca6d42ad91bc38c18f1f7e5df6'};
  for(const [name,pin] of Object.entries(pins))assert.equal(sha(await readSQL(name)),pin,name);
  assert.equal(sha(await readFile(new URL('../../docs/design/sessions-v2-architecture.md',import.meta.url),'utf8')),
    '7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049');
  assert.ok(migration.startsWith('BEGIN;'));assert.match(migration,/COMMIT;\s*$/);
  for(const name of ['library-migrations.js','membership-role-grants.js']){
    const text=await readFile(new URL('../../scripts/'+name,import.meta.url),'utf8');
    assert.equal(text.includes(migrationName),false,'033 must remain unregistered/unreplayed');
  }
});

test('exactly three columns, eight relations and all original columns/guards/indexes/ACLs survive',async()=>{
  const after=await catalog(db),added=after.columns.filter(newColumn);
  assert.equal(added.length,3);assert.deepEqual(after.columns.filter(r=>!newColumn(r)),baseline.columns);
  for(const row of added){
    assert.equal(row.type,'listening_v2.safe_uint');
    assert.equal(row.attnotnull,row.attname!=='private_transfer_from_generation');
    if(row.attname==='private_transfer_from_generation')assert.equal(row.default_value,null);
    else assert.match(row.default_value,/^0(?:::.*)?$/);
  }
  for(const key of ['constraints','triggers','functions'])for(const old of baseline[key])
    assert.ok(after[key].some(row=>JSON.stringify(row)===JSON.stringify(old)),key+': '+JSON.stringify(old));
  assert.deepEqual(after.indexes,baseline.indexes);assert.deepEqual(after.roles,baseline.roles);
  const oldACL=after.acl.filter(r=>!(r.table_schema==='public'&&r.table_name==='library_users'&&r.column_name==='sessions_privacy_epoch')
    &&!(r.table_schema==='listening_v2'&&r.table_name==='privacy_personas'
      &&['controller_privacy_epoch','private_transfer_from_generation'].includes(r.column_name)));
  assert.deepEqual(oldACL,baseline.acl);
  assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='listening_v2' ORDER BY 1")).rows.map(r=>r.tablename),relations);
});

test('public V1 data and every existing public column remain unchanged after additive DDL',async t=>{
  const client=await fixture({apply:false});t.after(()=>client.close());
  await client.exec("INSERT INTO public.library_users(id,access_kind) VALUES('v1-owner','apple')");
  const id=randomUUID();
  await client.query(`INSERT INTO public.listening_rooms(id,environment,owner_id,status,invite_hash,code_hash,data)
    VALUES($1,'v1-fixture','v1-owner','active','v1-invite','v1-code','{"untouched":true}')`,[id]);
  const old=(await client.query('SELECT to_jsonb(t) AS row FROM public.listening_rooms t')).rows;
  const user=(await client.query('SELECT to_jsonb(t) AS row FROM public.library_users t')).rows;
  await client.exec(migration);
  assert.deepEqual((await client.query('SELECT to_jsonb(t) AS row FROM public.listening_rooms t')).rows,old);
  assert.deepEqual((await client.query("SELECT to_jsonb(t)-'sessions_privacy_epoch' AS row FROM public.library_users t")).rows,user);
  assert.equal(String((await client.query('SELECT sessions_privacy_epoch FROM public.library_users')).rows[0].sessions_privacy_epoch),'0');
});

test('initial INSERT cannot fabricate any historical bridge; guests capture only zero',async()=>{
  for(const row of [guest(),apple(),apple({controller_kind:'erased',controller_principal_id:null,
    status:'erased',withdrawn_at_ms:now,scrub_due_at_ms:now+day})]){
    await rejected(insert('privacy_personas',{...row,privacy_generation:2,private_transfer_from_generation:1}));
  }
  for(const value of [1,max,null,-1,'9007199254740992'])
    await rejected(insert('privacy_personas',guest({controller_privacy_epoch:value})));
  const row=(await insert('privacy_personas',guest())).rows[0];
  assert.equal(String(row.controller_privacy_epoch),'0');assert.equal(row.private_transfer_from_generation,null);
  const a=(await insert('privacy_personas',apple({controller_privacy_epoch:max}))).rows[0];
  assert.equal(String(a.controller_privacy_epoch),max);assert.equal(a.private_transfer_from_generation,null);
});

test('sole live guest to Apple transition requires exact old generation bridge and exactly one increment',async()=>{
  const row=guest({privacy_generation:10});await insert('privacy_personas',row);
  for(const changes of [
    {...transferChanges(row),private_transfer_from_generation:null},
    transferChanges(row,{bridge:9}),transferChanges(row,{bridge:11}),
    transferChanges(row,{generation:10}),transferChanges(row,{generation:12}),
    {...transferChanges(row),status:'withdrawn',withdrawn_at_ms:now,scrub_due_at_ms:now+day},
    {...transferChanges(row),controller_privacy_epoch:null},
    {...transferChanges(row),guest_credential_digest:hash(1)},
    {...transferChanges(row),controller_key_id:'k'}
  ])await rejected(update(row,changes));
  const result=await update(row,transferChanges(row,{epoch:42}));assert.equal(result.rows.length,1);
  const a=result.rows[0];assert.equal(String(a.privacy_generation),'11');
  assert.equal(String(a.private_transfer_from_generation),'10');assert.equal(String(a.controller_privacy_epoch),'42');
  assert.equal(a.guest_credential_digest,null);assert.equal(a.guest_credential_expires_at_ms,null);
  // This is a SQL shape/CAS fixture. It does not authenticate A or consent.
  assert.equal((await db.query(`UPDATE listening_v2.privacy_personas SET privacy_generation=12
    WHERE environment=$1 AND persona_id=$2 AND controller_kind='guest' AND status='live' AND privacy_generation=10
    RETURNING persona_id`,[env,row.persona_id])).rows.length,0);
});

test('capture/bridge never change later, including withdrawal/erasure; second transfer and clearing refuse',async()=>{
  const row=guest({privacy_generation:4});await insert('privacy_personas',row);
  await update(row,transferChanges(row,{epoch:8}));
  for(const changes of [
    {private_transfer_from_generation:null},{private_transfer_from_generation:3},
    {private_transfer_from_generation:5},{controller_privacy_epoch:7},{controller_privacy_epoch:9},
    {controller_privacy_epoch:null},{controller_principal_id:'apple-B',privacy_generation:6},
    {controller_kind:'guest',controller_principal_id:row.original_principal_id,controller_key_id:'k',
      guest_credential_digest:hash(1),guest_credential_expires_at_ms:now+day,privacy_generation:6}
  ])await rejected(update(row,changes));
  await update(row,{updated_at_ms:now+1});
  const withdrawal={privacy_generation:6,status:'withdrawn',withdrawn_at_ms:now,scrub_due_at_ms:now+day,
    scrub_cursor:'p2:'+randomUUID()+':r',updated_at_ms:now+2};
  await update(row,withdrawal);
  await rejected(update(row,{status:'live',privacy_generation:7,withdrawn_at_ms:null,scrub_due_at_ms:null,scrub_cursor:null}));
  await rejected(update(row,{controller_privacy_epoch:9,privacy_generation:7}));
  await rejected(update(row,{private_transfer_from_generation:null,privacy_generation:7}));
  const erased=(await update(row,{controller_kind:'erased',controller_principal_id:null,status:'erased',privacy_generation:7})).rows[0];
  assert.equal(String(erased.private_transfer_from_generation),'4');assert.equal(String(erased.controller_privacy_epoch),'8');
  await rejected(update(row,{private_transfer_from_generation:null}));
  await rejected(update(row,{controller_privacy_epoch:0}));
  await rejected(update(row,{controller_kind:'apple',controller_principal_id:'apple-A',privacy_generation:8}));
});

test('existing Apple rows acquire no historical bridge or retrospective captured epoch',async t=>{
  const client=await fixture({apply:false});t.after(()=>client.close());
  const row=apple({privacy_generation:4});await insert('privacy_personas',row,client);await client.exec(migration);
  const a=(await client.query('SELECT * FROM listening_v2.privacy_personas')).rows[0];
  assert.equal(a.private_transfer_from_generation,null);assert.equal(String(a.controller_privacy_epoch),'0');
  await rejected(update(row,{private_transfer_from_generation:3},client));
  await rejected(update(row,{controller_privacy_epoch:1},client));
  await update(row,{privacy_generation:5,updated_at_ms:now+1},client);
});

test('all 030 origin/dependency/generation/no-resurrection and row limits stay effective',async()=>{
  const row=guest({privacy_generation:5});await insert('privacy_personas',row);
  for(const changes of [
    {environment:'test'},{persona_id:randomUUID()},{original_principal_id:'replacement'},
    {original_key_id:'replacement'},{created_at_ms:now-1},{privacy_generation:4},
    {guest_credential_digest:hash(2),privacy_generation:6},
    {guest_credential_expires_at_ms:now+2*day,privacy_generation:6},
    {status:'withdrawn',withdrawn_at_ms:now,scrub_due_at_ms:now+day},
    {controller_privacy_epoch:1},{updated_at_ms:now-1}
  ])await rejected(update(row,changes));
  await update(row,{privacy_generation:6,status:'withdrawn',withdrawn_at_ms:now,scrub_due_at_ms:now+day});
  await rejected(update(row,{status:'live',privacy_generation:7,withdrawn_at_ms:null,scrub_due_at_ms:null}));
  await rejected(update(row,transferChanges({...row,privacy_generation:6})));
  for(const overrides of [
    {guest_credential_expires_at_ms:now},{guest_credential_expires_at_ms:now+90*day+1},
    {status:'withdrawn',withdrawn_at_ms:now,scrub_due_at_ms:now+day+1},
    {status:'withdrawn',withdrawn_at_ms:now,scrub_due_at_ms:now-1},
    {status:'withdrawn',withdrawn_at_ms:now,scrub_due_at_ms:now+day,scrub_cursor:'x'.repeat(97)},
    {original_key_id:'x'.repeat(161)}, {original_key_id:'bad\nkey'}
  ])await rejected(insert('privacy_personas',guest(overrides)));
});

test('user epoch is safe, nonnull, monotone, equal-update tolerant and refuses wrap',async()=>{
  await db.exec("INSERT INTO public.library_users(id) VALUES('epoch-owner')");
  const set=value=>db.query("UPDATE public.library_users SET sessions_privacy_epoch=$1 WHERE id='epoch-owner' RETURNING sessions_privacy_epoch",[value]);
  assert.equal(String((await set(0)).rows[0].sessions_privacy_epoch),'0');
  assert.equal(String((await set(1)).rows[0].sessions_privacy_epoch),'1');
  await rejected(set(0));await rejected(set(-1));await rejected(set(null));
  await rejected(set('9007199254740992'));await rejected(set('9223372036854775808'));
  assert.equal(String((await set(max)).rows[0].sessions_privacy_epoch),max);
  await set(max);
  await rejected(db.exec("UPDATE public.library_users SET sessions_privacy_epoch=sessions_privacy_epoch+1 WHERE id='epoch-owner'"));
  await rejected(set(0));
  await rejected(db.exec("INSERT INTO public.library_users(id,sessions_privacy_epoch) VALUES('negative',-1)"));
  await rejected(db.exec("INSERT INTO public.library_users(id,sessions_privacy_epoch) VALUES('null',NULL)"));
  for(const value of [-1,null,'9007199254740992'])
    await rejected(insert('privacy_personas',apple({controller_privacy_epoch:value})));
  const near=guest({privacy_generation:max});await insert('privacy_personas',near);
  await rejected(update(near,transferChanges(near,{generation:max,bridge:max})));
  await rejected(db.query(`UPDATE listening_v2.privacy_personas SET privacy_generation=privacy_generation+1
    WHERE environment=$1 AND persona_id=$2`,[env,near.persona_id]));
});

test('the exact 18-element SQL aggregate accepts 512 and rejects 513 UTF8/escaped bytes',async()=>{
  for(const unicode of [false,true]){
    const seed=apple({original_principal_id:unicode?'é'.repeat(30):'g',
      original_key_id:unicode?'😀'.repeat(15):'k',controller_principal_id:unicode?'A"\\':'A',
      controller_privacy_epoch:max});
    const exact=await fillTo(seed,512);await insert('privacy_personas',exact);
    assert.ok(await tupleBytes(exact,{count:16})<512,'new values share, rather than bypass, the original cap');
    const measured=(await db.query(`SELECT jsonb_array_length(jsonb_build_array(${fields.join(',')})) AS count,
      octet_length(jsonb_build_array(${fields.join(',')})::text)::int AS n
      FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2`,[env,exact.persona_id])).rows[0];
    assert.deepEqual(measured,{count:18,n:512});
    const tooLarge={...exact,persona_id:randomUUID(),controller_principal_id:exact.controller_principal_id+'x'};
    assert.equal(await tupleBytes(tooLarge),513);assert.ok(await tupleBytes(tooLarge,{count:16})<=512);
    await rejected(insert('privacy_personas',tooLarge));
  }
});

test('numeric time growth at a currently full row refuses; compact transfer/withdrawal with maximum uints fits',async()=>{
  const exact=await fillTo(apple({original_principal_id:'g',original_key_id:'k',controller_principal_id:'A'}),512);
  await insert('privacy_personas',exact);
  assert.ok(await tupleBytes({...exact,updated_at_ms:max})>512);
  await rejected(update(exact,{updated_at_ms:max}));
  const row=guest({original_principal_id:'g2',controller_principal_id:'g2',privacy_generation:'9007199254740988',
    created_at_ms:'9007199254739991',updated_at_ms:'9007199254739991',guest_credential_expires_at_ms:max});
  await insert('privacy_personas',row);
  await update(row,transferChanges(row,{generation:'9007199254740989',bridge:'9007199254740988',epoch:max}));
  const terminal=(await update(row,{privacy_generation:'9007199254740990',status:'withdrawn',
    withdrawn_at_ms:'9007199254740491',scrub_due_at_ms:max,scrub_cursor:'p2:'+randomUUID()+':x',updated_at_ms:max})).rows[0];
  assert.ok(await tupleBytes(terminal)<=512);assert.equal(String(terminal.controller_privacy_epoch),max);
  assert.equal(String(terminal.private_transfer_from_generation),'9007199254740988');
});

test('a legacy 512-byte row refuses migration atomically rather than truncating or widening the cap',async t=>{
  const client=await fixture({apply:false});t.after(()=>client.close());
  const exact=await fillTo(apple({original_principal_id:'g',original_key_id:'k',controller_principal_id:'A'}),512,{client,count:16});
  await insert('privacy_personas',exact,client);const before=await catalog(client);
  const old=(await client.query('SELECT to_jsonb(t) AS row FROM listening_v2.privacy_personas t')).rows;
  await rejected(client.exec(migration));await client.exec('ROLLBACK');
  assert.deepEqual(await catalog(client),before);
  assert.deepEqual((await client.query('SELECT to_jsonb(t) AS row FROM listening_v2.privacy_personas t')).rows,old);
});

test('unexpected preexisting epoch/bridge columns refuse without lossy reconciliation',async t=>{
  const client=await fixture({apply:false});t.after(()=>client.close());
  await client.exec('ALTER TABLE public.library_users ADD COLUMN sessions_privacy_epoch bigint DEFAULT -1');
  await client.exec("INSERT INTO public.library_users(id) VALUES('inconsistent')");
  const before=await catalog(client);
  await assert.rejects(client.exec(migration),{code:'42701'});await client.exec('ROLLBACK');
  assert.deepEqual(await catalog(client),before);
  assert.equal(String((await client.query('SELECT sessions_privacy_epoch FROM public.library_users')).rows[0].sessions_privacy_epoch),'-1');
});

test('roles receive only specified new column updates and preserve old auth and controller denials',async()=>{
  await db.exec("INSERT INTO public.library_users(id,access_kind) VALUES('role-owner','guest')");
  await db.exec("INSERT INTO public.library_tokens(digest,user_id) VALUES('role-token','role-owner')");
  const row=guest();await insert('privacy_personas',row);
  for(const role of ['lyra_runtime_v1','lyra_account_v1'])await asRole(db,role,async()=>{
    await db.exec("UPDATE public.library_users SET sessions_privacy_epoch=sessions_privacy_epoch+1 WHERE id='role-owner'");
    await rejected(db.exec("UPDATE public.library_users SET sessions_privacy_epoch=0 WHERE id='role-owner'"));
    for(const field of ['id','access_kind','created_at'])
      await denied(db.exec(`UPDATE public.library_users SET ${field}=${field} WHERE id='role-owner'`));
    await denied(db.exec('ALTER TABLE public.library_users ADD COLUMN forbidden integer'));
    await denied(db.exec('CREATE TABLE listening_v2.forbidden(id integer)'));
    await denied(db.exec('DELETE FROM listening_v2.output_guards'));
    await denied(db.exec('TRUNCATE listening_v2.output_guards'));
  });
  await asRole(db,'lyra_runtime_v1',async()=>{
    for(const field of ['controller_kind','controller_principal_id','controller_key_id','guest_credential_digest',
      'guest_credential_expires_at_ms','controller_privacy_epoch','private_transfer_from_generation'])
      await denied(update(row,{[field]:normalized(row)[field]}));
    await denied(db.exec('UPDATE public.library_users SET disabled=disabled'));
    for(const field of ['digest','user_id','revoked','expires_at','created_at'])
      await denied(db.exec(`UPDATE public.library_tokens SET ${field}=${field}`));
    // Existing 032 remains false-only row-lock authority, never privacy state.
    await db.exec('UPDATE public.library_tokens SET auth_lock_anchor=false');
    await rejected(db.exec('UPDATE public.library_tokens SET auth_lock_anchor=true'));
    await rejected(db.exec('UPDATE public.library_tokens SET auth_lock_anchor=NULL'));
  });
  await asRole(db,'lyra_account_v1',async()=>{
    const a=(await update(row,transferChanges(row,{epoch:2}))).rows[0];
    assert.equal(String(a.controller_privacy_epoch),'2');assert.equal(String(a.private_transfer_from_generation),'0');
    await denied(update(row,{original_key_id:'new-origin'}));
    await denied(db.exec('DELETE FROM listening_v2.privacy_personas'));
    await denied(db.exec('INSERT INTO listening_v2.semantic_events DEFAULT VALUES'));
    await denied(db.exec('UPDATE listening_v2.rooms SET event_seq=event_seq'));
  });
  // Inspect actual new UPDATE privileges, including absence of table-wide UPDATE.
  const grants=(await db.query(`SELECT table_schema,table_name,column_name,grantee FROM information_schema.column_privileges
    WHERE privilege_type='UPDATE' AND grantee IN ('lyra_runtime_v1','lyra_account_v1')
      AND ((table_schema='public' AND table_name='library_users' AND column_name='sessions_privacy_epoch')
        OR (table_schema='listening_v2' AND table_name='privacy_personas'
          AND column_name IN ('controller_privacy_epoch','private_transfer_from_generation'))) ORDER BY 1,2,3,4`)).rows;
  assert.deepEqual(grants,[
    {table_schema:'listening_v2',table_name:'privacy_personas',column_name:'controller_privacy_epoch',grantee:'lyra_account_v1'},
    {table_schema:'listening_v2',table_name:'privacy_personas',column_name:'private_transfer_from_generation',grantee:'lyra_account_v1'},
    {table_schema:'public',table_name:'library_users',column_name:'sessions_privacy_epoch',grantee:'lyra_account_v1'},
    {table_schema:'public',table_name:'library_users',column_name:'sessions_privacy_epoch',grantee:'lyra_runtime_v1'}]);
  for(const role of ['lyra_runtime_v1','lyra_account_v1'])assert.equal((await db.query(
    "SELECT has_table_privilege($1,'public.library_users','UPDATE') AS allowed",[role])).rows[0].allowed,false);
});

test('new trigger functions are invoker, fixed pg_catalog, with no PUBLIC or application execute',async()=>{
  const functions=(await db.query(`SELECT p.oid::regprocedure::text AS signature,p.prosecdef,p.proconfig,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='listening_v2'
      AND p.oid::regprocedure::text NOT IN (${baseline.functions.map((_,i)=>'$'+(i+1)).join(',')}) ORDER BY 1`,
  baseline.functions.map(f=>f.signature))).rows;
  assert.equal(functions.length,2);
  for(const fn of functions){
    assert.equal(fn.prosecdef,false);assert.deepEqual(fn.proconfig,['search_path=pg_catalog']);assert.equal(fn.public_execute,false);
    for(const role of ['lyra_runtime_v1','lyra_account_v1','composition_untrusted'])assert.equal((await db.query(
      'SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',[role,fn.signature])).rows[0].allowed,false);
  }
  await asRole(db,'composition_untrusted',async()=>{
    await denied(db.exec('SELECT * FROM listening_v2.privacy_personas'));
    await denied(db.exec('UPDATE public.library_users SET sessions_privacy_epoch=0'));
    await denied(insert('privacy_personas',guest()));
  });
});

test('roles absent creates no role or public grant; roles introduced later get no automatic authority',async t=>{
  const client=await fixture({roles:false,apply:false});t.after(()=>client.close());
  const roles=(await client.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows;
  await client.exec(migration);
  assert.deepEqual((await client.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows,roles);
  await client.exec('CREATE ROLE lyra_runtime_v1 NOLOGIN; CREATE ROLE lyra_account_v1 NOLOGIN');
  for(const role of ['lyra_runtime_v1','lyra_account_v1']){
    assert.equal((await client.query("SELECT has_column_privilege($1,'public.library_users','sessions_privacy_epoch','UPDATE') AS allowed",[role])).rows[0].allowed,false);
    assert.equal((await client.query("SELECT has_schema_privilege($1,'listening_v2','USAGE') AS allowed",[role])).rows[0].allowed,false);
  }
  // Later catalog-qualified role replay belongs to Root; direct reapply is
  // intentionally not promised and must not silently bless partial drift.
  await assert.rejects(client.exec(migration),{code:'42701'});await client.exec('ROLLBACK');
});

test('before/after role behavior and failure after DDL/GRANT are transactional',async t=>{
  const client=await fixture({apply:false});t.after(()=>client.close());
  await client.exec("INSERT INTO public.library_users(id) VALUES('before-role')");
  const row=guest();await insert('privacy_personas',row,client);
  const snapshot=await catalog(client);
  for(const role of ['lyra_runtime_v1','lyra_account_v1'])assert.equal((await client.query(
    "SELECT has_table_privilege($1,'public.library_users','UPDATE') AS allowed",[role])).rows[0].allowed,false);
  await asRole(client,'lyra_runtime_v1',async()=>{await denied(update(row,{controller_principal_id:'A'},client));});
  await assert.rejects(client.exec(migration.replace(/COMMIT;\s*$/,'SELECT 1/0;\nCOMMIT;')),{code:'22012'});
  await client.exec('ROLLBACK');assert.deepEqual(await catalog(client),snapshot);
  const prior=(await client.query('SELECT to_jsonb(t) AS row FROM listening_v2.privacy_personas t')).rows;
  await client.exec(migration);
  const current=(await client.query("SELECT to_jsonb(t)-ARRAY['controller_privacy_epoch','private_transfer_from_generation'] AS row FROM listening_v2.privacy_personas t")).rows;
  assert.deepEqual(current,prior);
  await asRole(client,'lyra_account_v1',async()=>{await update(row,transferChanges(row),client);});
  await asRole(client,'lyra_runtime_v1',async()=>{
    await client.exec("UPDATE public.library_users SET sessions_privacy_epoch=1 WHERE id='before-role'");
    await denied(update(row,{private_transfer_from_generation:null},client));
  });
});

test('full compaction deletes an unreferenced persona while FK/origin guards stay intact',async()=>{
  const row=guest();await insert('privacy_personas',row);await update(row,transferChanges(row));
  const roomID=randomUUID();
  await insert('rooms',{environment:env,session_id:roomID,host_install_scope:hash(3),provider:'appleMusic',
    host_persona_id:row.persona_id,host_privacy_generation:1,invite_digest:hash(4),code_digest:hash(5),
    created_at_ms:now,expires_at_ms:now+day/3,updated_at_ms:now});
  await rejected(update(row,{original_principal_id:'redacted'}));
  await asRole(db,'lyra_runtime_v1',async()=>{
    await assert.rejects(db.query('DELETE FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2',
      [env,row.persona_id]),{code:'23001'});
    await db.query('DELETE FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2',[env,roomID]);
    assert.equal((await db.query('DELETE FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2 RETURNING persona_id',
      [env,row.persona_id])).rows.length,1);
  });
});
