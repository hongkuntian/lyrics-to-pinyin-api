import test, {before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createReceiptStore,decodeSafeUInt} from '../../api/utils/listening-v2/receipt-store.js';
import {createCreationTickets,canonicalCommandHash} from '../../api/utils/listening-v2/tickets.js';
import {SessionV2Error} from '../../api/utils/listening-v2/errors.js';

// Deliberately one embedded connection. The SQL auth/clock fixture tests the
// injected hook contract, not production App Attest or concurrent PostgreSQL.
const environment='preview:receipt-r1',otherEnvironment='preview:receipt-r1-b';
const start=1800000000000,day=86400000,auth={principalID:'guest',keyID:'key',credentialDigest:'c'.repeat(64)};
const binding1={version:1,secret:Buffer.alloc(32,11)},binding2={version:2,secret:Buffer.alloc(32,22)};
const binding3={version:3,secret:Buffer.alloc(32,33)},binding4={version:65534,secret:Buffer.alloc(32,44)};
const ticketKey={id:'ticket-1',secret:Buffer.alloc(32,33)};
const digest=n=>n.toString(16).padStart(64,'0');
let sql,clock,transactions,trace,queries,calls,mutator,hookOverride,commitCheck,personaID;
before(async()=>{
 sql=new PGlite();
 await sql.exec(await readFile(new URL('../../db/030-listening-v2-schema.sql',import.meta.url),'utf8'));
 await sql.exec(`CREATE TABLE receipt_fixture_users(id text PRIMARY KEY,enabled boolean NOT NULL);
  CREATE TABLE receipt_fixture_tokens(digest text PRIMARY KEY,user_id text,revoked boolean,expires bigint);
  CREATE TABLE receipt_fixture_keys(id text PRIMARY KEY,user_id text,revoked boolean);
  CREATE TABLE receipt_fixture_clock(ms bigint NOT NULL);`);
});
after(()=>sql.close());
beforeEach(async()=>{
 await sql.exec(`TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,
  listening_v2.rooms,listening_v2.privacy_personas,listening_v2.private_profile_assets,listening_v2.returning_grants;
  TRUNCATE receipt_fixture_users,receipt_fixture_tokens,receipt_fixture_keys,receipt_fixture_clock;
  INSERT INTO receipt_fixture_users VALUES('guest',true),('other',true);
  INSERT INTO receipt_fixture_tokens VALUES('${auth.credentialDigest}','guest',false,${start+90*day});
  INSERT INTO receipt_fixture_keys VALUES('key','guest',false),('key-2','guest',false);
  INSERT INTO receipt_fixture_clock VALUES(${start});`);
 clock=start;transactions=0;trace=[];queries=[];calls=0;hookOverride=null;commitCheck=null;personaID=null;
 mutator=async({tx,command,nowMS})=>{
  calls++;
  if(['create','restart'].includes(command.action))await room(tx,command.sessionID,{at:nowMS});
  else await tx.query(`UPDATE listening_v2.rooms SET state_version=state_version+1,
   updated_at_ms=$3 WHERE environment=$1 AND session_id=$2`,[command.environment,command.sessionID,nowMS]);
  return {status:'accepted',result:{stateVersion:1}};
 };
});
const db={transaction:async fn=>{
 transactions++;
 return sql.transaction(async tx=>{
  trace.push('transaction');
  const query=tx.query.bind(tx);
  const connection={query:async(text,params)=>{trace.push(text);queries.push({text,params});return query(text,params);}};
  return fn(connection);
 });
}};
async function dbClock(tx){return (await tx.query('SELECT ms::text AS ms FROM receipt_fixture_clock')).rows[0].ms;}
async function advance(tx,ms){clock=ms;await tx.query('UPDATE receipt_fixture_clock SET ms=$1',[ms]);}
async function lockAuthorization({tx,authentication,environment:env,bindingKeyManifest}){
 trace.push('auth-lock');
 const {principalID,keyID,credentialDigest}=authentication;
 // Fixture has no identity/connection/guard scopes. User/token precede key;
 // the exclusive exact-key lock is the cross-version replay serialization anchor.
 await tx.query('SELECT id FROM receipt_fixture_users WHERE id=$1 FOR UPDATE',[principalID]);
 await tx.query('SELECT digest FROM receipt_fixture_tokens WHERE digest=$1 FOR UPDATE',[credentialDigest]);
 await tx.query('SELECT id FROM receipt_fixture_keys WHERE id=$1 FOR UPDATE',[keyID]);
 for(const descriptor of bindingKeyManifest.keys){
  const configured=[binding1,binding2,binding3,binding4].find(key=>key.version===descriptor.version);
  if(!configured||descriptor.verificationHash!==createHmac('sha256',configured.secret)
   .update(JSON.stringify(['sessions-v2.receipt-key-check',descriptor.version,env])).digest('hex'))throw new SessionV2Error('unavailable');
 }
 if(hookOverride){
  const value=hookOverride({tx,authentication,environment:env});
  return value&&typeof value==='object'?{bindingKeyManifestHash:bindingKeyManifest.hash,...value}:value;
 }
 const p=personaID?(await tx.query('SELECT * FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2 FOR SHARE',[env,personaID])).rows[0]:null;
 const expiry=(await tx.query('SELECT expires::text FROM receipt_fixture_tokens WHERE digest=$1',[credentialDigest])).rows[0]?.expires;
 return {version:1,environment:env,principalID,keyID,bindingKeyManifestHash:bindingKeyManifest.hash,
  notAfterMS:Math.min(decodeSafeUInt(expiry),p?decodeSafeUInt(p.guest_credential_expires_at_ms):Number.MAX_SAFE_INTEGER),
  actorPersonaID:p?.persona_id??null,actorPrivacyGeneration:p?decodeSafeUInt(p.privacy_generation):null,
  revalidate:async({tx:again,nowMS,phase,receipt})=>{
   assert.equal(again,tx);trace.push('auth-'+phase);
   if(phase==='commit'&&commitCheck)await commitCheck({tx,nowMS});
   const r=(await tx.query(`SELECT u.enabled,t.revoked AS token_revoked,t.expires::text,
    k.revoked AS key_revoked,t.user_id AS token_owner,k.user_id AS key_owner
    FROM receipt_fixture_users u JOIN receipt_fixture_tokens t ON t.digest=$2
    JOIN receipt_fixture_keys k ON k.id=$3 WHERE u.id=$1`,[principalID,credentialDigest,keyID])).rows[0];
   if(!r||!r.enabled||r.token_revoked||r.key_revoked||r.token_owner!==principalID||
    r.key_owner!==principalID||nowMS>=decodeSafeUInt(r.expires))return false;
   if(p){
    const current=(await tx.query('SELECT * FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2',[env,p.persona_id])).rows[0];
    if(!current||current.status!=='live'||decodeSafeUInt(current.privacy_generation)!==decodeSafeUInt(p.privacy_generation)||
     current.controller_principal_id!==principalID||current.controller_key_id!==keyID||
     current.guest_credential_digest!==credentialDigest||nowMS>=decodeSafeUInt(current.guest_credential_expires_at_ms))return false;
    if(receipt?.actor_persona_id&&(receipt.actor_persona_id!==p.persona_id||receipt.actor_privacy_generation!==decodeSafeUInt(p.privacy_generation)))return false;
   }
   return true;
  }};
}
function store(options={}){
 return createReceiptStore({db,environment,bindingKeys:[binding1],activeBindingKeyVersion:1,
  ticketKeys:[ticketKey],activeTicketKeyID:ticketKey.id,lockAuthorization,
  mutations:Object.fromEntries(['create','restart','queue.add','queue.move','privacy.erase'].map(action=>[action,args=>mutator(args)])),
  now:()=>clock,readClockMS:dbClock,...options});
}
function creation(action='create',payload={provider:'appleMusic'}){
 const semantic={version:2,action,expected:action==='restart'?{sourceRecapRevision:7}:{},payload};
 const rawCommand=JSON.stringify(semantic),bodyHash=canonicalCommandHash(rawCommand);
 const ticket=createCreationTickets({keys:[ticketKey],activeKeyID:ticketKey.id,now:()=>clock}).issue({
  environment,principalID:auth.principalID,keyID:auth.keyID,action,bodyHash,
  sourceRecapRevision:action==='restart'?7:null});
 return {input:{authentication:auth,rawCommand,creationTicket:ticket.ticket},...ticket};
}
function mutation(sessionID,overrides={}){
 return {authentication:auth,rawCommand:JSON.stringify({version:2,action:'queue.add',sessionID,
  commandID:randomUUID(),expected:{queueRevision:0},payload:{catalogSelectionID:'selection',placement:'end'},...overrides})};
}
async function room(tx,id,{env=environment,at=start,scope=digest(1),...overrides}={}){
 const row={environment:env,session_id:id,host_install_scope:scope,provider:'appleMusic',
  invite_digest:digest(2),code_digest:digest(3),created_at_ms:at,expires_at_ms:at+8*3600000,updated_at_ms:at,...overrides};
 const keys=Object.keys(row);await tx.query(`INSERT INTO listening_v2.rooms (${keys.join(',')})
  VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
}
async function count(table){return (await sql.query('SELECT count(*)::int AS n FROM listening_v2.'+table)).rows[0].n;}
const rejects=(promise,code)=>assert.rejects(promise,{code});

test('create and equal retry return the durable result once; canonical key order is insignificant',async()=>{
 const c=creation(),s=store(),first=await s.execute(c.input);
 assert.equal(first.replayed,false);assert.equal(first.sessionID,c.sessionID);
 const reordered={...c.input,rawCommand:'{"payload":{"provider":"appleMusic"},"expected":{},"action":"create","version":2}'};
 const retry=await s.execute(reordered);
 assert.deepEqual({...retry,replayed:false},first);assert.equal(retry.replayed,true);assert.equal(calls,1);
 assert.equal(await count('rooms'),1);assert.equal(await count('command_receipts'),1);
 const row=(await sql.query('SELECT * FROM listening_v2.command_receipts')).rows[0];
 assert.notEqual(row.principal_binding,auth.principalID);assert.notEqual(row.key_binding,auth.keyID);
 assert.equal(decodeSafeUInt(row.ticket_expires_at_ms),c.notAfterMS);
 assert.equal(decodeSafeUInt(row.delete_after_ms),start+8*3600000+30*day);
 assert.equal((await sql.query('SELECT receipt_count FROM listening_v2.rooms')).rows[0].receipt_count,1);
});

test('mutation dedupes by room + authenticated actor + command, independent of action',async()=>{
 const id=randomUUID();await room(sql,id);const s=store(),m=mutation(id);
 await s.execute(m);assert.equal((await s.execute(m)).replayed,true);assert.equal(calls,1);
 const raw=JSON.parse(m.rawCommand);
 for(const patch of [{payload:{...raw.payload,placement:'next'}},{expected:{queueRevision:1}},{action:'queue.move'}])
  await rejects(s.execute({...m,rawCommand:JSON.stringify({...raw,...patch})}),'conflict');
 assert.equal(calls,1);assert.equal(await count('command_receipts'),1);
 const b=mutation(id,{...raw});await store().execute({...b,authentication:{...auth,keyID:'key-2'}});
 assert.equal(calls,2);assert.equal(await count('command_receipts'),2);
 const id2=randomUUID();await room(sql,id2,{scope:digest(7),invite_digest:digest(8),code_digest:digest(9)});
 await s.execute({...m,rawCommand:JSON.stringify({...raw,sessionID:id2})});assert.equal(calls,3);
});

test('create/restart share a global actor command namespace even when ticket allocates another room',async()=>{
 const c=creation(),s=store();await s.execute(c.input);
 const changed=creation('restart'),parts=changed.ticket.split('.');
 const payload=JSON.parse(Buffer.from(parts[0],'base64url'));payload.commandID=c.commandID;
 const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
 changed.input.creationTicket=encoded+'.'+createHmac('sha256',ticketKey.secret).update(encoded).digest('base64url');
 await rejects(s.execute(changed.input),'conflict');assert.equal(calls,1);assert.equal(await count('rooms'),1);
});

test('different semantic body cannot reuse a valid creation ticket',async()=>{
 const c=creation();await store().execute(c.input);
 await rejects(store().execute({...c.input,rawCommand:JSON.stringify({version:2,action:'create',expected:{},payload:{provider:'spotify'}})}),'invalid_request');
 assert.equal(calls,1);
});

test('restart retry retains the original random seed/permutation in the same room transaction',async()=>{
 const c=creation('restart');let permutation;
 mutator=async({tx,command,nowMS})=>{
  calls++;permutation=[randomUUID(),randomUUID()];
  await room(tx,command.sessionID,{at:nowMS,state:{occurrences:[],visits:[],seed:permutation}});
  return {status:'accepted',result:{count:2}};
 };
 const s=store();await s.execute(c.input);const retained=[...permutation];await s.execute(c.input);
 assert.equal(calls,1);assert.deepEqual((await sql.query('SELECT state FROM listening_v2.rooms')).rows[0].state.seed,retained);
});

test('expired ticket refuses before transaction and after receipt retention deletion; no recreation',async()=>{
 const c=creation(),s=store();await s.execute(c.input);
 await sql.exec('DELETE FROM listening_v2.command_receipts;DELETE FROM listening_v2.rooms');
 clock=c.notAfterMS+31*day;
 await rejects(s.execute(c.input),'expired');assert.equal(transactions,1);assert.equal(calls,1);assert.equal(await count('rooms'),0);
});

test('create expiry crossing inside transaction rolls back room, receipt and all callback writes',async()=>{
 const c=creation(),s=store();
 const original=mutator;
 mutator=async args=>{const out=await original(args);await advance(args.tx,c.notAfterMS);return out;};
 await rejects(s.execute(c.input),'expired');assert.equal(await count('rooms'),0);assert.equal(await count('command_receipts'),0);
 // The deterministic SQL clock change also rolled back, proving one connection.
 assert.equal(decodeSafeUInt(await dbClock(sql)),start);
 clock=start;mutator=original;await s.execute(c.input);assert.equal(await count('rooms'),1);
});

test('mutation failure and later receipt constraint failure roll back domain/event/outbox writes together',async()=>{
 const id=randomUUID();await room(sql,id);const m=mutation(id),s=store();
 mutator=async({tx})=>{
  calls++;await tx.query('UPDATE listening_v2.rooms SET state_version=state_version+1');
  await tx.query(`INSERT INTO listening_v2.semantic_events(environment,session_id,event_id,seq,lane,lane_seq,
   state_version,type,server_at_ms,delete_after_ms) VALUES($1,$2,$3,1,'semantic',1,1,'queue.added',$4,$5)`,[environment,id,randomUUID(),start,start+day]);
  await tx.query(`INSERT INTO listening_v2.outbox(environment,job_id,job_key,kind,room_id,payload,created_at_ms,due_at_ms,retry_until_ms)
   VALUES($1,$2,'wake','wake',$3,$4,$5,$5,$6)`,[environment,randomUUID(),id,{version:2,environment},start,start+day]);
  return {status:'accepted',result:{count:1}};
 };
 // Trigger is fixture-only fault injection after actual mutation/event/outbox SQL.
 await sql.exec(`CREATE FUNCTION receipt_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'fixture receipt failure' USING ERRCODE='23514'; END $$;
  CREATE TRIGGER receipt_fixture_fail BEFORE INSERT ON listening_v2.command_receipts
  FOR EACH ROW EXECUTE FUNCTION receipt_fixture_fail();`);
 try{await rejects(s.execute(m),'unavailable');}finally{await sql.exec('DROP TRIGGER receipt_fixture_fail ON listening_v2.command_receipts;DROP FUNCTION receipt_fixture_fail()');}
 for(const table of ['command_receipts','semantic_events','outbox'])assert.equal(await count(table),0);
 assert.equal(decodeSafeUInt((await sql.query('SELECT state_version FROM listening_v2.rooms')).rows[0].state_version),0);
 await s.execute(m);assert.equal(await count('command_receipts'),1);assert.equal(await count('outbox'),1);
 const m2=mutation(id);mutator=async({tx})=>{await tx.query('UPDATE listening_v2.rooms SET state_version=99');throw new SessionV2Error('forbidden');};
 await rejects(s.execute(m2),'forbidden');
 assert.equal(decodeSafeUInt((await sql.query('SELECT state_version FROM listening_v2.rooms')).rows[0].state_version),1);
});

test('current auth revocation and exact credential deadline deny saved receipt and changed-body probe',async()=>{
 const c=creation(),s=store();await s.execute(c.input);
 for(const sqlText of ["UPDATE receipt_fixture_users SET enabled=false WHERE id='guest'",
  "UPDATE receipt_fixture_tokens SET revoked=true","UPDATE receipt_fixture_keys SET revoked=true WHERE id='key'",
  "UPDATE receipt_fixture_keys SET user_id='other' WHERE id='key'",
  `UPDATE receipt_fixture_tokens SET expires=${start}`]){
  await sql.exec(sqlText);await rejects(s.execute(c.input),'unauthorized');
  await sql.exec(`UPDATE receipt_fixture_users SET enabled=true;UPDATE receipt_fixture_tokens SET revoked=false,expires=${start+90*day};
   UPDATE receipt_fixture_keys SET revoked=false,user_id='guest';`);
 }
 assert.equal(calls,1);
});

test('commit revalidation can refuse and roll back after mutation; privacy replay hook runs before body conflict',async()=>{
 const c=creation(),s=store();commitCheck=async({tx})=>{await tx.query('UPDATE receipt_fixture_tokens SET revoked=true');};
 await rejects(s.execute(c.input),'unauthorized');assert.equal(await count('rooms'),0);
 commitCheck=null;await s.execute(c.input);
 hookOverride=({environment:env})=>({version:1,environment:env,principalID:auth.principalID,keyID:auth.keyID,notAfterMS:start+day,
  actorPersonaID:null,actorPrivacyGeneration:null,revalidate:async({phase})=>phase!=='replay'});
 await rejects(s.execute(c.input),'unauthorized');assert.equal(calls,2);
 const m=mutation(c.sessionID);hookOverride=null;await s.execute(m);hookOverride=({environment:env})=>({version:1,
  environment:env,principalID:auth.principalID,keyID:auth.keyID,notAfterMS:start+day,actorPersonaID:null,actorPrivacyGeneration:null,
  revalidate:async({phase})=>phase!=='replay'});
 const raw=JSON.parse(m.rawCommand);raw.payload.placement='next';
 await rejects(s.execute({...m,rawCommand:JSON.stringify(raw)}),'unauthorized');
});

test('real persona generation/withdrawal and guest dependency deadline deny receipt replay without scrub scheduling',async()=>{
 personaID=randomUUID();
 await sql.query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
  controller_kind,controller_principal_id,controller_key_id,guest_credential_digest,guest_credential_expires_at_ms,created_at_ms,updated_at_ms)
  VALUES($1,$2,'guest','key','guest','guest','key',$3,$4,$5,$5)`,[environment,personaID,auth.credentialDigest,start+day,start]);
 const c=creation(),s=store();await s.execute(c.input);
 const stored=(await sql.query('SELECT actor_persona_id,actor_privacy_generation FROM listening_v2.command_receipts')).rows[0];
 assert.equal(stored.actor_persona_id,personaID);assert.equal(decodeSafeUInt(stored.actor_privacy_generation),0);
 await advance(sql,start+day);
 // Mutation replay avoids the shorter creation ticket deadline, isolating GuestLive.
 clock=start;await advance(sql,start);const m=mutation(c.sessionID);await s.execute(m);
 await advance(sql,start+day);await rejects(s.execute(m),'unauthorized');
 assert.equal((await sql.query('SELECT status FROM listening_v2.privacy_personas')).rows[0].status,'live');
 await advance(sql,start);
 await sql.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=1,
  withdrawn_at_ms=$1,scrub_due_at_ms=$2`,[start,start+day]);
 await rejects(s.execute(m),'unauthorized');assert.equal(calls,2);
});

test('deadline reached during the final auth hook refuses both new work and replay using a fresh final clock',async()=>{
 const id=randomUUID();await room(sql,id);
 await sql.query('UPDATE receipt_fixture_tokens SET expires=$1',[start+1]);
 commitCheck=async({tx})=>advance(tx,start+1);
 const s=store(),m=mutation(id);await rejects(s.execute(m),'unauthorized');
 assert.equal(await count('command_receipts'),0);
 // SQL clock update rolled back. Persist once before testing an exact retry.
 commitCheck=null;clock=start;await s.execute(m);
 commitCheck=async({tx})=>advance(tx,start+1);
 await rejects(s.execute(m),'unauthorized');assert.equal(calls,2);
});

test('default clock queries actual wall time on the transaction connection',async()=>{
 clock=decodeSafeUInt((await sql.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS ms')).rows[0].ms);
 const c=creation(),s=store({readClockMS:undefined,now:Date.now});
 await s.execute(c.input);
 assert.ok(trace.some(s=>s.includes('clock_timestamp()')&&!s.includes('FROM receipt_fixture_clock')));
 assert.equal(calls,1);
});

test('missing/invalid trusted hook refuses; locks precede room/receipt and all phases use supplied tx',async()=>{
 assert.throws(()=>store({lockAuthorization:undefined}),{code:'unavailable'});
 const c=creation();
 for(const value of [null,true,{}, {version:1,environment,principalID:'other',keyID:auth.keyID,revalidate:()=>true}]){
  hookOverride=()=>value;await rejects(store().execute(c.input),'unavailable');
 }
 hookOverride=null;await store().execute(c.input);
 const keyLock=trace.findIndex(s=>s.includes('receipt_fixture_keys WHERE id=$1 FOR UPDATE'));
 const roomLock=trace.findIndex(s=>s.includes('listening_v2.rooms')&&s.includes('FOR UPDATE'));
 const receiptLock=trace.findIndex(s=>s.includes('listening_v2.command_receipts')&&s.includes('FOR UPDATE'));
 assert.ok(keyLock>=0&&roomLock>keyLock&&receiptLock>roomLock);
 assert.ok(trace.includes('auth-locked')&&trace.includes('auth-mutation')&&trace.includes('auth-commit'));
});

test('environment-scoped HMACs isolate identical actor and command UUIDs',async()=>{
 const id=randomUUID();await room(sql,id);await room(sql,id,{env:otherEnvironment});
 const m=mutation(id);await store().execute(m);await store({environment:otherEnvironment}).execute(m);
 const rows=(await sql.query('SELECT environment,principal_binding,key_binding FROM listening_v2.command_receipts ORDER BY environment')).rows;
 assert.equal(rows.length,2);assert.notEqual(rows[0].principal_binding,rows[1].principal_binding);assert.notEqual(rows[0].key_binding,rows[1].key_binding);
 const c=creation();await rejects(store({environment:otherEnvironment}).execute(c.input),'invalid_request');
});

test('key rotation searches retained versions, never rewrites replay identity, and refuses missing historical keys',async()=>{
 const c=creation();await store().execute(c.input);
 const rotated=store({bindingKeys:[binding2,binding1],activeBindingKeyVersion:2});
 assert.equal((await rotated.execute(c.input)).replayed,true);assert.equal(calls,1);
 const m=mutation(c.sessionID);await rotated.execute(m);assert.equal(calls,2);
 const rows=(await sql.query('SELECT binding_key_version FROM listening_v2.command_receipts ORDER BY binding_key_version')).rows;
 assert.deepEqual(rows,[{binding_key_version:1},{binding_key_version:2}]);
 await rejects(store({bindingKeys:[binding2],activeBindingKeyVersion:2}).execute(c.input),'unavailable');
 await rejects(store().execute(m),'unavailable');assert.equal(calls,2);
});

test('key continuity reads remain bounded as unrelated retained receipt history grows',async t=>{
 await sql.query(`INSERT INTO listening_v2.command_receipts(environment,session_id,principal_binding,key_binding,
  command_id,binding_key_version,action,canonical_body_hash,status,created_at_ms,ticket_expires_at_ms,delete_after_ms)
  SELECT $1,gen_random_uuid(),$2,$3,gen_random_uuid(),1,'create',$4,'refused',$5,$6,$7
  FROM generate_series(1,2048)`,[environment,digest(91),digest(92),digest(93),start,start+600000,start+30*day]);
 await sql.exec('ANALYZE listening_v2.command_receipts');
 const c=creation(),s=store();await s.execute(c.input);
 const probes=queries.filter(q=>/SELECT\s+(1|binding_key_version)\s+FROM\s+listening_v2\.command_receipts/i.test(q.text));
 assert.ok(probes.length>0&&probes.length<=5,'continuity lookup has a fixed maximum of five version probes');
 let visited=0;
 function countVisited(plan){
  visited+=(plan['Actual Rows']??0)+(plan['Rows Removed by Filter']??0);
  for(const child of plan.Plans??[])countVisited(child);
 }
 for(const q of probes){
  const explained=await sql.query('EXPLAIN (ANALYZE,FORMAT JSON) '+q.text,q.params);
  countVisited(explained.rows[0]['QUERY PLAN'][0].Plan);
 }
 assert.ok(visited<=16,`continuity probes inspected ${visited} plan rows for 2048 unrelated receipts`);
 t.diagnostic(`2048 unrelated receipts: ${probes.length} version probes, ${visited} visited plan rows`);
 // Unknown versions anywhere in this environment still prevent a fresh replay
 // namespace, even when the unknown receipt belongs to a different actor/room.
 await sql.query(`UPDATE listening_v2.command_receipts SET binding_key_version=65535
  WHERE command_id=(SELECT command_id FROM listening_v2.command_receipts WHERE principal_binding=$1 LIMIT 1)`,[digest(91)]);
 queries=[];const before=calls;
 await rejects(s.execute(mutation(c.sessionID)),'unavailable');assert.equal(calls,before);
 assert.ok(queries.filter(q=>/SELECT\s+(1|binding_key_version)\s+FROM\s+listening_v2\.command_receipts/i.test(q.text)).length<=5);
});

test('four retained key versions need five probes and a fifth unknown version still refuses',async()=>{
 const keys=[binding4,binding3,binding2,binding1];
 async function historical(version){
  await sql.query(`INSERT INTO listening_v2.command_receipts(environment,session_id,principal_binding,key_binding,
   command_id,binding_key_version,action,canonical_body_hash,status,created_at_ms,ticket_expires_at_ms,delete_after_ms)
   VALUES($1,$2,$3,$4,$5,$6,'create',$7,'refused',$8,$9,$10)`,
  [environment,randomUUID(),digest(94),digest(95),randomUUID(),version,digest(96),start,start+600000,start+30*day]);
 }
 for(const key of keys)await historical(key.version);
 const c=creation(),s=store({bindingKeys:keys,activeBindingKeyVersion:binding4.version});
 await s.execute(c.input);
 const probes=()=>queries.filter(q=>/SELECT\s+binding_key_version\s+FROM\s+listening_v2\.command_receipts/i.test(q.text));
 assert.equal(probes().length,5);assert.equal(calls,1);
 await historical(65535);queries=[];
 await rejects(s.execute(c.input),'unavailable');
 assert.equal(probes().length,5);assert.equal(calls,1);
});

test('principal changes cannot read old actor results and configured keys are copied rather than mutated in place',async()=>{
 const c=creation(),key={version:1,secret:Buffer.from(binding1.secret)},ticket={id:ticketKey.id,secret:Buffer.from(ticketKey.secret)};
 const s=store({bindingKeys:[key],ticketKeys:[ticket]});await s.execute(c.input);
 key.secret.fill(0);ticket.secret.fill(0);assert.equal((await s.execute(c.input)).replayed,true);
 await sql.exec("UPDATE receipt_fixture_keys SET user_id='other' WHERE id='key'");
 await rejects(s.execute(c.input),'unauthorized');
 // A currently authenticated different principal still cannot use the guest ticket.
 await rejects(s.execute({...c.input,authentication:{...auth,principalID:'other'}}),'invalid_request');
});

test('invalid keyrings, duplicate versions and invalid permit answers fail closed',async()=>{
 for(const options of [{bindingKeys:[]},{bindingKeys:[binding1,binding1]},
  {bindingKeys:[{version:0,secret:binding1.secret}]},{bindingKeys:[{version:1,secret:Buffer.alloc(16)}]},
  {activeBindingKeyVersion:2},{environment:'preview'},{mutations:{create:null}},{ticketKeys:[]}])
  assert.throws(()=>store(options),{code:'unavailable'});
 const c=creation();
 hookOverride=()=>({version:1,environment,principalID:auth.principalID,keyID:auth.keyID,
  notAfterMS:start+day,actorPersonaID:null,actorPrivacyGeneration:null,revalidate:async()=>undefined});
 await rejects(store().execute(c.input),'unavailable');assert.equal(calls,0);
});

test('trusted immutable key-version policy rejects secret replacement under a retained version',async()=>{
 const c=creation();await store().execute(c.input);
 await rejects(store({bindingKeys:[{version:1,secret:Buffer.alloc(32,99)}]}).execute(c.input),'unavailable');
 assert.equal(calls,1);assert.equal(await count('command_receipts'),1);
 hookOverride=()=>({version:1,environment,principalID:auth.principalID,keyID:auth.keyID,notAfterMS:start+day,
  bindingKeyManifestHash:'0'.repeat(64),actorPersonaID:null,actorPrivacyGeneration:null,revalidate:async()=>true});
 await rejects(store().execute(c.input),'unavailable');
});

test('closed/missing/expired rooms refuse new mutations; currently authorized exact retry remains read-only',async()=>{
 const id=randomUUID();await room(sql,id);const m=mutation(id),s=store();await s.execute(m);
 await sql.query(`UPDATE listening_v2.rooms SET status='ended',ended_at_ms=$1,
  event_delete_after_ms=$2,receipt_delete_after_ms=$3`,[start,start+day,start+30*day]);
 assert.equal((await s.execute(m)).replayed,true);
 await rejects(s.execute(mutation(id)),'expired');await rejects(s.execute(mutation(randomUUID())),'not_found');
 assert.equal(calls,1);
});

test('receipt deletion in an expired room never grants a new mutation',async()=>{
 const id=randomUUID();await room(sql,id);const m=mutation(id),s=store();await s.execute(m);
 await sql.exec('DELETE FROM listening_v2.command_receipts');
 await advance(sql,start+8*3600000);await rejects(s.execute(m),'expired');assert.equal(calls,1);
});

test('durable redacted refusal without room replays and arbitrary PII result fields roll back',async()=>{
 const c=creation();mutator=async()=>{calls++;return {status:'refused',result:{code:'forbidden'}};};
 const s=store();assert.equal((await s.execute(c.input)).status,'refused');assert.equal((await s.execute(c.input)).replayed,true);
 assert.equal(await count('rooms'),0);assert.equal(calls,1);
 const d=creation();mutator=async({tx,command})=>{await room(tx,command.sessionID);return {status:'accepted',result:{name:'private name'}};};
 await rejects(s.execute(d.input),'unavailable');assert.equal(await count('rooms'),0);
});

test('receipt quota consumes only registered reserved capacity; unreserved exhaustion rolls back',async()=>{
 const id=randomUUID();await room(sql,id,{receipt_count:29999,reserved_receipts:1});const s=store();
 await rejects(s.execute(mutation(id)),'unavailable');assert.equal(await count('command_receipts'),0);
 const original=mutator;mutator=async args=>({...await original(args),consumeReservedReceipt:true});
 await s.execute(mutation(id));
 assert.deepEqual((await sql.query('SELECT receipt_count,reserved_receipts FROM listening_v2.rooms')).rows,[{receipt_count:30000,reserved_receipts:0}]);
});

test('only serialization/deadlock failures retry, at most twice, with the same command on a fresh transaction',async()=>{
 const c=creation(),original=mutator;let attempts=0;
 mutator=async args=>{await original(args);if(++attempts<3)throw Object.assign(new Error('synthetic serialization'),{code:attempts===1?'40001':'40P01'});return {status:'accepted',result:{count:3}};};
 await store().execute(c.input);assert.equal(transactions,3);assert.equal(await count('rooms'),1);assert.equal(await count('command_receipts'),1);
 const id=(await sql.query('SELECT session_id FROM listening_v2.rooms')).rows[0].session_id;
 attempts=0;transactions=0;mutator=async()=>{attempts++;throw Object.assign(new Error('synthetic serialization'),{code:'40001'});};
 await rejects(store().execute(mutation(id)),'conflict');assert.equal(attempts,3);assert.equal(transactions,3);
 transactions=0;mutator=async()=>{throw Object.assign(new Error('ambiguous connection loss'),{code:'08006'});};
 await rejects(store().execute(mutation(id)),'unavailable');assert.equal(transactions,1);
});

test('a caller-replaced ticket cannot renew the original intent after a rolled-back attempt',async()=>{
 const c=creation(),original=mutator;let attempts=0,replacement;
 mutator=async args=>{
  const value=await original(args);
  if(++attempts===1)throw Object.assign(new Error('synthetic serialization'),{code:'40001'});
  return value;
 };
 const retryDB={transaction:async fn=>{
  try{return await db.transaction(fn);}
  catch(error){
   if(error.code==='40001'){
    await advance(sql,c.notAfterMS);
    replacement=creation();
    c.input.creationTicket=replacement.input.creationTicket;
   }
   throw error;
  }
 }};
 await rejects(store({db:retryDB}).execute(c.input),'expired');
 assert.notEqual(replacement.sessionID,c.sessionID);
 assert.notEqual(replacement.commandID,c.commandID);
 assert.equal(transactions,2);assert.equal(calls,1);
 assert.equal(await count('rooms'),0);assert.equal(await count('command_receipts'),0);
});

test('safe uint decoding rejects rounding, alternative syntax and overflow before Number conversion',()=>{
 for(const [value,want] of [[0,0],['0',0],[0n,0],['9007199254740991',Number.MAX_SAFE_INTEGER],
  [9007199254740991n,Number.MAX_SAFE_INTEGER],[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]])assert.equal(decodeSafeUInt(value),want);
 for(const value of ['9007199254740992',9007199254740992n,9007199254740992,-1,-1n,'-0','01','+1','1.0','1e0',' 1',null,undefined,{},NaN,Infinity,1.5])
  assert.throws(()=>decodeSafeUInt(value),{code:'unavailable'});
});

test('relational bigint edge is returned exactly and retention arithmetic overflow rolls back',async()=>{
 const id=randomUUID();await room(sql,id,{state_version:String(Number.MAX_SAFE_INTEGER-1)});
 mutator=async({tx,command})=>{
  calls++;const row=(await tx.query('UPDATE listening_v2.rooms SET state_version=state_version+1 RETURNING state_version')).rows[0];
  return {status:'accepted',result:{stateVersion:decodeSafeUInt(row.state_version)}};
 };
 const s=store(),m=mutation(id);assert.equal((await s.execute(m)).result.stateVersion,Number.MAX_SAFE_INTEGER);
 assert.equal((await s.execute(m)).result.stateVersion,Number.MAX_SAFE_INTEGER);
 await rejects(s.execute(mutation(id)),'unavailable');assert.equal(await count('command_receipts'),1);
 await sql.exec('DELETE FROM listening_v2.command_receipts;DELETE FROM listening_v2.rooms');
 const high=Number.MAX_SAFE_INTEGER-1000;await room(sql,randomUUID(),{at:high,expires_at_ms:Number.MAX_SAFE_INTEGER});
 await sql.query('UPDATE receipt_fixture_tokens SET expires=$1',[String(Number.MAX_SAFE_INTEGER)]);
 clock=high;await advance(sql,high);const sid=(await sql.query('SELECT session_id FROM listening_v2.rooms')).rows[0].session_id;
 mutator=async()=>({status:'accepted',result:{}});
 await rejects(s.execute(mutation(sid)),'unavailable');assert.equal(await count('command_receipts'),0);
});

test('unknown action and ambiguous/unbounded wire shape refuse before transaction',async()=>{
 const id=randomUUID(),s=store();
 for(const rawCommand of [JSON.stringify({version:2,action:'unknown',expected:{},payload:{}}),
  '{"version":2,"version":2,"action":"create","expected":{},"payload":{}}',
  JSON.stringify({version:2,action:'create',expected:{},payload:{},sessionID:id}),
  '{"version":2,"action":"create","expected":{},"payload":{"n":9007199254740992}}','x'.repeat(16385)])
  await rejects(s.execute({authentication:auth,rawCommand}),'invalid_request');
 assert.equal(transactions,0);
});


// Tests-first discriminator for the exact030/gateway roomless privacy.erase gap.
// On b88 the first execute reaches not_found before its trusted reducer. Root
// must retain that observed red; this worker has not imported or run the suite.
test('standalone privacy.erase commits room_id NULL with thirty-day receipt, no room lookup or counters',async()=>{
 const id=randomUUID(),m=mutation(id,{action:'privacy.erase',expected:{privacyGeneration:1},payload:{scope:'my_sessions_persona',confirmed:true}});
 mutator=async({room:actual,command})=>{calls++;assert.equal(actual,null);assert.equal(command.sessionID,id);return {status:'accepted',result:{privacyGeneration:2}};};
 const first=await store().execute(m);assert.equal(first.replayed,false);assert.equal(calls,1);
 const r=(await sql.query('SELECT * FROM listening_v2.command_receipts')).rows[0];assert.equal(r.room_id,null);
 assert.equal(r.action,'privacy.erase');assert.equal(decodeSafeUInt(r.delete_after_ms),start+30*day);
 assert.equal(queries.filter(x=>/FROM listening_v2.rooms|UPDATE listening_v2.rooms/.test(x.text)).length,0);
 assert.equal((await store().execute(m)).replayed,true);assert.equal(calls,1);
 const c=JSON.parse(m.rawCommand);await rejects(store().execute({...m,rawCommand:JSON.stringify({...c,expected:{privacyGeneration:2}})}),'conflict');
 await sql.exec("UPDATE receipt_fixture_keys SET revoked=true WHERE id='key'");await rejects(store().execute(m),'unauthorized');
});
test('standalone privacy.erase ignores a coincident expired/capped room and cannot consume its reserve',async()=>{
 const id=randomUUID();await room(sql,id,{expires_at_ms:start+1,receipt_count:29999,reserved_receipts:1});
 clock=start+2;await sql.query('UPDATE receipt_fixture_clock SET ms=$1',[clock]);const before=(await sql.query('SELECT * FROM listening_v2.rooms')).rows;
 const m=mutation(id,{action:'privacy.erase'});mutator=async({room:actual})=>{calls++;assert.equal(actual,null);return {status:'accepted',result:{privacyGeneration:2}};};
 await store().execute(m);assert.deepEqual((await sql.query('SELECT * FROM listening_v2.rooms')).rows,before);
 assert.equal((await sql.query('SELECT room_id FROM listening_v2.command_receipts')).rows[0].room_id,null);
 mutator=async()=>({status:'accepted',result:{},consumeReservedReceipt:true});
 await rejects(store().execute(mutation(id,{action:'privacy.erase'})),'unavailable');assert.deepEqual((await sql.query('SELECT * FROM listening_v2.rooms')).rows,before);
});
test('standalone privacy.erase keeps binding-key continuity and post-write deadline rollback',async()=>{
 const m=mutation(randomUUID(),{action:'privacy.erase'});
 mutator=async()=>{calls++;return {status:'accepted',result:{privacyGeneration:2}};};await store().execute(m);
 assert.equal((await store({bindingKeys:[binding1,binding2],activeBindingKeyVersion:2}).execute(m)).replayed,true);assert.equal(calls,1);
 await rejects(store({bindingKeys:[binding2],activeBindingKeyVersion:2}).execute(m),'unavailable');
 const m2=mutation(randomUUID(),{action:'privacy.erase'});commitCheck=async({tx})=>advance(tx,start+90*day);
 await rejects(store().execute(m2),'unauthorized');assert.equal(await count('command_receipts'),1);
 assert.equal(decodeSafeUInt(await dbClock(sql)),start);
});
