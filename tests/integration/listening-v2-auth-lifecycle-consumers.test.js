import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {libraryDB} from '../helpers/library-db.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {disableUser,revokeKey,revokeSessions} from '../../api/utils/app-auth/admin.js';
import {SongLibraryStore,digest} from '../../api/utils/song-library/store.js';
import {createPrivacyLifecycle} from '../../api/utils/listening-v2/privacy-lifecycle.js';
import {createAuthPrivacyWriters} from '../../api/utils/listening-v2/privacy-writers.js';
import {PRIVACY_CODEC_FIELDS,decodePersonaTuple} from '../../api/utils/listening-v2/privacy-codec.js';
import {SpotifyStore} from '../../api/utils/spotify/store.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';

// Positive auth authority always comes from actual guest/challenge/register/
// session/authenticate methods. Only external Apple/App Attest crypto is mocked.
// Persona INSERTs below are retained PREimages, never successful transfers,
// first-retention proof, or fabricated auth responses. Root owns the private
// first-retention/read/erase/processor composition and real PG concurrency.
const policy={audience:'test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
const bundleID=policy.bundles[0],sessionsPrivacy=Object.freeze({coordinatorEnvironment:'test'});
const key=n=>Buffer.alloc(32,n).toString('base64');
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const shape=(p)=>PRIVACY_CODEC_FIELDS.personaTuple.map(k=>p[k]===null?null:
 ['privacy_generation','guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms','created_at_ms','updated_at_ms',
 'controller_privacy_epoch','private_transfer_from_generation'].includes(k)?Number(p[k]):p[k]);
async function fixture(t,{v2=true,roles=false,before=async()=>{},after=async()=>{},finalClock=null}={}){
 const f=await libraryDB();t.after(()=>f.db.close());
 // Provision fixture roles before the migrations' real conditional grants.
 if(roles){await f.db.query('CREATE ROLE lyra_account_v1');await f.db.query('CREATE ROLE lyra_runtime_v1');}
 for(const file of ['027-spotify-background.sql','029-listening-sessions.sql','032-auth-token-row-locks.sql'])
  await f.db.exec(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
 if(roles)await replayMembershipRoleGrants(f.db);
 if(v2)for(const file of ['030-listening-v2-schema.sql','031-listening-v2-lifecycle-support.sql','033-listening-v2-lifecycle-composition.sql'])
  await f.db.exec(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
 await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
 const trace=[],wrap=(raw,id)=>({async query(sql,args=[]){trace.push({sql,args:structuredClone(args),id});
  await before(raw,sql,args);
  // Deterministic SQL comparator fixture only. It replaces the final sampled
  // timestamp, never an auth/SQL result; this is not wall-clock race placement.
  const sampled=finalClock?.at&&sql.includes('WITH auth_clock AS MATERIALIZED');
  const executed=sampled?sql.replace('clock_timestamp() AS at',`$${args.length+1}::timestamptz AS at`):sql;
  const result=await raw.query(executed,sampled?[...args,finalClock.at]:args);
  await after(raw,sql,args,result);return result;}});
 let xid=0;const db={query:wrap(f.store.db,null).query,transaction:fn=>{
  const id=++xid;trace.push({event:'BEGIN',id});return f.store.db.transaction(tx=>fn(wrap(tx,id))).then(value=>{
   trace.push({event:'COMMIT',id});return value;
  },error=>{trace.push({event:'ROLLBACK',id});throw error;});}};
 const flush=[],apple={subject:'A',authenticate:async()=>({subjectHash:digest(apple.subject),refreshTokenEncrypted:'external-crypto'}),revoke:async()=>{}};
 const external={attestFn:()=>({publicKey:'external-crypto',receipt:Buffer.from('external-crypto')}),
  assertionFn:({assertion})=>Number(assertion.toString())};
 const options={policy,...external,...(v2?{sessionsPrivacy}:{}),apple,spotifyCleanupFn:async(_,ids)=>flush.push(ids)};
 return {...f,db,trace,flush,apple,options,accounts:new AccountStore(db,options),auth:new AppAuthStore(db,options)};
}
async function guest(f,n=1){
 const keyID=key(n),credential='lyra_g_'+randomUUID().replaceAll('-','')+'abcdefghijk';
 const nonce=await f.accounts.challenge({purpose:'guest',bundleID,keyID},null,'fixture-'+n);
 await f.accounts.guest({...nonce,bundleID,keyID,credential,attestation:'Y3J5cHRv'});
 return credentialSession(f,credential,keyID,1);
}
async function credentialSession(f,credential,keyID,counter){
 const {challenge}=await f.auth.challenge(credential,{purpose:'session',bundleID,keyID});
 const result=await f.auth.session(credential,{challenge,bundleID,keyID,assertion:Buffer.from(String(counter)).toString('base64')});
 const user=await f.auth.authenticate(result.token);return {credential,keyID,user,bearer:result.token,counter};
}
async function sibling(f,g,n=2){
 const keyID=key(n),nonce=await f.auth.challenge(g.credential,{purpose:'register',bundleID,keyID});
 await f.auth.register(g.credential,{...nonce,bundleID,keyID,attestation:'Y3J5cHRv'});
 return credentialSession(f,g.credential,keyID,1);
}
async function signIn(f,g){
 const handle=await f.accounts.prepareWriterAuthentication(g.bearer),nonce=await f.accounts.challenge({purpose:'apple',bundleID},g.user);
 return f.accounts.signIn(g.user,{...nonce,bundleID,identityToken:'external-crypto',authorizationCode:'external-crypto'},handle);
}
async function signOut(f,g){return f.accounts.signOut(g.user,await f.accounts.prepareWriterAuthentication(g.bearer));}
async function persona(f,g,environment='test'){
 const p=await one(f.db,`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms,
 floor(extract(epoch FROM t.expires_at)*1000)::text AS expiry FROM library_tokens t WHERE digest=$1`,[g.user.credentialDigest]);
 const id=randomUUID();await f.db.query(`INSERT INTO listening_v2.privacy_personas
 (environment,persona_id,original_principal_id,original_key_id,controller_kind,controller_principal_id,controller_key_id,
 guest_credential_digest,guest_credential_expires_at_ms,created_at_ms,updated_at_ms)
 VALUES($1,$2,$3,$4,'guest',$3,$4,$5,$6,$7,$7)`,[environment,id,g.user.id,g.keyID,g.user.credentialDigest,p.expiry,p.ms]);
 return {environment,id};
}
const row=(f,p)=>one(f.db,'SELECT * FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2',[p.environment,p.id]);
async function hints(f){return (await f.db.query("SELECT * FROM listening_v2.outbox WHERE kind='privacy_dependency' ORDER BY job_id")).rows;}
async function snapshot(f){
 const result={};for(const table of ['library_users','library_tokens','app_attest_keys','app_auth_sessions','account_identities',
  'listening_v2.privacy_personas','listening_v2.outbox','listening_v2.rooms','listening_v2.output_guards','spotify_connections','spotify_outbox'])
  result[table]=(await f.store.db.query('SELECT to_jsonb(t) AS row FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows;
 return result;
}
async function pending(f,selector,state='pending'){
 const now=Number((await one(f.db,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms')).ms),id=randomUUID();
 await f.db.query(`INSERT INTO listening_v2.outbox(environment,job_id,job_key,kind,payload,created_at_ms,due_at_ms,retry_until_ms,state)
 VALUES('preview:other',$1,$2,'privacy_dependency',$3,$4,$4,$5,$6)`,[id,'privacy-dependency:'+id,
 {version:2,environment:'preview:other',selector,cursor:null,invalidatedAtMS:now},now,now+86400000,'pending']);
 if(state==='claimed')await f.db.query("UPDATE listening_v2.outbox SET state='claimed',claim_epoch=1,attempt_count=1,claim_nonce_hash=$2,claim_until_ms=$3 WHERE job_id=$1",[id,digest('claim'),now+30000]);
 // A dead job retains responsibility but must satisfy the real terminal stamp CHECK.
 if(state==='dead')await f.db.query("UPDATE listening_v2.outbox SET state='dead',attempt_count=10,completed_at_ms=$2,delete_after_ms=$3 WHERE job_id=$1",[id,now,now+86400000]);return id;
}
async function room(f,p,{nonempty=false}={}){
 const r=await row(f,p),id=randomUUID(),now=Number(r.created_at_ms);
 await f.db.query(`INSERT INTO listening_v2.rooms(environment,session_id,host_install_scope,host_persona_id,host_privacy_generation,
 privacy_persona_ids,provider,invite_digest,code_digest,state,occurrence_count,created_at_ms,expires_at_ms,updated_at_ms)
 VALUES($1,$2,$3,$4,$5,$6,'appleMusic',$7,$8,$9,$10,$11,$12,$11)`,[p.environment,id,digest('install'),p.id,r.privacy_generation,[p.id],
 digest('invite'+id),digest('code'+id),{occurrences:nonempty?[{unknown:'do not guess recording'}]:[],visits:[]},nonempty?1:0,now,now+3600000]);return id;
}

test('closed constructor is IO-free and rejects request flags, callbacks, clocks and proxies',()=>{
 let sql=0;const db={query(){sql++;throw Error('construction IO');},transaction(){sql++;throw Error('construction IO');}};
 for(const constructor of [o=>new AccountStore(db,{policy,...o}),o=>new AppAuthStore(db,{policy,...o}),o=>new SongLibraryStore(db,o)]){
  constructor({});constructor({sessionsPrivacy});
  for(const value of [true,null,{}, {coordinatorEnvironment:'test',permit:true}, {coordinatorEnvironment:'test',authorize:()=>true},
   {coordinatorEnvironment:'test',now:()=>0},new Proxy({},{ownKeys(){throw Error('proxy inspected');}})])
   assert.throws(()=>constructor({sessionsPrivacy:value}),{code:'sessions_privacy_unavailable'});
 }
 assert.equal(sql,0);assert.equal(createAuthPrivacyWriters(db,undefined),null);
});

test('actual off operations preserve schema-absent V1 without V2 relations or epoch queries',async t=>{
 const f=await fixture(t,{v2:false}),g=await guest(f);f.trace.length=0;
 const a=await signIn(f,g),signed=await credentialSession(f,a.credential,g.keyID,2);await signOut(f,signed);
 await new SongLibraryStore(f.db).createUser('reader-a','token-a');
 assert.equal(f.trace.some(x=>/listening_v2|sessions_privacy_epoch|controller_privacy_epoch/.test(x.sql??'')),false);
 assert.equal((await one(f.db,"SELECT to_regclass('listening_v2.privacy_personas') AS name")).name,null);
});

test('actual G/K1 to A transfers the whole exact live set across environments, closes C, never K2',async t=>{
 const f=await fixture(t),g=await guest(f),k2=await sibling(f,g),p=await persona(f,g),q=await persona(f,g,'preview:other'),s=await persona(f,k2);
 const a=await signIn(f,g);
 for(const ref of [p,q]){const value=await row(f,ref);assert.equal(value.controller_kind,'apple');assert.equal(value.controller_principal_id,a.userID);
  assert.equal(Number(value.privacy_generation),1);assert.equal(Number(value.private_transfer_from_generation),0);
  assert.equal(Number(value.controller_privacy_epoch),0);assert.equal(value.guest_credential_digest,null);
  decodePersonaTuple(JSON.stringify(shape(value)),{reserveFuture:true});}
 const siblingRow=await row(f,s);assert.equal(siblingRow.controller_kind,'guest');assert.equal(siblingRow.original_key_id,k2.keyID);
 assert.equal(Number(siblingRow.privacy_generation),0);assert.equal(siblingRow.controller_principal_id,g.user.id);
 assert.equal((await one(f.db,'SELECT revoked FROM library_tokens WHERE digest=$1',[g.user.credentialDigest])).revoked,true);
 await assert.rejects(f.auth.authenticate(k2.bearer),{code:'session_expired'});
 // Actual canonical token predicate, with the processor stopped. The actual
 // all-audience private readers remain Root-owned and are not faked here.
 assert.equal((await one(f.db,`SELECT NOT t.revoked AND NOT k.revoked AND NOT u.disabled AND k.user_id=p.original_principal_id
 AND t.user_id=p.original_principal_id AND t.expires_at>clock_timestamp() AS live FROM listening_v2.privacy_personas p
 JOIN library_tokens t ON t.digest=p.guest_credential_digest JOIN app_attest_keys k ON k.key_id=p.original_key_id
 JOIN library_users u ON u.id=p.original_principal_id WHERE p.environment=$1 AND p.persona_id=$2`,[s.environment,s.id])).live,false);
 const selectors=(await hints(f)).map(h=>h.payload.selector);assert(selectors.some(x=>x.kind==='credential'&&x.value===g.user.credentialDigest));
 assert(selectors.some(x=>x.kind==='guest-key'&&x.value===g.keyID));assert.equal(f.flush.length,1);
});

test('same-A and A-to-B retain A private ownership and the exact one-time bridge',async t=>{
 const f=await fixture(t),g=await guest(f),p=await persona(f,g),a=await signIn(f,g),before=await row(f,p);
 const a1=await credentialSession(f,a.credential,g.keyID,2),again=await signIn(f,a1);assert.equal(again.userID,a.userID);
 assert.deepEqual(await row(f,p),before);
 const a2=await credentialSession(f,again.credential,g.keyID,3);f.apple.subject='B';const b=await signIn(f,a2);
 assert.notEqual(b.userID,a.userID);assert.deepEqual(await row(f,p),before);
 assert.equal((await one(f.db,'SELECT user_id FROM app_attest_keys WHERE key_id=$1',[g.keyID])).user_id,b.userID);
});

for(const state of ['pending','claimed','dead'])for(const kind of ['credential','guest-key','guest-user','apple-controller'])
 test('actual transfer refuses global unfinished '+kind+' '+state+' responsibility',async t=>{
  const f=await fixture(t),target=await guest(f,5),a=await signIn(f,target),g=await guest(f),p=await persona(f,g);
  await pending(f,{kind,value:{credential:g.user.credentialDigest,'guest-key':g.keyID,'guest-user':g.user.id,'apple-controller':a.userID}[kind]},state);
  const before=await snapshot(f);await assert.rejects(signIn(f,g),{code:'sessions_privacy_deferred'});assert.deepEqual(await snapshot(f),before);
  assert.equal((await row(f,p)).controller_kind,'guest');
 });

test('whole transfer overflow refuses before changing any prefix or source authority',async t=>{
 const f=await fixture(t),g=await guest(f);for(let i=0;i<101;i++)await persona(f,g,'preview:p'+i);
 const before=await snapshot(f);await assert.rejects(signIn(f,g),{code:'sessions_privacy_deferred'});assert.deepEqual(await snapshot(f),before);
});

test('exact current retained C deadline drift refuses the whole live transfer',async t=>{
 const f=await fixture(t),g=await guest(f);await persona(f,g);
 await f.db.query("UPDATE library_tokens SET expires_at=expires_at+interval '1 millisecond' WHERE digest=$1",[g.user.credentialDigest]);
 const before=await snapshot(f);await assert.rejects(signIn(f,g),{code:'sessions_privacy_deferred'});assert.deepEqual(await snapshot(f),before);
});

for(const nonempty of [false,true])test('actual entry refuses unsupported touched room transition before closure, nonempty='+nonempty,async t=>{
 const f=await fixture(t),g=await guest(f),p=await persona(f,g);await room(f,p,{nonempty});const before=await snapshot(f);
 await assert.rejects(signIn(f,g),{code:'sessions_privacy_transition_unavailable'});assert.deepEqual(await snapshot(f),before);
 assert.equal(f.flush.length,0);
});

test('actual entry never guesses install/guard binding or releases uncertain safety truth',async t=>{
 const f=await fixture(t),g=await guest(f);await persona(f,g);
 await f.db.query(`INSERT INTO listening_v2.output_guards(environment,guard_id,provider,binding_key_version,account_binding,
 connection_lineage,output_scope,scope_kind,original_install_scope,created_at_ms,updated_at_ms,safety_capsule)
 VALUES('test',$1,'appleMusic',1,$2,$2,$2,'captured_output',$2,1,1,$3)`,[randomUUID(),digest('unmapped'),{retained:'unknown predecessor'}]);
 const before=await snapshot(f);await assert.rejects(signOut(f,g),{code:'sessions_privacy_transition_unavailable'});assert.deepEqual(await snapshot(f),before);
});

test('actual signOut closes C with global responsibility while Apple history survives',async t=>{
 const f=await fixture(t),g=await guest(f),p=await persona(f,g),a=await signIn(f,g),kept=await row(f,p);
 const signed=await credentialSession(f,a.credential,g.keyID,2);await signOut(f,signed);assert.deepEqual(await row(f,p),kept);
 assert((await hints(f)).some(h=>h.payload.selector.kind==='credential'&&h.payload.selector.value===signed.user.credentialDigest));
});

for(const operation of ['disable','key','delete'])test('actual '+operation+' derives owned source kinds and leaves B keys alone',async t=>{
 const f=await fixture(t),g=await guest(f),p=await persona(f,g),a=await signIn(f,g);
 const other=await guest(f,9),aOther=await signIn(f,other);assert.equal(aOther.userID,a.userID);
 const signed=await credentialSession(f,a.credential,g.keyID,2);f.apple.subject='B';const b=await signIn(f,signed);
 const retained=await row(f,p);f.apple.subject='A';
 if(operation==='disable')await disableUser(f.db,a.userID,{sessionsPrivacy,spotifyCleanupFn:async()=>{}});
 else if(operation==='key')await revokeKey(f.db,other.keyID,{sessionsPrivacy,spotifyCleanupFn:async()=>{}});
 else{const current=await credentialSession(f,aOther.credential,other.keyID,2),nonce=await f.accounts.challenge({purpose:'delete',bundleID},current.user);
  await f.accounts.delete(current.user,{...nonce,bundleID,identityToken:'external-crypto',authorizationCode:'external-crypto'},
   await f.accounts.prepareWriterAuthentication(current.bearer));}
 assert.equal((await one(f.db,'SELECT user_id FROM app_attest_keys WHERE key_id=$1',[g.keyID])).user_id,b.userID);
 assert.equal((await one(f.db,'SELECT revoked FROM app_attest_keys WHERE key_id=$1',[g.keyID])).revoked,false);
 assert.deepEqual(await row(f,p),retained);
 const selectors=(await hints(f)).map(h=>h.payload.selector);
 assert(selectors.some(x=>x.kind==='guest-key'&&x.value===other.keyID));
 if(operation!=='key')assert(selectors.some(x=>x.kind==='apple-controller'&&x.value===a.userID));
 else assert.equal(selectors.some(x=>x.kind==='apple-controller'),false);
});

test('actual guest disable emits guest-user, exact key and actual credential closures',async t=>{
 const f=await fixture(t),g=await guest(f);await persona(f,g,'preview:other');await disableUser(f.db,g.user.id,{sessionsPrivacy,spotifyCleanupFn:async()=>{}});
 const selectors=(await hints(f)).map(h=>h.payload.selector);
 for(const [kind,value] of [['credential',g.user.credentialDigest],['guest-key',g.keyID],['guest-user',g.user.id]])
  assert(selectors.some(s=>s.kind===kind&&s.value===value));
 assert.equal(selectors.some(s=>s.kind==='apple-controller'),false);
});

test('actual same-C session replacement and session-only revoke do not withdraw or touch broker',async t=>{
 const f=await fixture(t),g=await guest(f),p=await persona(f,g),before=await row(f,p);
 const spotify=new SpotifyStore(f.db),id=randomUUID();await spotify.create({id,epoch:randomUUID(),enrollmentID:randomUUID(),ownerID:g.user.id,
 keyID:g.keyID,credentialDigest:g.user.credentialDigest,status:'connected',consumers:{}});
 const broker=await spotify.read(id),renewed=await credentialSession(f,g.credential,g.keyID,2);
 await assert.rejects(f.auth.authenticate(g.bearer),{code:'session_expired'});assert.equal((await f.auth.authenticate(renewed.bearer)).id,g.user.id);
 await revokeSessions(f.db,g.user.id);assert.deepEqual(await row(f,p),before);assert.deepEqual(await spotify.read(id),broker);
 assert.equal((await hints(f)).length,0);
});

test('actual createUser refuses same-owner digest resurrection, preserves foreign-owner predicate and data flags',async t=>{
 const f=await fixture(t),g=await guest(f),p=await persona(f,g,'preview:other');await signOut(f,g);
 const store=new SongLibraryStore(f.db,{sessionsPrivacy}),before=await snapshot(f);
 await assert.rejects(store.createUser(g.user.id,g.credential),{code:'sessions_privacy_deferred'});assert.deepEqual(await snapshot(f),before);
 await assert.rejects(store.createUser('reader-b',g.credential),{code:'token_collision'});assert.deepEqual(await snapshot(f),before);
 assert.equal((await row(f,p)).status,'live');
});

test('actual createUser allows auth-only reuse after permanent withdrawal even with unfinished hint',async t=>{
 const f=await fixture(t),g=await guest(f),p=await persona(f,g);await signOut(f,g);
 const lifecycle=createPrivacyLifecycle({db:f.db,coordinatorEnvironment:'test'}),claim=await lifecycle.claimDependency();
 assert(claim);await lifecycle.processDependency(claim);assert.equal((await row(f,p)).status,'withdrawn');
 assert((await hints(f)).some(h=>h.state!=='published'));
 await new SongLibraryStore(f.db,{sessionsPrivacy}).createUser(g.user.id,g.credential);
 assert.equal((await one(f.db,'SELECT revoked FROM library_tokens WHERE digest=$1',[g.user.credentialDigest])).revoked,false);
 assert.equal((await row(f,p)).status,'withdrawn'); // Not a fresh-retention/admission assertion.
});

test('deleted target reenable refuses old live controller personas, then allows auth only after actual permanent withdrawal',async t=>{
 const f=await fixture(t),g=await guest(f),p=await persona(f,g),a=await signIn(f,g),signed=await credentialSession(f,a.credential,g.keyID,2);
 const nonce=await f.accounts.challenge({purpose:'delete',bundleID},signed.user);await f.accounts.delete(signed.user,{...nonce,bundleID,
 identityToken:'external-crypto',authorizationCode:'external-crypto'},await f.accounts.prepareWriterAuthentication(signed.bearer));
 const returning=await guest(f,9),before=await snapshot(f);await assert.rejects(signIn(f,returning),{code:'sessions_privacy_deferred'});
 assert.deepEqual(await snapshot(f),before);
 const lifecycle=createPrivacyLifecycle({db:f.db,coordinatorEnvironment:'test'});
 // Schedule the actual controller job first; no fake claim or withdrawn postimage.
 await f.db.query("UPDATE listening_v2.outbox SET due_at_ms=due_at_ms+60000 WHERE kind='privacy_dependency' AND payload->'selector'->>'kind'<>'apple-controller'");
 const claim=await lifecycle.claimDependency();assert(claim);await lifecycle.processDependency(claim);
 assert.equal((await row(f,p)).status,'withdrawn');assert.equal((await signIn(f,returning)).userID,a.userID);
 assert.equal((await row(f,p)).status,'withdrawn');
});

for(const faultAt of ['transfer','hint','C2'])test('actual signIn rolls all auth, persona and hints back after '+faultAt,async t=>{
 let armed=false;const f=await fixture(t,{after:async(_tx,sql)=>{if(armed&&(
  faultAt==='transfer'&&/UPDATE listening_v2\.privacy_personas/.test(sql)||
  faultAt==='hint'&&/INSERT INTO listening_v2\.outbox/.test(sql)||
  faultAt==='C2'&&/INSERT INTO library_tokens/.test(sql)))throw Error('injected '+faultAt);}});
 const g=await guest(f);await persona(f,g);const before=await snapshot(f);armed=true;
 await assert.rejects(signIn(f,g),/injected|sessions_privacy_unavailable/);armed=false;assert.deepEqual(await snapshot(f),before);assert.equal(f.flush.length,0);
});

test('configured account final auth deadline SQL is last before COMMIT and flush is after it',async t=>{
 const f=await fixture(t),g=await guest(f);await persona(f,g);f.trace.length=0;await signIn(f,g);
 const commit=f.trace.findLastIndex(x=>x.event==='COMMIT'),last=f.trace[commit-1];assert.match(last.sql,/source_live/);assert.match(last.sql,/target_live/);
 const mutations=f.trace.filter(x=>x.id===last.id&&x.sql);
 const firstConnection=mutations.findIndex(x=>/FROM spotify_connections/.test(x.sql)&&/FOR UPDATE/.test(x.sql));
 const personaLock=mutations.findIndex(x=>/FROM listening_v2\.privacy_personas/.test(x.sql)&&/FOR UPDATE/.test(x.sql));
 assert(firstConnection>=0&&personaLock>firstConnection);
 assert.equal(mutations.slice(personaLock+1).some(x=>/FOR (?:NO KEY )?UPDATE/.test(x.sql)&&/FROM (?:public\.)?(?:library_users|library_tokens|app_attest_keys|app_auth_sessions|spotify_connections)/.test(x.sql)),false);
 assert.equal(f.flush.length,1);
});

test('actual exact S replaced during Apple IO still refuses with another valid S and no privacy writes',async t=>{
 const f=await fixture(t),g=await guest(f);await persona(f,g);const authenticate=f.apple.authenticate;
 f.apple.authenticate=async()=>{await credentialSession(f,g.credential,g.keyID,2);return authenticate();};
 const beforePersonas=(await f.db.query('SELECT * FROM listening_v2.privacy_personas')).rows;
 await assert.rejects(signIn(f,g),{code:'app_access_revoked'});assert.deepEqual((await f.db.query('SELECT * FROM listening_v2.privacy_personas')).rows,beforePersonas);
 assert.equal((await hints(f)).length,0);
});

test('actual deadline/C2 corruption after lifecycle persistence rolls back and never flushes',async t=>{
 let armed=false;const f=await fixture(t,{after:async(tx,sql,args)=>{
  if(armed&&/INSERT INTO library_tokens/.test(sql)){armed=false;await tx.query('UPDATE library_tokens SET expires_at=clock_timestamp() WHERE digest=$1',[args[0]]);}
 }});const g=await guest(f);await persona(f,g);const before=await snapshot(f);armed=true;
 await assert.rejects(signIn(f,g),{code:'app_access_revoked'});assert.deepEqual(await snapshot(f),before);assert.equal(f.flush.length,0);
});

test('actual AccountStore transfer and closure run with exact 030/031/033 account grants',async t=>{
 const f=await fixture(t,{roles:true}),g=await guest(f),p=await persona(f,g);
 await f.db.query('SET ROLE lyra_account_v1');
 let a;try{a=await signIn(f,g);
  await assert.rejects(f.db.query("INSERT INTO listening_v2.semantic_events(environment) VALUES('test')"),e=>e.code==='42501');
  await assert.rejects(f.db.query('DELETE FROM listening_v2.output_guards'),e=>e.code==='42501');
 }finally{await f.db.query('RESET ROLE');}
 assert.equal((await row(f,p)).controller_principal_id,a.userID);
 assert((await hints(f)).some(h=>h.payload.selector.kind==='credential'));
});

// ACR1-01: real SQL with exact fractional C and the canonical floored persona
// cutoff. Clock-substituted cases are deterministic statement discriminators,
// not a claim of placing a real sub-millisecond wall-clock race.
async function fractionalCutoff(f,g){
 await f.db.query("UPDATE library_tokens SET expires_at=date_trunc('milliseconds',clock_timestamp()+interval '30 seconds')+interval '900 microseconds' WHERE digest=$1",[g.user.credentialDigest]);
 const times=await one(f.db,`SELECT floor(extract(epoch FROM expires_at)*1000)::text AS cutoff_ms,
 (expires_at-interval '900 microseconds')::text AS cutoff,
 (expires_at-interval '450 microseconds')::text AS within,
 (expires_at-interval '1900 microseconds')::text AS before
 FROM library_tokens WHERE digest=$1`,[g.user.credentialDigest]);
 await persona(f,g);return times;
}
test('ACR1-01 actual transfer carries retained cutoff into the last auth SQL',async t=>{
 const f=await fixture(t),g=await guest(f),at=await fractionalCutoff(f,g);await signIn(f,g);
 const commit=f.trace.findLastIndex(x=>x.event==='COMMIT'),last=f.trace[commit-1];
 assert.match(last.sql,/source_live/);assert.match(last.sql,/privacy_live/);
 assert.equal(last.args[3],Number(at.cutoff_ms));assert.equal(last.args.length,4);
});
test('ACR1-01 same last SQL refuses privacy cutoff while exact C remains live',async t=>{
 let captured;const finalClock={at:null};
 const f=await fixture(t,{finalClock,after:async(_tx,sql,_args,result)=>{if(sql.includes('WITH auth_clock AS MATERIALIZED'))captured=result.rows[0];}});
 const g=await guest(f),at=await fractionalCutoff(f,g),before=await snapshot(f);finalClock.at=at.within;
 await assert.rejects(signIn(f,g),{code:'app_access_revoked'});
 assert.equal(captured.source_live,true);assert.equal(captured.target_live,true);assert.equal(captured.privacy_live,false);
 assert.deepEqual(await snapshot(f),before);assert.equal(f.flush.length,0);
});
test('ACR1-01 sampled pre-cutoff transfer remains live',async t=>{
 let captured;const finalClock={at:null};
 const f=await fixture(t,{finalClock,after:async(_tx,sql,_args,result)=>{if(sql.includes('WITH auth_clock AS MATERIALIZED'))captured=result.rows[0];}});
 const g=await guest(f),at=await fractionalCutoff(f,g);finalClock.at=at.before;await signIn(f,g);
 assert.equal(captured.source_live,true);assert.equal(captured.target_live,true);assert.equal(captured.privacy_live,true);
 assert.equal(f.flush.length,1);
});
