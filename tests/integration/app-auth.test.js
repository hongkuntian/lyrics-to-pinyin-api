import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB,source} from '../helpers/library-db.js';
import {AppAuthStore,authPolicy} from '../../api/utils/app-auth/store.js';
import {createAppAuthHandler} from '../../api/app-auth.js';
import {createMusicRomanizeHandler} from '../../api/music-romanize.js';
import {createRomanizeHandler} from '../../api/romanize.js';
import {createSongLibraryHandler} from '../../api/song-library.js';
import {createMockRes} from '../helpers/mock-http.js';
import {randomUUID} from 'node:crypto';
import {reserveExplanation,claimExplanation} from '../../api/utils/song-library/study-store.js';
import {configureEmergencyBudget,disableUser,revokeSessions,revokeKey} from '../../api/utils/app-auth/admin.js';
const policy={audience:'test',environment:'production',prefix:'9ESZX68J8U',bundles:['com.test.Lyra']};
const keyID=Buffer.alloc(32,1).toString('base64'),bundleID=policy.bundles[0];
async function fixture(t){const f=await libraryDB();t.after(()=>f.db.close());return {...f,auth:new AppAuthStore(f.store.db,{policy,
 attestFn:()=>({publicKey:'fixture',receipt:Buffer.from('fixture')}),assertionFn:({assertion})=>Number(assertion.toString())})};}
async function enroll(auth,token='token-a'){
 const {challenge}=await auth.challenge(token,{keyID,bundleID,purpose:'register'});
 await auth.register(token,{keyID,bundleID,challenge,attestation:'Zml4dHVyZQ=='});
 return mint(auth,token,1);
}
async function mint(auth,token,counter){const {challenge}=await auth.challenge(token,{keyID,bundleID,purpose:'session'});
 return auth.session(token,{keyID,bundleID,challenge,assertion:Buffer.from(String(counter)).toString('base64')});}
