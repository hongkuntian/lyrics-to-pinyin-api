import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import * as contexts from '../../api/utils/listening-v2/auth-context.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {SongLibraryStore} from '../../api/utils/song-library/store.js';
import {migrationNames} from '../../scripts/library-migrations.js';
import {SessionV2Error} from '../../api/utils/listening-v2/errors.js';

// Authored for Root, not executed by the postimage worker. One PGlite client:
// real SQL/rollback/clock, no PostgreSQL contention or actual erase claim.
const hash=x=>createHash('sha256').update(x).digest('hex');
const environment='preview:writer-auth-r1';
const policy={audience:'writer-tests',environment:'development',prefix:'ABCDEFGHIJ',bundles:['com.lyrica.app']};
const bundleID=policy.bundles[0],keyID=Buffer.alloc(32,1).toString('base64');
const sibling=Buffer.alloc(32,2).toString('base64'),foreign=Buffer.alloc(32,3).toString('base64');
let db,adapter,auth,source,bearer,trace,intercept;
before(async()=>{
 db=new PGlite();
 assert.equal(migrationNames.length,30);
 assert.ok(migrationNames.every(n=>!/^03[01]-/.test(n)));
 for(const name of migrationNames)await db.exec(await readFile(new URL('../../db/'+name,import.meta.url),'utf8'));
 adapter={query:(...a)=>db.query(...a),transaction:fn=>db.transaction(fn)};
});
after(()=>db.close());
beforeEach(async()=>{
 await db.exec('TRUNCATE public.library_users CASCADE');
 const library=new SongLibraryStore(adapter);
 await library.createUser('G','source-token');await library.createUser('A','target-token');await library.createUser('B','foreign-token');
 await db.query("UPDATE public.library_users SET access_kind=CASE WHEN id='G' THEN 'guest' ELSE 'apple' END");
 await db.query("UPDATE public.library_tokens SET expires_at=clock_timestamp()+interval '90 days' WHERE user_id='G'");
 auth=new AppAuthStore(adapter,{policy,attestFn:()=>({publicKey:'external-crypto-fixture',receipt:Buffer.from('receipt')}),
  assertionFn:({assertion})=>Number(assertion.toString())});
 bearer=await enroll('source-token',keyID);await enroll('source-token',sibling);await enroll('foreign-token',foreign);
 source=await auth.authenticate(bearer);trace=[];intercept=undefined;
});
async function enroll(token,key){
 const {challenge}=await auth.challenge(token,{keyID:key,bundleID,purpose:'register'});
 await auth.register(token,{keyID:key,bundleID,challenge,attestation:'Zml4dHVyZQ=='});
 return mint(token,key,1);
}
async function mint(token,key,counter){
 const {challenge}=await auth.challenge(token,{keyID:key,bundleID,purpose:'session'});
 return (await auth.session(token,{keyID:key,bundleID,challenge,assertion:Buffer.from(String(counter)).toString('base64')})).token;
}
function factory(){
 assert.equal(typeof contexts.createWriterAuthContext,'function','Root negative control: factory absent on exact b88');
 return contexts.createWriterAuthContext({authStore:auth,environment});
}
const operation=(kind='signOut',targetPrincipalID='A')=>kind==='signIn'?
 {kind,targetPrincipalID,targetCredentialDigest:hash(randomUUID())}:{kind};
