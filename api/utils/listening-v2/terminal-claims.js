import {createHash,randomBytes} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {SessionV2Error,transactionRetrySignal} from './errors.js';
import {parseBoundedSessionJSON} from './protocol.js';
import {decodePrivacyUInt} from './privacy-codec.js';
import {parseTerminalPayload} from './terminal-codec.js';

const DAY=86400000,MAX=9007199254740991;
const refuse=()=>{throw new SessionV2Error('unavailable');};
const json=JSON.stringify;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?
 '{'+Object.keys(value).sort().map(key=>json(key)+':'+canonical(value[key])).join(',')+'}':json(value);
const uuid=value=>typeof value==='string'&&value.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const digest=value=>typeof value==='string'&&value.length===64&&/^[0-9a-f]{64}$/.test(value);
function closed(value,fields){
 if(!value||typeof value!=='object'||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))refuse();
 const keys=Reflect.ownKeys(value);
 if(keys.length!==fields.length||fields.some(key=>!Object.hasOwn(value,key)))refuse();
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||!fields.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))refuse();}
}
function uint(value){
 // The actual SQL boundary below is jsonb::text, so numbers must already be
 // numbers. The shared adapter validates without coercing objects or rounding.
 if(typeof value!=='number')refuse();return decodePrivacyUInt(value);
}
const fields=Object.freeze(['environment','job_id','job_key','kind','room_id','guard_id','persona_id','asset_id',
 'privacy_generation','guard_revision','send_ordinal','state','attempt_count','claim_epoch','claim_nonce_hash',
 'claim_until_ms','payload','created_at_ms','due_at_ms','retry_until_ms','completed_at_ms','delete_after_ms']);
const references=Object.freeze(['room_id','guard_id','persona_id','asset_id','privacy_generation','guard_revision','send_ordinal']);
async function safe(work){try{return await work();}catch(error){const retry=transactionRetrySignal(error);if(retry)throw retry;refuse();}}
// Every predicate uses this statement's unrounded numeric DB clock. Flooring is
// solely for integer storage, never permission/lease/deadline comparison.
const clockCTE=`WITH terminal_clock AS MATERIALIZED (
 SELECT extract(epoch FROM clock_timestamp())*1000 AS now_ms)`;
const eligible=`((o.state='pending' AND o.due_at_ms::numeric<=t.now_ms)
 OR (o.state='claimed' AND o.claim_until_ms::numeric<=t.now_ms))`;
const exhausted=`(o.attempt_count>=10 OR t.now_ms>=o.retry_until_ms::numeric)`;
// Entire physical row, including exact JSONB payload, all references, count,
// epoch, nonce/lease, original chronology and completion metadata. No partial
// hash, JS numeric re-encoding, callback assertion or caller-selected SQL.
const exact=`o.environment=$1 AND o.job_id=($2::jsonb->>'job_id')::uuid
 AND o.kind='authority_terminal' AND to_jsonb(o)=$2::jsonb`;
const selectSQL=`${clockCTE}
 SELECT to_jsonb(o)::text AS raw_envelope FROM listening_v2.outbox AS o CROSS JOIN terminal_clock AS t
 WHERE o.environment=$1 AND o.kind='authority_terminal' AND ${eligible}
 ORDER BY o.due_at_ms,o.job_id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`;
const claimSQL=`${clockCTE}
 UPDATE listening_v2.outbox AS o SET
 state=CASE WHEN ${exhausted} THEN 'dead' ELSE 'claimed' END,
 attempt_count=o.attempt_count+CASE WHEN ${exhausted} THEN 0 ELSE 1 END,
 claim_epoch=CASE WHEN ${exhausted} THEN o.claim_epoch ELSE o.claim_epoch+1 END,
 claim_nonce_hash=CASE WHEN ${exhausted} THEN NULL ELSE $3::text END,
 claim_until_ms=CASE WHEN ${exhausted} THEN NULL
  ELSE LEAST(floor(t.now_ms)+30000,o.retry_until_ms::numeric)::bigint END,
 completed_at_ms=CASE WHEN ${exhausted} THEN floor(t.now_ms)::bigint ELSE NULL END,
 delete_after_ms=CASE WHEN ${exhausted} THEN (floor(t.now_ms)+86400000)::bigint ELSE NULL END
 FROM terminal_clock AS t WHERE ${exact} AND ${eligible}
 AND t.now_ms>=0 AND t.now_ms<=9007199254740991::numeric
 AND ((${exhausted} AND floor(t.now_ms)+86400000<=9007199254740991::numeric)
  OR (NOT ${exhausted} AND o.claim_epoch<9007199254740991
   AND LEAST(floor(t.now_ms)+30000,o.retry_until_ms::numeric)>t.now_ms))
 RETURNING to_jsonb(o)::text AS raw_envelope`;
