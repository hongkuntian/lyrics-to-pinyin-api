import {SpotifyStore} from './store.js';
import {LibraryError} from '../song-library/store.js';
import {closeConnection} from './service.js';
import {enqueue} from './queue.js';

// Closed internal plans, never auth evidence, callbacks or public DTOs. The
// caller already holds its complete actual user/token/key/session lock union.
const plans=new WeakMap();
const refuse=()=>{throw new LibraryError('spotify_revocation_invalid',409);};
function bounded(error){
 if(error instanceof LibraryError&&error.code==='spotify_revocation_invalid')throw error;
 throw new LibraryError('spotify_revocation_unavailable',503);
}
function transactionID(row){
 const id=row?.transaction_id;
 if(typeof id!=='string'||!/^[1-9]\d{0,19}$/.test(id)||BigInt(id)>18446744073709551615n)refuse();
 return id;
}
async function sameTransaction(db,id){
 if(transactionID((await db.query('SELECT pg_current_xact_id()::text AS transaction_id')).rows[0])!==id)refuse();
}
const sourceSQL=`SELECT id,owner_id,key_id,credential_digest,enrollment_id,data::text AS source_data,updated_at::text AS source_updated_at
 FROM spotify_connections WHERE ($1::text IS NULL OR owner_id=$1) AND ($2::text IS NULL OR key_id=$2) AND ($3::text IS NULL OR credential_digest=$3) ORDER BY id COLLATE "C"`;
function source(row){
 return Object.freeze({id:row.id,ownerID:row.owner_id,keyID:row.key_id,credentialDigest:row.credential_digest,
  enrollmentID:row.enrollment_id,data:row.source_data,updatedAt:row.source_updated_at});
}

export async function prepareSpotifyRevocationInTransaction(db,selector,reason='ownerRevoked',now=Date.now()){
 try{
  if(!db||typeof db!=='object'||typeof db.query!=='function'||!selector||typeof selector!=='object'||Array.isArray(selector)||
   Reflect.ownKeys(selector).some(k=>!['ownerID','keyID','credentialDigest'].includes(k))||typeof reason!=='string'||!Number.isSafeInteger(now))refuse();
  // Snapshot every caller-owned input synchronously, before the first await.
  // The actual legacy selector remains nullable and conjunctive, not a new scope.
  const values=Object.freeze([selector.ownerID??null,selector.keyID??null,selector.credentialDigest??null]);
  if(values.some(v=>v!==null&&typeof v!=='string'))refuse();
  const query=db.query;
  const first=(await db.query("SELECT pg_current_xact_id()::text AS transaction_id, to_regclass('spotify_connections')::text AS name")).rows[0];
  const id=transactionID(first),present=Boolean(first?.name);
  // Owner-wide selectors require ALL owner keys even when the digest narrows
  // the scan. Those preheld anchors exclude enrollment and owner moves. Never
  // acquire an earlier auth lock here or during persistence.
  const rows=present?(await db.query(sourceSQL+' FOR UPDATE',values)).rows:[];
  // Copy SQL text and compute the pure close plan in this turn. No row object,
  // JSON object, reason or clock supplied by a caller survives the next await.
  const connections=Object.freeze(rows.map(row=>{
   const before=source(row),c=JSON.parse(before.data),outbox=[];
   if(!c||typeof c!=='object'||Array.isArray(c)||c.id!==before.id)refuse();
   closeConnection(c,reason,now,(kind,outboxID,data,due)=>outbox.push(Object.freeze({kind,id:outboxID,data:JSON.stringify(data),due})));
   return Object.freeze({before,after:JSON.stringify(c),epoch:c.epoch,outbox:Object.freeze(outbox)});
  }));
  await sameTransaction(db,id); // Autocommit/pool-query facades cannot prepare.
  if(db.query!==query)refuse();
  const handle=Object.freeze(Object.create(null));
  plans.set(handle,{db,query,id,present,values,connections});return handle;
 }catch(error){bounded(error);}
}

export async function persistSpotifyRevocationInTransaction(db,handle){
 const plan=plans.get(handle);
 // Retire synchronously on every attempt, including wrong client and failure.
 // A rejected or partly executed scope cannot be retried after a savepoint.
 if(plan)plans.delete(handle);
 try{
  if(!plan||db!==plan.db||db.query!==plan.query)refuse();
  await sameTransaction(db,plan.id);
  if(!plan.present)return []; // Actual schema-absent legacy installation.
  // Recheck the complete closed selector, including negative/new-row drift,
  // without acquiring any new locking SELECT after the caller's lower locks.
  const current=(await db.query(sourceSQL,plan.values)).rows.map(source);
  if(current.length!==plan.connections.length||current.some((row,i)=>JSON.stringify(row)!==JSON.stringify(plan.connections[i].before)))refuse();
  await sameTransaction(db,plan.id);
  const ids=[];
  for(const connection of plan.connections){
   const {before:b,after,epoch,outbox}=connection;
   // The write is restricted to the planned physical ID and exact SQL source
   // image; never follow an arbitrary data.id or overwrite an intervening edit.
   const changed=await db.query(`UPDATE spotify_connections SET data=$2,updated_at=now()
 WHERE id=$1 AND owner_id=$3 AND key_id=$4 AND credential_digest=$5 AND enrollment_id=$6
 AND data=$7::jsonb AND updated_at=$8::timestamptz AND pg_current_xact_id()::text=$9 RETURNING id`,
    [b.id,after,b.ownerID,b.keyID,b.credentialDigest,b.enrollmentID,b.data,b.updatedAt,plan.id]);
   if(changed.rows.length!==1||changed.rows[0].id!==b.id)refuse();
   await db.query('DELETE FROM spotify_snapshot_capabilities WHERE connection_id=$1',[b.id]);
   for(const o of outbox)await db.query(`INSERT INTO spotify_outbox(id,connection_id,epoch,kind,due_at_ms,data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[o.id,b.id,epoch,o.kind,o.due,o.data,new Date(o.due+86400000)]);
   ids.push(b.id);
  }
  await sameTransaction(db,plan.id);return ids;
 }catch(error){bounded(error);}
}

// Unmodified V1 callers retain the same signature and postcommit cleanup path.
export async function revokeSpotifyInTransaction(db,selector,reason='ownerRevoked',now=Date.now()){
 return persistSpotifyRevocationInTransaction(db,await prepareSpotifyRevocationInTransaction(db,selector,reason,now));
}
export async function flushSpotifyCleanup(db,ids,{enqueueFn=enqueue,now=Date.now}={}){
 const store=new SpotifyStore(db);
 for(const id of ids)for(const row of await store.pending(id))if(row.kind==='cleanup'){
  const result=await enqueueFn('tick',{version:1,kind:'cleanup',connectionID:id,connectionEpoch:row.epoch,outboxID:row.id,ordinal:0,dueAtMS:row.due},{idempotencyKey:row.id,delaySeconds:Math.max(0,Math.ceil((row.due-now())/1000)),retentionSeconds:86400});
  await store.receipt(row.id,result?.messageId??'accepted');
 }
}