function connection(tx){return {query:async(sql,args=[])=>{
 trace.push({sql,args:structuredClone(args)});
 if(intercept)await intercept(sql,args,tx);
 return tx.query(sql,args);
}};}
async function locked(c,a,op,fn,requiredScopes){
 return db.transaction(async real=>{
  const tx=connection(real),discovery=await c.discover({tx,authentication:a,operationRawJSON:JSON.stringify(op),requiredScopes});
  const scope=await c.lock({tx,discovery});return fn(scope,tx,real,discovery);
 });
}
async function changed(kind,tx,op){
 if(kind==='signIn'){
  await tx.query('UPDATE public.app_attest_keys SET user_id=$2 WHERE key_id=$1',[keyID,op.targetPrincipalID]);
  await tx.query('UPDATE public.library_tokens SET revoked=true WHERE digest=$1',[source.credentialDigest]);
  await tx.query('DELETE FROM public.app_auth_sessions WHERE key_id=$1',[keyID]);
  await tx.query("INSERT INTO public.library_tokens(digest,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '365 days')",[op.targetCredentialDigest,op.targetPrincipalID]);
 }else if(kind==='signOut')await tx.query('UPDATE public.library_tokens SET revoked=true WHERE digest=$1',[source.credentialDigest]);
 else {
  await tx.query('UPDATE public.library_users SET disabled=true WHERE id=$1',[source.id]);
  await tx.query('UPDATE public.library_tokens SET revoked=true WHERE user_id=$1',[source.id]);
  await tx.query("UPDATE public.app_attest_keys SET revoked=true,public_key='',receipt=''::bytea WHERE user_id=$1",[source.id]);
  await tx.query('DELETE FROM public.app_auth_sessions WHERE key_id IN (SELECT key_id FROM public.app_attest_keys WHERE user_id=$1)',[source.id]);
 }
}
async function snapshot(tx=db){return (await tx.query(`SELECT
 (SELECT jsonb_agg(to_jsonb(u) ORDER BY id COLLATE "C") FROM public.library_users u) AS users,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY digest COLLATE "C") FROM public.library_tokens t) AS tokens,
 (SELECT jsonb_agg(to_jsonb(k) ORDER BY key_id COLLATE "C") FROM public.app_attest_keys k) AS keys,
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY digest COLLATE "C") FROM public.app_auth_sessions s) AS sessions`)).rows;}
const reject=(p,code='unauthorized')=>assert.rejects(p,e=>{
 assert.ok(e instanceof SessionV2Error);assert.equal(e.code,code);assert.equal(e.message,code);
 assert.doesNotMatch(JSON.stringify(e),new RegExp(bearer+'|'+hash(bearer)+'|external-crypto-fixture'));return true;
});
const locks=()=>trace.filter(r=>/FOR (?:NO KEY )?UPDATE/.test(r.sql));

for(const kind of ['signIn','signOut','delete'])test(kind+' checks actual live preimage, intentional postimage and single consumption',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation(kind),before=await snapshot();
 assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.evidence));
 assert.doesNotMatch(JSON.stringify(a),new RegExp(bearer+'|'+hash(bearer)+'|'+source.credentialDigest));
 await locked(c,a,op,async(scope,tx)=>{
  assert.equal(await scope.revalidate({tx}),true);assert.equal(await scope.assertFreshSession({tx,maxAgeMS:120000}),true);
  await changed(kind,tx,op);
  const n=locks().length;assert.equal(await scope.verifyPostimage({tx}),true);
  assert.match(trace.at(-1).sql,/clock_timestamp\(\)/);assert.doesNotMatch(trace.at(-1).sql,/\bnow\(\)/);
  assert.equal(locks().length,n);
  await reject(scope.verifyPostimage({tx}),'unavailable');await reject(scope.revalidate({tx}),'unavailable');
 });
 assert.notDeepEqual(await snapshot(),before);await assert.rejects(auth.authenticate(bearer),{code:'session_expired'});
 // Foreign B and its session still authenticate; no cross-owner closure.
 assert.equal((await db.query('SELECT disabled FROM public.library_users WHERE id=\'B\'')).rows[0].disabled,false);
 assert.equal((await db.query('SELECT revoked FROM public.app_attest_keys WHERE key_id=$1',[foreign])).rows[0].revoked,false);
});

for(const kind of ['signIn','signOut','delete'])for(const phase of ['before-lock','before-intent','after-intent'])
 test(kind+' exact source deadline crosses real clock '+phase+'; entire transaction rolls back',async()=>{
  const c=factory(),a=await c.prepare(bearer),op=operation(kind),before=await snapshot();
  await reject(db.transaction(async real=>{
   // Fixture shrinks a real stored deadline before discovery; no injected clock.
   await real.query("UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE digest=$1",[hash(bearer)]);
   const tx=connection(real),discovery=await c.discover({tx,authentication:a,operationRawJSON:JSON.stringify(op)});
   if(phase==='before-lock')await setTimeout(350);
   const scope=await c.lock({tx,discovery});
   if(phase==='before-intent')await setTimeout(350);
   await scope.revalidate({tx});await changed(kind,tx,op);
   if(phase==='after-intent')await setTimeout(350);
   await scope.verifyPostimage({tx});
  }));
  assert.deepEqual(await snapshot(),before);
 });
for(const kind of ['signIn','signOut','delete'])test(kind+' captured credential deadline survives deliberate revocation and cannot be extended',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation(kind),before=await snapshot();
 await reject(db.transaction(async real=>{
  await real.query("UPDATE public.library_tokens SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE digest=$1",[source.credentialDigest]);
  const tx=connection(real),d=await c.discover({tx,authentication:a,operationRawJSON:JSON.stringify(op)}),s=await c.lock({tx,discovery:d});
  await s.revalidate({tx});await changed(kind,tx,op);await setTimeout(350);await s.verifyPostimage({tx});
 }));assert.deepEqual(await snapshot(),before);
});
for(const kind of ['signIn','signOut','delete'])test(kind+' nullable existing credential expiry remains valid',async()=>{
 await db.query('UPDATE public.library_tokens SET expires_at=NULL WHERE digest=$1',[source.credentialDigest]);
 const c=factory(),a=await c.prepare(bearer),op=operation(kind);
 await locked(c,a,op,async(s,tx)=>{await s.revalidate({tx});await changed(kind,tx,op);assert.equal(await s.verifyPostimage({tx}),true);});
});

