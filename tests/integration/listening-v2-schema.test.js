import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

// One process/worker, real PostgreSQL engine in WASM; not a multi-connection
// contention, deployed-role, clock-deadline, provider or auth qualification.
const migration=await readFile(new URL('../../db/030-listening-v2-schema.sql',import.meta.url),'utf8');
const v1=await readFile(new URL('../../db/029-listening-sessions.sql',import.meta.url),'utf8');
const env='preview:schema-r1-a',otherEnv='preview:schema-r1-b';
const hash=n=>n.toString(16).padStart(64,'0');
const day=86400000,now=1800000000000;
async function fixture(t,{apply=true,roles=true}={}) {
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE library_users(id text PRIMARY KEY);
    CREATE TABLE library_tokens(digest text PRIMARY KEY,user_id text REFERENCES library_users(id));
    CREATE TABLE app_attest_keys(key_id text PRIMARY KEY,user_id text REFERENCES library_users(id));
    INSERT INTO library_users VALUES('host'),('guest');
    INSERT INTO library_tokens VALUES('credential','guest');
    INSERT INTO app_attest_keys VALUES('key','guest');`);
  if(roles)await db.exec('CREATE ROLE lyra_runtime_v1;CREATE ROLE lyra_account_v1;CREATE ROLE v2_untrusted;');
  await db.exec(v1);
  if(apply)await db.exec(migration);
  return db;
}
async function insert(db,table,row) {
  const keys=Object.keys(row);
  return db.query(`INSERT INTO listening_v2.${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row));
}
const persona=(overrides={})=>({environment:env,persona_id:randomUUID(),original_principal_id:'guest',original_key_id:'key',
  controller_kind:'guest',controller_principal_id:'guest',controller_key_id:'key',guest_credential_digest:hash(1),
  guest_credential_expires_at_ms:now+90*day,created_at_ms:now,updated_at_ms:now,...overrides});
const room=(overrides={})=>({environment:env,session_id:randomUUID(),host_install_scope:hash(2),provider:'appleMusic',
  invite_digest:hash(3),code_digest:hash(4),created_at_ms:now,expires_at_ms:now+8*3600000,updated_at_ms:now,...overrides});
const guard=(overrides={})=>({environment:env,guard_id:randomUUID(),provider:'spotify',binding_key_version:1,
  account_binding:hash(5),connection_lineage:hash(6),output_scope:hash(7),scope_kind:'captured_output',
  original_install_scope:hash(2),created_at_ms:now,updated_at_ms:now,...overrides});
const receipt=(r,overrides={})=>({environment:r.environment,session_id:r.session_id,room_id:r.session_id,
  principal_binding:hash(10),key_binding:hash(11),command_id:randomUUID(),binding_key_version:1,
  action:'queue.add',canonical_body_hash:hash(12),status:'accepted',created_at_ms:now,delete_after_ms:now+31*day,...overrides});
const event=(r,overrides={})=>({environment:r.environment,session_id:r.session_id,event_id:randomUUID(),seq:1,
  lane:'semantic',lane_seq:1,state_version:0,type:'queue.added',server_at_ms:now,delete_after_ms:now+2*day,...overrides});
const asset=(p,overrides={})=>({environment:p.environment,asset_id:randomUUID(),persona_id:p.persona_id,privacy_generation:0,
  asset_generation:1,install_scope:hash(2),state:'staged',object_key:randomUUID(),content_hash:hash(13),content_type:'image/jpeg',
  byte_count:262144,width:256,height:256,created_at_ms:now,stage_expires_at_ms:now+3600000,...overrides});
const job=(r,overrides={})=>({environment:r.environment,job_id:randomUUID(),job_key:'wake:'+r.session_id,kind:'wake',room_id:r.session_id,
  payload:{version:2,environment:r.environment},created_at_ms:now,due_at_ms:now,retry_until_ms:now+day,...overrides});
const constraint=async promise=>assert.rejects(promise,error=>['23514','23502','22023','22003'].includes(error.code), 'expected engine constraint failure');
const foreignKey=async promise=>assert.rejects(promise,{code:'23503'});
const restricted=async promise=>assert.rejects(promise,{code:'23001'});
const duplicate=async promise=>assert.rejects(promise,{code:'23505'});
const denied=async promise=>assert.rejects(promise,{code:'42501'});

