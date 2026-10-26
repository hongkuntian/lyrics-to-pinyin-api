import test, {before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import {createCurrentAuthContext,decodeAuthTimeMS} from '../../api/utils/listening-v2/auth-context.js';
import {SessionV2Error} from '../../api/utils/listening-v2/errors.js';

// One embedded connection, actual auth DDL, no concurrent PostgreSQL claim.
const environment='preview:auth-locks-r1';
const bearer='lyra_s_'+'a'.repeat(43),replacement='lyra_s_'+'b'.repeat(43);
const hash=value=>createHash('sha256').update(value).digest('hex');
const credential=hash('original-credential'),otherCredential=hash('other-credential');
const key=Buffer.alloc(32,7).toString('base64'),otherKey=Buffer.alloc(32,8).toString('base64');
const policy=()=>({audience:'lyra-preview',environment:'development',prefix:'ABCDEFGHIJ',bundles:['com.lyrica.app']});
let sql,trace,authenticateSQL,authCalls;
before(async()=>{
 sql=new PGlite();
 for(const file of ['001-song-library.sql','021-app-auth.sql','025-memberships.sql'])
  await sql.exec(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
 // Execute the exact SELECT from the inspected existing authenticate method,
 // without importing its unrelated V1/provider/dependency graph. The method
 // and App Attest issuance are NOT executed or qualified by this adapter seam.
 const source=await readFile(new URL('../../api/utils/app-auth/store.js',import.meta.url),'utf8');
 authenticateSQL=source.split('async authenticate(token) {')[1]?.match(/`([^`]+)`/s)?.[1];
 assert.ok(authenticateSQL);assert.doesNotMatch(authenticateSQL,/sessionDigest|s\.digest\s+AS/i);
});
after(()=>sql.close());
beforeEach(async()=>{
 await sql.exec(`TRUNCATE public.library_users CASCADE;
  INSERT INTO public.library_users(id,access_kind) VALUES('guest','guest'),('aaa','apple'),('zzz','beta');`);
 await sql.query(`INSERT INTO public.library_tokens(digest,user_id,expires_at)
  VALUES($1,'guest',clock_timestamp()+interval '90 days'),($2,'aaa',NULL)`,[credential,otherCredential]);
 for(const [id,owner] of [[key,'guest'],[otherKey,'aaa']])await sql.query(`INSERT INTO public.app_attest_keys
  (key_id,user_id,audience,bundle_id,environment,public_key,receipt)
  VALUES($1,$2,'lyra-preview','com.lyrica.app','development','fixture-public-key','fixture-receipt')`,[id,owner]);
 await sql.query(`INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at)
  VALUES($1,$2,$3,'lyra-preview',clock_timestamp()+interval '15 minutes')`,[hash(bearer),key,credential]);
 trace=[];authCalls=[];
});
function store(p=policy()){
 return {policy:p,async authenticate(token){
  authCalls.push(token);
  const row=(await sql.query(authenticateSQL,[hash(token),p.audience,p.environment,p.bundles])).rows[0];
  if(!row)throw Object.assign(new Error('session_expired'),{code:'session_expired'});
  return row;
 }};
}
const context=options=>createCurrentAuthContext({authStore:store(),environment,...options});
function connection(tx,intercept){
 return {query:async(text,params=[])=>{
  trace.push({text,params:[...params]});
  if(intercept)await intercept(text,params,tx);
  return tx.query(text,params);
 }};
}
async function run(c,authentication,fn,intercept,requiredScopes){
 return sql.transaction(async tx=>{
  const conn=connection(tx,intercept);
  const discovery=await c.discover({tx:conn,authentication,requiredScopes});
  const scope=await c.lock({tx:conn,discovery});
  return fn(scope,conn,discovery);
 });
}
const rejects=(promise,code='unauthorized')=>assert.rejects(promise,error=>{
 assert.ok(error instanceof SessionV2Error);assert.equal(error.code,code);
 assert.equal(error.message,code);assert.equal(error.cause,undefined);
 assert.doesNotMatch(JSON.stringify(error),new RegExp(bearer+'|fixture-public-key|fixture-receipt'));
 return true;
});

test('bearer preparation binds actual AppAuthStore evidence, survives receipt spread, freezes internal scope',async()=>{
 const c=context(),authentication=await c.prepare(bearer);
 assert.deepEqual(authCalls,[bearer]);assert.ok(Object.isFrozen(c));assert.ok(Object.isFrozen(authentication));
 assert.ok(Object.isFrozen(authentication.evidence));
 assert.equal(authentication.principalID,'guest');assert.equal(authentication.keyID,key);
 assert.doesNotMatch(JSON.stringify(authentication),new RegExp(bearer+'|'+credential+'|'+hash(bearer)));
 await run(c,Object.freeze({...authentication}),async(scope,tx,discovery)=>{
  assert.ok(Object.isFrozen(scope));assert.ok(Object.isFrozen(discovery));
  for(const list of ['userIDs','credentialDigests','keyIDs'])assert.ok(Object.isFrozen(discovery[list]));
  assert.equal(scope.principalID,'guest');assert.equal(scope.credentialDigest,credential);
  assert.equal(scope.bundleID,'com.lyrica.app');assert.equal(scope.audience,'lyra-preview');
  assert.equal(scope.attestEnvironment,'development');assert.equal(scope.accessKind,'guest');
  assert.equal(scope.notAfterMS,scope.sessionExpiresAtMS);
  assert.ok(scope.credentialExpiresAtMS>scope.notAfterMS);
  assert.equal(await scope.revalidate({tx,nowMS:Number.MAX_SAFE_INTEGER}),true); // caller clock ignored
  assert.equal(scope.version,undefined);assert.equal(scope.actorPersonaID,undefined);
  assert.equal(scope.bindingKeyManifestHash,undefined); // deliberately NOT a receipt permit
  assert.doesNotMatch(JSON.stringify(scope),new RegExp(bearer+'|fixture-public-key|fixture-receipt'));
 });
});

test('malformed bearer fails before authentication and storage; no credential/header fallback',async()=>{
 const c=context();
 for(const input of [null,{},Buffer.from(bearer),'Bearer '+bearer,'lyra_g_'+'a'.repeat(43),'lyra_s_',
  bearer+'\n',bearer+' ',bearer+'/', 'lyra_s_'+'a'.repeat(250)])await rejects(c.prepare(input));
 assert.deepEqual(authCalls,[]);assert.deepEqual(trace,[]);
});

test('existing opaque Unicode principal IDs retain their exact identity and canonical byte lock order',async()=>{
 const id='guest-\u6d4b\u8bd5',supplement='guest-\ud83c\udfb5',privateUse='guest-\ue000';
 await sql.query("INSERT INTO public.library_users(id,access_kind) VALUES($1,'guest'),($2,'beta'),($3,'beta')",[id,supplement,privateUse]);
 await sql.query('UPDATE public.library_tokens SET user_id=$1 WHERE digest=$2',[id,credential]);
 await sql.query('UPDATE public.app_attest_keys SET user_id=$1 WHERE key_id=$2',[id,key]);
 const c=context(),a=await c.prepare(bearer);
 assert.equal(a.principalID,id);
 await run(c,a,async(scope,tx,plan)=>{
  assert.equal(scope.principalID,id);
  assert.deepEqual(plan.userIDs,[id,supplement,privateUse,'aaa'].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
  assert.equal(await scope.revalidate({tx}),true);
 },null,{userIDs:[supplement,privateUse,'aaa']});
});

test('authenticate failure and database exceptions expose stable safe codes only',async()=>{
 await rejects(context().prepare(replacement));
 const c=context({authStore:{policy:policy(),authenticate:async()=>{throw new Error(bearer);}}});
 await rejects(c.prepare(bearer),'unavailable');
 const good=context(),a=await good.prepare(bearer);
 await rejects(good.discover({tx:{query:async()=>{throw new Error(bearer);}},authentication:a}),'unavailable');
});

test('forged, cross-factory or identity-altered authentication cannot allocate locks',async()=>{
 const c=context(),a=await c.prepare(bearer);
 for(const altered of [{principalID:'guest',keyID:key,bundleID:'com.lyrica.app',evidence:{}},
  {...a,principalID:'aaa'},{...a,keyID:otherKey},{...a,bundleID:'other'}, {...a,credentialDigest:credential}]){
  await rejects(sql.transaction(tx=>c.discover({tx:connection(tx),authentication:altered})));
 }
 await rejects(sql.transaction(tx=>context().discover({tx:connection(tx),authentication:a})));
 assert.deepEqual(trace,[]);
});

test('configured policy is copied, bounded and deployment fenced',async()=>{
 const p=policy(),c=context({authStore:store(p)}),a=await c.prepare(bearer);
 p.bundles[0]='other';p.audience='changed';p.environment='production';
 await run(c,a,(scope)=>assert.equal(scope.audience,'lyra-preview'));
 for(const options of [{environment:'preview'},{environment:'production'},
  {authStore:store({...policy(),environment:'production'})},
  {authStore:store({...policy(),audience:'lyra-production'})},
  {authStore:store({...policy(),prefix:'bad'})},
  {authStore:store({...policy(),bundles:['']})},
  {authStore:store({...policy(),bundles:Array(33).fill('a')})}])
  assert.throws(()=>context(options),{code:'unavailable'});
 const production={...policy(),audience:'lyra-production',environment:'production'};
 assert.ok(context({environment:'production',authStore:store(production)}));
});

test('lock order includes all discovered owners before sorted tokens, keys, exact bearer session',async()=>{
 const c=context(),a=await c.prepare(bearer);
 await run(c,a,async(scope,tx,plan)=>{
  assert.deepEqual(plan.userIDs,['aaa','guest','zzz']);
  assert.deepEqual(plan.credentialDigests,[credential,otherCredential].sort());
  assert.deepEqual(plan.keyIDs,[key,otherKey].sort());
  assert.equal(await scope.revalidate({tx}),true);
 },null,{userIDs:['zzz','guest','aaa','zzz'],credentialDigests:[otherCredential],keyIDs:[otherKey]});
 const locks=trace.filter(row=>/FOR UPDATE/.test(row.text));
 assert.deepEqual(locks.map(row=>[row.text.match(/FROM public\.(\w+)/)[1],row.params[0]]),[
  ...['aaa','guest','zzz'].map(id=>['library_users',id]),
  ...[credential,otherCredential].sort().map(id=>['library_tokens',id]),
  ...[key,otherKey].sort().map(id=>['app_attest_keys',id]),['app_auth_sessions',hash(bearer)]
 ]);
 assert.ok(trace.some(row=>row.text.includes('clock_timestamp()')));
 assert.ok(trace.every(row=>!row.text.includes('now()')));
});

test('scope inputs and plans are bounded, single-use and tied to their discovery connection',async()=>{
 const c=context(),a=await c.prepare(bearer);
 for(const requiredScopes of [{unexpected:[]},{userIDs:['x'.repeat(129)]},{keyIDs:['not-key']},
  {credentialDigests:['A'.repeat(64)]},{userIDs:Array(65).fill('guest')},
  {credentialDigests:[hash('missing')]},{keyIDs:[Buffer.alloc(32,9).toString('base64')]}]){
  await rejects(sql.transaction(tx=>c.discover({tx:connection(tx),authentication:a,requiredScopes})),'unavailable');
 }
 await sql.transaction(async tx=>{
  const first=connection(tx),second=connection(tx),plan=await c.discover({tx:first,authentication:a});
  await rejects(c.lock({tx:second,discovery:plan}),'unavailable');
  await rejects(c.lock({tx:first,discovery:{...plan}}),'unavailable');
  const scope=await c.lock({tx:first,discovery:plan});
  await rejects(scope.revalidate({tx:second}),'unavailable');
 });
 await sql.transaction(async tx=>{
  const conn=connection(tx),plan=await c.discover({tx:conn,authentication:a});
  await c.lock({tx:conn,discovery:plan});
  await rejects(c.lock({tx:conn,discovery:plan}),'unavailable');
  await rejects(c.discover({tx:conn,authentication:a}),'unavailable');
 });
});

test('pooled client reuse gets a new scope; old plans and scopes fail across transactions',async()=>{
 const c=context(),a=await c.prepare(bearer);
 let target,oldPlan,oldScope;
 // Reuse one facade object exactly as pg.Pool reuses a client after release.
 const pooled={query:(...args)=>target.query(...args)};
 await sql.transaction(async tx=>{
  target=tx;oldPlan=await c.discover({tx:pooled,authentication:a});
  oldScope=await c.lock({tx:pooled,discovery:oldPlan});
  assert.equal(await oldScope.revalidate({tx:pooled}),true);
 });
 await sql.transaction(async tx=>{
  target=tx;
  await rejects(oldScope.revalidate({tx:pooled}),'unavailable');
  await rejects(c.lock({tx:pooled,discovery:oldPlan}),'unavailable');
  const fresh=await c.discover({tx:pooled,authentication:a});
  const scope=await c.lock({tx:pooled,discovery:fresh});
  assert.equal(await scope.revalidate({tx:pooled}),true);
 });
 let unused;
 await sql.transaction(async tx=>{target=tx;unused=await c.discover({tx:pooled,authentication:a});});
 await sql.transaction(async tx=>{target=tx;await rejects(c.lock({tx:pooled,discovery:unused}),'unavailable');});
});

test('autocommit and pool.query facades cannot stand in for an active transaction',async()=>{
 const c=context(),a=await c.prepare(bearer);
 await rejects(c.discover({tx:sql,authentication:a}),'unavailable');
 assert.equal(trace.filter(row=>/FOR UPDATE/.test(row.text)).length,0);
});

for(const [name,change] of [
 ['user disabled',"UPDATE public.library_users SET disabled=true WHERE id='guest'"],
 ['token revoked',`UPDATE public.library_tokens SET revoked=true WHERE digest='${credential}'`],
 ['key revoked',`UPDATE public.app_attest_keys SET revoked=true WHERE key_id='${key}'`],
 ['session revoked',`UPDATE public.app_auth_sessions SET revoked=true WHERE digest='${hash(bearer)}'`],
 ['token owner mismatch',`UPDATE public.library_tokens SET user_id='aaa' WHERE digest='${credential}'`],
 ['key moved to Apple',`UPDATE public.app_attest_keys SET user_id='aaa' WHERE key_id='${key}'`],
 ['session credential mismatch',`UPDATE public.app_auth_sessions SET credential_digest='${otherCredential}' WHERE digest='${hash(bearer)}'`],
 ['session key mismatch',`UPDATE public.app_auth_sessions SET key_id='${otherKey}' WHERE digest='${hash(bearer)}'`],
 ['key bundle mismatch',`UPDATE public.app_attest_keys SET bundle_id='other' WHERE key_id='${key}'`],
 ['key audience mismatch',`UPDATE public.app_attest_keys SET audience='other' WHERE key_id='${key}'`],
 ['session audience mismatch',`UPDATE public.app_auth_sessions SET audience='other' WHERE digest='${hash(bearer)}'`],
 ['attestation environment mismatch',`UPDATE public.app_attest_keys SET environment='production' WHERE key_id='${key}'`],
 ['session expired',`UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()-interval '1 ms'`],
 ['credential expired',`UPDATE public.library_tokens SET expires_at=clock_timestamp()-interval '1 ms' WHERE digest='${credential}'`]
])test(name+' refuses prepared evidence before locks',async()=>{
 const c=context(),a=await c.prepare(bearer);await sql.exec(change);
 await rejects(run(c,a,()=>assert.fail('must not return scope')));
 assert.equal(trace.filter(row=>/FOR UPDATE/.test(row.text)).length,0);
});

test('deleted old bearer cannot select a renewed session by credential/key; new bearer still works',async()=>{
 const c=context(),old=await c.prepare(bearer);
 await sql.transaction(async tx=>{
  await tx.query('DELETE FROM public.app_auth_sessions WHERE key_id=$1',[key]);
  await tx.query(`INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at)
   VALUES($1,$2,$3,'lyra-preview',clock_timestamp()+interval '15 minutes')`,[hash(replacement),key,credential]);
 });
 await rejects(run(c,old,()=>assert.fail()));
 const fresh=await c.prepare(replacement);
 await run(c,fresh,async(scope,tx)=>{
  assert.equal(scope.keyID,old.keyID);assert.equal(await scope.revalidate({tx}),true);
 });
 assert.ok(trace.some(row=>/app_auth_sessions.*FOR UPDATE/.test(row.text)&&row.params[0]===hash(replacement)));
});

test('discovery-to-lock key/credential/session moves abort rather than locking an undiscovered earlier scope',async()=>{
 for(const change of [
  `UPDATE public.app_attest_keys SET user_id='zzz' WHERE key_id='${key}'`,
  `UPDATE public.library_tokens SET user_id='zzz' WHERE digest='${credential}'`,
  `UPDATE public.app_auth_sessions SET credential_digest='${otherCredential}' WHERE digest='${hash(bearer)}'`
 ]){
  const c=context(),a=await c.prepare(bearer);trace=[];
  await rejects(sql.transaction(async tx=>{
   const conn=connection(tx),plan=await c.discover({tx:conn,authentication:a});
   await tx.exec(change);await c.lock({tx:conn,discovery:plan});
  }),'conflict');
  const locks=trace.filter(row=>/FOR UPDATE/.test(row.text));
  assert.ok(locks.every(row=>!['zzz',otherCredential,otherKey].includes(row.params[0])));
 }
});

test('additional key owner discovered before locking cannot be expanded after lower locks',async()=>{
 const c=context(),a=await c.prepare(bearer);
 await rejects(sql.transaction(async tx=>{
  const conn=connection(tx),plan=await c.discover({tx:conn,authentication:a,requiredScopes:{keyIDs:[otherKey]}});
  await tx.query("UPDATE public.app_attest_keys SET user_id='zzz' WHERE key_id=$1",[otherKey]);
  await c.lock({tx:conn,discovery:plan});
 }),'conflict');
 assert.equal(trace.filter(row=>/FOR UPDATE/.test(row.text)&&row.params[0]==='zzz').length,0);
});

test('fresh same-connection revalidation detects revocation and rolls back caller writes',async()=>{
 const c=context(),a=await c.prepare(bearer);
 await rejects(run(c,a,async(scope,tx)=>{
  await tx.query("UPDATE public.library_users SET auth_count=42 WHERE id='guest'");
  await tx.query('UPDATE public.library_tokens SET revoked=true WHERE digest=$1',[credential]);
  const locks=trace.filter(row=>/FOR UPDATE/.test(row.text)).length;
  try{await scope.revalidate({tx});}finally{assert.equal(trace.filter(row=>/FOR UPDATE/.test(row.text)).length,locks);}
 }));
 assert.deepEqual((await sql.query("SELECT auth_count,disabled FROM public.library_users WHERE id='guest'")).rows,
  [{auth_count:0,disabled:false}]);
 assert.equal((await sql.query('SELECT revoked FROM public.library_tokens WHERE digest=$1',[credential])).rows[0].revoked,false);
});

test('revalidation refuses key movement and old session removal without taking new locks',async()=>{
 for(const [change,code] of [[`UPDATE public.app_attest_keys SET user_id='aaa' WHERE key_id='${key}'`,'conflict'],
  [`DELETE FROM public.app_auth_sessions WHERE digest='${hash(bearer)}'`,'unauthorized']]){
  const c=context(),a=await c.prepare(bearer);
  await rejects(run(c,a,async(scope,tx)=>{await tx.query(change);await scope.revalidate({tx});}),code);
 }
});

test('transaction-start time cannot preserve auth across a real DB session/credential deadline',async()=>{
 for(const relation of ['app_auth_sessions','library_tokens']){
  const c=context(),a=await c.prepare(bearer);
  await rejects(sql.transaction(async tx=>{
   await tx.query(`UPDATE public.${relation} SET expires_at=clock_timestamp()+interval '150 milliseconds'`);
   const conn=connection(tx),plan=await c.discover({tx:conn,authentication:a}),scope=await c.lock({tx:conn,discovery:plan});
   await tx.query("UPDATE public.library_users SET auth_count=99 WHERE id='guest'");
   await setTimeout(200);
   assert.equal((await tx.query(`SELECT expires_at>now() AS stale FROM public.${relation} LIMIT 1`)).rows[0].stale,true);
   await scope.revalidate({tx:conn,nowMS:0});
  }));
  assert.equal((await sql.query("SELECT auth_count FROM public.library_users WHERE id='guest'")).rows[0].auth_count,0);
 }
});

test('deadline crossing while locks are acquired refuses and rolls back',async()=>{
 const c=context(),a=await c.prepare(bearer);let crossed=false;
 await rejects(run(c,a,()=>assert.fail(),async(text,params,tx)=>{
  if(!crossed&&text.includes('app_attest_keys')&&text.includes('FOR UPDATE')){
   crossed=true;await tx.query("UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()-interval '1 ms'");
  }
 }));
 assert.equal(crossed,true);
});

test('auth uses actual finite credential minimum, permits existing null expiry without inventing guest retention',async()=>{
 const c=context(),a=await c.prepare(bearer);
 await sql.query("UPDATE public.library_tokens SET expires_at=clock_timestamp()+interval '2 minutes' WHERE digest=$1",[credential]);
 await run(c,a,scope=>assert.equal(scope.notAfterMS,scope.credentialExpiresAtMS));
 await sql.query('UPDATE public.library_tokens SET expires_at=NULL WHERE digest=$1',[credential]);
 await run(c,a,scope=>{assert.equal(scope.credentialExpiresAtMS,null);assert.equal(scope.notAfterMS,scope.sessionExpiresAtMS);});
});

test('expiry extension or same-transaction authority change cannot extend the frozen scope',async()=>{
 const c=context(),a=await c.prepare(bearer);
 await rejects(run(c,a,async(scope,tx)=>{
  await tx.query("UPDATE public.app_auth_sessions SET expires_at=expires_at+interval '1 hour'");
  await scope.revalidate({tx});
 }));
});

test('safe timestamp decoding rejects coercion, rounding and int8 overflow',()=>{
 for(const value of [0,'0',0n,9007199254740991,'9007199254740991',9007199254740991n])
  assert.equal(decodeAuthTimeMS(value),Number(value));
 for(const value of [null,undefined,{},[],true,'','01','-1','1.0','1e3',' 1','1\n',-1,1.5,NaN,Infinity,
  '9007199254740992',9007199254740992,9007199254740992n,'9223372036854775807','9'.repeat(1000)])
  assert.throws(()=>decodeAuthTimeMS(value),{code:'unavailable'});
});

test('actual timestamptz SQL preserves safe maximum and rejects overflow/infinity/negative expiry',async()=>{
 const c=context(),a=await c.prepare(bearer);
 const maximum="TIMESTAMPTZ 'epoch'+interval '9007199254740 seconds'+interval '991 milliseconds'";
 await sql.exec(`UPDATE public.app_auth_sessions SET expires_at=${maximum};
  UPDATE public.library_tokens SET expires_at=NULL;`);
 assert.equal((await sql.query('SELECT floor(extract(epoch FROM expires_at)*1000)::text AS ms FROM public.app_auth_sessions')).rows[0].ms,'9007199254740991');
 await run(c,a,scope=>assert.equal(scope.notAfterMS,Number.MAX_SAFE_INTEGER));
 for(const value of [maximum+"+interval '1 millisecond'","'infinity'::timestamptz","'-infinity'::timestamptz","TIMESTAMPTZ '1969-12-31'"]){
  await sql.exec(`UPDATE public.app_auth_sessions SET expires_at=${value}`);
  await rejects(run(c,a,()=>assert.fail()),'unavailable');
 }
});
