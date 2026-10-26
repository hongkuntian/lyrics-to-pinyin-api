import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

// AUTHORED, not executed by the source-only worker. Actual public migrations,
// then 030, then 031. This suite tests SQL and the documented SQL CAS recipe;
// it does not import/qualify a lifecycle writer, scheduler or authorization API.
const files=['001-song-library.sql','021-app-auth.sql','022-live-lyrics-push.sql',
  '025-memberships.sql','029-listening-sessions.sql','030-listening-v2-schema.sql'];
const sources=await Promise.all(files.map(f=>readFile(new URL('../../db/'+f,import.meta.url),'utf8')));
const lifecycle=await readFile(new URL('../../db/031-listening-v2-lifecycle-support.sql',import.meta.url),'utf8');
const env='preview:lifecycle-a',otherEnv='preview:lifecycle-b',now=1800000000000,day=86400000;
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest=n=>n.toString(16).padStart(64,'0');
const key=n=>Buffer.alloc(32,n).toString('base64');
const tables=['command_receipts','outbox','output_guards','privacy_personas','private_profile_assets',
  'returning_grants','rooms','semantic_events'];
let db,baseline;
async function insert(table,row,client=db){
  const columns=Object.keys(row);
  return client.query(`INSERT INTO listening_v2.${table} (${columns.join(',')})
    VALUES (${columns.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row));
}
const rejected=p=>assert.rejects(p,e=>['23514','23502','22023','22003'].includes(e.code));
const denied=p=>assert.rejects(p,{code:'42501'});
const duplicate=p=>assert.rejects(p,{code:'23505'});
function payload(kind='credential',value=digest(1),overrides={}){
  return {version:2,environment:env,selector:kind==='indexed-sweep'?{kind}:{kind,value},cursor:null,
    invalidatedAtMS:kind==='indexed-sweep'?null:now-1000,...overrides};
}
function hint(p=payload(),overrides={}){
  const jobID=randomUUID();
  return {environment:env,job_id:jobID,job_key:'privacy-dependency:'+jobID,kind:'privacy_dependency',
    payload:p,created_at_ms:now,due_at_ms:now,retry_until_ms:now+day,...overrides};
}
function persona(overrides={}){
  return {environment:env,persona_id:randomUUID(),original_principal_id:'guest',original_key_id:key(1),
    controller_kind:'guest',controller_principal_id:'guest',controller_key_id:key(1),
    guest_credential_digest:digest(1),guest_credential_expires_at_ms:now+day,
    created_at_ms:now,updated_at_ms:now,...overrides};
}
function room(overrides={}){
  return {environment:env,session_id:randomUUID(),host_install_scope:digest(9),provider:'appleMusic',
    invite_digest:digest(10),code_digest:digest(11),created_at_ms:now,expires_at_ms:now+28800000,
    updated_at_ms:now,...overrides};
}
const columns=async()=> (await db.query(`SELECT n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
  pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname IN ('public','listening_v2') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
  ORDER BY 1,2,3`)).rows;
const acl=async()=> (await db.query(`SELECT table_schema,table_name,column_name,grantee,privilege_type
  FROM information_schema.column_privileges WHERE table_schema IN ('public','listening_v2')
  ORDER BY 1,2,3,4,5`)).rows;
const indexCatalog=async()=> (await db.query(`SELECT schemaname,indexname,indexdef FROM pg_indexes
  WHERE schemaname IN ('public','listening_v2') ORDER BY 1,2`)).rows;
before(async()=>{
  db=new PGlite();
  await db.exec('CREATE ROLE lyra_runtime_v1; CREATE ROLE lyra_account_v1; CREATE ROLE lifecycle_untrusted;');
  for(const sql of sources)await db.exec(sql);
  baseline={columns:await columns(),acl:await acl(),indexes:await indexCatalog(),
    roles:(await db.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows,
    functions:(await db.query(`SELECT p.proname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='listening_v2' ORDER BY p.proname`)).rows};
  await db.exec(lifecycle);
});
after(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec(`TRUNCATE ${tables.map(t=>'listening_v2.'+t).join(',')} CASCADE;
    TRUNCATE public.library_users CASCADE;`);
});

test('031 reapplies additively with eight V2 relations, unchanged columns, functions, roles and grants',async()=>{
  await insert('outbox',hint());
  const oldID=randomUUID();
  await db.exec("INSERT INTO library_users(id) VALUES('v1-owner')");
  await db.query(`INSERT INTO listening_rooms(id,environment,owner_id,status,invite_hash,code_hash,data)
    VALUES($1,'v1-fixture','v1-owner','active','v1-invite','v1-code','{"unchanged":true}')`,[oldID]);
  const old=(await db.query('SELECT to_jsonb(t) AS row FROM listening_rooms t')).rows;
  const prior=(await db.query('SELECT to_jsonb(t) AS row FROM listening_v2.outbox t')).rows;
  const indexes=await indexCatalog();
  await db.exec(lifecycle);await db.exec(lifecycle);
  assert.deepEqual(await indexCatalog(),indexes);
  assert.deepEqual(await columns(),baseline.columns);assert.deepEqual(await acl(),baseline.acl);
  assert.deepEqual((await db.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows,baseline.roles);
  assert.deepEqual((await db.query(`SELECT p.proname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='listening_v2' ORDER BY p.proname`)).rows,baseline.functions);
  assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='listening_v2' ORDER BY tablename")).rows.map(r=>r.tablename),tables);
  assert.deepEqual((await db.query('SELECT to_jsonb(t) AS row FROM listening_rooms t')).rows,old);
  assert.deepEqual((await db.query('SELECT to_jsonb(t) AS row FROM listening_v2.outbox t')).rows,prior);
  for(const index of baseline.indexes)assert.deepEqual(indexes.find(x=>x.indexname===index.indexname&&x.schemaname===index.schemaname),index);
});

test('030 alone rejects the new kind; transactional 031 failure leaves 030 intact before retry',async t=>{
  const old=new PGlite();t.after(()=>old.close());
  for(const sql of sources)await old.exec(sql); // roles absent is supported by the actual conditional grants
  await rejected(insert('outbox',hint(),old));
  const constraints=async()=> (await old.query(`SELECT conname,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='listening_v2.outbox'::regclass ORDER BY conname`)).rows;
  const prior=await constraints();
  await old.exec('ALTER TABLE listening_v2.outbox RENAME CONSTRAINT outbox_kind_check TO unexpected_kind_check');
  await rejected(old.exec(lifecycle));await old.exec('ROLLBACK');
  await old.exec('ALTER TABLE listening_v2.outbox RENAME CONSTRAINT unexpected_kind_check TO outbox_kind_check');
  assert.deepEqual(await constraints(),prior);
  await assert.rejects(old.exec(lifecycle.replace(/COMMIT;\s*$/,'SELECT 1/0;\nCOMMIT;')),{code:'22012'});
  await old.exec('ROLLBACK');assert.deepEqual(await constraints(),prior);
  assert.equal((await old.query("SELECT to_regclass('listening_v2.privacy_personas_live_credential') AS i")).rows[0].i,null);
  await old.exec(lifecycle);await insert('outbox',hint(),old);
});

test('only the five exact selectors and exact keyset cursors are admitted',async()=>{
  for(const [kind,value] of [['credential',digest(1)],['guest-user','guest'],['guest-key',key(1)],
    ['guest-key',key(255)],['apple-controller','apple-A'],['indexed-sweep',undefined]]){
    const p=payload(kind,value,{cursor:[otherEnv,uuid(5)]});
    const row=(await insert('outbox',hint(p))).rows[0];assert.deepEqual(row.payload,p);
    assert.ok(Buffer.byteLength(JSON.stringify(row.payload))<=512);
  }
  await insert('outbox',hint(payload('credential',digest(2),{invalidatedAtMS:0})));
  const max=Number.MAX_SAFE_INTEGER;
  await insert('outbox',hint(payload('credential',digest(3),{invalidatedAtMS:max-day}),
    {created_at_ms:max-day,due_at_ms:max-day,retry_until_ms:max}));
  const invalid=[null,[],{},payload('unknown','x'),payload('credential',digest(1).toUpperCase().replace(/1$/,'A')),
    payload('guest-user',null),payload('guest-user',{}),payload('guest-user',[]),payload('guest-user',5),
    payload('credential','x'),payload('guest-key','x'.repeat(44)),payload('guest-key','A'.repeat(42)+'B='),
    payload('guest-user',''),payload('guest-user','x'.repeat(161)),payload('guest-user','é'.repeat(81)),
    payload('apple-controller','a\n'),payload('indexed-sweep',undefined,{selector:{kind:'indexed-sweep',value:'x'}}),
    payload('credential',digest(1),{selector:{kind:'credential',value:digest(1),personaID:uuid(1)}}),
    payload('credential',digest(1),{version:'2'}),payload('credential',digest(1),{version:3}),
    payload('credential',digest(1),{environment:otherEnv}),payload('credential',digest(1),{cursor:[]}),
    payload('credential',digest(1),{cursor:[env]}),payload('credential',digest(1),{cursor:[env,uuid(1),'extra']}),
    payload('credential',digest(1),{cursor:{environment:env,personaID:uuid(1)}}),
    payload('credential',digest(1),{cursor:['preview',uuid(1)]}),payload('credential',digest(1),{cursor:[env,'not-a-uuid']}),
    payload('credential',digest(1),{cursor:[env,'00000000-0000-4000-8000-00000000AAAA']}),
    payload('credential',digest(1),{invalidatedAtMS:null}),payload('credential',digest(1),{invalidatedAtMS:'1'}),
    payload('credential',digest(1),{invalidatedAtMS:-1}),payload('credential',digest(1),{invalidatedAtMS:0.5}),
    payload('credential',digest(1),{invalidatedAtMS:9007199254740992}),
    payload('credential',digest(1),{invalidatedAtMS:now+1}),
    payload('indexed-sweep',undefined,{invalidatedAtMS:now})];
  for(const p of invalid)await rejected(insert('outbox',hint(p)));
  for(const field of ['version','environment','selector','cursor','invalidatedAtMS']){
    const p=payload();delete p[field];await rejected(insert('outbox',hint(p)));
  }
  for(const field of ['roomID','sessionID','guardID','personaID','assetID','guardRevision','sendOrdinal',
    'privacyGeneration','bearer','publicKey','name','execute','release'])await rejected(insert('outbox',hint({...payload(),[field]:'forbidden'})));
});

test('payload remains <=512 normalized UTF-8 bytes, including cursor reserve; no other caps change',async()=>{
  const p=payload('guest-user','x'.repeat(160),{environment:'preview:'+'e'.repeat(120),
    cursor:['preview:'+'c'.repeat(120),uuid(1)]});
  const size=(await db.query('SELECT octet_length($1::jsonb::text)::int AS n',[p])).rows[0].n;
  assert.ok(size>512);await rejected(insert('outbox',hint(p,{environment:p.environment})));
  const n=160-(size-512);assert.ok(n>0&&n<160);
  const exact={...p,selector:{kind:'guest-user',value:'x'.repeat(n)}};
  const j=hint(exact,{environment:p.environment});await insert('outbox',j);
  assert.equal((await db.query('SELECT octet_length(payload::text)::int AS n FROM listening_v2.outbox WHERE environment=$1 AND job_id=$2',
    [j.environment,j.job_id])).rows[0].n,512);
  await rejected(insert('outbox',hint({...exact,selector:{kind:'guest-user',value:'x'.repeat(n+1)}},{environment:p.environment})));
  const firstPage={...p,cursor:null};
  assert.ok((await db.query('SELECT octet_length($1::jsonb::text)::int AS n',[firstPage])).rows[0].n<=512);
  await rejected(insert('outbox',hint(firstPage,{environment:p.environment})));
  const accepted=payload('guest-user','é'.repeat(40),{cursor:[otherEnv,uuid(1)]});
  await insert('outbox',hint(accepted));
  // Existing 030 persona and event/result caps are preserved, not expanded.
  await rejected(insert('privacy_personas',persona({original_principal_id:'x'.repeat(160),
    controller_principal_id:'x'.repeat(160)})));
  const r=room();await insert('rooms',r);
  await rejected(insert('semantic_events',{environment:env,session_id:r.session_id,event_id:uuid(8),seq:1,
    lane:'semantic',lane_seq:1,state_version:0,type:'privacy.test',payload:{x:'x'.repeat(512)},
    server_at_ms:now,delete_after_ms:now+day}));
});

test('hint references/fences and all legacy closed kinds remain constrained',async()=>{
  for(const [field,value] of [['room_id',uuid(1)],['guard_id',uuid(1)],['persona_id',uuid(1)],['asset_id',uuid(1)],
    ['privacy_generation',0],['guard_revision',0],['send_ordinal',0]]){
    // CHECK precedes FK; no referenced row can turn this hint into execution.
    await rejected(insert('outbox',hint(payload(),{[field]:value})));
  }
  await rejected(insert('outbox',hint(payload(),{kind:'unrecognized'})));
  await rejected(insert('outbox',hint(payload(),{job_key:'caller-selected'})));
  await rejected(insert('outbox',hint(payload(),{state:'cancelled',completed_at_ms:now,delete_after_ms:now+day})));
  const r=room(),p=persona();await insert('rooms',r);await insert('privacy_personas',p);
  for(const kind of ['wake','room_expiry'])await insert('outbox',{...hint({version:2,environment:env}),kind,room_id:r.session_id});
  await insert('outbox',{...hint({version:2,environment:env}),kind:'privacy_scrub',persona_id:p.persona_id,privacy_generation:0});
  await rejected(insert('outbox',{...hint({version:2,environment:env}),kind:'privacy_scrub'}));
  await rejected(insert('outbox',{...hint({version:2,environment:env}),kind:'execution',room_id:r.session_id}));
  await rejected(insert('outbox',{...hint({version:2,environment:env}),kind:'guard_cleanup'}));
  await rejected(insert('outbox',{...hint({version:2,environment:env}),kind:'asset_delete',persona_id:p.persona_id,privacy_generation:0}));
  await rejected(insert('outbox',{...hint({version:'2',environment:env}),kind:'wake',room_id:r.session_id}));
  await rejected(insert('outbox',hint(payload(),{attempt_count:11})));
  await rejected(insert('outbox',hint(payload(),{retry_until_ms:now+day+1})));
});

test('coalescing is exact environment+selector, excludes completed handoffs, and retains dead hints',async()=>{
  const first=hint();await insert('outbox',first);
  await duplicate(insert('outbox',hint()));
  await duplicate(insert('outbox',hint({...payload(),selector:{value:digest(1),kind:'credential'}})));
  await insert('outbox',hint(payload('credential',digest(2))));
  await insert('outbox',hint(payload('guest-user',digest(1))));
  await insert('outbox',hint({...payload(),environment:otherEnv},{environment:otherEnv}));
  await db.query(`UPDATE listening_v2.outbox SET state='dead',completed_at_ms=$3::bigint,delete_after_ms=$3::bigint+$4::bigint
    WHERE environment=$1 AND job_id=$2`,[env,first.job_id,now,day]);
  await duplicate(insert('outbox',hint()));
  await db.query("UPDATE listening_v2.outbox SET state='published' WHERE environment=$1 AND job_id=$2",[env,first.job_id]);
  await insert('outbox',hint()); // a genuinely new invalidation cycle, after durable handoff
});

// This is the storage contract's SQL recipe, NOT a lifecycle service. The
// trusted service must hold earlier identity anchors before this final CAS.
// $3/$4/$5 are the exact observed payload/state/claim epoch, never caller auth.
const mergeCAS=`UPDATE listening_v2.outbox SET
  payload=jsonb_set(jsonb_set(payload,'{invalidatedAtMS}',
    to_jsonb(LEAST((payload->>'invalidatedAtMS')::bigint,$6::bigint))),'{cursor}',
    CASE WHEN $6::bigint<(payload->>'invalidatedAtMS')::bigint THEN 'null'::jsonb ELSE payload->'cursor' END)
  WHERE environment=$1 AND job_id=$2 AND kind='privacy_dependency' AND payload=$3::jsonb
    AND state=$4 AND claim_epoch=$5 AND state IN ('pending','dead')
    AND payload->'selector'->>'kind'<>'indexed-sweep' RETURNING *`;
test('documented runtime merge CAS preserves earliest invalidation, rejects stale snapshots, and resets cursor for earlier evidence',async()=>{
  const j=hint(payload('credential',digest(1),{cursor:[otherEnv,uuid(5)]}));await insert('outbox',j);
  await db.exec('SET ROLE lyra_runtime_v1');
  try{
    let row=(await db.query('SELECT * FROM listening_v2.outbox WHERE environment=$1 AND job_id=$2',[env,j.job_id])).rows[0];
    const merge=(expected,at)=>db.query(mergeCAS,[env,j.job_id,expected.payload,expected.state,expected.claim_epoch,at]);
    row=(await merge(row,now-500)).rows[0];assert.equal(row.payload.invalidatedAtMS,now-1000);
    assert.deepEqual(row.payload.cursor,[otherEnv,uuid(5)]);
    const stale=structuredClone(row);
    row=(await merge(row,now-2000)).rows[0];assert.equal(row.payload.invalidatedAtMS,now-2000);assert.equal(row.payload.cursor,null);
    assert.equal((await merge(stale,now-3000)).rows.length,0);
    // Retry bookkeeping changes no timestamp; a late sweep time cannot replace it.
    await db.query(`UPDATE listening_v2.outbox SET state='claimed',attempt_count=1,claim_epoch=1,
      claim_nonce_hash=$3,claim_until_ms=$4 WHERE environment=$1 AND job_id=$2`,[env,j.job_id,digest(6),now+10000]);
    assert.equal((await merge(row,now)).rows.length,0);
    await db.query(`UPDATE listening_v2.outbox SET state='dead',attempt_count=10,claim_nonce_hash=NULL,
      claim_until_ms=NULL,completed_at_ms=$3::bigint,delete_after_ms=$3::bigint+$4::bigint WHERE environment=$1 AND job_id=$2`,[env,j.job_id,now+day,day]);
    const dead=(await db.query('SELECT * FROM listening_v2.outbox WHERE environment=$1 AND job_id=$2',[env,j.job_id])).rows[0];
    assert.equal(dead.payload.invalidatedAtMS,now-2000);
    row=(await merge(dead,now+day)).rows[0];assert.equal(row.payload.invalidatedAtMS,now-2000);
    assert.equal(String(row.created_at_ms),String(now));assert.equal(String(row.retry_until_ms),String(now+day));
  }finally{await db.exec('RESET ROLE');}
  // SQL does not police arbitrary trusted-role UPDATE/DELETE or implement the
  // durable handoff/no-resurrection scheduler. No engine-level monotone claim.
});

test('account can insert/observe coalesced hints through existing columns but cannot merge, claim or execute',async()=>{
  const first=hint();await db.exec('SET ROLE lyra_account_v1');
  try{
    await insert('outbox',first);
    const second=hint(payload('credential',digest(1),{invalidatedAtMS:now-100}));
    const keys=Object.keys(second);
    const result=await db.query(`INSERT INTO listening_v2.outbox(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})
      ON CONFLICT DO NOTHING RETURNING job_id`,Object.values(second));assert.equal(result.rows.length,0);
    const rows=(await db.query(`SELECT * FROM listening_v2.outbox WHERE environment=$1 AND kind='privacy_dependency'
      AND state<>'published' AND payload->'selector'=$2::jsonb`,[env,first.payload.selector])).rows;
    assert.equal(rows.length,1);assert.ok(rows[0].payload.invalidatedAtMS<=second.payload.invalidatedAtMS);
    // If this comparison is false, the account transaction MUST refuse/roll
    // back for runtime repair. INSERT DO NOTHING alone is not coalescing proof.
    await denied(db.query(mergeCAS,[env,first.job_id,rows[0].payload,'pending',0,now-2000]));
    await denied(db.exec("UPDATE listening_v2.outbox SET state='claimed'"));
    await denied(db.exec('DELETE FROM listening_v2.outbox'));
    await denied(insert('outbox',hint(payload(),{room_id:uuid(1),guard_id:uuid(2),guard_revision:0,send_ordinal:1,kind:'execution'})));
    await denied(insert('outbox',hint(payload(),{guard_id:uuid(2),guard_revision:0,send_ordinal:1,kind:'guard_cleanup'})));
    await rejected(insert('outbox',hint(payload('guest-user','guest'),{persona_id:uuid(2)})));
    await denied(db.exec('CREATE TABLE listening_v2.forbidden(id integer)'));
    await denied(db.exec('TRUNCATE listening_v2.output_guards'));
    await denied(db.exec('DELETE FROM listening_v2.output_guards'));
  }finally{await db.exec('RESET ROLE');}
  await db.exec('SET ROLE lifecycle_untrusted');
  try{await denied(db.exec('SELECT * FROM listening_v2.outbox'));await denied(insert('outbox',hint()));}
  finally{await db.exec('RESET ROLE');}
});

async function populatePersonas(){
  // Retired history outnumbers live rows and deliberately shares selectors.
  // No fake auth tables: personas are the real 030 relation; their identifiers
  // alone confer no GuestLive/controller authority.
  await db.query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
    controller_kind,controller_principal_id,controller_key_id,guest_credential_digest,guest_credential_expires_at_ms,
    status,privacy_generation,withdrawn_at_ms,scrub_due_at_ms,created_at_ms,updated_at_ms)
    SELECT $1,md5('history-'||i)::uuid,'guest',$2,'guest','guest',$2,$3,$4,'withdrawn',1,$5::bigint,$5::bigint+$6::bigint,$5::bigint,$5::bigint
    FROM generate_series(1,5000) i`,[env,key(1),digest(1),now+day,now,day]);
  await db.query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
    controller_kind,controller_principal_id,controller_key_id,guest_credential_digest,guest_credential_expires_at_ms,created_at_ms,updated_at_ms)
    SELECT $1,md5('live-'||i)::uuid,'g-'||i,'k-'||i,'guest','g-'||i,'k-'||i,lpad(to_hex(i+100),64,'0'),$2,$3,$3
    FROM generate_series(1,500) i`,[env,now+day,now]);
  for(const e of [env,otherEnv]){
    await insert('privacy_personas',persona({environment:e,persona_id:uuid(1)}));
    await insert('privacy_personas',persona({environment:e,persona_id:uuid(2),original_principal_id:'former-guest',original_key_id:key(2),controller_kind:'apple',
      controller_principal_id:'apple-A',controller_key_id:null,guest_credential_digest:null,guest_credential_expires_at_ms:null}));
  }
  await db.exec('ANALYZE listening_v2.privacy_personas');
}
function nodes(plan){return [plan,...(plan.Plans??[]).flatMap(nodes)];}
async function selective(sql,args,index,condition){
  const raw=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'];
  const plan=(typeof raw==='string'?JSON.parse(raw):raw)[0].Plan;
  const all=nodes(plan),scan=all.find(n=>n['Index Name']===index);
  assert.ok(scan,JSON.stringify(plan));assert.match(scan['Index Cond']??'',condition);
  assert.match(scan['Index Cond']??'',/>/,'successor cursor must be an index range, not a post-scan filter');
  if(index.startsWith('privacy_personas'))assert.match(scan['Index Cond'],/environment.*persona_id/);
  assert.equal(all.some(n=>n['Node Type']==='Seq Scan'),false,JSON.stringify(plan));
  assert.equal(scan['Rows Removed by Filter']??0,0,JSON.stringify(plan));
  console.log('LIFECYCLE_PLAN '+JSON.stringify({index:scan['Index Name'],condition:scan['Index Cond'],
    actualRows:scan['Actual Rows'],filteredRows:scan['Rows Removed by Filter']??0,
    sharedHits:scan['Shared Hit Blocks'],sharedReads:scan['Shared Read Blocks']}));
  return plan;
}
test('dependency-led C-order indexes seek live personas across environments amid unrelated retired history',async()=>{
  await populatePersonas();
  for(const [column,value,kind,index] of [
    ['guest_credential_digest',digest(1),'guest','privacy_personas_live_credential'],
    ['original_principal_id','guest','guest','privacy_personas_live_guest_user'],
    ['original_key_id',key(1),'guest','privacy_personas_live_guest_key'],
    ['controller_principal_id','apple-A','apple','privacy_personas_live_apple_controller']]){
    const sql=`SELECT environment,persona_id FROM listening_v2.privacy_personas
      WHERE ${column} COLLATE "C"=$1::text COLLATE "C" AND controller_kind='${kind}' AND status='live'
      AND (${column} COLLATE "C",environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::text COLLATE "C",$3::uuid)
      ORDER BY environment COLLATE "C",persona_id LIMIT 100`;
    const args=[value,env,uuid(kind==='apple'?2:1)];
    await selective(sql,args,index,new RegExp(column));
    const rows=(await db.query(sql,args)).rows;
    assert.deepEqual(rows,[{environment:otherEnv,persona_id:uuid(kind==='apple'?2:1)}]);
  }
  const sweep=`SELECT environment,persona_id FROM listening_v2.privacy_personas WHERE controller_kind='guest' AND status='live'
    AND (environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::uuid)
    ORDER BY environment COLLATE "C",persona_id LIMIT 100`;
  await selective(sweep,[env,uuid(1)],'privacy_personas_live_guest_sweep',/ROW|environment/);
  const first=(await db.query(sweep,[env,uuid(1)])).rows;assert.equal(first.length,100);
  const last=first.at(-1),second=(await db.query(sweep,[last.environment,last.persona_id])).rows;
  assert.equal(second.some(r=>first.some(x=>x.environment===r.environment&&x.persona_id===r.persona_id)),false);
  // Plans are selective-access evidence on this fixture, not measured IO,
  // scheduler throughput, latency or deadline compliance. No forced seqscan-off.
});

test('actual public owner enumeration includes revoked rows and seeks canonical byte-order cursors',async()=>{
  await db.exec(`INSERT INTO library_users(id) SELECT 'other-'||i FROM generate_series(1,5000) i;
    INSERT INTO library_users(id) VALUES('target');
    INSERT INTO library_tokens(digest,user_id,revoked) SELECT md5('token-'||i),'other-'||i,true FROM generate_series(1,5000) i;
    INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt,revoked)
    SELECT 'other-key-'||i,'other-'||i,'test','test.bundle','development','synthetic','synthetic',true FROM generate_series(1,5000) i;
    INSERT INTO app_auth_sessions(digest,key_id,credential_digest,audience,expires_at,revoked)
    SELECT md5('session-'||i),'other-key-'||i,md5('token-'||i),'test',clock_timestamp(),true FROM generate_series(1,5000) i;`);
  for(const n of [1,2,3]){
    await db.query('INSERT INTO library_tokens(digest,user_id,revoked) VALUES($1,$2,$3)',[digest(n),'target',n===2]);
    await db.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt,revoked)
      VALUES($1,'target','test','test.bundle','development','synthetic','synthetic',$2)`,[key(n),n===2]);
    await db.query(`INSERT INTO app_auth_sessions(digest,key_id,credential_digest,audience,expires_at,revoked)
      VALUES($1,$2,$3,'test',clock_timestamp(),$4)`,[digest(n),key(1),digest(1),n===2]);
  }
  await db.exec('ANALYZE library_tokens; ANALYZE app_attest_keys; ANALYZE app_auth_sessions;');
  for(const [table,owner,id,ownerValue,cursor,index,expected] of [
    ['library_tokens','user_id','digest','target',digest(1),'library_tokens_owner_digest',[digest(2),digest(3)]],
    ['app_attest_keys','user_id','key_id','target','', 'app_attest_keys_owner_key',[key(1),key(2),key(3)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))],
    ['app_auth_sessions','key_id','digest',key(1),digest(1),'app_auth_sessions_key_digest',[digest(2),digest(3)]]]){
    const sql=`SELECT ${id} FROM public.${table} WHERE ${owner} COLLATE "C"=$1::text COLLATE "C"
      AND ${id} COLLATE "C">$2::text COLLATE "C" ORDER BY ${id} COLLATE "C" LIMIT 100`;
    await selective(sql,[ownerValue,cursor],index,new RegExp(owner));
    assert.deepEqual((await db.query(sql,[ownerValue,cursor])).rows.map(r=>r[id]),expected);
  }
});