// Tests deliberately execute writes and inspect catalogs; no migration text
// matching substitutes for a constraint or permission test.
test('fresh migration adds exactly eight relations, is environment fenced, and preserves V1 schema/data',async t=>{
  const db=await fixture(t,{apply:false});
  const oldID=randomUUID();
  await db.query(`INSERT INTO listening_rooms(id,environment,owner_id,status,invite_hash,code_hash,data)
    VALUES($1,'v1-fixture','host','active','v1-invite','v1-code','{"unchanged":true}')`,[oldID]);
  const catalog=()=>db.query(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
    pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2`);
  const before=(await catalog()).rows;
  await db.exec(migration);
  assert.deepEqual((await catalog()).rows,before);
  assert.deepEqual((await db.query('SELECT data FROM listening_rooms WHERE id=$1',[oldID])).rows,[{data:{unchanged:true}}]);
  assert.deepEqual((await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='listening_v2' ORDER BY tablename`)).rows.map(r=>r.tablename),
    ['command_receipts','outbox','output_guards','privacy_personas','private_profile_assets','returning_grants','rooms','semantic_events']);
  const indexes=(await db.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='listening_v2'`)).rows;
  assert.ok(indexes.length>30);
  for(const index of indexes)assert.match(index.indexdef,/environment/,index.indexname);
  const fks=(await db.query(`SELECT c.conname,c.confdeltype,
    pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='listening_v2' AND c.contype='f'`)).rows;
  assert.ok(fks.length>=12);
  for(const fk of fks){assert.equal(fk.confdeltype,'r');assert.match(fk.definition,/FOREIGN KEY \(environment,/);assert.match(fk.definition,/REFERENCES listening_v2\..*\(environment,/);}
  for(const invalid of ['preview','preview:','Preview:branch','preview:with/slash','',null])await constraint(insert(db,'rooms',room({environment:invalid})));
  for(const valid of ['production','development','test',env,otherEnv])await insert(db,'rooms',room({environment:valid}));
});

test('returning cooldown persists independently of active trust with narrow runtime ownership',async t=>{
  const db=await fixture(t),p=persona();await insert(db,'privacy_personas',p);
  const grant={environment:env,grant_id:randomUUID(),host_install_scope:hash(2),pair_digest:hash(14),hmac_key_version:1,status:'active',
    host_persona_id:p.persona_id,host_privacy_generation:0,guest_persona_id:p.persona_id,guest_privacy_generation:0,
    created_at_ms:now,updated_at_ms:now};
  const initial=(await insert(db,'returning_grants',grant)).rows[0];
  assert.equal(String(initial.cooldown_until_ms),'0');
  const update=value=>db.query('UPDATE listening_v2.returning_grants SET cooldown_until_ms=$1 WHERE environment=$2 AND grant_id=$3 RETURNING status,grant_generation,revoked_at_ms,cooldown_until_ms',
    [value,env,grant.grant_id]);
  await db.exec('SET ROLE lyra_runtime_v1');
  try{
    const changed=(await update(now+60000)).rows[0];
    assert.equal(changed.status,'active');assert.equal(String(changed.grant_generation),'0');assert.equal(changed.revoked_at_ms,null);
    assert.equal(String(changed.cooldown_until_ms),String(now+60000));
    await constraint(update('-1'));await constraint(update('9007199254740992'));
    assert.equal(String((await update('9007199254740991')).rows[0].cooldown_until_ms),'9007199254740991');
  }finally{await db.exec('RESET ROLE');}
  await db.exec('SET ROLE lyra_account_v1');
  try{await denied(update(0));}finally{await db.exec('RESET ROLE');}
  assert.equal((await db.query('SELECT count(*)::int n FROM pg_tables WHERE schemaname=$1',['listening_v2'])).rows[0].n,8);
});

test('failed transactional migration leaves no partial schema/grants; fresh retry succeeds',async t=>{
  const db=await fixture(t,{apply:false});
  const fail=migration.replace(/COMMIT;\s*$/,'SELECT 1/0;\nCOMMIT;');
  await assert.rejects(db.exec(fail),{code:'22012'});
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT to_regnamespace('listening_v2') AS schema")).rows[0].schema,null);
  await db.exec(migration);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM listening_v2.rooms')).rows[0].n,0);
  await assert.rejects(db.exec(migration),{code:'42P06'}); // runner records its hash; no silent IF NOT EXISTS drift.
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT has_table_privilege('lyra_runtime_v1','listening_v2.rooms','INSERT') AS allowed")).rows[0].allowed,true);
});

test('composite FKs and unique scopes isolate every relation across deployment identities',async t=>{
  const db=await fixture(t),p=persona(),r=room({host_persona_id:p.persona_id,host_privacy_generation:0});
  await insert(db,'privacy_personas',p);await insert(db,'rooms',r);
  await foreignKey(insert(db,'rooms',room({environment:otherEnv,host_persona_id:p.persona_id,host_privacy_generation:0})));
  await insert(db,'privacy_personas',{...p,environment:otherEnv});
  await insert(db,'rooms',{...r,environment:otherEnv});
  await duplicate(insert(db,'rooms',room()));
  const g=guard();await insert(db,'output_guards',g);await insert(db,'output_guards',{...g,environment:otherEnv});
  const grant={environment:env,grant_id:randomUUID(),host_install_scope:hash(2),pair_digest:hash(14),hmac_key_version:1,status:'active',
    host_persona_id:p.persona_id,host_privacy_generation:0,guest_persona_id:p.persona_id,guest_privacy_generation:0,created_at_ms:now,updated_at_ms:now};
  await insert(db,'returning_grants',grant);await insert(db,'returning_grants',{...grant,environment:otherEnv});
  await duplicate(insert(db,'returning_grants',{...grant,grant_id:randomUUID()}));
  const a=asset(p);await insert(db,'private_profile_assets',a);await insert(db,'private_profile_assets',{...a,environment:otherEnv});
  const e=event(r);await insert(db,'semantic_events',e);await insert(db,'semantic_events',{...e,environment:otherEnv});
  const c=receipt(r);await insert(db,'command_receipts',c);await insert(db,'command_receipts',{...c,environment:otherEnv});
  const j=job(r);await insert(db,'outbox',j);await insert(db,'outbox',{...j,environment:otherEnv,payload:{version:2,environment:otherEnv}});
  const missingEnv='preview:unpopulated';
  await foreignKey(insert(db,'returning_grants',{...grant,environment:missingEnv}));
  await foreignKey(insert(db,'private_profile_assets',{...a,environment:missingEnv}));
  await foreignKey(insert(db,'semantic_events',{...e,environment:missingEnv}));
  await foreignKey(insert(db,'command_receipts',{...c,environment:missingEnv}));
  await foreignKey(insert(db,'outbox',{...j,environment:missingEnv,payload:{version:2,environment:missingEnv}}));
  await constraint(insert(db,'outbox',job(r,{job_key:'wrong-env',payload:{version:2,environment:otherEnv}})));
  await constraint(insert(db,'outbox',job(r,{job_key:'missing-env',payload:{version:2}})));
});

test('missing guards are uninitialized; initialized manifest and one same-account lane are constraint shapes, not Release proof',async t=>{
  const db=await fixture(t),g=guard();
  assert.equal((await db.query('SELECT * FROM listening_v2.output_guards WHERE environment=$1',[env])).rows.length,0);
  const actual=(await insert(db,'output_guards',g)).rows[0];
  assert.equal(actual.bootstrap_state,'uninitialized');assert.equal(actual.lane_state,'blocked');assert.equal(actual.qualification_manifest_hash,null);
  await constraint(db.query(`UPDATE listening_v2.output_guards SET bootstrap_state='initialized',lane_state='idle' WHERE environment=$1`,[env]));
  await constraint(db.query(`UPDATE listening_v2.output_guards SET lane_state='idle' WHERE environment=$1`,[env]));
  const init={bootstrap_state:'initialized',bootstrap_epoch:1,minimum_writer_generation:1,qualification_manifest_hash:hash(20),lane_state:'executing',
    execution_id:randomUUID(),send_ordinal:1,claim_epoch:1,claim_nonce_hash:hash(21),claim_until_ms:now+20000,endpoint_body_hash:hash(22),may_have_been_sent:true};
  await db.query(`UPDATE listening_v2.output_guards SET ${Object.keys(init).map((k,i)=>`${k}=$${i+1}`).join(',')},guard_revision=1 WHERE environment=$${Object.keys(init).length+1}`,[...Object.values(init),env]);
  await duplicate(insert(db,'output_guards',guard({...init,output_scope:hash(23)})));
  await insert(db,'output_guards',guard({...init,account_binding:hash(24)}));
  await constraint(db.query('UPDATE listening_v2.output_guards SET send_ordinal=0 WHERE environment=$1',[env]));
  await constraint(db.query('UPDATE listening_v2.output_guards SET qualification_manifest_hash=NULL WHERE environment=$1',[env]));
  await constraint(db.query('UPDATE listening_v2.output_guards SET account_binding=$1 WHERE guard_id=$2 AND environment=$3',[hash(26),g.guard_id,env]));
  await constraint(db.query('UPDATE listening_v2.output_guards SET observed_count=511,reserved_visit_credits=2 WHERE environment=$1',[env]));
  await constraint(db.query('UPDATE listening_v2.output_guards SET safety_capsule=$1 WHERE environment=$2',[{padding:'x'.repeat(131072)},env]));
  // Invalidation of bootstrap proof must retain an already-sent uncertain lane.
  await db.query(`UPDATE listening_v2.output_guards SET bootstrap_state='legacy_quarantined',lane_state='uncertain',
    guard_revision=2 WHERE environment=$1 AND guard_id=$2`,[env,g.guard_id]);
  assert.equal((await db.query('SELECT may_have_been_sent FROM listening_v2.output_guards WHERE environment=$1 AND guard_id=$2',[env,g.guard_id])).rows[0].may_have_been_sent,true);
  await constraint(db.query('UPDATE listening_v2.output_guards SET lane_state=$1 WHERE environment=$2 AND guard_id=$3',['idle',env,g.guard_id]));
});

test('End and direct room/user/credential deletion cannot cascade away indefinite quarantine/terminal reservations',async t=>{
  const db=await fixture(t),g=guard({bootstrap_state:'initialized',bootstrap_epoch:1,minimum_writer_generation:1,
    qualification_manifest_hash:hash(20),lane_state:'uncertain',execution_id:randomUUID(),send_ordinal:1,
    claim_nonce_hash:hash(21),claim_until_ms:now+20000,endpoint_body_hash:hash(22),may_have_been_sent:true,
    observed_count:500,reserved_visit_credits:12,reserved_semantic_events:12,reserved_receipts:2,
    safety_capsule:{version:1,unsettled:true},reserved_capsule_bytes:8192}),p=persona(),r=room({host_persona_id:p.persona_id,host_privacy_generation:0});
  await insert(db,'output_guards',g);await insert(db,'privacy_personas',p);await insert(db,'rooms',r);
  const before=(await db.query('SELECT * FROM listening_v2.output_guards')).rows;
  await db.query(`UPDATE listening_v2.rooms SET status='ended',ended_at_ms=$1,event_delete_after_ms=$2,receipt_delete_after_ms=$3
    WHERE environment=$4`,[now,now+day,now+30*day,env]);
  assert.equal((await db.query('SELECT terminal_reservation_bytes,end_event_reserved FROM listening_v2.rooms')).rows[0].terminal_reservation_bytes,8192);
  await db.query('DELETE FROM listening_v2.rooms WHERE environment=$1',[env]);
  await db.query('DELETE FROM listening_v2.privacy_personas WHERE environment=$1',[env]);
  await db.exec("DELETE FROM library_tokens;DELETE FROM app_attest_keys;DELETE FROM library_users WHERE id='guest';");
  assert.deepEqual((await db.query('SELECT * FROM listening_v2.output_guards')).rows,before);
  await assert.rejects(db.query('DELETE FROM listening_v2.output_guards'),/v2_guard_retained/);
  await constraint(db.query('UPDATE listening_v2.output_guards SET terminal_reservation_bytes=0'));
  assert.deepEqual((await db.query('SELECT * FROM listening_v2.output_guards')).rows,before);
});

test('runtime can enqueue guard-only cleanup after room deletion without widening account execution grants',async t=>{
  const db=await fixture(t),g=guard(),r=room();
  await insert(db,'output_guards',g);await insert(db,'rooms',r);
  await db.query('DELETE FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2',[env,r.session_id]);
  const cleanup=job(r,{job_key:'cleanup:'+g.guard_id,kind:'guard_cleanup',room_id:null,
    guard_id:g.guard_id,guard_revision:0,send_ordinal:0});
  await db.exec('SET ROLE lyra_runtime_v1');
  await insert(db,'outbox',cleanup);
  for(const change of [{guard_id:null},{guard_revision:null},{send_ordinal:null},{room_id:r.session_id}]){
    await constraint(insert(db,'outbox',{...cleanup,...change,job_id:randomUUID(),job_key:randomUUID()}));
  }
  await foreignKey(insert(db,'outbox',{...cleanup,job_id:randomUUID(),job_key:randomUUID(),guard_id:randomUUID()}));
  await foreignKey(insert(db,'outbox',{...cleanup,environment:otherEnv,job_id:randomUUID(),job_key:randomUUID(),
    payload:{version:2,environment:otherEnv}}));
  await db.exec('RESET ROLE;SET ROLE lyra_account_v1');
  await denied(insert(db,'outbox',{...cleanup,job_id:randomUUID(),job_key:randomUUID()}));
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM listening_v2.outbox')).rows[0].n,1);
});

test('personas enforce immutable origin/dependency, finite actual deadline, generation changes, no resurrection and bounded registry bytes',async t=>{
  const db=await fixture(t),p=persona();await insert(db,'privacy_personas',p);
  await constraint(db.query('UPDATE listening_v2.privacy_personas SET original_key_id=$1',['other-key']));
  await constraint(db.query('UPDATE listening_v2.privacy_personas SET guest_credential_expires_at_ms=$1,privacy_generation=1',[now+89*day]));
  await constraint(insert(db,'privacy_personas',persona({original_key_id:'key2',controller_key_id:'key2',guest_credential_digest:null})));
  await constraint(insert(db,'privacy_personas',persona({original_key_id:'key2',controller_key_id:'key2',guest_credential_expires_at_ms:now+90*day+1})));
  await constraint(insert(db,'privacy_personas',persona({original_principal_id:'x'.repeat(160),controller_principal_id:'x'.repeat(160),
    original_key_id:'y'.repeat(160),controller_key_id:'y'.repeat(160)})));
  await constraint(db.query(`UPDATE listening_v2.privacy_personas SET controller_kind='apple',controller_principal_id='apple-A',
    controller_key_id=NULL,guest_credential_digest=NULL,guest_credential_expires_at_ms=NULL`));
  await db.query(`UPDATE listening_v2.privacy_personas SET controller_kind='apple',controller_principal_id='apple-A',
    controller_key_id=NULL,guest_credential_digest=NULL,guest_credential_expires_at_ms=NULL,privacy_generation=1`);
  assert.equal((await db.query('SELECT original_principal_id,controller_principal_id FROM listening_v2.privacy_personas')).rows[0].original_principal_id,'guest');
  await constraint(db.query("UPDATE listening_v2.privacy_personas SET controller_principal_id='apple-B',privacy_generation=2"));
  await constraint(db.query(`UPDATE listening_v2.privacy_personas SET controller_kind='guest',controller_principal_id='guest',
    controller_key_id='key',guest_credential_digest=$1,guest_credential_expires_at_ms=$2,privacy_generation=2`,[hash(1),now+90*day]));
  await db.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,withdrawn_at_ms=$1,scrub_due_at_ms=$2`,[now+1,now+day]);
  await constraint(db.query(`UPDATE listening_v2.privacy_personas SET status='live',privacy_generation=3,withdrawn_at_ms=NULL,scrub_due_at_ms=NULL`));
  await constraint(db.query('UPDATE listening_v2.privacy_personas SET privacy_generation=1'));
  // No GuestLive claim: SQL has stored a deadline, but has not joined/revoked real auth rows.
  assert.equal((await db.query('SELECT status FROM listening_v2.privacy_personas')).rows[0].status,'withdrawn');
});

