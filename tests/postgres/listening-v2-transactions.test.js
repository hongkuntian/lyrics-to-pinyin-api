// Explicit local qualification: this file is outside npm test's hermetic globs.
// It creates/drops only its own randomized database on an owned Unix-only test
// cluster. Supply LYRA_TEST_POSTGRES_MANIFEST from the documented local setup.
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,realpath,stat,readdir} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {createCurrentAuthContext} from '../../api/utils/listening-v2/auth-context.js';
import {createReceiptStore} from '../../api/utils/listening-v2/receipt-store.js';
import {createCreationTickets,canonicalCommandHash} from '../../api/utils/listening-v2/tickets.js';

const environment='test',hash=value=>createHash('sha256').update(value).digest('hex');
const bearer='lyra_s_'+'a'.repeat(43),credential=hash('local-fixture-credential');
const keyID=Buffer.alloc(32,7).toString('base64');
const policy={audience:'lyra-local-qualification',environment:'development',prefix:'ABCDEFGHIJ',bundles:['com.lyrica.app']};
const binding={version:1,secret:Buffer.alloc(32,11)},ticketKey={id:'local-ticket',secret:Buffer.alloc(32,22)};
let admin,pool,databaseName,created=false,currentAuth,authentication,calls;
const clients=new Map();

