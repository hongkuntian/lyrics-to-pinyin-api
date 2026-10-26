// MANUAL ONLY; outside npm's hermetic test globs. NOT EXECUTED by the author.
// Apply at tests/postgres/ before Root runs the documented explicit command.
// Real owner-role PostgreSQL transactions, actual private composition and DDL.
// Synthetic SQL identities/retained pending room; no enrollment/provider/HTTP.
import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,realpath,lstat,stat,readdir} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {createPrivateAdmissionService} from '../../api/utils/listening-v2/privacy-context.js';
import {createAdmissionState,restoreAdmissionState,validateAdmissionCommand} from '../../api/utils/listening-v2/admission.js';

const environment='test',day=86400000;
const hash=s=>createHash('sha256').update(s).digest('hex');
const policy={audience:'private-pg-test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
const binding={version:1,secret:Buffer.alloc(32,4)},pairKey={version:1,secret:Buffer.alloc(32,5)};
const ticketKey={id:'unused-private-pg',secret:Buffer.alloc(32,6)};
const runID=randomBytes(6).toString('hex'),appName=name=>`lyrica-private-${runID}-${name}`;
let admin,pool,databaseName,created=false,adminConnected=false;
const borrowed=new Set(),operations=new Set(),holds=new Set(),cleanupScopes=new Set(),poolErrors=[];
const receiptInsert=text=>/^\s*INSERT INTO listening_v2\.command_receipts\(/.test(text);
const uuid=value=>assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);

async function bounded(promise,ms,label){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}
 finally{clearTimeout(timer);}
}
// Attach rejection handling at creation; assertions happen only after drainage.
function outcome(promise){
 const p=promise.then(value=>({value}),error=>({error}));operations.add(p);
 void p.then(()=>operations.delete(p));return p;
}
function barrier(){
 let enter,release;const waiting=new Promise(r=>{enter=r;}),released=new Promise(r=>{release=r;});
 const hold={waiting,release:()=>{release();holds.delete(hold);},async point(value){
  enter(value);await bounded(released,10000,'mutation hold timed out');
 }};holds.add(hold);return hold;
}
async function entered(hold,pending){
 return bounded(Promise.race([hold.waiting,pending.then(r=>{throw r.error??new Error('completed before receipt barrier');})]),
  2500,'receipt barrier was not entered');
}
async function acquire(){
 const client=await pool.connect();
 const lease={client,released:false,release(error){if(!this.released){this.released=true;borrowed.delete(this);client.release(error);}}};
 borrowed.add(lease);return lease;
}
async function query(text,params=[]){
 const lease=await acquire();
 try{return await lease.client.query(text,params);}
 catch(error){
  // Numbered migrations contain their own BEGIN/COMMIT. A failed migration
  // must not return an aborted transaction to the pool during setup teardown.
  try{await rollbackRelease(lease);}catch(cleanup){throw new AggregateError([error,cleanup]);}throw error;
 }finally{lease.release();}
}
async function rollbackRelease(lease){
 if(!lease||lease.released)return;
 let error;try{await lease.client.query('ROLLBACK');}catch(e){error=e;throw e;}finally{lease.release(error);}
}
async function begin(lease,name){
 await lease.client.query('BEGIN');
 await lease.client.query("SELECT set_config('application_name',$1,true)",[appName(name)]);
 return (await lease.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
}
async function blocked(name,blockerPID){
 assert.ok(Number.isInteger(blockerPID));const deadline=Date.now()+2000;
 while(Date.now()<deadline){
  const rows=(await admin.query(`SELECT pid,wait_event_type,pg_blocking_pids(pid) AS blockers
   FROM pg_stat_activity WHERE datname=$1 AND application_name=$2`,[databaseName,appName(name)])).rows;
  assert.ok(rows.length<=1,'transaction label must identify one actual client');
  const row=rows[0];
  if(row?.wait_event_type==='Lock'&&row.blockers.includes(blockerPID)){
   assert.notEqual(row.pid,blockerPID);return row;
  }
  await delay(10);
 }
 assert.fail('expected real PostgreSQL lock was not observed: '+name);
}
async function quiescent(){
 assert.equal(operations.size,0,'owned outcome must settle');assert.equal(holds.size,0);
 assert.equal(borrowed.size,0,'all explicit pool borrowers must return');assert.equal(cleanupScopes.size,0);
 assert.equal(pool.waitingCount,0);assert.equal(pool.totalCount,pool.idleCount);
 const rows=(await admin.query(`SELECT pid,state FROM pg_stat_activity
  WHERE datname=$1 AND state IN ('idle in transaction','idle in transaction (aborted)')`,[databaseName])).rows;
 assert.deepEqual(rows,[]);assert.deepEqual(poolErrors,[]);
}

before(async()=>{
 const path=process.env.LYRA_TEST_POSTGRES_MANIFEST,uid=process.getuid();
 assert.ok(path&&isAbsolute(path),'explicit current-user-owned local manifest required');
 const file=await lstat(path);assert.ok(file.isFile()&&!file.isSymbolicLink());assert.equal(file.uid,uid);
 const marker=JSON.parse(await readFile(path,'utf8'));
 assert.equal(marker.purpose,'lyrica-sessions-v2-local-qualification');
 assert.equal(marker.active,true);assert.equal(marker.TCPListening,false);assert.equal(marker.ownerUID,uid);
 assert.match(marker.socketDirectory,/^\/tmp\/lyrica-sessions-pg-[A-Za-z0-9_-]+$/);
 const socket=await lstat(marker.socketDirectory);
 assert.ok(socket.isDirectory()&&!socket.isSymbolicLink());assert.equal(socket.uid,uid);assert.equal(socket.mode&0o077,0);
 assert.ok(isAbsolute(marker.dataDirectory));assert.equal((await stat(marker.dataDirectory)).uid,uid);
 assert.ok(Number.isInteger(marker.port)&&marker.port>1024&&marker.port<65536);
 assert.ok(typeof marker.user==='string'&&marker.user.length>0);
 const config={host:marker.socketDirectory,port:marker.port,user:marker.user,password:'',ssl:false,
  connectionTimeoutMillis:3000,statement_timeout:8000,lock_timeout:3000,idle_in_transaction_session_timeout:15000,
  application_name:appName('owner')};
 admin=new pg.Client({...config,database:'postgres'});await admin.connect();adminConnected=true;
 assert.equal((await admin.query('SHOW listen_addresses')).rows[0].listen_addresses,'');
 assert.equal((await admin.query('SELECT inet_server_addr() IS NULL AS unix_only')).rows[0].unix_only,true);
 assert.equal(await realpath((await admin.query('SHOW data_directory')).rows[0].data_directory),await realpath(marker.dataDirectory));
 assert.equal(Number((await admin.query('SHOW port')).rows[0].port),marker.port);
 assert.equal((await admin.query('SELECT current_user AS owner')).rows[0].owner,marker.user);
 assert.equal((await admin.query('SHOW fsync')).rows[0].fsync,'on');
 assert.equal((await admin.query('SHOW synchronous_commit')).rows[0].synchronous_commit,'on');
 databaseName='lyrica_sessions_private_'+randomUUID().replaceAll('-','');
 assert.match(databaseName,/^lyrica_sessions_private_[a-f0-9]{32}$/);
 await admin.query('CREATE DATABASE '+databaseName);created=true;
 pool=new pg.Pool({...config,database:databaseName,max:6,idleTimeoutMillis:1000});
 pool.on('error',error=>poolErrors.push(error));
 // Same synthetic roles as the existing manual harness. Never alter a role
 // already present; reject LOGIN roles instead of treating them as fixtures.
 await query(`DO $$BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_runtime_v1') THEN CREATE ROLE lyra_runtime_v1 NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_account_v1') THEN CREATE ROLE lyra_account_v1 NOLOGIN; END IF;
 END$$`);
 const roles=(await query("SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname IN ('lyra_runtime_v1','lyra_account_v1') ORDER BY rolname")).rows;
 assert.deepEqual(roles,[{rolname:'lyra_account_v1',rolcanlogin:false},{rolname:'lyra_runtime_v1',rolcanlogin:false}]);
 const files=(await readdir(new URL('../../db/',import.meta.url))).filter(f=>/^\d{3}-.+\.sql$/.test(f)&&Number(f.slice(0,3))<=30).sort();
 assert.deepEqual(files.map(f=>Number(f.slice(0,3))),Array.from({length:30},(_,i)=>i+1));
 for(const file of files)await query(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
 // No pg type parser overrides: these are actual domain-over-int8 strings.
 assert.equal((await query('SELECT 1::listening_v2.safe_uint AS n')).rows[0].n,'1');
},{timeout:45000});

afterEach(async()=>{if(pool)await quiescent();});
after(async()=>{
 const failures=[];
 // Normally every local finally already ran. Rescue only this suite's scopes,
 // in their dependency-aware order, before considering pool shutdown.
 for(const hold of [...holds])hold.release();
 for(const cleanup of [...cleanupScopes])try{await cleanup();}catch(e){failures.push(e);}
 await Promise.all([...operations]);
 if(pool){
  try{await quiescent();}catch(e){failures.push(e);}
  // Even an assertion failure must return/destroy every known borrower first.
  for(const lease of [...borrowed])try{await rollbackRelease(lease);}catch(e){failures.push(e);}
  if(pool.waitingCount!==0||pool.totalCount!==pool.idleCount){
   failures.push(new Error('pool still has an unaccounted borrower; refusing pool.end'));
  }else await pool.end();
 }
 if(admin){
  try{if(adminConnected&&created){
   // Scope is the exact randomized database this invocation created. No
   // cluster stop, foreign DB termination, DROP ROLE or default service work.
   await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
   await admin.query('DROP DATABASE '+databaseName);
  }}finally{await admin.end();}
 }
 if(failures.length)throw new AggregateError(failures,'manual suite teardown failed');
});

const tables=['rooms','privacy_personas','returning_grants','semantic_events','outbox','command_receipts','output_guards','private_profile_assets'];
async function snapshot(db={query}){
 const result={};for(const table of tables)result[table]=(await db.query(
  `SELECT * FROM listening_v2.${table} ORDER BY to_jsonb(${table})::text`)).rows;
 return result;
}
async function seed({requesterLifetimeMS=day}={}){
 await quiescent();
 await query(`TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,
  listening_v2.rooms,listening_v2.returning_grants,listening_v2.private_profile_assets,
  listening_v2.privacy_personas,listening_v2.output_guards;
  TRUNCATE public.library_users CASCADE;`);
 const start=Number((await query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms')).rows[0].ms)-100;
 const f={start,sessionID:randomUUID(),hostScope:hash(randomBytes(32)),requestID:randomUUID(),hostMemberID:randomUUID(),
  permitDeadline:start+600000,people:[],abuseCalls:0,services:[]};
 for(let n=0;n<3;n++){
  const p={user:'g'+randomBytes(6).toString('hex'),key:randomBytes(32).toString('base64'),persona:randomUUID(),
   bearer:'lyra_s_'+randomBytes(32).toString('base64url'),credential:hash(randomBytes(32)),expires:start+(n===1?requesterLifetimeMS:day)};
  p.ref={id:p.persona,generation:1};p.install={principalID:p.user,keyID:p.key,bundleID:policy.bundles[0],audience:policy.audience,attestEnvironment:policy.environment};
  f.people.push(p);
  await query("INSERT INTO public.library_users(id,access_kind) VALUES($1,'guest')",[p.user]);
  await query('INSERT INTO public.library_tokens(digest,user_id,expires_at) VALUES($1,$2,to_timestamp($3::numeric/1000))',[p.credential,p.user,p.expires]);
  await query(`INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
   VALUES($1,$2,$3,$4,$5,'synthetic-no-crypto-enrollment',decode('00','hex'))`,[p.key,p.user,policy.audience,policy.bundles[0],policy.environment]);
  await query(`INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at)
   VALUES($1,$2,$3,$4,to_timestamp($5::numeric/1000))`,[hash(p.bearer),p.key,p.credential,policy.audience,start+600000]);
  await query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
   controller_kind,controller_principal_id,controller_key_id,privacy_generation,guest_credential_digest,guest_credential_expires_at_ms,created_at_ms,updated_at_ms)
   VALUES($1,$2,$3,$4,'guest',$3,$4,1,$5,$6,$7,$7)`,[environment,p.persona,p.user,p.key,p.credential,p.expires,start]);
 }
 const [host,guest]=f.people;
 f.pairDigest=createHmac('sha256',pairKey.secret).update(JSON.stringify([
  'sessions-v2.returning-pair',1,environment,f.hostScope,guest.key])).digest('hex');
 const base=createAdmissionState({environment,sessionID:f.sessionID,nowMS:start,expiresAtMS:start+28800000,title:'Private PG',
  host:{install:host.install,persona:host.ref,profile:{reference:'p0',revision:1,roomConsentRevision:1,persona:host.ref},memberID:f.hostMemberID,scope:f.hostScope}});
 const admission=restoreAdmissionState(JSON.stringify({...base,stateVersion:1,lifetimeRequestCount:1,pending:[{
  id:f.requestID,version:1,status:'pending',install:guest.install,persona:guest.ref,pairDigest:f.pairDigest,
  profileReference:'p1',profileRevision:1,roomConsentRevision:1,inviteGeneration:1,createdAtMS:start,expiresAtMS:start+120000}]}));
 // Faithful saveState composition fixture: scalar/privacy mirrors and all
 // pending/Leave/End reservations, not a caller actor flag or fake recording.
 const meta={version:1,miscCount:0,reservedEvents:3,reservedReceipts:3,storefront:'us'};
 await query(`INSERT INTO listening_v2.rooms(environment,session_id,host_install_scope,host_persona_id,host_privacy_generation,
  privacy_persona_ids,provider,invite_digest,code_digest,invite_generation,state,created_at_ms,expires_at_ms,updated_at_ms,
  state_version,session_revision,settings_revision,reserved_semantic_events,reserved_receipts)
  VALUES($1,$2,$3,$4,1,$5,'appleMusic',$6,$7,1,$8,$9,$10,$9,2,0,0,3,3)`,
 [environment,f.sessionID,f.hostScope,host.persona,[host.persona,guest.persona].sort(),hash(randomBytes(32)),hash(randomBytes(32)),
  {occurrences:[],visits:[],admission,admissionStore:meta},start,start+28800000]);
 const guardDigest=hash(randomBytes(32));
 await query(`INSERT INTO listening_v2.output_guards(environment,guard_id,provider,binding_key_version,account_binding,connection_lineage,output_scope,
  scope_kind,original_install_scope,created_at_ms,updated_at_ms,bootstrap_state,lane_state,send_ordinal,execution_id,
  claim_nonce_hash,claim_until_ms,endpoint_body_hash,may_have_been_sent,reserved_visit_credits,reserved_semantic_events)
  VALUES($1,$2,'appleMusic',1,$3,$3,$3,'captured_output',$3,1,1,'legacy_quarantined','uncertain',1,$4,$3,100,$3,true,3,3)`,
 [environment,randomUUID(),guardDigest,randomUUID()]);
 f.initial=await snapshot();return f;
}

function intention(f,kind,actor=kind==='cancel'?1:0,lease=1){
 const action=kind==='cancel'?'admission.cancel':kind==='leave'?'leave':'admission.decide';
 const rawCommand=JSON.stringify({version:2,action,sessionID:f.sessionID,commandID:randomUUID(),
  expected:kind==='leave'?{memberLeaseVersion:lease}:{requestVersion:1},
  payload:kind==='leave'?{}:kind==='cancel'?{requestID:f.requestID}:{requestID:f.requestID,decision:kind}});
 return {bearer:f.people[actor].bearer,rawCommand};
}
const admissionQuery=(f,actor=1)=>({bearer:f.people[actor].bearer,rawQuery:JSON.stringify({
 version:2,action:'admission.read',sessionID:f.sessionID,payload:{requestID:f.requestID}})});
function service(f,name,{hold}={}){
 const record={name,transactions:[],sql:[]};f.services.push(record);
 const db={query,async transaction(fn){
  const lease=await acquire(),entry={};record.transactions.push(entry);let bad;
  try{
   entry.pid=await begin(lease,name);
   const tx={query:async(text,params=[])=>{
    const result=await lease.client.query(text,params);record.sql.push(text);
    if(hold&&receiptInsert(text))await hold.point({tx:lease.client,pid:entry.pid,provisional:await snapshot(lease.client)});
    return result;
   }};
   const result=await fn(tx);await lease.client.query('COMMIT');entry.committed=true;return result;
  }catch(error){
   entry.error=error.code??error.message;
   try{await lease.client.query('ROLLBACK');}catch(e){bad=e;throw new AggregateError([error,e],'transaction rollback failed');}
   throw error;
  }finally{lease.release(bad);}
 }};
 const instance=createPrivateAdmissionService({db,environment,policy,bindingKeys:[binding],activeBindingKeyVersion:1,
  receiptKeyPolicy:{environment,keys:[{version:1,verificationHash:createHmac('sha256',binding.secret)
   .update(JSON.stringify(['sessions-v2.receipt-key-check',1,environment])).digest('hex')}]},
  ticketKeys:[ticketKey],activeTicketKeyID:ticketKey.id,pairKeys:[pairKey],pairPolicyRevision:1,
  // ONLY external authorization fixture: a fixed finite synthetic permit,
  // strictly bound to the actual intention/actor/room/pair/body hash request.
  antiAbuse:{authorize:async request=>{
   assert.deepEqual(Object.keys(request).sort(),['version','environment','principalID','keyID','sessionID','commandID','bodyHash','pairDigest'].sort());
   assert.equal(request.version,1);assert.equal(request.environment,environment);assert.equal(request.sessionID,f.sessionID);
   assert.ok(f.people.some(p=>p.user===request.principalID&&p.key===request.keyID));
   assert.equal(request.pairDigest,f.pairDigest);uuid(request.commandID);assert.match(request.bodyHash,/^[a-f0-9]{64}$/);
   f.abuseCalls++;return {...request,status:'allowed',notAfterMS:f.permitDeadline};
  }}});
 return {...instance,record};
}

function success(result){assert.equal(result.error,undefined);assert.equal(result.value.status,'accepted');return result.value;}
function assertPassive(f,s){
 assert.deepEqual(s.output_guards,f.initial.output_guards,'sent/uncertain safety ledger must be byte-equivalent');
 assert.deepEqual(s.privacy_personas,f.initial.privacy_personas,'no lifecycle rewrite or inferred generation transfer');
 assert.deepEqual(s.private_profile_assets,f.initial.private_profile_assets);
 const mutable=new Set(['state','privacy_persona_ids','state_version','session_revision','settings_revision','invite_generation',
  'event_seq','semantic_event_count','reserved_semantic_events','receipt_count','reserved_receipts','updated_at_ms']);
 const stable=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!mutable.has(key)));
 assert.equal(s.rooms.length,1);assert.deepEqual(stable(s.rooms[0]),stable(f.initial.rooms[0]));
 assert.deepEqual(s.rooms[0].state.occurrences,[]);assert.deepEqual(s.rooms[0].state.visits,[]);
 assert.deepEqual(Object.keys(s.rooms[0].state).sort(),['admission','admissionStore','occurrences','visits']);
 for(const record of f.services)for(const sql of record.sql){
  assert.doesNotMatch(sql,/listening_v2\.output_guards/,'composition may not acquire output authority');
  assert.doesNotMatch(sql,/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:(?:public|listening_v2)\.)?(?:library_|app_auth_|app_attest_|spotify_|privacy_personas|private_profile_assets)/i);
 }
}
function assertReceipt(f,s,input){
 const {command,bodyHash}=validateAdmissionCommand(input.rawCommand);
 const p=f.people.find(p=>p.bearer===input.bearer);assert.ok(p);
 const rows=s.command_receipts.filter(r=>r.command_id===command.commandID);assert.equal(rows.length,1);
 const r=rows[0],bind=(kind,id)=>createHmac('sha256',binding.secret).update(JSON.stringify([
  'sessions-v2.command-receipt',1,environment,kind,id])).digest('hex');
 assert.equal(r.environment,environment);assert.equal(r.session_id,f.sessionID);assert.equal(r.room_id,f.sessionID);
 assert.equal(r.binding_key_version,1);assert.equal(r.principal_binding,bind('principal',p.user));assert.equal(r.key_binding,bind('key',p.key));
 assert.equal(r.actor_persona_id,p.persona);assert.equal(r.actor_privacy_generation,'1');
 assert.equal(r.action,command.action);assert.equal(r.canonical_body_hash,bodyHash);assert.equal(r.ticket_expires_at_ms,null);
 assert.equal(r.status,'accepted');
 assert.deepEqual(Object.keys(r.result).sort(),['admissionID','eventSeq','sessionRevision','settingsRevision','stateVersion']);
 assert.equal(r.result.admissionID,f.requestID);
 for(const key of ['eventSeq','sessionRevision','settingsRevision','stateVersion'])assert.ok(Number.isSafeInteger(r.result[key]));
 assert.ok(BigInt(r.delete_after_ms)>=BigInt(r.created_at_ms)+2592000000n);
}
function assertWinner(f,s,kind,inputs){
 assertPassive(f,s);const r=s.rooms[0],a=r.state.admission,approved=kind==='approve',denied=kind==='deny';
 assert.equal(a.status,'active');assert.equal(a.stateVersion,2);assert.equal(a.membershipRevision,approved?1:0);
 assert.equal(a.lifetimeRequestCount,1);assert.equal(a.lifetimeMemberCount,approved?2:1);
 assert.equal(a.members.length,approved?2:1);assert.deepEqual(a.pending,[]);
 assert.deepEqual(a.members[0],f.initial.rooms[0].state.admission.members[0]);
 assert.deepEqual(a.originalHost,f.initial.rooms[0].state.admission.originalHost);
 assert.deepEqual(a.settings,f.initial.rooms[0].state.admission.settings);
 assert.equal(r.state_version,'3');assert.equal(r.session_revision,approved?'1':'0');
 assert.equal(r.event_seq,approved?'2':'1');assert.equal(r.semantic_event_count,approved?2:1);
 assert.equal(r.reaction_event_count,0);assert.equal(r.receipt_count,inputs.length);
 assert.equal(r.reserved_semantic_events,approved?1:0);assert.equal(r.reserved_receipts,approved?2:1);
 assert.deepEqual(r.state.admissionStore,{version:1,miscCount:0,reservedEvents:approved?1:0,reservedReceipts:approved?2:1,storefront:'us'});
 assert.deepEqual([...r.privacy_persona_ids].sort(),a.members.map(m=>m.persona.id).sort());
 assert.equal(s.semantic_events.length,approved?2:1);
 const terminal=s.semantic_events.find(e=>e.event_id===f.requestID);assert.ok(terminal);
 assert.equal(terminal.type,'admission.terminal');assert.equal(terminal.seq,1);assert.equal(terminal.lane_seq,1);
 assert.equal(terminal.lane,'semantic');assert.equal(terminal.state_version,'3');
 assert.equal(terminal.environment,environment);assert.equal(terminal.session_id,f.sessionID);
 assert.equal(terminal.command_id,JSON.parse(inputs[0].rawCommand).commandID);
 // The requester owns the terminal; the host owns the deciding receipt.
 assert.equal(terminal.actor_persona_id,f.people[1].persona);assert.equal(terminal.actor_privacy_generation,'1');
 assert.equal(terminal.occurrence_id,null);assert.equal(terminal.visit_id,null);
 const expected={version:2,status:approved?'admitted':denied?'denied':'cancelled',pairDigest:f.pairDigest};
 if(kind!=='cancel')expected.decidedByMemberID=f.hostMemberID;
 if(approved){
  const m=a.members[1];uuid(m.id);assert.deepEqual(m.install,f.people[1].install);assert.deepEqual(m.persona,f.people[1].ref);
  assert.equal(m.status,'active');assert.equal(m.leaseVersion,1);assert.equal(m.firstJoinOrdinal,1);assert.equal(m.endedAtMS,null);
  assert.equal(m.profileReference,'p1');assert.equal(m.profileRevision,1);assert.equal(m.roomConsentRevision,1);
  expected.memberID=m.id;expected.memberLeaseVersion=1;
  const joined=s.semantic_events.find(e=>e.type==='member.joined');assert.ok(joined);uuid(joined.event_id);
  assert.notEqual(joined.event_id,f.requestID);assert.equal(joined.seq,2);assert.equal(joined.lane_seq,2);
  assert.equal(joined.command_id,terminal.command_id);assert.equal(joined.actor_persona_id,f.people[1].persona);
  assert.deepEqual(joined.payload,{memberID:m.id});
 }
 assert.deepEqual(terminal.payload,expected);
 assert.equal(s.returning_grants.length,kind==='cancel'?0:1);
 if(kind!=='cancel'){
  const g=s.returning_grants[0];uuid(g.grant_id);
  assert.equal(g.environment,environment);assert.equal(g.host_install_scope,f.hostScope);assert.equal(g.pair_digest,f.pairDigest);
  assert.equal(g.hmac_key_version,1);assert.equal(g.grant_generation,approved?'1':'0');assert.equal(g.status,approved?'active':'revoked');
  if(approved){
   assert.equal(g.host_persona_id,f.people[0].persona);assert.equal(g.guest_persona_id,f.people[1].persona);
   assert.equal(g.approver_persona_id,f.people[0].persona);assert.equal(g.approved_session_id,f.sessionID);
   for(const side of ['host','guest','approver'])assert.equal(g[side+'_privacy_generation'],'1');
   assert.equal(g.revoked_at_ms,null);assert.equal(g.cooldown_until_ms,'0');
  }else{
   for(const side of ['host','guest','approver']){assert.equal(g[side+'_persona_id'],null);assert.equal(g[side+'_privacy_generation'],null);}
   assert.equal(g.approved_session_id,null);assert.equal(g.revoked_at_ms,terminal.server_at_ms);
   assert.equal(BigInt(g.cooldown_until_ms)-BigInt(terminal.server_at_ms),60000n);
  }
 }
 assert.equal(s.outbox.length,1);const wake=s.outbox[0];uuid(wake.job_id);
 assert.equal(wake.kind,'wake');assert.equal(wake.room_id,f.sessionID);assert.equal(wake.job_key,'wake:'+f.sessionID);
 assert.equal(wake.state,'pending');assert.equal(wake.attempt_count,0);assert.equal(wake.claim_epoch,'0');
 assert.equal(wake.guard_id,null);assert.equal(wake.send_ordinal,null);
 assert.deepEqual(wake.payload,{version:2,environment,sessionID:f.sessionID,eventSeq:approved?2:1});
 assert.equal(typeof r.event_seq,'string','real pg bigint string reaches production decoder');
 assert.equal(typeof wake.payload.eventSeq,'number','consumer watermark must be JSON number');
 assert.equal(wake.payload.eventSeq,Number(r.event_seq));
 assert.equal(s.command_receipts.length,inputs.length);for(const input of inputs)assertReceipt(f,s,input);
}
async function unchanged(work,code){
 const before=await snapshot();await assert.rejects(work,{code});assert.deepEqual(await snapshot(),before);
}
async function currentHost(f){
 const identity=await new AppAuthStore({query},{policy}).authenticate(f.people[0].bearer);
 assert.equal(identity.id,f.people[0].user);assert.equal(identity.keyID,f.people[0].key);
}

async function admissionRace(f,winnerKind,loserKind){
 const hold=barrier(),a=intention(f,winnerKind),b=intention(f,loserKind);
 let firstService,secondService,first,second;
 const cleanup=async()=>{
  hold.release();try{if(first)await first;if(second)await second;}finally{cleanupScopes.delete(cleanup);}
 };cleanupScopes.add(cleanup);
 try{
  firstService=service(f,'first',{hold});secondService=service(f,'second');
  first=outcome(firstService.execute(a));const held=await entered(hold,first);
  assertWinner(f,held.provisional,winnerKind,[a]);
  second=outcome(secondService.execute(b));const row=await blocked('second',held.pid);
  assert.equal(row.pid,secondService.record.transactions[0].pid);
 }finally{await cleanup();}
 assert.equal(success(await first).replayed,false);
 assert.equal((await second).error?.code,'conflict','discovery drift must abort, without an internal restart');
 assert.equal(firstService.record.transactions.length,1);assert.equal(secondService.record.transactions.length,1);
 assert.ok(!secondService.record.sql.some(receiptInsert),'failed discovery has no losing receipt');
 const settled=await snapshot();assertWinner(f,settled,winnerKind,[a]);
 const settledAbuse=f.abuseCalls;
 // Cancellation creates no grant preimage drift, so the waiting approval
 // reaches its permit before the later locked-room comparison rejects it.
 assert.equal(settledAbuse,winnerKind==='approve'||winnerKind==='cancel'?1:0);
 // Explicit caller resolves the SAME persisted intention after the first has
 // settled. No catch/retry loop, new UUID, changed body or swallowed failure.
 const fresh=await secondService.execute(b);assert.equal(fresh.status,'accepted');assert.equal(fresh.replayed,false);
 const final=await snapshot();assertWinner(f,final,winnerKind,[a,b]);
 assert.deepEqual(final.semantic_events,settled.semantic_events);assert.deepEqual(final.returning_grants,settled.returning_grants);
 assert.deepEqual(final.outbox,settled.outbox);assert.deepEqual(final.rooms[0].state,settled.rooms[0].state);
 const read=await secondService.readAdmission(admissionQuery(f));
 assert.equal(read.admission.status,winnerKind==='approve'?'admitted':winnerKind==='deny'?'denied':'cancelled');
 assert.equal(read.admission.memberLeaseVersion,winnerKind==='approve'?1:null);
 assert.equal(read.admission.memberID,winnerKind==='approve'?final.rooms[0].state.admission.members[1].id:null);
 for(const [s,input] of [[firstService,a],[secondService,b]]){
  assert.equal((await s.execute(input)).replayed,true);assert.equal((await s.readReceipt(input)).replayed,true);
 }
 assert.deepEqual(await snapshot(),final,'exact replays and targeted read have no effects');
 assert.equal(f.abuseCalls,settledAbuse,'fresh terminal loser cannot acquire another positive-work permit');
 await quiescent();
}

async function revoker(f,name){
 const lease=await acquire();
 try{
  const pid=await begin(lease,name);
  return {lease,pid,write:()=>lease.client.query('UPDATE public.library_tokens SET revoked=true WHERE digest=$1',[f.people[1].credential])};
 }catch(error){try{await rollbackRelease(lease);}catch(cleanup){throw new AggregateError([error,cleanup]);}throw error;}
}
async function revocationFirst(f,{commit=true,observerFailure=false}={}){
 const s=service(f,'revoked-waiter'),input=intention(f,'approve');let r,pending;
 const cleanup=async()=>{
  // Revoker-first: unlock BEFORE draining the command waiting on this token.
  try{await rollbackRelease(r?.lease);}finally{if(pending)await pending;cleanupScopes.delete(cleanup);}
 };cleanupScopes.add(cleanup);
 try{
  r=await revoker(f,'revoke-first');assert.equal((await r.write()).rowCount,1);
  pending=outcome(s.execute(input));await blocked('revoked-waiter',r.pid);
  if(observerFailure)throw new Error('injected observer failure after real revocation-first lock');
  await r.lease.client.query(commit?'COMMIT':'ROLLBACK');
 }finally{await cleanup();}
 assert.equal(s.record.transactions.length,1);await quiescent();return {pending:await pending,input,s};
}
async function commandFirst(f,{observerFailure=false,cancelRevoker=false}={}){
 const hold=barrier(),input=intention(f,'approve');let s,r,first,write;
 const cleanup=async()=>{
  // Command-first: release mutation, drain command AND blocked revoker query,
  // THEN roll back/release that revoker. Never queue ROLLBACK behind a held
  // UPDATE and wait for it before releasing the command (the old R1 bug).
  hold.release();
  try{if(first)await first;if(write)await write;}
  finally{try{await rollbackRelease(r?.lease);}finally{cleanupScopes.delete(cleanup);}}
 };cleanupScopes.add(cleanup);
 try{
  s=service(f,'command-first',{hold});
  first=outcome(s.execute(input));const held=await entered(hold,first);
  assertWinner(f,held.provisional,'approve',[input]);
  r=await revoker(f,'revoke-after');write=outcome(r.write());await blocked('revoke-after',held.pid);
  if(cancelRevoker){
   assert.equal(observerFailure,true,'cancellation is only an observer-failure negative control');
   // Cancel only the exact suite-owned revoker whose real lock was observed.
   // The server emits the query error; no result or SQLSTATE is substituted.
   assert.equal((await admin.query('SELECT pg_cancel_backend($1) AS cancelled',[r.pid])).rows[0].cancelled,true);
   assert.equal((await write).error?.code,'57014','the actual blocked UPDATE must be cancelled');
  }
  if(observerFailure)throw new Error('injected observer failure after real command-first lock');
  hold.release();success(await first);assert.equal((await write).error,undefined);
  assert.equal((await write).value.rowCount,1);await r.lease.client.query('COMMIT');
 }finally{await cleanup();}
 assert.equal(s.record.transactions.length,1);await quiescent();return {input,s};
}

test('approve versus deny: both first-winner orderings retain one exact terminal and grant effect',{timeout:45000},async t=>{
 for(const [first,second] of [['approve','deny'],['deny','approve']])await t.test(first+' first',async()=>{
  await admissionRace(await seed(),first,second);
 });
});
test('approve versus requester cancel: both first-winner orderings retain exact member/lease history',{timeout:45000},async t=>{
 for(const [first,second] of [['approve','cancel'],['cancel','approve']])await t.test(first+' first',async()=>{
  await admissionRace(await seed(),first,second);
 });
});
test('OTHER guest credential invalidation first: deny command, rollback control, and observer-failure cleanup',{timeout:45000},async t=>{
 await t.test('committed revocation denies a live host before all effects',async()=>{
  const f=await seed(),before=await snapshot(),{pending,s}=await revocationFirst(f);
  assert.equal(pending.error?.code,'unauthorized');assert.equal(f.abuseCalls,0);
  assert.ok(!s.record.sql.some(receiptInsert));assert.deepEqual(await snapshot(),before);await currentHost(f);
  assert.equal((await query('SELECT revoked FROM library_tokens WHERE digest=$1',[f.people[1].credential])).rows[0].revoked,true);
  await unchanged(()=>s.execute(intention(f,'deny')),'unauthorized');
  await unchanged(()=>s.execute(intention(f,'cancel')),'unauthorized');
 });
 await t.test('rolled-back revocation loses to the waiting command',async()=>{
  const f=await seed(),{pending,input}=await revocationFirst(f,{commit:false});success(pending);
  assertWinner(f,await snapshot(),'approve',[input]);
  assert.equal((await query('SELECT revoked FROM library_tokens WHERE digest=$1',[f.people[1].credential])).rows[0].revoked,false);
 });
 await t.test('observer failure unlocks before draining its waiter',async()=>{
  const f=await seed();await assert.rejects(revocationFirst(f,{observerFailure:true}),/injected observer failure/);
  await quiescent();assert.equal((await snapshot()).command_receipts.length,1);
  assert.equal((await query('SELECT revoked FROM library_tokens WHERE digest=$1',[f.people[1].credential])).rows[0].revoked,false);
 });
});
test('command first: real credential revoke waits, then all saved audiences lose current authorization',{timeout:45000},async t=>{
 await t.test('approval commits once before revocation; no saved-result disclosure after it',async()=>{
  const f=await seed(),{input,s}=await commandFirst(f),saved=await snapshot();assertWinner(f,saved,'approve',[input]);
  await currentHost(f); // actor remains valid; denial is the OTHER guest's dependency.
  await unchanged(()=>s.execute(input),'unauthorized');await unchanged(()=>s.readReceipt(input),'unauthorized');
  const altered={...input,rawCommand:input.rawCommand.replace('approve','deny')};
  await unchanged(()=>s.execute(altered),'unauthorized');await unchanged(()=>s.readReceipt(altered),'unauthorized');
  await unchanged(()=>s.readAdmission(admissionQuery(f)),'unauthorized');
  await unchanged(()=>s.execute(intention(f,'cancel')),'unauthorized');
  assert.equal(f.abuseCalls,1);assert.deepEqual(await snapshot(),saved);
 });
 await t.test('observer failure drains mutation and revoker write before rollback/release',async()=>{
  const f=await seed();await assert.rejects(commandFirst(f,{observerFailure:true}),/injected observer failure/);
  await quiescent();assert.equal((await snapshot()).command_receipts.length,1);
  assert.equal((await query('SELECT revoked FROM library_tokens WHERE digest=$1',[f.people[1].credential])).rows[0].revoked,false);
 });
 await t.test('observer failure preserves an actual cancelled revoker UPDATE after drainage',async()=>{
  const f=await seed();
  await assert.rejects(commandFirst(f,{observerFailure:true,cancelRevoker:true}),error=>{
   assert.ok(error instanceof AggregateError,'the observer sentinel must not hide an unexpected SQL failure');
   assert.equal(error.errors.length,2);
   assert.match(error.errors[0].message,/injected observer failure after real command-first lock/);
   assert.equal(error.errors[1].code,'57014');return true;
  });
  await quiescent();assert.equal((await snapshot()).command_receipts.length,1);
  assert.equal((await query('SELECT revoked FROM library_tokens WHERE digest=$1',[f.people[1].credential])).rows[0].revoked,false);
 });
});
test('historical admission lease and Leave receipt never grant a former member current command rights',{timeout:30000},async()=>{
 const f=await seed(),s=service(f,'historical'),approve=intention(f,'approve');await s.execute(approve);
 const admitted=await snapshot();assertWinner(f,admitted,'approve',[approve]);
 const stale=intention(f,'leave',1,0),refused=await s.execute(stale);
 assert.equal(refused.status,'refused');assert.equal(refused.result.code,'conflict');
 assert.deepEqual((await snapshot()).rooms[0].state.admission.members,admitted.rooms[0].state.admission.members);
 const leave=intention(f,'leave',1,1);assert.equal((await s.execute(leave)).status,'accepted');
 const afterLeave=await snapshot(),m=afterLeave.rooms[0].state.admission.members[1];
 assert.equal(m.id,admitted.rooms[0].state.admission.members[1].id);assert.equal(m.status,'left');assert.equal(m.leaseVersion,2);
 assert.equal((await s.execute(leave)).replayed,true);assert.equal((await s.readReceipt(leave)).replayed,true);
 assert.equal((await s.execute(stale)).replayed,true);assert.deepEqual(await snapshot(),afterLeave);
 await unchanged(()=>s.execute(intention(f,'deny',1)),'forbidden');
 await unchanged(()=>s.execute(intention(f,'leave',1,1)),'forbidden');
 await unchanged(()=>s.readAdmission(admissionQuery(f,0)),'not_found');
 await unchanged(()=>s.readAdmission(admissionQuery(f,2)),'not_found');
 const historical=await s.readAdmission(admissionQuery(f));
 assert.deepEqual(historical,{version:2,sessionID:f.sessionID,admission:{id:f.requestID,version:2,status:'admitted',memberID:m.id,memberLeaseVersion:1}});
 const cancel=intention(f,'cancel');assert.equal((await s.execute(cancel)).status,'accepted');
 const final=await snapshot();assertPassive(f,final);
 assert.deepEqual(final.rooms[0].state,afterLeave.rooms[0].state);assert.deepEqual(final.returning_grants,admitted.returning_grants);
 assert.deepEqual(final.semantic_events,afterLeave.semantic_events);assert.deepEqual(final.outbox,afterLeave.outbox);
 assert.equal(final.semantic_events.length,3);assert.equal(final.semantic_events.filter(e=>e.type==='member.left').length,1);
 assert.deepEqual(final.semantic_events.find(e=>e.event_id===f.requestID),admitted.semantic_events.find(e=>e.event_id===f.requestID));
 assert.equal(final.command_receipts.length,4);assert.equal(final.rooms[0].receipt_count,4);
 assert.equal(final.rooms[0].reserved_receipts,1);assert.equal(final.rooms[0].reserved_semantic_events,0);
 assert.equal(final.rooms[0].state_version,'4');assert.equal(final.rooms[0].session_revision,'2');assert.equal(final.rooms[0].event_seq,'3');
 assert.equal(final.outbox[0].claim_epoch,'1');assert.equal(final.outbox[0].payload.eventSeq,3);
 // Exact current app session matters even when guest credential/persona and
 // retained historical controller remain live. This is direct synthetic SQL
 // invalidation, not an assertion of production sign-out lifecycle wiring.
 await query('UPDATE public.app_auth_sessions SET revoked=true WHERE digest=$1',[hash(f.people[1].bearer)]);
 await unchanged(()=>s.execute(leave),'unauthorized');await unchanged(()=>s.readReceipt(leave),'unauthorized');
 await unchanged(()=>s.readAdmission(admissionQuery(f)),'unauthorized');
 assert.equal((await query('SELECT revoked FROM library_tokens WHERE digest=$1',[f.people[1].credential])).rows[0].revoked,false);
 await currentHost(f);assert.equal((await s.readReceipt(approve)).replayed,true);
 assert.deepEqual(await snapshot(),final); // bearer-only revocation did not withdraw another audience's GuestLive.
});
test('real DB wall time crosses positive OTHER guest deadline after room/grant/events/outbox/receipt writes',{timeout:30000},async()=>{
 const f=await seed({requesterLifetimeMS:5000}),hold=barrier(),input=intention(f,'approve');let s,pending;
 const cleanup=async()=>{hold.release();try{if(pending)await pending;}finally{cleanupScopes.delete(cleanup);}};cleanupScopes.add(cleanup);
 try{
  s=service(f,'guest-deadline',{hold});
  pending=outcome(s.execute(input));const held=await entered(hold,pending);assertWinner(f,held.provisional,'approve',[input]);
  const clocks=async()=>(await held.tx.query(`SELECT expires_at>now() AS transaction_live,expires_at>clock_timestamp() AS wall_live,
   floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms
   FROM public.library_tokens WHERE digest=$1`,[f.people[1].credential])).rows[0];
  const live=await clocks();assert.equal(live.transaction_live,true);assert.equal(live.wall_live,true);
  assert.ok(f.people[1].expires>Number(live.now_ms),'the exact referenced deadline must still be positive after writes');
  await admin.query(`SELECT pg_sleep((GREATEST(0::numeric,$1::numeric/1000-extract(epoch FROM clock_timestamp()))+0.05)::double precision)`,[f.people[1].expires]);
  const expired=await clocks();assert.equal(expired.transaction_live,true);assert.equal(expired.wall_live,false);
  assert.ok(Number(expired.now_ms)>=f.people[1].expires);
 }finally{await cleanup();}
 assert.equal((await pending).error?.code,'unauthorized');assert.equal(s.record.transactions.length,1);
 assert.equal(s.record.sql.filter(receiptInsert).length,1,'receipt INSERT really completed before final refusal');
 assert.deepEqual(await snapshot(),f.initial,'rollback includes every provisional domain, grant, terminal, outbox and receipt effect');
 assert.equal(f.abuseCalls,1);await currentHost(f);
 await unchanged(()=>s.execute(input),'unauthorized');await unchanged(()=>s.execute(intention(f,'deny')),'unauthorized');
 await unchanged(()=>s.readReceipt(input),'unauthorized');await unchanged(()=>s.readAdmission(admissionQuery(f)),'unauthorized');
 assert.equal((await query('SELECT status,privacy_generation FROM listening_v2.privacy_personas WHERE persona_id=$1',[f.people[1].persona])).rows[0].status,'live');
 await quiescent();
});