test('room JSON octets, 100/512 shared escrow, event/execution/receipt reservations, safe revisions and eight-hour lifetime',async t=>{
  const db=await fixture(t),r=room();await insert(db,'rooms',r);
  const update=(sql,args=[])=>db.query('UPDATE listening_v2.rooms SET '+sql,args);
  for(const bad of [-1,'9007199254740992'])await constraint(update('session_revision=$1',[bad]));
  await constraint(update('authority_epoch=$1',['9007199254740992']));
  await update('session_revision=9007199254740991');
  await constraint(update('session_revision=0'));
  await constraint(update('protocol_version=1'));
  await constraint(insert(db,'rooms',room({environment:otherEnv,expires_at_ms:now+8*3600000+1})));
  await constraint(update('expires_at_ms=expires_at_ms+1'));
  await constraint(update('state=$1',[{}]));
  await constraint(update('state=$1',[{occurrences:[],visits:[],padding:'é'.repeat(131072)}]));
  // JSONB text with its spaces is the conservative UTF-8 measurement used by SQL.
  const empty={occurrences:[],visits:[],padding:''};
  const overhead=(await db.query('SELECT octet_length($1::jsonb::text)::int AS n',[empty])).rows[0].n;
  const exact={...empty,padding:'x'.repeat(262144-overhead)};
  await update('state=$1',[exact]);
  assert.equal((await db.query('SELECT octet_length(state::text)::int AS n FROM listening_v2.rooms')).rows[0].n,262144);
  await constraint(update('state=$1',[{...exact,padding:exact.padding+'x'}]));
  await update('state=$1,occurrence_count=100,observed_visit_count=511,traversal_credits=1',[
    {occurrences:Array(100).fill(null),visits:Array(511).fill(null)}]);
  await constraint(update('desired_credits=1'));
  await update('state=$1,observed_visit_count=512,traversal_credits=0',[
    {occurrences:Array(100).fill(null),visits:Array(512).fill(null)}]);
  await constraint(update('occurrence_count=101,state=$1',[{occurrences:Array(101).fill(null),visits:Array(512).fill(null)}]));
  await constraint(update('observed_visit_count=513,state=$1',[{occurrences:Array(100).fill(null),visits:Array(513).fill(null)}]));
  for(const sql of ['semantic_event_count=20000,reserved_semantic_events=1','reaction_event_count=10001',
    'receipt_count=30000,reserved_receipts=1','execution_count=1000,reserved_executions=1',
    'end_event_reserved=false','terminal_reservation_bytes=0','event_seq=30002'])await constraint(update(sql));
  // Null stand-ins above prove array/count constraints only, not a valid typed room domain.
});