for(const kind of ['signIn','signOut','delete'])test(kind+' missing intentional postimage is refused and cannot be retried',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation(kind),before=await snapshot();
 await reject(locked(c,a,op,async(s,tx)=>{
  try{await s.verifyPostimage({tx});}catch(e){await reject(s.verifyPostimage({tx}),'unavailable');await reject(s.revalidate({tx}),'unavailable');throw e;}
 }),'conflict');assert.deepEqual(await snapshot(),before);
});
for(const [kind,label,sql,args] of [
 ['signOut','removed source session','DELETE FROM public.app_auth_sessions WHERE digest=$1',()=>[hash(bearer)]],
 ['signOut','moved source key','UPDATE public.app_attest_keys SET user_id=\'B\' WHERE key_id=$1',()=>[keyID]],
 ['signOut','disabled source','UPDATE public.library_users SET disabled=true WHERE id=\'G\'',()=>[]],
 ['signIn','wrong target key owner','UPDATE public.app_attest_keys SET user_id=\'B\' WHERE key_id=$1',()=>[keyID]],
 ['signIn','revoked new token','UPDATE public.library_tokens SET revoked=true WHERE digest=$1',op=>[op.targetCredentialDigest]],
 ['signIn','extra old-key session',"INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES($1,$2,$3,'writer-tests',clock_timestamp()+interval '5 minutes')",()=>[hash('unplanned-session'),keyID,source.credentialDigest]],
 ['signIn','new token wrong owner','UPDATE public.library_tokens SET user_id=\'B\' WHERE digest=$1',op=>[op.targetCredentialDigest]],
 ['delete','unscrubbed key public material',"UPDATE public.app_attest_keys SET public_key='retained' WHERE key_id=$1",()=>[sibling]],
 ['delete','extra source token',"INSERT INTO public.library_tokens(digest,user_id) VALUES($1,'G')",()=>[hash('unplanned-token')]],
 ['delete','key escaped to B',"UPDATE public.app_attest_keys SET user_id='B' WHERE key_id=$1",()=>[sibling]],
 ['delete','source token still live','UPDATE public.library_tokens SET revoked=false WHERE digest=$1',()=>[source.credentialDigest]]
])test(kind+' refuses '+label+' postimage with rollback',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation(kind),before=await snapshot();
 await reject(locked(c,a,op,async(s,tx)=>{await changed(kind,tx,op);await tx.query(sql,args(op));await s.verifyPostimage({tx});}),'conflict');
 assert.deepEqual(await snapshot(),before);
});

test('source S replacement during external IO is not rescued by another live session for K',async()=>{
 const c=factory(),a=await c.prepare(bearer),next=await mint('source-token',keyID,2);
 assert.equal((await auth.authenticate(next)).id,'G');
 await reject(locked(c,a,operation(),()=>assert.fail('old S admitted')));
 assert.equal(locks().length,0);
});
test('S removed between discovery/lock while a valid sibling survives refuses',async()=>{
 const c=factory(),a=await c.prepare(bearer);
 await reject(db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,operationRawJSON:'{"kind":"signOut"}'});
  await real.query('DELETE FROM public.app_auth_sessions WHERE digest=$1',[hash(bearer)]);
  await c.lock({tx,discovery:d});
 }),'conflict');
});