test('index catalog has exact predicates, C text keys and no new relation or identity columns',async()=>{
  const indexes=await indexCatalog();
  for(const [name,keys,kind] of [
    ['privacy_personas_live_credential','guest_credential_digest COLLATE "C", environment COLLATE "C", persona_id','guest'],
    ['privacy_personas_live_guest_user','original_principal_id COLLATE "C", environment COLLATE "C", persona_id','guest'],
    ['privacy_personas_live_guest_key','original_key_id COLLATE "C", environment COLLATE "C", persona_id','guest'],
    ['privacy_personas_live_apple_controller','controller_principal_id COLLATE "C", environment COLLATE "C", persona_id','apple'],
    ['privacy_personas_live_guest_sweep','environment COLLATE "C", persona_id','guest'],
    ['library_tokens_owner_digest','user_id COLLATE "C", digest COLLATE "C"'],
    ['app_attest_keys_owner_key','user_id COLLATE "C", key_id COLLATE "C"'],
    ['app_auth_sessions_key_digest','key_id COLLATE "C", digest COLLATE "C"']]){
    const index=indexes.find(x=>x.indexname===name);assert.ok(index,name);assert.match(index.indexdef,/COLLATE "C"/);
    assert.ok(index.indexdef.includes('('+keys+')'),index.indexdef);
    if(kind)assert.match(index.indexdef,new RegExp("controller_kind.*'"+kind+"'.*status.*'live'"));
  }
  const coalesce=indexes.find(x=>x.indexname==='outbox_privacy_dependency_pending');assert.ok(coalesce);
  assert.match(coalesce.indexdef,/UNIQUE INDEX/);assert.match(coalesce.indexdef,/selector/);assert.match(coalesce.indexdef,/published/);
  assert.deepEqual(await columns(),baseline.columns);
});