test('enrollment ACK cannot authorize requests; session needs fresh possession proof',async t=>{
 const {auth,db}=await fixture(t);const session=await enroll(auth);
 assert.equal((await auth.authenticate(session.token)).id,'reader-a');
 assert.equal((await db.query('SELECT digest FROM app_auth_sessions')).rows[0].digest.includes(session.token),false);
 await assert.rejects(auth.authenticate('token-a'),{code:'session_expired'});
 await assert.rejects(auth.register('token-b',{keyID,bundleID,challenge:'ignored',attestation:'ignored'}),{code:'app_access_revoked'});
 assert.deepEqual(await auth.register('token-a',{keyID,bundleID,challenge:'ignored',attestation:'ignored'}),{registered:true});
});
test('nonce replay and counter races cannot mint a second session',async t=>{
 const {auth}=await fixture(t);await enroll(auth);
 const {challenge}=await auth.challenge('token-a',{keyID,bundleID,purpose:'session'});
 const body={keyID,bundleID,challenge,assertion:Buffer.from('2').toString('base64')};
 const results=await Promise.allSettled([auth.session('token-a',body),auth.session('token-a',body)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 await assert.rejects(mint(auth,'token-a',2),{code:'app_assertion_invalid'});
});
test('expiry, credential rotation, key revocation, user disable and environment isolate sessions',async t=>{
 const {auth,store,db}=await fixture(t);let session=await enroll(auth);
 const wrong=new AppAuthStore(store.db,{policy:{...policy,audience:'preview'}});
 await assert.rejects(wrong.authenticate(session.token),{code:'session_expired'});
 await db.query('UPDATE app_auth_sessions SET expires_at=now()');await assert.rejects(auth.authenticate(session.token),{code:'session_expired'});
 session=await mint(auth,'token-a',2);await db.query('UPDATE app_attest_keys SET revoked=true');
 await assert.rejects(auth.authenticate(session.token),{code:'session_expired'});await db.query('UPDATE app_attest_keys SET revoked=false');
 await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");await assert.rejects(auth.authenticate(session.token),{code:'session_expired'});
 await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");await store.createUser('reader-a','rotated');
 await assert.rejects(auth.authenticate(session.token),{code:'session_expired'});
});
test('challenge purpose, credential, bundle and lifetime are bound durably',async t=>{
 const {auth,db}=await fixture(t);await enroll(auth);
 let {challenge}=await auth.challenge('token-a',{keyID,bundleID,purpose:'register'});
 await assert.rejects(auth.session('token-a',{keyID,bundleID,challenge,assertion:'Mg=='}),{code:'challenge_expired'});
 ({challenge}=await auth.challenge('token-a',{keyID,bundleID,purpose:'session'}));
 await db.query('UPDATE app_auth_challenges SET expires_at=now()');
 await assert.rejects(auth.session('token-a',{keyID,bundleID,challenge,assertion:'Mg=='}),{code:'challenge_expired'});
 await assert.rejects(auth.challenge('token-a',{keyID,bundleID:'evil',purpose:'session'}),{code:'invalid_request'});
});
test('all public app routes reject anonymous and raw beta credentials before work',async t=>{
 const {auth,store}=await fixture(t);let work=0;
 for(const handler of [createMusicRomanizeHandler({authStore:auth,libraryStore:store,getAvailableAPIsFn:()=>{work++;return [];}}),
  createRomanizeHandler({authStore:auth,libraryStore:store,detectLanguageFn:()=>{work++;return 'zh';}}),
  createSongLibraryHandler({authStore:auth,store,loadLyrics:()=>{work++;}})]){
  for(const token of [null,'token-a']){const res=createMockRes();await handler({method:'POST',headers:{authorization:token?`Bearer ${token}`:undefined},body:{}},res);
   assert.equal(res.statusCode,401);assert.equal(res.headers['Cache-Control'],'private, no-store');}
 }
 assert.equal(work,0);
 const session=await enroll(auth),handler=createSongLibraryHandler({authStore:auth,store});
 const res=createMockRes();await handler({method:'POST',headers:{authorization:`Bearer ${session.token}`},body:{action:'capabilities'}},res);
 assert.equal(res.statusCode,200);
});
test('authentication HTTP rejects malformed, oversized and anonymous enrollment',async t=>{
 const {auth}=await fixture(t),handler=createAppAuthHandler({store:auth});
 for(const [body,token,status] of [[{},null,401],[{action:'challenge',keyID,bundleID,purpose:'session',extra:true},'token-a',400],
  [{action:'register',keyID,bundleID,challenge:'a'.repeat(43),attestation:'x'.repeat(33000)},'token-a',400]]){
  const res=createMockRes();await handler({method:'POST',headers:{authorization:token?`Bearer ${token}`:undefined},body},res);assert.equal(res.statusCode,status);
 }
});
test('durable auth, business and explicit refresh quotas survive a new instance',async t=>{
 const {auth,store}=await fixture(t),session=await enroll(auth),handler=createSongLibraryHandler({authStore:auth,store});
 for(let i=0;i<61;i++){const res=createMockRes();await handler({method:'POST',headers:{authorization:`Bearer ${session.token}`},body:{action:'capabilities'}},res);assert.equal(res.statusCode,i<60?200:429);}
 for(let i=0;i<7;i++){if(i<6)await auth.limit('reader-b',true);else await assert.rejects(auth.limit('reader-b',true),{code:'rate_limited'});}
});
test('emergency cap covers unlimited generation and direct database admissions',async t=>{
 const {store,db}=await fixture(t);await store.saveDocument(source);await store.configureUserAccess('reader-a',{unlimitedGeneration:true});
 await db.query('UPDATE library_settings SET emergency_daily_micros=20000,emergency_monthly_micros=20000');
 await assert.rejects(store.reserve({userID:'reader-a',documentID:source.id,target:'en',recipe:'test',reservedMicros:30000}),{code:'emergency_budget_exhausted'});
 await assert.rejects(db.query(`INSERT INTO translation_jobs(id,document_id,target,recipe,user_id,state,reserved_micros,accounted_micros)
  VALUES($1,$2,'en','test','reader-a','queued',30000,30000)`,[randomUUID(),source.id]),/emergency_budget_exhausted/);
 await assert.rejects(reserveExplanation(store.db,{key:'test',doc:source,selection:{sourceID:'L0001',lower:0,upper:1},recipe:'test',userID:'reader-a',amount:30000}),{code:'emergency_budget_exhausted'});
});
test('worker claim rechecks kill switch and disabled account without submitting',async t=>{
 const {store,db}=await fixture(t);await store.saveDocument(source);
 const job=await store.reserve({userID:'reader-a',documentID:source.id,target:'en',recipe:'test',reservedMicros:30000});
 await db.query('UPDATE library_settings SET enabled=false');assert.equal(await store.claim(job.job.id),null);
 await db.query('UPDATE library_settings SET enabled=true');await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");assert.equal(await store.claim(job.job.id),null);
 assert.equal((await store.job(job.job.id)).state,'queued');
});
test('preview and production policy cannot silently share trust',()=>{
 const env={LYRA_APP_AUTH_AUDIENCE:'lyra-production',LYRA_APP_ATTEST_ENVIRONMENT:'production',LYRA_APP_ID_PREFIX:policy.prefix,LYRA_APP_BUNDLE_IDS:bundleID};
 assert.equal(authPolicy({...env,VERCEL_ENV:'production'}).environment,'production');
 assert.throws(()=>authPolicy({...env,VERCEL_ENV:'preview'}),{code:'app_auth_not_configured'});
 assert.throws(()=>authPolicy({...env,VERCEL_ENV:'production',LYRA_APP_ATTEST_ENVIRONMENT:'development'}),{code:'app_auth_not_configured'});
});
test('operator controls revoke access immediately and validate emergency limits',async t=>{
 const {auth,db}=await fixture(t);let session=await enroll(auth);
 await assert.rejects(configureEmergencyBudget(db,{dailyMicros:-1,monthlyMicros:10}),{code:'invalid_budget'});
 await configureEmergencyBudget(db,{dailyMicros:100,monthlyMicros:200});
 assert.equal(Number((await db.query('SELECT emergency_daily_micros FROM library_settings')).rows[0].emergency_daily_micros),100);
 await revokeSessions(db,'reader-a');await assert.rejects(auth.authenticate(session.token),{code:'session_expired'});
 session=await mint(auth,'token-a',2);await revokeKey(db,keyID);
 await assert.rejects(auth.authenticate(session.token),{code:'session_expired'});
 await assert.rejects(mint(auth,'token-a',3),{code:'app_access_revoked'});
 await disableUser(db,'reader-a');await assert.rejects(auth.credential('token-a'),{code:'unauthorized'});
 await assert.rejects(disableUser(db,'missing'),{code:'user_not_found'});
});
test('concurrent unlimited admissions cannot exceed the monthly emergency cap',async t=>{
 const {store,db}=await fixture(t);await store.saveDocument(source);
 for(const user of ['reader-a','reader-b'])await store.configureUserAccess(user,{unlimitedGeneration:true});
 await configureEmergencyBudget(db,{dailyMicros:100000,monthlyMicros:50000});
 const results=await Promise.allSettled(['en','fr'].map((target,index)=>store.reserve({userID:index?'reader-b':'reader-a',documentID:source.id,target,recipe:'test',reservedMicros:30000})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'emergency_budget_exhausted');
 const job=results.find(r=>r.status==='fulfilled').value.job;
 await configureEmergencyBudget(db,{dailyMicros:100000,monthlyMicros:20000});
 await assert.rejects(store.claim(job.id),{code:'emergency_budget_exhausted'});
});