test('complete sorted user/token/key/session union, source allKeys and reader lock mode',async()=>{
 const extra=hash('source-extra-token');await db.query("INSERT INTO public.library_tokens(digest,user_id) VALUES($1,'G')",[extra]);
 const unicode=['u-\ue000','u-🎵','u-测试'];for(const id of unicode)await db.query('INSERT INTO public.library_users(id) VALUES($1)',[id]);
 const c=factory(),a=await c.prepare(bearer);
 const expectedS=(await db.query('SELECT digest FROM public.app_auth_sessions ORDER BY digest COLLATE "C"')).rows.map(r=>r.digest);
 await locked(c,a,operation('delete'),async(s,tx)=>{await s.revalidate({tx});},
  {userIDs:unicode,credentialDigests:[hash('foreign-token')],keyIDs:[foreign]});
 const order=x=>[...x].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
 const l=locks();
 assert.deepEqual(l.map(r=>[r.sql.match(/FROM public\.(\w+)/)[1],r.args[0]]),[
  ...order(['B','G',...unicode]).map(x=>['library_users',x]),
  ...order([extra,source.credentialDigest,hash('foreign-token')]).map(x=>['library_tokens',x]),
  ...order([keyID,sibling,foreign]).map(x=>['app_attest_keys',x]),...expectedS.map(x=>['app_auth_sessions',x])]);
 assert.ok(l.filter(r=>/library_users/.test(r.sql)).every(r=>/FOR NO KEY UPDATE/.test(r.sql)));
 trace=[];const reader=contexts.createCurrentAuthContext({authStore:auth,environment}),ra=await reader.prepare(bearer);
 await db.transaction(async real=>{const tx=connection(real),d=await reader.discover({tx,authentication:ra});await reader.lock({tx,discovery:d});});
 assert.ok(locks().filter(r=>/library_users/.test(r.sql)).every(r=>/FOR UPDATE/.test(r.sql)&&!/NO KEY/.test(r.sql)));
});

test('signOut discovers every source key although its credential narrows Spotify connections',async()=>{
 const c=factory(),a=await c.prepare(bearer);
 await locked(c,a,operation(),async(s,tx)=>{await changed('signOut',tx);await s.verifyPostimage({tx});});
 assert.deepEqual(locks().filter(r=>/app_attest_keys/.test(r.sql)).map(r=>r.args[0]),[keyID,sibling].sort());
});
for(const [kind,label,statement,params] of [
 ['signIn','key owner drift',"UPDATE public.app_attest_keys SET user_id='B' WHERE key_id=$1",[keyID]],
 ['signIn','token owner drift',"UPDATE public.library_tokens SET user_id='B' WHERE digest=$1",[hash('source-token')]],
 ['signOut','extra source key',"INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt) VALUES($1,'G','writer-tests','com.lyrica.app','development','fixture','fixture')",[Buffer.alloc(32,9).toString('base64')]],
 ['delete','extra source key',"INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt) VALUES($1,'G','writer-tests','com.lyrica.app','development','fixture','fixture')",[Buffer.alloc(32,9).toString('base64')]],
 ['signIn','target changed kind',"UPDATE public.library_users SET access_kind='guest' WHERE id='A'",[]]
])test(kind+' '+label+' after discovery aborts without appending B lock',async()=>{
 const c=factory(),a=await c.prepare(bearer),before=await snapshot();
 await reject(db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,operationRawJSON:JSON.stringify(operation(kind))});
  await real.query(statement,params);await c.lock({tx,discovery:d});
 }),'conflict');
 assert.ok(locks().filter(r=>/library_users/.test(r.sql)).every(r=>r.args[0]!=='B'));
 if(label==='extra source key')assert.equal(locks().filter(r=>!/library_users/.test(r.sql)).length,0);
 assert.deepEqual(await snapshot(),before);
});

