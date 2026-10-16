import {database} from '../song-library/database.js';
import {LibraryError} from '../song-library/store.js';
export class SpotifyStore {
 constructor(db=database()){this.db=db;}
 async create(c){return this.db.transaction(async db=>{
  // Serialize owner/key enrollment replacements without a transaction over HTTP.
  const key=(await db.query('SELECT key_id,user_id,revoked,environment FROM app_attest_keys WHERE key_id=$1 FOR UPDATE',[c.keyID])).rows[0];
  const credential=(await db.query('SELECT 1 FROM library_tokens t JOIN library_users u ON u.id=t.user_id WHERE t.digest=$1 AND t.user_id=$2 AND NOT t.revoked AND NOT u.disabled AND (t.expires_at IS NULL OR t.expires_at>now())',[c.credentialDigest,c.ownerID])).rows[0];
  if(!key||key.user_id!==c.ownerID||key.revoked||!credential||c.ownerEnvironment!==undefined&&key.environment!==c.ownerEnvironment)throw new LibraryError('app_access_revoked',403);
  const prior=(await db.query('SELECT data FROM spotify_connections WHERE owner_id=$1 AND key_id=$2 AND enrollment_id=$3',[c.ownerID,c.keyID,c.enrollmentID])).rows[0];if(prior)return prior.data;
  await db.query('INSERT INTO spotify_connections(id,owner_id,key_id,credential_digest,enrollment_id,data) VALUES($1,$2,$3,$4,$5,$6)',[c.id,c.ownerID,c.keyID,c.credentialDigest,c.enrollmentID,JSON.stringify(c)]);return c;
 });}
 async read(id){return (await this.db.query('SELECT data FROM spotify_connections WHERE id=$1',[id])).rows[0]?.data??null;}
 async enrollment(user,id){return (await this.db.query('SELECT data FROM spotify_connections WHERE owner_id=$1 AND key_id=$2 AND enrollment_id=$3',[user.id,user.keyID,id])).rows[0]?.data??null;}
 async adopt(id,user,fn){return this.db.transaction(async db=>{
  // Adoption serializes every proven grant for this attested owner/key. A
  // per-connection lock cannot prevent two finalizers from retiring each other.
  const key=(await db.query('SELECT user_id,revoked,environment FROM app_attest_keys WHERE key_id=$1 FOR UPDATE',[user.keyID])).rows[0];
  const credential=(await db.query('SELECT 1 FROM library_tokens t JOIN library_users u ON u.id=t.user_id WHERE t.digest=$1 AND t.user_id=$2 AND NOT t.revoked AND NOT u.disabled AND (t.expires_at IS NULL OR t.expires_at>now())',[user.credentialDigest,user.id])).rows[0];
  if(!key||key.user_id!==user.id||key.revoked||!credential)throw new LibraryError('app_access_revoked',403);
  const rows=(await db.query('SELECT data FROM spotify_connections WHERE owner_id=$1 AND key_id=$2 ORDER BY id FOR UPDATE',[user.id,user.keyID])).rows;
  const connections=rows.map(row=>row.data),current=connections.find(c=>c.id===id);
  if(!current||current.credentialDigest!==user.credentialDigest)throw new LibraryError('spotify_connection_not_found',404);
  if(current.ownerEnvironment!==undefined&&key.environment!==current.ownerEnvironment)throw new LibraryError('app_access_revoked',403);
  const before=new Map(connections.map(c=>[c.id,JSON.stringify(c)])),outbox=[];
  const result=fn(current,connections,(c,kind,outboxID,data,due)=>outbox.push({connectionID:c.id,epoch:c.epoch,kind,id:outboxID,data,due}));
  for(const c of connections)if(JSON.stringify(c)!==before.get(c.id))await db.query('UPDATE spotify_connections SET data=$2,updated_at=now() WHERE id=$1',[c.id,JSON.stringify(c)]);
  for(const o of outbox)await db.query('INSERT INTO spotify_outbox(id,connection_id,epoch,kind,due_at_ms,data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',[o.id,o.connectionID,o.epoch,o.kind,o.due,JSON.stringify(o.data),new Date(o.due+86400000)]);
  return result;
 });}
 async mutate(id,fn){return this.db.transaction(async db=>{
  const row=(await db.query('SELECT data FROM spotify_connections WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new LibraryError('spotify_connection_not_found',404);
  const c=row.data,rows=[];const result=await fn(c,(kind,key,data,due)=>rows.push({kind,id:key,data,due}));
  await db.query('UPDATE spotify_connections SET data=$2,updated_at=now() WHERE id=$1',[id,JSON.stringify(c)]);
  for(const o of rows)await db.query(`INSERT INTO spotify_outbox(id,connection_id,epoch,kind,due_at_ms,data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[o.id,id,c.epoch,o.kind,o.due,JSON.stringify(o.data),new Date(o.due+86400000)]);
  return result;
 });}
 async pending(id){return (await this.db.query("SELECT id,kind,epoch,due_at_ms AS due,data FROM spotify_outbox WHERE connection_id=$1 AND state='pending' ORDER BY due_at_ms,id",[id])).rows.map(r=>({...r,due:Number(r.due)}));}
 async receipt(id,receipt,state='published'){await this.db.query("UPDATE spotify_outbox SET state=$2,receipt=$3 WHERE id=$1 AND state='pending'",[id,state,receipt??null]);}
 async outbox(id){return (await this.db.query('SELECT * FROM spotify_outbox WHERE id=$1',[id])).rows[0]??null;}
 async ownerValid(c){const row=(await this.db.query(`SELECT k.bundle_id,k.environment,k.audience FROM app_attest_keys k JOIN library_users u ON u.id=k.user_id JOIN library_tokens t ON t.user_id=u.id WHERE u.id=$1 AND k.key_id=$2 AND t.digest=$3 AND NOT k.revoked AND NOT u.disabled AND NOT t.revoked AND (t.expires_at IS NULL OR t.expires_at>now())`,[c.ownerID,c.keyID,c.credentialDigest])).rows[0];return Boolean(row&&row.bundle_id===c.bundleID&&row.environment===c.ownerEnvironment&&(!this.policy||row.environment===this.policy.environment&&row.audience===this.policy.audience&&this.policy.bundles.includes(row.bundle_id)));}
 async capability(digest){return (await this.db.query('SELECT connection_id AS "connectionID",session_id AS "sessionID",expires_at_ms AS "expiresAtMS" FROM spotify_snapshot_capabilities WHERE digest=$1',[digest])).rows[0]??null;}
 async addCapability(digest,id,sessionID,expiry){await this.db.query('INSERT INTO spotify_snapshot_capabilities(digest,connection_id,session_id,expires_at_ms) VALUES($1,$2,$3,$4) ON CONFLICT(digest) DO NOTHING',[digest,id,sessionID,expiry]);}
 async revokeCapabilities(id,sessionID){await this.db.query('DELETE FROM spotify_snapshot_capabilities WHERE connection_id=$1 AND ($2::text IS NULL OR session_id=$2)',[id,sessionID??null]);}
 async circuit(bucket,notBefore,reason){if(notBefore)await this.db.query(`INSERT INTO spotify_provider_circuits(id,not_before_ms,reason) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET not_before_ms=greatest(spotify_provider_circuits.not_before_ms,EXCLUDED.not_before_ms),reason=EXCLUDED.reason`,[bucket,notBefore,reason]);return Number((await this.db.query('SELECT not_before_ms FROM spotify_provider_circuits WHERE id=$1',[bucket])).rows[0]?.not_before_ms??0);}
 async maintenance(now){
  await this.db.query('DELETE FROM spotify_snapshot_capabilities WHERE expires_at_ms<=$1',[now]);
  await this.db.query('DELETE FROM spotify_outbox WHERE expires_at<=$1',[new Date(now)]);
  // Normal request work bounds retention; this is explicitly not a scheduler or
  // a promise to recover an unacknowledged bootstrap without a future executor.
  for(const {id,data:c} of (await this.db.query('SELECT id,data FROM spotify_connections')).rows){
   let changed=false;
   for(const s of Object.values(c.consumers??{}))if(s.expiresAt+86400000<=now){s.token=null;s.widgetToken=null;s.capability=null;s.capabilityDigest=null;s.snapshot=null;s.terminalPayload=null;s.status='ended';changed=true;}
   if(c.grantExpiresAt<=now){c.access=null;c.refresh=null;c.stage=null;c.status='reconnectRequired';changed=true;}
   if(changed)await this.mutate(id,current=>{for(const [sessionID,s] of Object.entries(c.consumers??{}))if(s.expiresAt+86400000<=now)current.consumers[sessionID]=s;if(current.grantExpiresAt<=now){current.access=null;current.refresh=null;current.stage=null;current.status='reconnectRequired';}});
  }
  await this.db.query("DELETE FROM spotify_connections WHERE data->>'status'='disconnected' AND updated_at<$1",[new Date(now-30*86400000)]);
 }
 async matching({ownerID,keyID,credentialDigest}){return (await this.db.query('SELECT data FROM spotify_connections WHERE ($1::text IS NULL OR owner_id=$1) AND ($2::text IS NULL OR key_id=$2) AND ($3::text IS NULL OR credential_digest=$3)',[ownerID??null,keyID??null,credentialDigest??null])).rows.map(r=>r.data);}
}
