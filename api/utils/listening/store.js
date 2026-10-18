import {createHash,randomBytes,randomInt} from 'node:crypto';
import {database} from '../song-library/database.js';
import {newRoom,memberOf,fail,uuid} from './model.js';
export const digest=value=>createHash('sha256').update(value).digest('hex');
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export class ListeningStore {
 constructor(db=database(),environment='development'){this.db=db;this.environment=environment;}
 async read(id){if(!uuid(id))fail('invalid_request',400);return (await this.db.query('SELECT data FROM listening_rooms WHERE id=$1 AND environment=$2',[id,this.environment])).rows[0]?.data??null;}
 async list(user){return (await this.db.query(`SELECT data FROM listening_rooms WHERE environment=$2 AND data @> $1::jsonb ORDER BY updated_at DESC LIMIT 50`,[JSON.stringify({members:[{userID:user.id,leftAtMS:null}]}),this.environment])).rows.map(r=>r.data);}
 async page(user,cursor){
  let before=Number.MAX_SAFE_INTEGER,beforeID='ffffffff-ffff-ffff-ffff-ffffffffffff';
  if(cursor){try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(value)||!Number.isSafeInteger(value[0])||!uuid(value[1]))throw Error();[before,beforeID]=value;}catch{fail('invalid_request',400);}}
  const member=JSON.stringify({members:[{userID:user.id,leftAtMS:null}]});
  const active=cursor?[]:(await this.db.query("SELECT data FROM listening_rooms WHERE status='active' AND environment=$2 AND data @> $1::jsonb ORDER BY updated_at DESC LIMIT 25",[member,this.environment])).rows.map(r=>r.data);
  const ended=(await this.db.query("SELECT data FROM listening_rooms WHERE status='ended' AND environment=$4 AND data @> $1::jsonb AND (((data->>'createdAtMS')::bigint,id)<($2::bigint,$3::uuid)) ORDER BY (data->>'createdAtMS')::bigint DESC,id DESC LIMIT 51",[member,before,beforeID,this.environment])).rows.map(r=>r.data);
  const last=ended[49];
  return {rooms:[...active,...ended.slice(0,50)],nextCursor:ended.length>50?Buffer.from(JSON.stringify([last.createdAtMS,last.id])).toString('base64url'):null};
 }
 async byInvite(value){if(typeof value!=='string'||!(/^[A-Za-z0-9_-]{32}$/.test(value)||/^\d{6}$/.test(value)))fail('session_not_found',404);return (await this.db.query("SELECT data FROM listening_rooms WHERE status='active' AND environment=$2 AND (invite_hash=$1 OR code_hash=$1)",[digest(value),this.environment])).rows[0]?.data??null;}
 async byShare(token){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(token))fail('session_not_shared',404);return (await this.db.query("SELECT data FROM listening_rooms WHERE status='ended' AND share_hash=$1 AND environment=$2",[digest(token),this.environment])).rows[0]?.data??null;}
 async create(user,input,now){
  const prior=await this.read(input.sessionID);if(prior){if(prior.host.userID!==user.id)fail('session_conflict');return prior;}
  const room=newRoom(user,input,now);room.environment=this.environment;room.invitation={token:randomBytes(24).toString('base64url'),code:String(randomInt(100000,1000000))};
  room.tick={ordinal:0,dueAtMS:room.provider==='spotify'?now:room.expiresAtMS};
  if(input.providerState)room.providerState={...room.providerState,...input.providerState};
  try{await this.db.transaction(async db=>{
   await db.query('INSERT INTO listening_rooms(id,owner_id,status,invite_hash,code_hash,data,environment) VALUES($1,$2,$3,$4,$5,$6,$7)',[room.id,user.id,room.status,digest(room.invitation.token),digest(room.invitation.code),JSON.stringify(room),this.environment]);
   await this.putTick(db,room);
  });}catch(error){if(error.code==='23505'){const same=await this.read(room.id);if(same?.host.userID===user.id)return same;fail('already_hosting_session');}throw error;}
  return room;
 }
 async save(db,room){room.stateVersion=(room.stateVersion??0)+1;await db.query('UPDATE listening_rooms SET status=$2,invite_hash=$3,code_hash=$4,share_hash=$5,data=$6,updated_at=now() WHERE id=$1',[room.id,room.status,digest(room.invitation.token),digest(room.invitation.code),room.shareToken?digest(room.shareToken):null,JSON.stringify(room)]);}
 async mutate(id,fn){return this.db.transaction(async db=>{
  const row=(await db.query('SELECT data FROM listening_rooms WHERE id=$1 AND environment=$2 FOR UPDATE',[id,this.environment])).rows[0];if(!row)fail('session_not_found',404);
  const room=row.data,result=await fn(room,db);await this.save(db,room);return result??room;
 });}
 async command(user,id,input,fn){
  if(!uuid(input.commandID))fail('invalid_request',400);
  const fingerprint=digest(JSON.stringify(canonical(input)));
  return this.mutate(id,async(room,db)=>{
   memberOf(room,user);
   const prior=(await db.query('SELECT actor_id,fingerprint FROM listening_commands WHERE room_id=$1 AND command_id=$2',[id,input.commandID])).rows[0];
   if(prior){if(prior.actor_id!==user.id||prior.fingerprint!==fingerprint)fail('session_command_conflict');return {room,duplicate:true};}
   await fn(room,db);
   await db.query('INSERT INTO listening_commands(room_id,command_id,actor_id,fingerprint,accepted_revision) VALUES($1,$2,$3,$4,$5)',[id,input.commandID,user.id,fingerprint,room.revision]);
   return {room,duplicate:false};
  });
 }
 async putTick(db,room){
  const tick=room.tick;
  await db.query('INSERT INTO listening_outbox(id,room_id,ordinal,due_at_ms) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[room.id+':'+tick.ordinal,room.id,tick.ordinal,tick.dueAtMS]);
 }
 async pending(id){return (await this.db.query("SELECT id,room_id AS \"sessionID\",ordinal,due_at_ms AS \"dueAtMS\" FROM listening_outbox WHERE room_id=$1 AND state='pending' ORDER BY ordinal LIMIT 64",[id])).rows.map(r=>({...r,dueAtMS:Number(r.dueAtMS)}));}
 async receipt(id,value){await this.db.query("UPDATE listening_outbox SET state='published',receipt=$2 WHERE id=$1 AND state='pending'",[id,value]);}
 async rateLimit(userID,action){
  const read=['list','read','observe','applied'].includes(action),bucket=read?'read':action==='search'?'search':'write',limit=read?150:30;
  const row=(await this.db.query(`INSERT INTO listening_rate_windows(user_id,bucket,window_at,count) VALUES($1,$2,date_trunc('minute',now()),1)
   ON CONFLICT(user_id,bucket) DO UPDATE SET count=CASE WHEN listening_rate_windows.window_at=date_trunc('minute',now()) THEN listening_rate_windows.count+1 ELSE 1 END,window_at=date_trunc('minute',now()) RETURNING count`,[userID,bucket])).rows[0];
  if(row.count>limit)fail('rate_limited',429);
 }
 async ownerAccountActive(room){return Boolean((await this.db.query('SELECT 1 FROM library_users WHERE id=$1 AND NOT disabled',[room.host.userID])).rows[0]);}
 async ownerValid(room){const h=room.host;return Boolean((await this.db.query(`SELECT 1 FROM library_users u JOIN app_attest_keys k ON k.user_id=u.id JOIN library_tokens t ON t.user_id=u.id WHERE u.id=$1 AND k.key_id=$2 AND t.digest=$3 AND NOT u.disabled AND NOT k.revoked AND NOT t.revoked AND (t.expires_at IS NULL OR t.expires_at>now())`,[h.userID,h.keyID,h.credentialDigest])).rows[0]);}
}
