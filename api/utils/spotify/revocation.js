import {SpotifyStore} from './store.js';
import {closeConnection} from './service.js';
import {enqueue} from './queue.js';
// Run within the caller's revocation transaction, before a key can move owners.
// A pre-migration installation has no Spotify state to revoke.
export async function revokeSpotifyInTransaction(db,selector,reason='ownerRevoked',now=Date.now()){
 if(!(await db.query("SELECT to_regclass('spotify_connections') AS name")).rows[0]?.name)return [];
 const rows=(await db.query(`SELECT data FROM spotify_connections WHERE ($1::text IS NULL OR owner_id=$1) AND ($2::text IS NULL OR key_id=$2) AND ($3::text IS NULL OR credential_digest=$3) FOR UPDATE`,[selector.ownerID??null,selector.keyID??null,selector.credentialDigest??null])).rows;
 const ids=[];
 for(const {data:c} of rows){const outbox=[];closeConnection(c,reason,now,(kind,id,data,due)=>outbox.push({kind,id,data,due}));
  await db.query('UPDATE spotify_connections SET data=$2,updated_at=now() WHERE id=$1',[c.id,JSON.stringify(c)]);
  await db.query('DELETE FROM spotify_snapshot_capabilities WHERE connection_id=$1',[c.id]);
  for(const o of outbox)await db.query(`INSERT INTO spotify_outbox(id,connection_id,epoch,kind,due_at_ms,data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[o.id,c.id,c.epoch,o.kind,o.due,JSON.stringify(o.data),new Date(o.due+86400000)]);
  ids.push(c.id);
 }
 return ids;
}
export async function flushSpotifyCleanup(db,ids,{enqueueFn=enqueue,now=Date.now}={}){
 const store=new SpotifyStore(db);
 for(const id of ids)for(const row of await store.pending(id))if(row.kind==='cleanup'){
  const result=await enqueueFn('tick',{version:1,kind:'cleanup',connectionID:id,connectionEpoch:row.epoch,outboxID:row.id,ordinal:0,dueAtMS:row.due},{idempotencyKey:row.id,delaySeconds:Math.max(0,Math.ceil((row.due-now())/1000)),retentionSeconds:86400});
  await store.receipt(row.id,result?.messageId??'accepted');
 }
}