const failureSQL=`${clockCTE}
 UPDATE listening_v2.outbox AS o SET state=CASE WHEN ${exhausted} THEN 'dead' ELSE 'pending' END,
 claim_nonce_hash=NULL,claim_until_ms=NULL,
 completed_at_ms=CASE WHEN ${exhausted} THEN floor(t.now_ms)::bigint ELSE NULL END,
 delete_after_ms=CASE WHEN ${exhausted} THEN (floor(t.now_ms)+86400000)::bigint ELSE NULL END
 FROM terminal_clock AS t WHERE ${exact} AND o.state='claimed'
 AND t.now_ms>=0 AND t.now_ms<=9007199254740991::numeric
 AND (NOT ${exhausted} OR floor(t.now_ms)+86400000<=9007199254740991::numeric)
 RETURNING to_jsonb(o)::text AS raw_envelope`;

/** Internal, disabled claim/failure-only responsibility store. Construction is
 * inert. Pass the actual song-library/database.js abstraction, not a request or
 * an already-open client. It owns each complete outbox-only transaction.
 * A handle means work exclusivity only: no authenticated source, semantic
 * success, End, refund, repair, dispatch, positive authority or Release.
 */
export function createTerminalClaims(options){
 let transaction,coordinator;
 try{
  closed(options,['db','coordinatorEnvironment']);coordinator=options.coordinatorEnvironment;
  if(typeof coordinator!=='string')refuse();
  // Validate configured namespace with the actual closed codec, without IO.
  parseTerminalPayload(json({version:2,environment:coordinator,selector:{kind:'credential',value:'0'.repeat(64)},
   invalidatedAtMS:0,phase:'rooms',cursor:null}));
  const db=options.db;
  if(!db||typeof db!=='object'||isProxy(db))refuse();
  for(const key of ['query','transaction']){
   const descriptor=Object.getOwnPropertyDescriptor(db,key);
   if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')refuse();
  }
  transaction=Object.getOwnPropertyDescriptor(db,'transaction').value.bind(db);
 }catch{refuse();}
 const claims=new WeakMap();
 function snapshot(result){
  if(!result||!Array.isArray(result.rows)||result.rows.length!==1)refuse();
  const wrapper=result.rows[0];closed(wrapper,['raw_envelope']);
  const raw=wrapper.raw_envelope;
  if(typeof raw!=='string'||raw.length>8192||Buffer.byteLength(raw)>8192)refuse();
  // Copy from raw SQL text synchronously before any await; never retain a
  // mutable driver row, caller object, alias, getter or proxy as evidence.
  const row=parseBoundedSessionJSON(raw);closed(row,fields);
  if(row.environment!==coordinator||!uuid(row.job_id)||row.kind!=='authority_terminal'||
   row.job_key!==`authority-terminal:${row.job_id}`||references.some(key=>row[key]!==null))refuse();
  const payload=parseTerminalPayload(json(row.payload));
  if(payload.environment!==coordinator||!['pending','claimed','dead','published'].includes(row.state))refuse();
  const created=uint(row.created_at_ms),due=uint(row.due_at_ms),retry=uint(row.retry_until_ms),epoch=uint(row.claim_epoch),a=uint(row.attempt_count);
  if(due<created||retry<due||retry-created>DAY||a>10||epoch<a||payload.invalidatedAtMS>created||
   payload.repair&&payload.repair.originalCreatedAtMS>created)refuse();
  if(['pending','claimed'].includes(row.state)&&(payload.phase!=='rooms'||row.completed_at_ms!==null||row.delete_after_ms!==null))refuse();
  if(row.state==='claimed'){
   if(a===0||epoch===0||!digest(row.claim_nonce_hash)||uint(row.claim_until_ms)>retry||row.claim_until_ms<created)refuse();
  }else if(row.claim_nonce_hash!==null||row.claim_until_ms!==null)refuse();
  if(['published','dead'].includes(row.state)){
   const completed=uint(row.completed_at_ms),after=uint(row.delete_after_ms);
   if(completed<created||completed>MAX-DAY||after<completed+DAY)refuse();
  }
  return freeze({raw,row});
 }
 function preserve(before,after,changed){
  for(const key of fields)if(!changed.includes(key)&&canonical(before[key])!==canonical(after[key]))refuse();
 }
 function terminal(before,after){
  if(after.claim_nonce_hash!==null||after.claim_until_ms!==null||after.attempt_count!==before.attempt_count||
   after.claim_epoch!==before.claim_epoch)refuse();
  if(after.state==='dead'){
   if(before.attempt_count<10&&after.completed_at_ms<before.retry_until_ms||
    after.delete_after_ms!==after.completed_at_ms+DAY)refuse();
  }else if(after.state!=='pending'||before.attempt_count>=10)refuse();
  preserve(before,after,['state','claim_nonce_hash','claim_until_ms','completed_at_ms','delete_after_ms']);
 }
 async function context(tx){
  // No external transaction API. Actual wrapper BEGIN/COMMIT/ROLLBACK owns this
  // client; capture its XID before the sole final mutation, never after it.
  if(!tx||typeof tx.query!=='function')refuse();const query=tx.query.bind(tx);
  const xid=(await query('SELECT txid_current()::text AS xid')).rows[0]?.xid;
  if(typeof xid!=='string'||!/^[1-9][0-9]{0,19}$/.test(xid))refuse();return {query,xid};
 }
 async function claimNext(...args){return safe(async()=>{
  if(args.length)refuse();
  const committed=await transaction(async tx=>{
   const c=await context(tx),selected=await c.query(selectSQL,[coordinator]);
   if(!Array.isArray(selected.rows)||selected.rows.length>1)refuse();if(!selected.rows.length)return null;
   const before=snapshot(selected),nonce=createHash('sha256').update(randomBytes(32)).digest('hex');
   const after=snapshot(await c.query(claimSQL,[coordinator,before.raw,nonce]));
   if(after.row.state==='dead'){terminal(before.row,after.row);return null;}
   if(after.row.state!=='claimed'||before.row.claim_epoch===MAX||
    after.row.attempt_count!==before.row.attempt_count+1||after.row.claim_epoch!==before.row.claim_epoch+1||
    after.row.claim_nonce_hash!==nonce||nonce===before.row.claim_nonce_hash)refuse();
   preserve(before.row,after.row,['state','attempt_count','claim_epoch','claim_nonce_hash','claim_until_ms']);
   return freeze({snapshot:after,claimXID:c.xid});
  });
  // Publish the opaque brand only AFTER the actual abstraction's COMMIT resolves.
  if(committed===null)return null;const handle=Object.freeze(Object.create(null));claims.set(handle,committed);return handle;
 });}
 async function failClaim(handle,...args){return safe(async()=>{
  if(args.length)refuse();const captured=claims.get(handle);if(!captured)refuse();
  const result=await transaction(async tx=>{
   const c=await context(tx);if(c.xid===captured.claimXID)refuse();
   // Expired-but-current exact claims may settle their already charged debit.
   // No live lease is required for FAILURE; a successor or any envelope drift
   // fails the full CAS. Expiry never permits a refund or semantic completion.
   const after=snapshot(await c.query(failureSQL,[coordinator,captured.snapshot.raw]));
   terminal(captured.snapshot.row,after.row);return Object.freeze({status:after.row.state});
  });
  claims.delete(handle);return result; // A rollback retains the exact handle.
 });}
 return Object.freeze({claimNext,failClaim});
}