test('creation dedupe ignores room/action; room dedupe includes principal, key, session and environment',async t=>{
  const db=await fixture(t),r=room();await insert(db,'rooms',r);
  const c=receipt(r,{action:'create',ticket_expires_at_ms:now+600000});await insert(db,'command_receipts',c);
  await duplicate(insert(db,'command_receipts',{...c,session_id:randomUUID(),room_id:null,action:'restart'}));
  await duplicate(insert(db,'command_receipts',{...c,canonical_body_hash:hash(99)}));
  await insert(db,'command_receipts',{...c,session_id:randomUUID(),room_id:null,key_binding:hash(15)});
  const normal=receipt(r);await insert(db,'command_receipts',normal);
  await duplicate(insert(db,'command_receipts',{...normal,action:'queue.move'}));
  await insert(db,'command_receipts',{...normal,principal_binding:hash(16)});
  await insert(db,'command_receipts',{...normal,key_binding:hash(17)});
  const r2=room({host_install_scope:hash(18),invite_digest:hash(19),code_digest:hash(20)});await insert(db,'rooms',r2);
  await insert(db,'command_receipts',{...normal,session_id:r2.session_id,room_id:r2.session_id});
  await constraint(insert(db,'command_receipts',receipt(r,{delete_after_ms:now+30*day-1})));
  await constraint(insert(db,'command_receipts',receipt(r,{result:{padding:'x'.repeat(512)}})));
  await constraint(insert(db,'command_receipts',receipt(r,{action:'restart',ticket_expires_at_ms:null})));
  await restricted(db.query('DELETE FROM listening_v2.rooms WHERE environment=$1',[env]));
  // DDL uniqueness rejects duplicate insertion. Exact retry return and changed-body
  // conflict classification require the future locked receipt/store transaction.
});