before(async()=>{
 const path=process.env.LYRA_TEST_POSTGRES_MANIFEST;
 assert.ok(path&&isAbsolute(path),'an explicit owned local-cluster manifest is required');
 const marker=JSON.parse(await readFile(path,'utf8'));
 assert.equal(marker.purpose,'lyrica-sessions-v2-local-qualification');
 assert.equal(marker.active,true);assert.equal(marker.TCPListening,false);
 assert.equal(marker.ownerUID,process.getuid());
 assert.equal((await stat(path)).uid,process.getuid());
 assert.match(marker.socketDirectory,/^\/tmp\/lyrica-sessions-pg-/);
 const socket=await stat(marker.socketDirectory);
 assert.equal(socket.uid,process.getuid());assert.equal(socket.mode&0o077,0);
 assert.ok(Number.isInteger(marker.port)&&marker.port>1024&&marker.port<65536);
 const config={host:marker.socketDirectory,port:marker.port,user:marker.user,
  connectionTimeoutMillis:3000,statement_timeout:8000};
 admin=new pg.Client({...config,database:'postgres'});await admin.connect();
 assert.equal((await admin.query('SHOW listen_addresses')).rows[0].listen_addresses,'');
 assert.equal(await realpath((await admin.query('SHOW data_directory')).rows[0].data_directory),await realpath(marker.dataDirectory));
 assert.equal((await stat(marker.dataDirectory)).uid,process.getuid());
 databaseName='lyrica_sessions_qual_'+randomUUID().replaceAll('-','');
 assert.match(databaseName,/^lyrica_sessions_qual_[a-f0-9]{32}$/);
 await admin.query('CREATE DATABASE '+databaseName);created=true;
 pool=new pg.Pool({...config,database:databaseName,max:6,idleTimeoutMillis:1000});
 // These are synthetic NOLOGIN roles in this owned cluster, not deployed roles.
 await pool.query(`DO $$BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_runtime_v1') THEN CREATE ROLE lyra_runtime_v1 NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_account_v1') THEN CREATE ROLE lyra_account_v1 NOLOGIN; END IF;
 END$$`);
 for(const file of (await readdir(new URL('../../db/',import.meta.url))).filter(f=>/^\d{3}-.+\.sql$/.test(f)).sort())
  await pool.query(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
}, {timeout:30000});

after(async()=>{
 if(pool)await pool.end();
 if(admin){
  if(created){
   await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
   await admin.query('DROP DATABASE '+databaseName);
  }
  await admin.end();
 }
});

beforeEach(async()=>{
 await pool.query(`TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,
  listening_v2.rooms,listening_v2.privacy_personas,listening_v2.private_profile_assets,
  listening_v2.returning_grants,listening_v2.output_guards;
  TRUNCATE public.library_users CASCADE;
  INSERT INTO public.library_users(id,access_kind) VALUES('guest-local','guest');`);
 await pool.query(`INSERT INTO public.library_tokens(digest,user_id,expires_at)
  VALUES($1,'guest-local',clock_timestamp()+interval '90 days')`,[credential]);
 await pool.query(`INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
  VALUES($1,'guest-local',$2,$3,'development','fixture-key','fixture-receipt')`,[keyID,policy.audience,policy.bundles[0]]);
 await pool.query(`INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at)
  VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')`,[hash(bearer),keyID,credential,policy.audience]);
 currentAuth=createCurrentAuthContext({authStore:new AppAuthStore(pool,{policy}),environment});
 authentication=await currentAuth.prepare(bearer);calls=0;clients.clear();
});

function barrier(){
 let entered,release;const waiting=new Promise(r=>{entered=r;}),held=new Promise(r=>{release=r;});
 return {waiting,release,async point(){entered();await held;}};
}
async function blocked(name,blockerPID){
 const deadline=Date.now()+2000;
 while(Date.now()<deadline){
  const row=(await admin.query(`SELECT pid,wait_event_type,pg_blocking_pids(pid) AS blockers
   FROM pg_stat_activity WHERE application_name=$1`,['lyrica-local-'+name])).rows[0];
  if(row?.wait_event_type==='Lock'&&row.blockers.includes(blockerPID))return row;
  await delay(10);
 }
 assert.fail('expected PostgreSQL lock barrier was not observed: '+name);
}
function gateway(name,{onMutation,invalidResult=false}={}){
 const db={async transaction(fn){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await client.query("SELECT set_config('application_name',$1,true)",['lyrica-local-'+name]);
   clients.set(name,(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   const value=await fn(client);await client.query('COMMIT');return value;
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
 }};
 const descriptors=[{version:1,verificationHash:createHmac('sha256',binding.secret)
  .update(JSON.stringify(['sessions-v2.receipt-key-check',1,environment])).digest('hex')}];
 const expectedManifestHash=hash(JSON.stringify(descriptors));
 const mutation=async({tx,command,nowMS})=>{
  calls++;
  if(command.action==='create')await tx.query(`INSERT INTO listening_v2.rooms(environment,session_id,
   host_install_scope,provider,invite_digest,code_digest,created_at_ms,expires_at_ms,updated_at_ms)
   VALUES($1,$2,$3,'appleMusic',$4,$5,$6,$7,$6)`,
  [environment,command.sessionID,hash('host-install'),hash(command.sessionID+'invite'),hash(command.sessionID+'code'),nowMS,nowMS+28800000]);
  else await tx.query(`UPDATE listening_v2.rooms SET queue_revision=queue_revision+1,
   state_version=state_version+1 WHERE environment=$1 AND session_id=$2`,[environment,command.sessionID]);
  if(onMutation)await onMutation({tx,command});
  return {status:'accepted',result:invalidResult?{name:'private-fixture'}:{count:calls}};
 };
 return createReceiptStore({db,environment,bindingKeys:[binding],activeBindingKeyVersion:1,
  ticketKeys:[ticketKey],activeTicketKeyID:ticketKey.id,mutations:{create:mutation,'queue.add':mutation},
  lockAuthorization:async({tx,authentication,environment:env,bindingKeyManifest})=>{
   assert.deepEqual(bindingKeyManifest.keys,descriptors);
   const plan=await currentAuth.discover({tx,authentication});
   const scope=await currentAuth.lock({tx,discovery:plan});
   // This fixture has no retained persona, guest policy or provider authority.
   // It qualifies the real current-auth/receipt boundary, not the full V2 hook.
   return {version:1,environment:env,principalID:scope.principalID,keyID:scope.keyID,
    bindingKeyManifestHash:expectedManifestHash,actorPersonaID:null,actorPrivacyGeneration:null,
    notAfterMS:scope.notAfterMS,revalidate:async({tx})=>scope.revalidate({tx})};
  }});
}
function creation(issuedAtMS=Date.now()){
 const rawCommand=JSON.stringify({version:2,action:'create',expected:{},payload:{provider:'appleMusic'}});
 const ticket=createCreationTickets({keys:[ticketKey],activeKeyID:ticketKey.id,now:()=>issuedAtMS}).issue({
  environment,principalID:authentication.principalID,keyID:authentication.keyID,action:'create',
  bodyHash:canonicalCommandHash(rawCommand),sourceRecapRevision:null});
 return {authentication,rawCommand,creationTicket:ticket.ticket,sessionID:ticket.sessionID};
}
function input(c){const {sessionID:_,...value}=c;return value;}
const outcome=promise=>promise.then(value=>({value}),error=>({error}));
async function entered(hold,pending){
 await Promise.race([hold.waiting,pending.then(result=>{throw result.error??new Error('operation completed before its mutation barrier');})]);
}
async function count(table){return Number((await pool.query('SELECT count(*) AS n FROM listening_v2.'+table)).rows[0].n);}
async function revoker(name,table,column,value){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT set_config('application_name',$1,true)",['lyrica-local-'+name]);
  const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return {client,pid,write:()=>client.query(`UPDATE public.${table} SET revoked=true WHERE ${column}=$1`,[value])};
 }catch(error){try{await client.query('ROLLBACK');}finally{client.release();}throw error;}
}
async function commandFirstRevocation(table,column,value,{observe=blocked,onRevoker}={}){
 const hold=barrier(),c=creation(),first=outcome(gateway('authorized',{onMutation:()=>hold.point()}).execute(input(c)));
 let r,write;
 try{
  await entered(hold,first);r=await revoker('revoke-after',table,column,value);write=outcome(r.write());
  onRevoker?.({client:r.client,first,write});
  await observe('revoke-after',clients.get('authorized'));
  hold.release();
  assert.equal((await first).error,undefined);assert.equal((await write).error,undefined);await r.client.query('COMMIT');
 }finally{
  // The observer can fail while the revoker waits on the held mutation. Drain
  // both operations before rolling back/releasing that client; no work outlives
  // this ownership scope or reaches pool.end() with a borrowed client.
  hold.release();await first;if(write)await write;
  if(r)try{await r.client.query('ROLLBACK');}finally{r.client.release();}
 }
 return c;
}

test('concurrent exact creates block and return one committed room and receipt',{timeout:7000},async()=>{
 const hold=barrier(),c=creation(),first=outcome(gateway('create-a',{onMutation:()=>hold.point()}).execute(input(c)));
 let second;
 try{
  await entered(hold,first);second=outcome(gateway('create-b').execute(input(c)));
  await blocked('create-b',clients.get('create-a'));
 }finally{hold.release();await first;if(second)await second;}
 const [a,b]=await Promise.all([first,second]);assert.equal(a.error,undefined);assert.equal(b.error,undefined);
 assert.equal(a.value.replayed,false);assert.equal(b.value.replayed,true);
 assert.equal(calls,1);assert.equal(await count('rooms'),1);assert.equal(await count('command_receipts'),1);
});

test('concurrent changed-body retry waits then conflicts without another write',{timeout:7000},async()=>{
 const c=creation();await gateway('seed').execute(input(c));calls=0;
 const command={version:2,action:'queue.add',sessionID:c.sessionID,commandID:randomUUID(),expected:{queueRevision:0},
  payload:{catalogSelectionID:'first',placement:'end'}};
 const a={authentication,rawCommand:JSON.stringify(command)},b={authentication,rawCommand:JSON.stringify({...command,payload:{...command.payload,catalogSelectionID:'different'}})};
 const hold=barrier(),first=outcome(gateway('mutation-a',{onMutation:()=>hold.point()}).execute(a));let second;
 try{await entered(hold,first);second=outcome(gateway('mutation-b').execute(b));await blocked('mutation-b',clients.get('mutation-a'));}
 finally{hold.release();await first;if(second)await second;}
 const [one,two]=await Promise.all([first,second]);assert.equal(one.error,undefined);assert.equal(two.error?.code,'conflict');
 assert.equal(calls,1);assert.equal(await count('command_receipts'),2);
});

for(const [label,table,column,value] of [['credential','library_tokens','digest',credential],['exact session','app_auth_sessions','digest',hash(bearer)]]){
 test(label+' revocation winning the lock denies the prepared bearer before writes',{timeout:7000},async()=>{
  const c=creation(),r=await revoker('revocation-first',table,column,value);let pending;
  try{
   await r.write();pending=outcome(gateway('denied-auth').execute(input(c)));
   await blocked('denied-auth',r.pid);await r.client.query('COMMIT');
  }finally{
   // Here the command is the blocked operation: release its revoker lock before
   // draining it, including when observing the expected barrier fails.
   try{await r.client.query('ROLLBACK');}finally{r.client.release();if(pending)await pending;}
  }
  assert.equal((await pending).error?.code,'unauthorized');assert.equal(calls,0);
  assert.equal(await count('rooms'),0);assert.equal(await count('command_receipts'),0);
 });

 test(label+' revocation waits for the authorized command, then denies saved receipt',{timeout:7000},async()=>{
  const c=await commandFirstRevocation(table,column,value);
  await assert.rejects(gateway('receipt-after-revocation').execute(input(c)),{code:'unauthorized'});
  assert.equal(calls,1);assert.equal(await count('rooms'),1);assert.equal(await count('command_receipts'),1);
 });

 test(label+' barrier observation failure drains operations and releases the revoker',{timeout:7000},async()=>{
  let owned,releases=0,firstSettled=false,writeSettled=false;
  try{
   await assert.rejects(commandFirstRevocation(table,column,value,{
    observe:async(name,pid)=>{await blocked(name,pid);throw new Error('injected barrier observation failure');},
    onRevoker:ownership=>{
     owned=ownership;const original=owned.client.release;
     owned.client.release=(...args)=>{releases++;return original(...args);};
     owned.first.then(()=>{firstSettled=true;});owned.write.then(()=>{writeSettled=true;});
    }
   }),/injected barrier observation failure/);
   assert.equal(firstSettled,true,'the first operation must settle before failure returns');
   assert.equal(writeSettled,true,'the blocked revocation must settle before failure returns');
   assert.equal(releases,1,'the revoker lease must be returned on observer failure');
   assert.equal(pool.waitingCount,0);assert.equal(pool.totalCount,pool.idleCount);
   assert.equal((await pool.query(`SELECT revoked FROM public.${table} WHERE ${column}=$1`,[value])).rows[0].revoked,false);
   const lingering=(await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND state='idle in transaction'",[databaseName])).rows;
   assert.deepEqual(lingering,[]);
  }finally{
   // Rescue the owned fixture on the red implementation too. This is outside
   // the assertions and cannot turn missing production cleanup into a pass.
   if(owned){await owned.first;await owned.write;if(releases===0){await owned.client.query('ROLLBACK');owned.client.release();}}
  }
 });
}

test('pool client reuse cannot reuse a prior transaction auth scope',{timeout:7000},async()=>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');const plan=await currentAuth.discover({tx:client,authentication});
  const old=await currentAuth.lock({tx:client,discovery:plan});await client.query('COMMIT');
  await client.query('BEGIN');await assert.rejects(old.revalidate({tx:client}),{code:'unavailable'});await client.query('ROLLBACK');
  await client.query('BEGIN');const fresh=await currentAuth.discover({tx:client,authentication});
  const scope=await currentAuth.lock({tx:client,discovery:fresh});assert.equal(await scope.revalidate({tx:client}),true);
  await client.query('COMMIT');
 }finally{try{await client.query('ROLLBACK');}finally{client.release();}}
});

test('private reducer output rolls back actual room and receipt writes',{timeout:7000},async()=>{
 await assert.rejects(gateway('private-result',{invalidResult:true}).execute(input(creation())),{code:'unavailable'});
 assert.equal(await count('rooms'),0);assert.equal(await count('command_receipts'),0);
});

test('real database wall time crosses a credential deadline while mutation is held',{timeout:8000},async()=>{
 await pool.query("UPDATE public.library_tokens SET expires_at=clock_timestamp()+interval '1500 milliseconds'");
 authentication=await currentAuth.prepare(bearer);
 const hold=barrier(),pending=outcome(gateway('deadline',{onMutation:()=>hold.point()}).execute(input(creation())));
 try{await entered(hold,pending);await pool.query('SELECT pg_sleep(1.6)');}finally{hold.release();await pending;}
 assert.equal((await pending).error?.code,'unauthorized');assert.equal(calls,1);
 assert.equal(await count('rooms'),0);assert.equal(await count('command_receipts'),0);
});

test('real database wall time cannot extend a held creation ticket deadline',{timeout:8000},async()=>{
 const hold=barrier(),pending=outcome(gateway('ticket-deadline',{onMutation:()=>hold.point()}).execute(input(creation(Date.now()-600000+1500))));
 try{await entered(hold,pending);await pool.query('SELECT pg_sleep(1.6)');}finally{hold.release();await pending;}
 assert.equal((await pending).error?.code,'expired');assert.equal(calls,1);
 assert.equal(await count('rooms'),0);assert.equal(await count('command_receipts'),0);
});

test('actual V2 grants retain runtime insertion and deny guard deletion and schema creation',async()=>{
 const r=(await pool.query(`SELECT
  has_table_privilege('lyra_runtime_v1','listening_v2.command_receipts','INSERT') AS receipt_insert,
  has_table_privilege('lyra_runtime_v1','listening_v2.output_guards','DELETE') AS guard_delete,
  has_schema_privilege('lyra_runtime_v1','listening_v2','CREATE') AS schema_create,
  has_table_privilege('lyra_account_v1','listening_v2.outbox','INSERT') AS account_outbox_table,
  has_column_privilege('lyra_account_v1','listening_v2.outbox','job_id','INSERT') AS account_cleanup_job,
  has_column_privilege('lyra_account_v1','listening_v2.outbox','guard_id','INSERT') AS account_guard,
  has_column_privilege('lyra_account_v1','listening_v2.outbox','send_ordinal','INSERT') AS account_execution`)).rows[0];
 assert.deepEqual(r,{receipt_insert:true,guard_delete:false,schema_create:false,
  account_outbox_table:false,account_cleanup_job:true,account_guard:false,account_execution:false});
 // Auth/receipt barrier clients above deliberately use the local owner. This
 // metadata check is not complete production role or lifecycle qualification.
});
