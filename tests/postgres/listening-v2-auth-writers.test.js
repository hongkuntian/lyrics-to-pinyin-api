// MANUAL, SOURCE-AUTHORED ONLY. Root runs after application in qualification.
// Real existing 001-029 migrations; no 030, synthetic roles, grants or provider IO.
import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,realpath,lstat,stat,readdir} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {SongLibraryStore,digest} from '../../api/utils/song-library/store.js';
import {disableUser,revokeKey,revokeSessions} from '../../api/utils/app-auth/admin.js';
import {SpotifyStore} from '../../api/utils/spotify/store.js';
import {ListeningStore} from '../../api/utils/listening/store.js';
import {createCurrentAuthContext} from '../../api/utils/listening-v2/auth-context.js';
const policy={audience:'writer-pg-test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
const bundleID=policy.bundles[0],runID=randomBytes(6).toString('hex');
const appName=name=>`lyrica-writers-${runID}-${name}`;
let admin,pool,databaseName,created=false,adminConnected=false;
const borrowed=new Set(),operations=new Set(),holds=new Set(),cleanupScopes=new Set(),poolErrors=[];
const pids=new Map();
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
 databaseName='lyrica_sessions_writers_'+randomUUID().replaceAll('-','');
 assert.match(databaseName,/^lyrica_sessions_writers_[a-f0-9]{32}$/);
 await admin.query('CREATE DATABASE '+databaseName);created=true;
 pool=new pg.Pool({...config,database:databaseName,max:6,idleTimeoutMillis:1000});
 pool.on('error',error=>poolErrors.push(error));
 const files=(await readdir(new URL('../../db/',import.meta.url))).filter(f=>/^\d{3}-.+\.sql$/.test(f)&&Number(f.slice(0,3))<=29).sort();
 assert.deepEqual(files.map(f=>Number(f.slice(0,3))),Array.from({length:29},(_,i)=>i+1));
 for(const file of files)await query(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
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

// Hooks observe real SQL only. They cannot substitute rows/permits, and the
// actual store always owns BEGIN/COMMIT through this real connection adapter.
function database(name,{enter,afterSQL}={}){
 return {query,async transaction(fn){
  const lease=await acquire();let failure;
  try{
   pids.set(name,await begin(lease,name));if(enter)await enter.point();
   const tx={async query(sql,args){const value=await lease.client.query(sql,args);if(afterSQL)await afterSQL(sql,lease.client,args);return value;}};
   const result=await fn(tx);await lease.client.query('COMMIT');return result;
  }catch(error){failure=error;throw error;}
  finally{try{await rollbackRelease(lease);}catch(error){if(failure)throw new AggregateError([failure,error]);throw error;}}
 }};
}
const cryptoFixtures={attestFn:()=>({publicKey:'external-crypto-fixture',receipt:Buffer.from('fixture')}),
 assertionFn:({assertion})=>Number(assertion.toString())};
const appleFixture={authenticate:async()=>({subjectHash:digest('apple-target'),refreshTokenEncrypted:'fixture-ciphertext'}),revoke:async()=>{}};
const cleanupFixture=async()=>{}; // External postcommit queue boundary only.
const accounts=db=>new AccountStore(db,{policy,...cryptoFixtures,apple:appleFixture,spotifyCleanupFn:cleanupFixture});
const auth=db=>new AppAuthStore(db,{policy,...cryptoFixtures});
async function seed(){
 await quiescent();pids.clear();
 await query('TRUNCATE spotify_connections CASCADE');
 await query('TRUNCATE library_users CASCADE');
 await query('TRUNCATE account_rate_windows,account_nonces');
 await query('UPDATE membership_settings SET public_access_enabled=true');
 const db=database('seed'),library=new SongLibraryStore(db),a=auth(db);
 await library.createUser('z-reader','credential-z');
 await library.createUser('é-reader','credential-e');
 const key=Buffer.alloc(32,17).toString('base64'),token='credential-z';
 const register=await a.challenge(token,{keyID:key,bundleID,purpose:'register'});
 await a.register(token,{keyID:key,bundleID,...register,attestation:'Zml4dHVyZQ=='});
 const challenge=await a.challenge(token,{keyID:key,bundleID,purpose:'session'});
 const bearer=await a.session(token,{keyID:key,bundleID,...challenge,assertion:'MQ=='});
 const user=await a.authenticate(bearer.token);
 return {db,library,auth:a,user,key,token,bearer:bearer.token};
}
async function sessionInput(f,counter=2){return {keyID:f.key,bundleID,...await f.auth.challenge(f.token,{keyID:f.key,bundleID,purpose:'session'}),assertion:Buffer.from(String(counter)).toString('base64')};}
async function prepared(f){const context=createCurrentAuthContext({authStore:f.auth,environment:'test'});return {context,authentication:await context.prepare(f.bearer)};}
async function current(p,db,requiredScopes){return db.transaction(async tx=>{
 const discovery=await p.context.discover({tx,authentication:p.authentication,requiredScopes});
 const scope=await p.context.lock({tx,discovery});await scope.revalidate({tx});return scope.principalID;
});}
async function connected(f){const c={id:randomUUID(),epoch:randomUUID(),enrollmentID:randomUUID(),ownerID:f.user.id,keyID:f.key,credentialDigest:f.user.credentialDigest,status:'connected',consumers:{}};await new SpotifyStore(f.db).create(c);return c;}
async function loginInput(f){return {...await accounts(f.db).challenge({purpose:'apple',bundleID},f.user),bundleID,identityToken:'fixture',authorizationCode:'fixture'};}

// Issuance has already completed the legacy autocommit quota UPDATE when its
// transaction is paused. Without this gate that UPDATE masks the old FK cycle.
test('session key -> token FK cycle versus actual current-auth is removed',{timeout:10000},async()=>{
 const f=await seed(),body=await sessionInput(f),p=await prepared(f),entry=barrier(),tokenHold=barrier();
 const issuing=outcome(auth(database('issuance',{enter:entry})).session(f.token,body));let reading;
 try{
  await entered(entry,issuing);
  reading=outcome(current(p,database('current',{afterSQL:sql=>/public\.library_tokens WHERE digest=\$1 FOR UPDATE/.test(sql)?tokenHold.point():undefined})));
  await entered(tokenHold,reading);entry.release();
  await blocked('issuance',pids.get('current'));
 }finally{entry.release();tokenHold.release();await issuing;if(reading)await reading;}
 assert.equal((await issuing).error,undefined);assert.equal((await reading).error,undefined);
 assert.equal((await f.auth.authenticate((await issuing).value.token)).id,f.user.id);
});

for(const writer of ['signOut','disableUser','revokeKey','rotate','signIn','delete','spotifyCreate','spotifyAdopt'])test(writer+' respects current-auth anchors before later rows',{timeout:10000},async()=>{
 let f=await seed(),input,c;
 if(writer==='delete'){
  const signed=await accounts(f.db).signIn(f.user,await loginInput(f));f.token=signed.credential;
  const issued=await f.auth.session(f.token,await sessionInput(f));f.bearer=issued.token;f.user=await f.auth.authenticate(f.bearer);
  input={...await accounts(f.db).challenge({purpose:'delete',bundleID},f.user),bundleID,identityToken:'fixture',authorizationCode:'fixture'};
 }else if(writer==='signIn')input=await loginInput(f);
 if(writer.startsWith('spotify'))c=await connected(f);
 const p=await prepared(f),hold=barrier();
 const reading=outcome(current(p,database('current',{afterSQL:sql=>/public\.library_tokens WHERE digest=\$1 FOR UPDATE/.test(sql)?hold.point():undefined})));
 let writing;
 try{
  await entered(hold,reading);const db=database('writer');
  const work={signOut:()=>accounts(db).signOut(f.user),disableUser:()=>disableUser(db,f.user.id,{spotifyCleanupFn:cleanupFixture}),
   revokeKey:()=>revokeKey(db,f.key,{spotifyCleanupFn:cleanupFixture}),rotate:()=>new SongLibraryStore(db).createUser(f.user.id,'replacement'),
   signIn:()=>accounts(db).signIn(f.user,input),delete:()=>accounts(db).delete(f.user,input),
   spotifyCreate:()=>new SpotifyStore(db).create({...c,id:randomUUID(),enrollmentID:randomUUID()}),
   spotifyAdopt:()=>new SpotifyStore(db).adopt(c.id,f.user,row=>{row.qualifiedMarker=true;})};
  writing=outcome(work[writer]());await blocked('writer',pids.get('current'));
 }finally{hold.release();await reading;if(writing)await writing;}
 assert.equal((await reading).error,undefined);assert.equal((await writing).error,undefined);
 if(!writer.startsWith('spotify'))await assert.rejects(f.auth.authenticate(f.bearer),{code:'session_expired'});
});

test('issuance wins, then signOut closes the credential without counter loss',{timeout:10000},async()=>{
 const f=await seed(),body=await sessionInput(f),hold=barrier();
 const issuing=outcome(auth(database('issuer',{afterSQL:sql=>/^UPDATE app_attest_keys SET sign_count/.test(sql)?hold.point():undefined})).session(f.token,body));let closing;
 try{await entered(hold,issuing);closing=outcome(accounts(database('closer')).signOut(f.user));await blocked('closer',pids.get('issuer'));}
 finally{hold.release();await issuing;if(closing)await closing;}
 assert.equal((await issuing).error,undefined);assert.equal((await closing).error,undefined);
 await assert.rejects(f.auth.authenticate((await issuing).value.token),{code:'session_expired'});
 assert.equal(Number((await query('SELECT sign_count FROM app_attest_keys WHERE key_id=$1',[f.key])).rows[0].sign_count),2);
});

for(const first of ['register','revoke'])test('absent-key registration versus credential revocation: '+first+' first',{timeout:10000},async()=>{
 const f=await seed(),key=Buffer.alloc(32,23).toString('base64');
 const body={keyID:key,bundleID,...await f.auth.challenge(f.token,{keyID:key,bundleID,purpose:'register'}),attestation:'Zml4dHVyZQ=='};
 const hold=barrier(),entry=barrier();let registration,revocation;
 try{
  // Registration passes its quota before either contender holds its user.
  registration=outcome(auth(database('registration',{enter:entry,afterSQL:sql=>first==='register'&&/INSERT INTO app_attest_keys/.test(sql)?hold.point():undefined})).register(f.token,body));
  await entered(entry,registration);
  if(first==='register'){
   entry.release();await entered(hold,registration);revocation=outcome(accounts(database('revocation')).signOut(f.user));
   await blocked('revocation',pids.get('registration'));
  }else{
   revocation=outcome(accounts(database('revocation',{afterSQL:sql=>/UPDATE library_tokens SET revoked/.test(sql)?hold.point():undefined})).signOut(f.user));
   await entered(hold,revocation);entry.release();await blocked('registration',pids.get('revocation'));
  }
 }finally{entry.release();hold.release();if(registration)await registration;if(revocation)await revocation;}
 assert.equal((await revocation).error,undefined);
 if(first==='register')assert.equal((await registration).error,undefined);else assert.equal((await registration).error?.code,'unauthorized');
 assert.equal(Number((await query('SELECT count(*) AS n FROM app_attest_keys WHERE key_id=$1',[key])).rows[0].n),first==='register'?1:0);
});

test('two real counter contenders commit one session, one challenge and no replay',{timeout:10000},async()=>{
 const f=await seed(),body=await sessionInput(f);
 const results=await Promise.all([outcome(auth(database('counter-a')).session(f.token,body)),outcome(auth(database('counter-b')).session(f.token,body))]);
 assert.equal(results.filter(r=>!r.error).length,1);assert.equal(results.find(r=>r.error).error.code,'challenge_expired');
 assert.equal(Number((await query('SELECT sign_count FROM app_attest_keys WHERE key_id=$1',[f.key])).rows[0].sign_count),2);
 assert.equal(Number((await query('SELECT count(*) AS n FROM app_auth_sessions WHERE key_id=$1',[f.key])).rows[0].n),1);
});

test('real PostgreSQL wall time expires credential during issuance and rolls back counter/session/challenge',{timeout:10000},async()=>{
 const f=await seed(),body=await sessionInput(f);
 await query("UPDATE library_tokens SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE digest=$1",[f.user.credentialDigest]);
 let reached=false;
 const db=database('expiry',{afterSQL:async(sql,tx)=>{
  if(/^UPDATE app_attest_keys SET sign_count/.test(sql)){
   assert.equal((await tx.query('SELECT expires_at>clock_timestamp() AS live FROM library_tokens WHERE digest=$1',[f.user.credentialDigest])).rows[0].live,true);
   reached=true;await tx.query('SELECT pg_sleep(1.6)');
   assert.equal((await tx.query('SELECT expires_at>clock_timestamp() AS live FROM library_tokens WHERE digest=$1',[f.user.credentialDigest])).rows[0].live,false);
  }
 }});
 await assert.rejects(auth(db).session(f.token,body),{code:'unauthorized'});assert.equal(reached,true);
 assert.equal(Number((await query('SELECT sign_count FROM app_attest_keys WHERE key_id=$1',[f.key])).rows[0].sign_count),1);
 assert.equal((await query('SELECT consumed FROM app_auth_challenges WHERE digest=$1',[digest(body.challenge)])).rows[0].consumed,false);
 assert.equal(Number((await query('SELECT count(*) AS n FROM app_auth_sessions WHERE digest=$1',[digest(f.bearer)])).rows[0].n),1);
});

for(const observerFailure of [false,true])test('expiry maintenance skips another locked session; observer failure='+observerFailure,{timeout:10000},async()=>{
 const f=await seed(),lease=await acquire();let pending,cleaned=false;
 const cleanup=async()=>{if(cleaned)return;cleaned=true;try{await rollbackRelease(lease);}finally{if(pending)await pending;cleanupScopes.delete(cleanup);}};
 cleanupScopes.add(cleanup);
 try{
  await begin(lease,'expired-holder');await lease.client.query('UPDATE app_auth_sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE digest=$1',[digest(f.bearer)]);
  // The uncommitted UPDATE leaves a live snapshot: add a committed expired row
  // first in other cases below; this also checks no blocking global DELETE.
  pending=outcome(auth(database('sweep')).challenge(f.token,{keyID:f.key,bundleID,purpose:'session'}));
  if(observerFailure)throw new Error('injected observer failure');
  assert.equal((await bounded(pending,2000,'cleanup waited for another session')).error,undefined);
 }catch(error){if(!observerFailure||error.message!=='injected observer failure')throw error;}
 finally{await cleanup();}
 await quiescent();
});

test('bounded cleanup skips a committed expired locked row and recovers next invocation',{timeout:10000},async()=>{
 const f=await seed();await query("UPDATE app_auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE digest=$1",[digest(f.bearer)]);
 const lease=await acquire();let pending;
 const cleanup=async()=>{try{await rollbackRelease(lease);}finally{if(pending)await pending;cleanupScopes.delete(cleanup);}};cleanupScopes.add(cleanup);
 try{
  await begin(lease,'expired');await lease.client.query('SELECT digest FROM app_auth_sessions WHERE digest=$1 FOR UPDATE',[digest(f.bearer)]);
  pending=outcome(auth(database('maintenance')).challenge(f.token,{keyID:f.key,bundleID,purpose:'session'}));
  assert.equal((await bounded(pending,2000,'maintenance waited instead of skipping')).error,undefined);
  assert.equal(Number((await query('SELECT count(*) AS n FROM app_auth_sessions')).rows[0].n),1);
 }finally{await cleanup();}
 await f.auth.challenge(f.token,{keyID:f.key,bundleID,purpose:'session'});
 assert.equal(Number((await query('SELECT count(*) AS n FROM app_auth_sessions')).rows[0].n),0);
});

// A room-holder can insert an actor FK while deletion holds its user anchor.
// FOR UPDATE on that user would make this a NEW cycle with unchanged V1.
test('account deletion user anchor remains compatible with V1 command actor FK',{timeout:10000},async()=>{
 const f=await seed(),signed=await accounts(f.db).signIn(f.user,await loginInput(f));f.token=signed.credential;
 const issued=await f.auth.session(f.token,await sessionInput(f));f.user=await f.auth.authenticate(issued.token);
 const roomID=randomUUID(),member={id:'host-member',userID:f.user.id,keyID:f.key,leftAtMS:null};
 await query(`INSERT INTO listening_rooms(id,environment,owner_id,status,invite_hash,code_hash,data)
  VALUES($1,'development',$2,'active',$3,$4,$5)`,[roomID,f.user.id,digest('invite'),digest('code'),JSON.stringify({id:roomID,status:'active',revision:0,stateVersion:0,invitation:{token:'invite',code:'code'},members:[member]})]);
 const hold=barrier(),store=new ListeningStore(database('v1'),'development');
 const command=outcome(store.command(f.user,roomID,{commandID:randomUUID()},()=>hold.point()));let deletion;
 try{
  await entered(hold,command);
  const input={...await accounts(f.db).challenge({purpose:'delete',bundleID},f.user),bundleID,identityToken:'fixture',authorizationCode:'fixture'};
  deletion=outcome(accounts(database('deletion')).delete(f.user,input));
  await blocked('deletion',pids.get('v1'));hold.release();
 }finally{hold.release();await command;if(deletion)await deletion;}
 assert.equal((await command).error,undefined);assert.equal((await deletion).error,undefined);
 assert.equal(Number((await query('SELECT count(*) AS n FROM listening_rooms')).rows[0].n),0);
});

for(const writer of ['disableUser','revokeKey','signIn','delete'])test('issuance precedes '+writer+' without a new reverse-order wait',{timeout:10000},async()=>{
 let f=await seed(),input,counter=2;
 if(writer==='delete'){
  const signed=await accounts(f.db).signIn(f.user,await loginInput(f));f.token=signed.credential;
  const issued=await f.auth.session(f.token,await sessionInput(f));f.bearer=issued.token;f.user=await f.auth.authenticate(f.bearer);counter=3;
  input={...await accounts(f.db).challenge({purpose:'delete',bundleID},f.user),bundleID,identityToken:'fixture',authorizationCode:'fixture'};
 }else if(writer==='signIn')input=await loginInput(f);
 const body=await sessionInput(f,counter),hold=barrier();
 const issuing=outcome(auth(database('issuer',{afterSQL:sql=>/^UPDATE app_attest_keys SET sign_count/.test(sql)?hold.point():undefined})).session(f.token,body));let writing;
 try{
  await entered(hold,issuing);const db=database('writer');
  writing=outcome(({disableUser:()=>disableUser(db,f.user.id,{spotifyCleanupFn:cleanupFixture}),
   revokeKey:()=>revokeKey(db,f.key,{spotifyCleanupFn:cleanupFixture}),
   signIn:()=>accounts(db).signIn(f.user,input),delete:()=>accounts(db).delete(f.user,input)})[writer]());
  await blocked('writer',pids.get('issuer'));
 }finally{hold.release();await issuing;if(writing)await writing;}
 assert.equal((await issuing).error,undefined);assert.equal((await writing).error,undefined);
 await assert.rejects(f.auth.authenticate((await issuing).value.token),{code:'session_expired'});
});

for(const writer of ['signOut','revokeKey','disableUser','signIn'])test(writer+' commits first and current-auth refuses the old bearer',{timeout:10000},async()=>{
 const f=await seed(),p=await prepared(f),input=writer==='signIn'?await loginInput(f):null,hold=barrier();let reading;
 const stop=writer==='revokeKey'?/^UPDATE app_attest_keys SET revoked/:/^UPDATE library_tokens SET revoked/;
 const db=database('writer',{afterSQL:sql=>stop.test(sql.trim())?hold.point():undefined});
 const writing=outcome(({signOut:()=>accounts(db).signOut(f.user),revokeKey:()=>revokeKey(db,f.key,{spotifyCleanupFn:cleanupFixture}),
  disableUser:()=>disableUser(db,f.user.id,{spotifyCleanupFn:cleanupFixture}),signIn:()=>accounts(db).signIn(f.user,input)})[writer]());
 try{await entered(hold,writing);reading=outcome(current(p,database('current')));await blocked('current',pids.get('writer'));}
 finally{hold.release();await writing;if(reading)await reading;}
 assert.equal((await writing).error,undefined);
 assert.ok(['unauthorized','conflict'].includes((await reading).error?.code));
});

test('owner move captures both existing users in UTF-8 byte order and revalidates final expiry',{timeout:10000},async()=>{
 const f=await seed();await query("UPDATE library_users SET access_kind='apple' WHERE id='é-reader'");
 await query('INSERT INTO account_identities(subject_hash,user_id,app_account_token) VALUES($1,$2,$3)',[digest('apple-target'),'é-reader',randomUUID()]);
 const input=await loginInput(f),seen=[];
 await query("UPDATE library_tokens SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE digest=$1",[f.user.credentialDigest]);
 const db=database('owner-move',{afterSQL:async(sql,tx,args)=>{
  if(/FROM library_users WHERE id=\$1 FOR NO KEY UPDATE/.test(sql))seen.push(args[0]);
  if(/^UPDATE app_attest_keys SET user_id/.test(sql)){
   assert.equal((await tx.query('SELECT expires_at>clock_timestamp() AS live FROM library_tokens WHERE digest=$1',[f.user.credentialDigest])).rows[0].live,true);
   await tx.query('SELECT pg_sleep(1.6)');
  }
 }});
 await assert.rejects(accounts(db).signIn(f.user,input),{code:'app_access_revoked'});
 assert.deepEqual(seen,['z-reader','é-reader']);
 assert.equal((await query('SELECT user_id FROM app_attest_keys WHERE key_id=$1',[f.key])).rows[0].user_id,f.user.id);
 assert.equal((await query('SELECT revoked FROM library_tokens WHERE digest=$1',[f.user.credentialDigest])).rows[0].revoked,false);
});

test('owner-wide signOut locks keys in byte order including sibling credentials',{timeout:10000},async()=>{
 const f=await seed(),ids=[Buffer.alloc(32,248).toString('base64'),Buffer.alloc(32,255).toString('base64')];
 for(const key of ids){const input={keyID:key,bundleID,...await f.auth.challenge(f.token,{keyID:key,bundleID,purpose:'register'}),attestation:'Zml4dHVyZQ=='};await f.auth.register(f.token,input);}
 await query('INSERT INTO library_tokens(digest,user_id) VALUES($1,$2)',[digest('sibling-credential'),f.user.id]);
 const sibling={id:randomUUID(),epoch:randomUUID(),enrollmentID:randomUUID(),ownerID:f.user.id,keyID:ids[0],credentialDigest:digest('sibling-credential'),status:'connected',consumers:{}};
 const spotify=new SpotifyStore(f.db);await spotify.create(sibling);
 const own=await connected(f),seen=[];
 await accounts(database('signout-order',{afterSQL:async(sql,_,args)=>{if(/FROM app_attest_keys WHERE key_id=\$1 FOR UPDATE/.test(sql))seen.push(args[0]);}})).signOut(f.user);
 assert.deepEqual(seen,[f.key,...ids].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
 assert.equal((await spotify.read(own.id)).reason,'signedOut');
 assert.equal((await spotify.read(sibling.id)).status,'connected','credential selector still limits connections');
});

test('standalone ordered session revoke waits for exact current-auth session then invalidates it',{timeout:10000},async()=>{
 const f=await seed(),p=await prepared(f),hold=barrier();let revoking;
 const reading=outcome(current(p,database('current',{afterSQL:sql=>/FROM public\.app_auth_sessions WHERE digest=\$1 FOR UPDATE/.test(sql)?hold.point():undefined})));
 try{
  await entered(hold,reading);
  revoking=outcome(database('session-revoke').transaction(tx=>revokeSessions(tx,f.user.id)));
  await blocked('session-revoke',pids.get('current'));
 }finally{hold.release();await reading;if(revoking)await revoking;}
 assert.equal((await reading).error,undefined);assert.equal((await revoking).error,undefined);
 await assert.rejects(f.auth.authenticate(f.bearer),{code:'session_expired'});
});

test('injected lock-observer failure drains actual current-auth and signOut contenders',{timeout:10000},async()=>{
 const f=await seed(),p=await prepared(f),hold=barrier(),sentinel=new Error('observer failed');let writing;
 const reading=outcome(current(p,database('current',{afterSQL:sql=>/public\.library_tokens WHERE digest=\$1 FOR UPDATE/.test(sql)?hold.point():undefined})));
 await assert.rejects((async()=>{
  try{
   await entered(hold,reading);writing=outcome(accounts(database('writer')).signOut(f.user));
   await blocked('writer',pids.get('current'));throw sentinel;
  }finally{hold.release();await reading;if(writing)await writing;}
 })(),e=>e===sentinel);
 assert.equal((await reading).error,undefined);assert.equal((await writing).error,undefined);await quiescent();
});

test('twelve real concurrent challenge requests admit exactly eight live pending rows',{timeout:10000},async()=>{
 const f=await seed();
 const results=await Promise.all(Array.from({length:12},(_,i)=>outcome(auth(database('challenge-'+i)).challenge(f.token,{keyID:f.key,bundleID,purpose:'session'}))));
 assert.equal(results.filter(x=>!x.error).length,8);
 for(const result of results.filter(x=>x.error))assert.equal(result.error.code,'rate_limited');
 assert.equal(Number((await query('SELECT count(*) AS n FROM app_auth_challenges WHERE NOT consumed AND expires_at>clock_timestamp()')).rows[0].n),8);
});

test('real expiry batches are capped, transactional on failure, and recover without deleting live sessions',{timeout:10000},async()=>{
 const f=await seed();
 await query(`INSERT INTO app_auth_sessions(digest,key_id,credential_digest,audience,expires_at)
  SELECT lpad(n::text,64,'0'),$1,$2,$3,clock_timestamp()-interval '1 second' FROM generate_series(1,250) n`,[f.key,f.user.credentialDigest,policy.audience]);
 const expired=async()=>Number((await query('SELECT count(*) AS n FROM app_auth_sessions WHERE expires_at<=clock_timestamp()')).rows[0].n);
 await f.auth.challenge(f.token,{keyID:f.key,bundleID,purpose:'session'});assert.equal(await expired(),150);
 const fault=new Error('expiry batch failure'),db=database('maintenance-failure',{afterSQL:sql=>{if(/DELETE FROM app_auth_sessions/.test(sql))throw fault;}});
 await assert.rejects(auth(db).challenge(f.token,{keyID:f.key,bundleID,purpose:'session'}),e=>e===fault);
 assert.equal(await expired(),150,'failed batch rolls back every selected row');
 await f.auth.challenge(f.token,{keyID:f.key,bundleID,purpose:'session'});assert.equal(await expired(),50);
 assert.equal((await f.auth.authenticate(f.bearer)).id,f.user.id);await quiescent();
});

// R2 additions. Keep the R1 harness/tests byte-for-byte above. This adapter is
// the same real BEGIN/query/COMMIT/ROLLBACK path, with actual results exposed
// to observation hooks. It never substitutes a row, permit or successful SQL.
function collisionDatabase(name,afterSQL) {
 return {query,async transaction(fn){
  const lease=await acquire();let failure;
  try{
   pids.set(name,await begin(lease,name));
   const tx={async query(sql,args=[]){
    const result=await lease.client.query(sql,args);
    await afterSQL(sql,lease.client,args,result);return result;
   }};
   const result=await fn(tx);await lease.client.query('COMMIT');return result;
  }catch(error){failure=error;throw error;}
  finally{try{await rollbackRelease(lease);}catch(error){if(failure)throw new AggregateError([failure,error]);throw error;}}
 }};
}
async function collisionState(db={query}) {
 const state={};
 // JSON timestamps retain PostgreSQL precision, including fractional expiry.
 for(const [table,key] of [['library_users','id'],['library_tokens','digest'],['app_attest_keys','key_id'],
  ['app_auth_sessions','digest'],['app_auth_challenges','digest'],['library_rate_windows','user_id'],['translation_jobs','id']])
  state[table]=(await db.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY ${key}::text COLLATE "C"`)).rows.map(r=>r.data);
 return state;
}
async function collisionFixture() {
 const f=await seed();
 await query("UPDATE library_users SET unlimited_generation=true,access_kind='guest'");
 await query("UPDATE library_tokens SET expires_at='2099-01-02 03:04:05.123456+00'");
 for(const id of ['z-reader','é-reader']){
  await query("INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,'2098-01-02 03:04:05.654321+00')",[digest('sibling-'+id),id]);
  await query("INSERT INTO library_rate_windows(user_id,window_start,count) VALUES($1,date_trunc('minute',now()),17)",[id]);
 }
 return f;
}
async function crossOwnerDigestRace({winnerID,revoked=false,newLoser=false,observerFailure=null}) {
 await collisionFixture();
 const loserID=newLoser?'new-losing-reader':winnerID==='z-reader'?'é-reader':'z-reader';
 const token='r2-shared-absent-digest',target=digest(token),preReads=new Set(),emptyLocks=new Set();
 const winnerAbsent=barrier(),loserAbsent=barrier(),inserted=barrier(),all=[winnerAbsent,loserAbsent,inserted];
 const pending=[];let winnerExpected,winning,losing,draining;
 const drain=()=>draining??=(async()=>{
  // Drop every application wait before draining blocked PostgreSQL callers.
  // Each adapter owns rollback/release, including failure before COMMIT.
  for(const hold of all)hold.release();
  try{await Promise.all(pending);}finally{cleanupScopes.delete(drain);}
 })();
 cleanupScopes.add(drain);
 const contender=(name,id,absent,isWinner)=>new SongLibraryStore(collisionDatabase(name,async(sql,client,args,result)=>{
  if(args[0]!==target)return;
  if(sql==='SELECT user_id FROM library_tokens WHERE digest=$1'){
   assert.deepEqual(result.rows,[],'actual initial owner lookup must see absence');preReads.add(id);
  }
  if(sql==='SELECT digest,user_id FROM library_tokens WHERE digest=$1 FOR UPDATE'){
   assert.deepEqual(result.rows,[],'actual exact locking lookup must also see absence');emptyLocks.add(id);
   await absent.point();
  }
  if(isWinner&&/^INSERT INTO library_tokens\(digest,user_id\)/.test(sql)){
   // Explicit TRUSTED FIXTURE INJECTION, not createUser/signOut behavior:
   // after the actual winning INSERT and before its COMMIT, preserve a finite
   // deadline and optionally revoke the winner's row in that same transaction.
   await client.query(`UPDATE library_tokens SET revoked=$2,expires_at='2097-02-03 04:05:06.987654+00'
    WHERE digest=$1`,[target,revoked]);
   winnerExpected=await collisionState(client);await inserted.point();
  }
 })).createUser(id,token);
 try{
  winning=outcome(contender('digest-winner',winnerID,winnerAbsent,true));pending.push(winning);
  losing=outcome(contender('digest-loser',loserID,loserAbsent,false));pending.push(losing);
  await entered(winnerAbsent,winning);await entered(loserAbsent,losing);
  assert.deepEqual([...preReads].sort(),[winnerID,loserID].sort());
  assert.deepEqual([...emptyLocks].sort(),[winnerID,loserID].sort());
  if(observerFailure==='after-absence')throw new Error('injected collision observer failure');
  winnerAbsent.release();await entered(inserted,winning);
  if(observerFailure==='after-insert')throw new Error('injected collision observer failure');
  loserAbsent.release();
  const lock=await blocked('digest-loser',pids.get('digest-winner'));
  assert.equal(lock.pid,pids.get('digest-loser'));
  const activity=(await admin.query('SELECT query,wait_event FROM pg_stat_activity WHERE pid=$1',[lock.pid])).rows[0];
  assert.match(activity.query,/^INSERT INTO library_tokens\(digest,user_id\)/);
  assert.equal(activity.wait_event,'transactionid','unique-conflict INSERT waits for the uncommitted winner');
  if(observerFailure==='after-blocked')throw new Error('injected collision observer failure');
  inserted.release(); // Actual winner COMMIT, then conflict predicate/refusal.
 }finally{await drain();}
 assert.equal((await winning).error,undefined);assert.equal((await winning).value,undefined);
 assert.equal((await losing).error?.code,'token_collision');assert.equal((await losing).error?.status,409);
 assert.deepEqual(await collisionState(),winnerExpected,'loser rotations/new user roll back; winner owner/expiry/revocation and all data are unchanged');
 const credential=winnerExpected.library_tokens.find(r=>r.digest===target);
 assert.equal(credential.user_id,winnerID);assert.equal(credential.revoked,revoked);
 assert.equal(credential.expires_at,'2097-02-03T04:05:06.987654+00:00');
 const library=new SongLibraryStore({query});
 if(revoked)assert.equal(await library.authenticate(token),null,'trusted revoked foreign witness stays denied');
 else assert.equal((await library.authenticate(token)).id,winnerID);
 // Loser old credentials remain usable, not merely present under another owner.
 if(!newLoser){
  const old=loserID==='z-reader'?'credential-z':'credential-e';
  assert.equal((await library.authenticate(old)).id,loserID);
  assert.equal((await library.authenticate('sibling-'+loserID)).id,loserID);
 }
 await quiescent();
}
for(const winnerID of ['z-reader','é-reader'])for(const revoked of [false,true])
test('absent foreign digest unique conflict: winner='+winnerID+', trusted revoked fixture='+revoked,{timeout:10000},async()=>{
 await crossOwnerDigestRace({winnerID,revoked});
});
test('absent foreign digest refusal also rolls back a newly inserted losing user',{timeout:10000},async()=>{
 await crossOwnerDigestRace({winnerID:'z-reader',revoked:true,newLoser:true});
});
for(const observerFailure of ['after-absence','after-insert','after-blocked'])
test('collision barrier failure drains both actual createUser callers: '+observerFailure,{timeout:10000},async()=>{
 await assert.rejects(crossOwnerDigestRace({winnerID:'z-reader',revoked:true,observerFailure}),{message:'injected collision observer failure'});
 await quiescent();
});

test('foreign digest appearing after discovery but before exact lock keeps token_collision policy',{timeout:10000},async()=>{
 await collisionFixture();const token='r2-between-lookups',target=digest(token),hold=barrier();let pending;
 try{
  const loser=new SongLibraryStore(collisionDatabase('discovery-loser',async(sql,_,args,result)=>{
   if(sql==='SELECT user_id FROM library_tokens WHERE digest=$1'&&args[0]===target){assert.deepEqual(result.rows,[]);await hold.point();}
  }));
  pending=outcome(loser.createUser('é-reader',token));await entered(hold,pending);
  await new SongLibraryStore(database('discovery-winner')).createUser('z-reader',token);
  const expected=await collisionState();hold.release();
  assert.equal((await pending).error?.code,'token_collision');assert.equal((await pending).error?.status,409);
  assert.deepEqual(await collisionState(),expected);
 }finally{hold.release();if(pending)await pending;}
});

test('same owner concurrent absent-digest createUser serializes and preserves exact stored deadline',{timeout:10000},async()=>{
 await collisionFixture();const token='r2-same-owner',target=digest(token),inserted=barrier(),preRead=barrier();
 let winning,losing,expected;
 try{
  const winner=new SongLibraryStore(collisionDatabase('same-winner',async(sql,client,args)=>{
   if(/^INSERT INTO library_tokens\(digest,user_id\)/.test(sql)&&args[0]===target){
    // Trusted deadline fixture inside the genuine winning transaction.
    await client.query("UPDATE library_tokens SET expires_at='2096-01-02 03:04:05.123456+00' WHERE digest=$1",[target]);
    expected=await collisionState(client);await inserted.point();
   }
  }));
  winning=outcome(winner.createUser('z-reader',token));await entered(inserted,winning);
  const loser=new SongLibraryStore(collisionDatabase('same-loser',async(sql,_,args,result)=>{
   if(sql==='SELECT user_id FROM library_tokens WHERE digest=$1'&&args[0]===target){assert.deepEqual(result.rows,[]);await preRead.point();}
  }));
  losing=outcome(loser.createUser('z-reader',token));await entered(preRead,losing);preRead.release();
  await blocked('same-loser',pids.get('same-winner'));inserted.release();
 }finally{preRead.release();inserted.release();await Promise.all([winning,losing].filter(Boolean));}
 assert.equal((await winning).error,undefined);assert.equal((await losing).error,undefined);
 assert.equal((await winning).value,undefined);assert.equal((await losing).value,undefined);
 assert.deepEqual(await collisionState(),expected,'same-owner conflict returns success without altering expiry/owner/data');
 assert.equal((await new SongLibraryStore({query}).authenticate(token)).id,'z-reader');await quiescent();
});