test('event lane maxima/unique cursors, byte payloads, references and retention fields execute in PostgreSQL',async t=>{
  const db=await fixture(t),r=room();await insert(db,'rooms',r);
  await insert(db,'semantic_events',event(r,{lane_seq:20000}));
  await insert(db,'semantic_events',event(r,{seq:2,lane:'reaction',lane_seq:10000,type:'reaction.accepted'}));
  await insert(db,'semantic_events',event(r,{seq:3,lane:'end',lane_seq:1,type:'session.ended'}));
  await duplicate(insert(db,'semantic_events',event(r,{seq:4,lane:'end',lane_seq:1,type:'session.ended'})));
  for(const overrides of [{seq:4,lane_seq:20001},{seq:4,lane:'reaction',lane_seq:10001},
    {seq:4,lane:'end',lane_seq:2,type:'session.ended'},{seq:4,lane_seq:2,payload:{name:'é'.repeat(256)}},
    {seq:4,lane_seq:2,delete_after_ms:now+day-1},{seq:4,lane_seq:2,actor_persona_id:randomUUID(),actor_privacy_generation:0}]) {
    if(overrides.actor_persona_id)await foreignKey(insert(db,'semantic_events',event(r,overrides)));
    else await constraint(insert(db,'semantic_events',event(r,overrides)));
  }
  const rows=(await db.query("SELECT lane,seq FROM listening_v2.semantic_events WHERE environment=$1 AND session_id=$2 AND lane='semantic' AND seq>0 ORDER BY seq LIMIT 100",[env,r.session_id])).rows;
  assert.deepEqual(rows,[{lane:'semantic',seq:1}]);
});