test('signIn unrelated sibling insertion after discovery preserves exact-K union and commits intended postimage',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation('signIn');
 const added=Buffer.alloc(32,9).toString('base64'),addedSession=hash('added-sibling-session');
 const unrelated=[sibling,added];let before;
 const siblingRows=async tx=>(await tx.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(k) ORDER BY key_id COLLATE "C") FROM public.app_attest_keys k WHERE key_id=ANY($1::text[])) AS keys,
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY digest COLLATE "C") FROM public.app_auth_sessions s WHERE key_id=ANY($1::text[])) AS sessions`,[unrelated])).rows;
 await db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,operationRawJSON:JSON.stringify(op)});
  // Representative unrelated registration/session rows, inserted after discovery.
  // Source authentication still comes from actual AppAuth prepare, not a stub.
  await real.query("INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt) VALUES($1,'G','writer-tests','com.lyrica.app','development','fixture','fixture')",[added]);
  await real.query("INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES($1,$2,$3,'writer-tests',clock_timestamp()+interval '15 minutes')",[addedSession,added,source.credentialDigest]);
  before=await siblingRows(real);
  const s=await c.lock({tx,discovery:d});
  assert.deepEqual(locks().filter(r=>/library_users/.test(r.sql)).map(r=>r.args[0]),['A','G']);
  assert.deepEqual(locks().filter(r=>/library_tokens/.test(r.sql)).map(r=>r.args[0]),[source.credentialDigest]);
  assert.deepEqual(locks().filter(r=>/app_attest_keys/.test(r.sql)).map(r=>r.args[0]),[keyID]);
  assert.deepEqual(locks().filter(r=>/app_auth_sessions/.test(r.sql)).map(r=>r.args[0]),[hash(bearer)]);
  assert.equal(await s.revalidate({tx}),true);await changed('signIn',tx,op);
  assert.equal(await s.verifyPostimage({tx}),true);
  assert.match(trace.at(-1).sql,/clock_timestamp\(\)/);
  // No further SQL/IO before this callback returns to COMMIT.
 });
 assert.deepEqual(await siblingRows(db),before);
 assert.equal((await db.query('SELECT user_id FROM public.app_attest_keys WHERE key_id=$1',[keyID])).rows[0].user_id,'A');
 assert.equal((await db.query('SELECT revoked FROM public.library_tokens WHERE digest=$1',[source.credentialDigest])).rows[0].revoked,true);
 assert.equal((await db.query('SELECT digest FROM public.app_auth_sessions WHERE key_id=$1',[keyID])).rows.length,0);
 assert.deepEqual((await db.query('SELECT user_id,revoked,isfinite(expires_at) AND expires_at>clock_timestamp() AS live FROM public.library_tokens WHERE digest=$1',[op.targetCredentialDigest])).rows,[{user_id:'A',revoked:false,live:true}]);
});

test('new credential negative preimage collision at discovery and after discovery refuses',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation('signIn');op.targetCredentialDigest=hash('foreign-token');
 await reject(locked(c,a,op,()=>assert.fail()),'conflict');assert.equal(locks().length,0);
 const fresh=operation('signIn');
 await reject(db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,operationRawJSON:JSON.stringify(fresh)});
  await real.query("INSERT INTO public.library_tokens(digest,user_id) VALUES($1,'B')",[fresh.targetCredentialDigest]);
  await c.lock({tx,discovery:d});
 }),'conflict');
 assert.ok(locks().every(r=>r.args[0]!=='B'));
});

test('operation is closed raw JSON; scope arrays copied synchronously before first await',async()=>{
 const c=factory(),a=await c.prepare(bearer);
 for(const raw of [{kind:'signOut'},'', '[]','null','{"kind":"delete","ok":true}',
  '{"kind":"signIn","targetPrincipalID":"A"}', '{"kind":"signOut","kind":"delete"}', ' '.repeat(2049),
  '{"kind":"signIn","targetPrincipalID":"B","targetCredentialDigest":"bad"}'])
  await reject(db.transaction(tx=>c.discover({tx:connection(tx),authentication:a,operationRawJSON:raw})),'invalid_request');
 const op=operation('signIn'),options={userIDs:['A']},expected=op.targetCredentialDigest;
 await db.transaction(async real=>{
  const tx=connection(real);let changedInputs=false;
  intercept=async()=>{if(!changedInputs){changedInputs=true;op.targetPrincipalID='B';op.targetCredentialDigest=hash('foreign-token');options.userIDs[0]='B';}};
  const d=await c.discover({tx,authentication:{...a},operationRawJSON:JSON.stringify(op),requiredScopes:options});intercept=undefined;
  const s=await c.lock({tx,discovery:d});
  await changed('signIn',tx,{kind:'signIn',targetPrincipalID:'A',targetCredentialDigest:expected});
  assert.equal(await s.verifyPostimage({tx}),true);
 });
 assert.ok(locks().every(r=>r.args[0]!=='B'));
});

test('wrong factory/forged auth and opaque plan never fabricate positive authority',async()=>{
 const c=factory(),a=await c.prepare(bearer);
 for(const authentication of [{...a,principalID:'B'},{...a,evidence:{}},{...a,sessionDigest:hash(bearer)}])
  await reject(db.transaction(tx=>c.discover({tx:connection(tx),authentication,operationRawJSON:'{"kind":"delete"}'})));
 await reject(db.transaction(tx=>factory().discover({tx:connection(tx),authentication:a,operationRawJSON:'{"kind":"delete"}'})));
 assert.equal(trace.length,0);
});
test('plan/scope tied to exact connection/xid, one pass, postfailure cannot be reused',async()=>{
 const c=factory(),a=await c.prepare(bearer);let current,old,plan;
 const pooled={query:(...args)=>current.query(...args)};
 await db.transaction(async real=>{
  current=real;plan=await c.discover({tx:pooled,authentication:a,operationRawJSON:'{"kind":"signOut"}'});
  await reject(c.lock({tx:connection(real),discovery:plan}),'unavailable');
  old=await c.lock({tx:pooled,discovery:plan});await reject(c.lock({tx:pooled,discovery:plan}),'unavailable');
  await reject(c.discover({tx:pooled,authentication:a,operationRawJSON:'{"kind":"signOut"}'}),'unavailable');
 });
 await db.transaction(async real=>{current=real;await reject(old.revalidate({tx:pooled}),'unavailable');await reject(old.verifyPostimage({tx:pooled}),'unavailable');});
 await reject(c.discover({tx:db,authentication:a,operationRawJSON:'{"kind":"signOut"}'}),'unavailable');
});
// The first three cases discriminate WA-R1-02; verifyPostimage is a retained
// consumption control expected to refuse reuse even on frozen R1.
for(const [normal,method] of [[false,'revalidate'],[false,'assertFreshSession'],[true,'assertFreshSession'],[false,'verifyPostimage']])
 test((normal?'reader':'writer')+' '+method+' wrong-client failure invalidates scope before SQL',async()=>{
  const c=normal?contexts.createCurrentAuthContext({authStore:auth,environment}):factory(),a=await c.prepare(bearer),before=await snapshot();
  await db.transaction(async real=>{
   const tx=connection(real),other=connection(real);
   assert.notEqual(other,tx); // Same real transaction, different caller facade.
   const d=await c.discover({tx,authentication:a,...(normal?{}:{operationRawJSON:'{"kind":"signOut"}'})}),s=await c.lock({tx,discovery:d});
   const invoke=(name,client)=>s[name]({tx:client,maxAgeMS:120000}),n=trace.length;
   await reject(invoke(method,other),'unavailable');
   assert.equal(trace.length,n,'wrong-client refusal must occur before SQL');
   const methods=normal?['assertFreshSession','revalidate']:['revalidate','assertFreshSession','verifyPostimage'];
   for(const next of [method,...methods.filter(name=>name!==method)]){
    await reject(invoke(next,tx),'unavailable');
    assert.equal(trace.length,n,'failed scope must refuse original client without further SQL');
   }
  });
  assert.deepEqual(await snapshot(),before);
 });

for(const field of ['userIDs','keyIDs','credentialDigests'])test(field+' input cap cannot be expanded or trimmed',async()=>{
 const c=factory(),a=await c.prepare(bearer),v=field==='userIDs'?'A':field==='keyIDs'?foreign:hash('foreign-token');
 await reject(locked(c,a,operation(),()=>assert.fail(),{[field]:Array(65).fill(v)}),'unavailable');assert.equal(locks().length,0);
});
for(const relation of ['keys','tokens','sessions'])test('derived '+relation+' union overflow refuses before lock without prefix acceptance',async()=>{
 const c=factory(),a=await c.prepare(bearer);
 for(let i=0;i<65;i++){
  if(relation==='keys')await db.query("INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt) VALUES($1,'G','writer-tests','com.lyrica.app','development','fixture','fixture')",[Buffer.alloc(32,i+20).toString('base64')]);
  if(relation==='tokens')await db.query("INSERT INTO public.library_tokens(digest,user_id) VALUES($1,'G')",[hash('overflow-'+i)]);
  if(relation==='sessions')await db.query("INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES($1,$2,$3,'writer-tests',clock_timestamp()+interval '5 minutes')",[hash('overflow-'+i),sibling,source.credentialDigest]);
 }
 await reject(locked(c,a,operation('delete'),()=>assert.fail()),'unavailable');assert.equal(locks().length,0);
});

for(const normal of [false,true])test((normal?'reader':'writer')+' exact freshness uses real DB time, age 121s remains normally valid but expires freshness',async()=>{
 const c=normal?contexts.createCurrentAuthContext({authStore:auth,environment}):factory(),a=await c.prepare(bearer);
 await db.query("UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()+interval '779 seconds' WHERE digest=$1",[hash(bearer)]);
 assert.equal((await auth.authenticate(bearer)).id,'G');const before=await snapshot();
 await reject(db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,...(normal?{}:{operationRawJSON:'{"kind":"signOut"}'})}),s=await c.lock({tx,discovery:d});
  assert.equal(await s.revalidate({tx}),true);await s.assertFreshSession({tx,maxAgeMS:120000});
 }),'expired');assert.deepEqual(await snapshot(),before);
});
for(const normal of [false,true])test((normal?'reader':'writer')+' freshness rejects unsafe bounds/future issuance and does not acquire locks',async()=>{
 const c=normal?contexts.createCurrentAuthContext({authStore:auth,environment}):factory(),a=await c.prepare(bearer);
 await db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,...(normal?{}:{operationRawJSON:'{"kind":"signOut"}'})}),s=await c.lock({tx,discovery:d});
  const n=locks().length;assert.equal(await s.assertFreshSession({tx,maxAgeMS:120000}),true);assert.equal(locks().length,n);
 });
 for(const maxAgeMS of [-1,900001,0.5,'120000',NaN,Infinity,undefined])await reject(db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,...(normal?{}:{operationRawJSON:'{"kind":"signOut"}'})}),s=await c.lock({tx,discovery:d});
  await s.assertFreshSession({tx,maxAgeMS});
 }),'invalid_request');
 await db.query("UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()+interval '16 minutes' WHERE digest=$1",[hash(bearer)]);
 await reject(db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,...(normal?{}:{operationRawJSON:'{"kind":"signOut"}'})}),s=await c.lock({tx,discovery:d});
  await s.assertFreshSession({tx,maxAgeMS:120000});
 }),'expired');
});
test('freshness refuses replaced source S even with live same-K replacement and rolls back mutation',async()=>{
 const c=factory(),a=await c.prepare(bearer),before=await snapshot();
 await reject(locked(c,a,operation(),async(s,tx)=>{
  await tx.query('DELETE FROM public.app_auth_sessions WHERE digest=$1',[hash(bearer)]);
  await tx.query("INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES($1,$2,$3,'writer-tests',clock_timestamp()+interval '15 minutes')",[hash('replacement'),keyID,source.credentialDigest]);
  await s.assertFreshSession({tx,maxAgeMS:120000});
 }));assert.deepEqual(await snapshot(),before);
});
test('submillisecond deadline edit cannot masquerade as same locked deadline',async()=>{
 const c=factory(),a=await c.prepare(bearer);
 await reject(locked(c,a,operation(),async(s,tx)=>{
  await tx.query("UPDATE public.app_auth_sessions SET expires_at=expires_at+interval '1 microsecond' WHERE digest=$1",[hash(bearer)]);
  await s.revalidate({tx});
 }),'unauthorized');
});
test('supplemental exact age predicate vectors preserve microseconds; no actual erase/clock injection claim',async()=>{
 // Pure database predicate vectors supplement default-clock integration above.
 // This does not run the production method at a chosen clock or prove erase.
 const rows=(await db.query(`WITH vectors(age,ok) AS (VALUES
 (interval '119.999999 seconds',true),(interval '120 seconds',true),(interval '120.000001 seconds',false),
 (interval '-0.000001 seconds',false),(interval '121 seconds',false))
 SELECT ok,(TIMESTAMPTZ '2030-01-01 00:00:00.123456+00' >= TIMESTAMPTZ '2030-01-01 00:00:00.123456+00'-age
 AND TIMESTAMPTZ '2030-01-01 00:00:00.123456+00' <= TIMESTAMPTZ '2030-01-01 00:00:00.123456+00'-age+120000*interval '1 millisecond') AS actual FROM vectors`)).rows;
 assert.ok(rows.every(r=>r.ok===r.actual));
});

for(const kind of ['signIn','signOut','delete'])for(const [name,change,args] of [
 ['disabled user',"UPDATE public.library_users SET disabled=true WHERE id='G'",()=>[]],
 ['revoked C','UPDATE public.library_tokens SET revoked=true WHERE digest=$1',()=>[source.credentialDigest]],
 ['revoked K','UPDATE public.app_attest_keys SET revoked=true WHERE key_id=$1',()=>[keyID]],
 ['revoked S','UPDATE public.app_auth_sessions SET revoked=true WHERE digest=$1',()=>[hash(bearer)]],
 ['wrong audience',"UPDATE public.app_auth_sessions SET audience='wrong' WHERE digest=$1",()=>[hash(bearer)]]
])test(kind+' rejects '+name+' after actual prepare and before allocating locks',async()=>{
 const c=factory(),a=await c.prepare(bearer);await db.query(change,args());
 await reject(locked(c,a,operation(kind),()=>assert.fail('unauthorized preimage reached consumer')));assert.equal(locks().length,0);
});
for(const kind of ['signIn','signOut','delete'])test(kind+' preintent revalidate refuses intentional auth mutation',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation(kind),before=await snapshot();
 await reject(locked(c,a,op,async(s,tx)=>{await changed(kind,tx,op);await s.revalidate({tx});}),kind==='signIn'?'conflict':'unauthorized');
 assert.deepEqual(await snapshot(),before);
});
for(const target of ['G','A'])test('Apple source -> '+target+' preserves other owner scopes and never transfers auth history',async()=>{
 await db.query("UPDATE public.library_users SET access_kind='apple' WHERE id='G'");
 const c=factory(),a=await c.prepare(bearer),op=operation('signIn',target);
 const other=(await db.query('SELECT to_jsonb(k) AS row FROM public.app_attest_keys k WHERE key_id=$1',[foreign])).rows;
 await locked(c,a,op,async(s,tx)=>{await s.revalidate({tx});await changed('signIn',tx,op);await s.verifyPostimage({tx});});
 assert.deepEqual((await db.query('SELECT to_jsonb(k) AS row FROM public.app_attest_keys k WHERE key_id=$1',[foreign])).rows,other);
 assert.ok(locks().every(r=>r.args[0]!=='B'&&r.args[0]!==foreign));
});
test('verified disabled Apple target may be reenabled only in the bound signIn postimage',async()=>{
 await db.query("UPDATE public.library_users SET disabled=true WHERE id='A'");
 const c=factory(),a=await c.prepare(bearer),op=operation('signIn');
 await locked(c,a,op,async(s,tx)=>{
  await s.revalidate({tx});await tx.query("UPDATE public.library_users SET disabled=false WHERE id='A'");
  await changed('signIn',tx,op);assert.equal(await s.verifyPostimage({tx}),true);
 });
});
test('supplemental live B anchors cannot authorize invalid source S',async()=>{
 const c=factory(),a=await c.prepare(bearer);await db.query('DELETE FROM public.app_auth_sessions WHERE digest=$1',[hash(bearer)]);
 await reject(locked(c,a,operation(),()=>assert.fail(),{userIDs:['B'],keyIDs:[foreign],credentialDigests:[hash('foreign-token')]}));
 assert.equal(locks().length,0);
});
for(const normal of [false,true])test((normal?'reader':'writer')+' unauthorized source yields unauthorized instead of freshness expired',async()=>{
 const c=normal?contexts.createCurrentAuthContext({authStore:auth,environment}):factory(),a=await c.prepare(bearer);
 await reject(db.transaction(async real=>{
  const tx=connection(real),d=await c.discover({tx,authentication:a,...(normal?{}:{operationRawJSON:'{"kind":"signOut"}'})}),s=await c.lock({tx,discovery:d});
  await tx.query('UPDATE public.app_auth_sessions SET revoked=true WHERE digest=$1',[hash(bearer)]);
  await s.assertFreshSession({tx,maxAgeMS:0});
 }));
});
test('postimage final SQL receives exact fractional source datetime text and precedes no further IO',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation('signIn');
 await db.transaction(async real=>{
  await real.query("UPDATE public.app_auth_sessions SET expires_at=date_trunc('second',clock_timestamp())+interval '10 minutes 0.123456 seconds' WHERE digest=$1",[hash(bearer)]);
  await real.query("UPDATE public.library_tokens SET expires_at=date_trunc('second',clock_timestamp())+interval '1 day 0.654321 seconds' WHERE digest=$1",[source.credentialDigest]);
  const deadlines=(await real.query('SELECT s.expires_at::text AS s,t.expires_at::text AS c FROM public.app_auth_sessions s JOIN public.library_tokens t ON t.digest=s.credential_digest WHERE s.digest=$1',[hash(bearer)])).rows[0];
  const tx=connection(real),d=await c.discover({tx,authentication:a,operationRawJSON:JSON.stringify(op)}),s=await c.lock({tx,discovery:d});
  await changed('signIn',tx,op);assert.equal(await s.verifyPostimage({tx}),true);
  assert.deepEqual(trace.at(-1).args.slice(0,2),[deadlines.s,deadlines.c]);
  assert.match(deadlines.s,/\.123456/);assert.match(deadlines.c,/\.654321/);
 });
});

// ACR1-01 narrow companion API: an optional negative bound can only shorten
// existing exact S/C/C2 authorization. Invalid supplied values retire scope.
for(const value of [null,-1,1.5,Infinity,'1',Number.MAX_SAFE_INTEGER+1])
 test('final writer cutoff rejects and retires invalid '+String(value),async()=>{
  const c=factory(),a=await c.prepare(bearer),op=operation();
  await locked(c,a,op,async(scope,tx)=>{
   await changed(op.kind,tx,op);await reject(scope.verifyPostimage({tx,notAfterMS:value}),'unavailable');
   await reject(scope.verifyPostimage({tx}),'unavailable');
  });
 });
test('final writer zero cutoff denies without relaxing exact source authority',async()=>{
 const c=factory(),a=await c.prepare(bearer),op=operation();
 await locked(c,a,op,async(scope,tx)=>{
  await changed(op.kind,tx,op);await reject(scope.verifyPostimage({tx,notAfterMS:0}),'unauthorized');
  await reject(scope.verifyPostimage({tx}),'unavailable');
 });
});