test('outbox has bounded claim/retry/deadline envelopes and indexed environment-bound job references',async t=>{
  const db=await fixture(t),r=room(),g=guard();await insert(db,'rooms',r);await insert(db,'output_guards',g);
  const j=job(r);await insert(db,'outbox',j);await duplicate(insert(db,'outbox',{...j,job_id:randomUUID()}));
  for(const overrides of [{job_key:'attempts',attempt_count:11},{job_key:'deadline',retry_until_ms:now+day+1},
    {job_key:'lease',state:'claimed'},{job_key:'payload',payload:{version:2,environment:env,padding:'x'.repeat(4096)}},
    {job_key:'no-ref',room_id:null},{job_key:'version',payload:{version:'2',environment:env}}])await constraint(insert(db,'outbox',job(r,overrides)));
  await insert(db,'outbox',job(r,{job_key:'claim',state:'claimed',attempt_count:1,claim_epoch:1,claim_nonce_hash:hash(30),claim_until_ms:now+20000}));
  await insert(db,'outbox',job(r,{job_key:'execute',kind:'execution',guard_id:g.guard_id,guard_revision:0,send_ordinal:0}));
  await foreignKey(insert(db,'outbox',job(r,{job_key:'missing-guard',kind:'execution',guard_id:randomUUID(),guard_revision:0,send_ordinal:0})));
  await constraint(insert(db,'outbox',job(r,{job_key:'published',state:'published',completed_at_ms:now,delete_after_ms:now+day-1})));
  await restricted(db.query('DELETE FROM listening_v2.rooms WHERE environment=$1',[env]));
});

test('private assets enforce staged/current uniqueness, persona FK/generation bounds, byte/dimension and deletion deadline envelopes',async t=>{
  const db=await fixture(t),p=persona();await insert(db,'privacy_personas',p);
  const a=asset(p);await insert(db,'private_profile_assets',a);
  await duplicate(insert(db,'private_profile_assets',asset(p)));
  await insert(db,'private_profile_assets',asset(p,{state:'current'}));
  await duplicate(insert(db,'private_profile_assets',asset(p,{state:'current'})));
  for(const overrides of [{byte_count:262145},{width:257},{stage_expires_at_ms:now+3600001},
    {content_type:'image/svg+xml'},{privacy_generation:'9007199254740992'}])await constraint(insert(db,'private_profile_assets',asset(p,{install_scope:hash(40),...overrides})));
  await restricted(db.query('DELETE FROM listening_v2.privacy_personas WHERE environment=$1',[env]));
  await constraint(db.query(`UPDATE listening_v2.private_profile_assets SET state='revoked',withdrawn_at_ms=$1,
    delete_due_at_ms=$2,backup_delete_due_at_ms=$3`,[now,now+day+1,now+30*day]));
  await db.query(`UPDATE listening_v2.private_profile_assets SET state='revoked',withdrawn_at_ms=$1,
    delete_due_at_ms=$2,backup_delete_due_at_ms=$3`,[now,now+day,now+30*day]);
  await constraint(db.query(`UPDATE listening_v2.private_profile_assets SET state='current',withdrawn_at_ms=NULL,
    delete_due_at_ms=NULL,backup_delete_due_at_ms=NULL WHERE environment=$1 AND asset_id=$2`,[env,a.asset_id]));
  await constraint(db.query('UPDATE listening_v2.private_profile_assets SET content_hash=$1',[hash(99)]));
  // Storing a deadline is not an object-store deletion or read-authorization hook.
  assert.equal((await db.query("SELECT count(*)::int AS n FROM listening_v2.private_profile_assets WHERE state='revoked'")).rows[0].n,2);
});

test('runtime/account roles have no DDL, TRUNCATE, guard DELETE or public raw SQL; narrow account hooks cannot insert execution jobs',async t=>{
  const db=await fixture(t),p=persona(),r=room();await insert(db,'privacy_personas',p);await insert(db,'rooms',r);
  await insert(db,'private_profile_assets',asset(p));
  for(const role of ['lyra_runtime_v1','lyra_account_v1','v2_untrusted']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await denied(db.exec('CREATE TABLE listening_v2.unowned(id integer)'));
      await denied(db.exec('TRUNCATE listening_v2.output_guards'));
      await denied(db.exec('DELETE FROM listening_v2.output_guards'));
      if(role==='v2_untrusted')await denied(db.exec('SELECT * FROM listening_v2.rooms'));
      if(role==='lyra_runtime_v1') {
        await insert(db,'output_guards',guard());
        await denied(db.query('UPDATE listening_v2.privacy_personas SET controller_principal_id=controller_principal_id'));
      }
      if(role==='lyra_account_v1') {
        await denied(insert(db,'rooms',room({environment:otherEnv})));
        await denied(db.query('UPDATE listening_v2.output_guards SET bootstrap_state=$1',[ 'initialized' ]));
        await denied(db.query('UPDATE listening_v2.output_guards SET safety_capsule=$1',[{}]));
        await denied(db.query('DELETE FROM listening_v2.privacy_personas'));
        await db.query(`UPDATE listening_v2.privacy_personas SET controller_kind='apple',controller_principal_id='apple-A',
          controller_key_id=NULL,guest_credential_digest=NULL,guest_credential_expires_at_ms=NULL,privacy_generation=1`);
        await db.query('UPDATE listening_v2.private_profile_assets SET privacy_generation=1');
        await db.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,withdrawn_at_ms=$1,scrub_due_at_ms=$2`,[now,now+day]);
        await insert(db,'outbox',{environment:env,job_id:randomUUID(),job_key:'scrub:'+p.persona_id,kind:'privacy_scrub',
          persona_id:p.persona_id,privacy_generation:2,payload:{version:2,environment:env},created_at_ms:now,due_at_ms:now,retry_until_ms:now+day});
        // Omit INSERT ... RETURNING for the refusal: SELECT grants exist anyway.
        await denied(insert(db,'outbox',job(r,{job_key:'account-execution',kind:'execution',guard_id:randomUUID(),guard_revision:0,send_ordinal:1})));
      }
    } finally {await db.exec('RESET ROLE');}
  }
  const privileges=(await db.query(`SELECT has_schema_privilege('v2_untrusted','listening_v2','USAGE') AS public_usage,
    has_schema_privilege('lyra_runtime_v1','listening_v2','CREATE') AS runtime_ddl,
    has_column_privilege('lyra_account_v1','listening_v2.command_receipts','canonical_body_hash','UPDATE') AS alter_hash,
    has_column_privilege('lyra_account_v1','listening_v2.command_receipts','result','UPDATE') AS redact`)).rows[0];
  assert.deepEqual(privileges,{public_usage:false,runtime_ddl:false,alter_hash:false,redact:true});
});

test('bounded cleanup/cursor selections have usable environment-scoped indexes',async t=>{
  const db=await fixture(t),p=persona(),r=room({privacy_persona_ids:[p.persona_id]});
  await insert(db,'privacy_personas',p);await insert(db,'rooms',r);await insert(db,'outbox',job(r));
  // A selective dependency among a nontrivial cohort avoids tying a test to the
  // planner's arbitrary choice between equally cheap one-row indexes.
  await db.query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
    controller_kind,controller_principal_id,controller_key_id,guest_credential_digest,guest_credential_expires_at_ms,created_at_ms,updated_at_ms)
    SELECT $1,md5(i::text)::uuid,'guest','key-'||i,'guest','guest','key-'||i,lpad(to_hex(i+100),64,'0'),$2,$3,$3
    FROM generate_series(1,1000) AS i`,[env,now+90*day,now]);
  await db.exec('ANALYZE listening_v2.privacy_personas;SET enable_seqscan=off');
  const plan=async(sql,args)=>(await db.query('EXPLAIN '+sql,args)).rows.map(x=>x['QUERY PLAN']).join('\n');
  assert.match(await plan(`SELECT persona_id FROM listening_v2.privacy_personas WHERE environment=$1 AND controller_kind='guest'
    AND status='live' AND guest_credential_expires_at_ms<=$2 ORDER BY guest_credential_expires_at_ms,persona_id LIMIT 100`,[env,now+90*day]),/privacy_personas_expiry/);
  assert.match(await plan(`SELECT persona_id FROM listening_v2.privacy_personas WHERE environment=$1 AND controller_kind='guest'
    AND status='live' AND guest_credential_digest=$2 LIMIT 100`,[env,hash(1)]),/privacy_personas_dependency/);
  assert.match(await plan(`SELECT session_id FROM listening_v2.rooms WHERE ARRAY[environment::text] @> ARRAY[$1::text]
    AND privacy_persona_ids @> ARRAY[$2::uuid] LIMIT 1`,[env,p.persona_id]),/rooms_privacy_refs/);
  assert.match(await plan(`SELECT job_id FROM listening_v2.outbox WHERE environment=$1 AND state='pending' AND due_at_ms<=$2
    ORDER BY due_at_ms,job_id LIMIT 100`,[env,now]),/outbox_due/);
  assert.match(await plan(`SELECT seq FROM listening_v2.semantic_events WHERE environment=$1 AND session_id=$2 AND lane='semantic'
    AND seq>0 ORDER BY seq LIMIT 100`,[env,r.session_id]),/semantic_events_cursor/);
});
