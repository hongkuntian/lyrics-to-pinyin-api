import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {parseTerminalPayload} from '../../api/utils/listening-v2/terminal-codec.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';

// AUTHORED ONLY; Root executes. Actual DDL, no schema/query mocks or terminal
// store callbacks. Manual outbox transitions characterize ROWS, never an actual
// 11-room processor, trusted repair authorization, App Attest or provider Release.
const sqlFile=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
const M=9007199254740991,DAY=86400000,U='ffffffff-ffff-ffff-ffff-ffffffffffff';
const env='test',d=n=>n.toString(16).padStart(64,'0');
const names=['001-song-library.sql','003-correction-foundation.sql','005-correction-batches.sql',
 '007-correction-publication.sql','009-study-explanations.sql','012-multilingual-content.sql',
 '013-pronunciation-aids.sql','014-lyric-source-refresh.sql','015-gpt6-luna.sql',
 '016-personal-unlimited-access.sql','017-translation-reuse.sql','018-translation-attempts.sql',
 '020-catalog-recording-bindings.sql','021-app-auth.sql','022-live-lyrics-push.sql',
 '023-live-lyrics-runtime.sql','024-live-lyrics-cleanup.sql','025-memberships.sql',
 '026-spotify-recordings.sql','027-spotify-background.sql','028-selected-lyrics-learning.sql',
 '029-listening-sessions.sql','030-listening-v2-schema.sql','031-listening-v2-lifecycle-support.sql',
 '032-auth-token-row-locks.sql','033-listening-v2-lifecycle-composition.sql'];
const migrationName='034-listening-v2-output-terminal-support.sql';
const relations=['command_receipts','outbox','output_guards','privacy_personas','private_profile_assets','returning_grants','rooms','semantic_events'];
const selectors=[{kind:'credential',value:d(1)},
 {kind:'installation',value:d(1),bindingVersion:1,throughGeneration:0},
 {kind:'private-transfer',targetEnvironment:'preview:other',personaID:U,fromGeneration:0,toGeneration:1}];
const payload=(selector=selectors[0],extra={})=>({version:2,environment:env,selector,invalidatedAtMS:0,phase:'rooms',cursor:null,...extra});
const repair={rootJobID:U,predecessorJobID:U,originalCreatedAtMS:0,originalRetryUntilMS:DAY,repairOrdinal:1};
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const rejected=p=>assert.rejects(p,e=>['23514','23502','22003','22P02','23503'].includes(e.code));
const denied=p=>assert.rejects(p,{code:'42501'}),duplicate=p=>assert.rejects(p,{code:'23505'});
async function fixture(t,{apply=true,footprint='minimal',lateRoles=false}={}){
 const db=new PGlite();t.after(()=>db.close());
 // All fixture roles precede conditional 027/029/032/033/034 grants.
 const createRoles=()=>db.exec(`CREATE ROLE lyra_runtime_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 CREATE ROLE lyra_account_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 CREATE ROLE terminal_untrusted NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
 if(!lateRoles)await createRoles();
 for(const name of names)await db.exec(await sqlFile(name));
 if(!lateRoles&&footprint==='observed')await observedRuntime(db);
 if(apply)await db.exec(await sqlFile(migrationName));
 if(lateRoles){await createRoles();if(footprint==='observed')await observedRuntime(db);}
 return db;
}
async function observedRuntime(db){
 // Exact public-table map retained by the manual PG harness; fixture only.
 const map={app_attest_keys:'SELECT,INSERT,UPDATE',app_auth_challenges:'SELECT,INSERT,UPDATE,DELETE',
  app_auth_sessions:'SELECT,INSERT,UPDATE,DELETE',library_settings:'SELECT',library_tokens:'SELECT',
  library_users:'SELECT',membership_settings:'SELECT',spotify_connections:'SELECT,INSERT,UPDATE,DELETE',
  spotify_outbox:'SELECT,INSERT,UPDATE,DELETE',spotify_snapshot_capabilities:'SELECT,INSERT,UPDATE,DELETE'};
 for(const [table,rights] of Object.entries(map))await db.exec('GRANT '+rights+' ON public.'+table+' TO lyra_runtime_v1');
 await db.exec('GRANT UPDATE(auth_window,auth_count,refresh_window,refresh_count) ON public.library_users TO lyra_runtime_v1');
 await db.exec('GRANT UPDATE(enabled,review_enabled) ON public.library_settings TO lyra_runtime_v1');
}
const oldKeyColumns=['key_id','user_id','audience','bundle_id','environment','public_key','receipt','sign_count','revoked','created_at'];
const metadataColumns=['sessions_install_binding_version','sessions_authority_generation'];
async function keyRights(db){return (await db.query(`SELECT r.rolname,a.attname,p.privilege,
 has_column_privilege(r.oid,a.attrelid,a.attnum,p.privilege) AS allowed
 FROM pg_roles r CROSS JOIN pg_attribute a CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
 WHERE r.rolname IN ('lyra_runtime_v1','lyra_account_v1') AND a.attrelid='public.app_attest_keys'::regclass
 AND a.attname=ANY($1::text[]) ORDER BY 1,2,3`,[oldKeyColumns])).rows;}
async function asRole(db,role,fn){await db.exec('SET ROLE '+role);try{return await fn();}finally{await db.exec('RESET ROLE');}}
async function insert(db,row){const keys=Object.keys(row);return db.query(`INSERT INTO listening_v2.outbox(${keys.join(',')})
 VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row));}
async function clock(db){return Number((await one(db,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS n')).n);}
async function job(db,p=payload(),extra={}){
 const at=await clock(db),id=randomUUID();return {environment:p.environment,job_id:id,job_key:'authority-terminal:'+id,
 kind:'authority_terminal',payload:p,created_at_ms:at,due_at_ms:at,retry_until_ms:at+600000,...extra};
}
async function row(db,j){return one(db,'SELECT * FROM listening_v2.outbox WHERE environment=$1 AND job_id=$2',[j.environment,j.job_id]);}
async function change(db,j,changes){const keys=Object.keys(changes);return db.query(`UPDATE listening_v2.outbox
 SET ${keys.map((k,i)=>k+'=$'+(i+1)).join(',')} WHERE environment=$${keys.length+1} AND job_id=$${keys.length+2} RETURNING *`,
 [...Object.values(changes),j.environment,j.job_id]);}
async function claim(db,j){const old=await row(db,j);return (await change(db,j,{state:'claimed',
 attempt_count:old.attempt_count+1,claim_epoch:Number(old.claim_epoch)+1,claim_nonce_hash:createHash('sha256').update(randomUUID()).digest('hex'),
 claim_until_ms:Number(old.retry_until_ms)})).rows[0];}
const cleared={claim_nonce_hash:null,claim_until_ms:null};
async function failClaim(db,j){const old=await row(db,j),dead=old.attempt_count===10;
 const at=await clock(db);return change(db,j,{state:dead?'dead':'pending',...cleared,
 ...(dead?{completed_at_ms:at,delete_after_ms:at+DAY}:{})});}
async function progress(db,j,cursor){const old=await row(db,j);return change(db,j,{state:'pending',...cleared,
 attempt_count:old.attempt_count-1,payload:{...old.payload,cursor}});}
async function publish(db,j){const old=await row(db,j),at=await clock(db);return change(db,j,{state:'published',...cleared,
 attempt_count:old.attempt_count-1,payload:{...old.payload,phase:'complete',cursor:null},completed_at_ms:at,delete_after_ms:at+DAY});}
async function catalog(db){const result={};for(const [key,sql] of Object.entries({
 checks:`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
 WHERE connamespace IN ('public'::regnamespace,'listening_v2'::regnamespace) ORDER BY 1,2`,
 indexes:`SELECT schemaname,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','listening_v2') ORDER BY 1,2`,
 acl:`SELECT table_schema,table_name,column_name,grantee,privilege_type FROM information_schema.column_privileges
 WHERE table_schema IN ('public','listening_v2') ORDER BY 1,2,3,4,5`,
 roles:`SELECT rolname,rolsuper,rolcanlogin,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles ORDER BY rolname`,
 columns:`SELECT table_schema,table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
 WHERE table_schema IN ('public','listening_v2') ORDER BY 1,2,ordinal_position`
}))result[key]=(await db.query(sql)).rows;return result;}

test('exact historical DDL pins and old checks/indexes/effective permissions/columns survive the slice',async t=>{
 const pins={'030-listening-v2-schema.sql':'4cd413d4fe3d38ab62695ec8898e9532326e85e8d60c9a5f358dc9b911f5e0c6',
 '031-listening-v2-lifecycle-support.sql':'111032345679f02d00fb0df0d85ba8d11d48fc836159fffe316908007912e9ec',
 '032-auth-token-row-locks.sql':'c19650a29438ebeea186203d954fee8e144a65ca6d42ad91bc38c18f1f7e5df6',
 '033-listening-v2-lifecycle-composition.sql':'71b57b21ae4555d3d76da9b9936342238926fa8059117e68aa41a40a7e628678'};
 for(const [name,pin] of Object.entries(pins))assert.equal(createHash('sha256').update(await sqlFile(name)).digest('hex'),pin);
 const db=await fixture(t,{apply:false,footprint:'observed'}),before=await catalog(db),rights=await keyRights(db);
 const deletes=(await db.query("SELECT rolname,has_table_privilege(oid,'public.app_attest_keys','DELETE') AS allowed FROM pg_roles WHERE rolname IN ('lyra_runtime_v1','lyra_account_v1') ORDER BY 1")).rows;
 await db.exec(await sqlFile(migrationName));const after=await catalog(db);
 for(const old of before.checks)if(!['outbox_lifecycle_kind','outbox_lifecycle_references'].includes(old.conname))
  assert.ok(after.checks.some(v=>JSON.stringify(v)===JSON.stringify(old)),old.conname);
 for(const old of before.indexes)assert.ok(after.indexes.some(v=>JSON.stringify(v)===JSON.stringify(old)),old.indexname);
 assert.deepEqual(after.roles,before.roles);
 const fresh=r=>r.table_schema==='public'&&r.table_name==='app_attest_keys'&&
  ['sessions_install_binding_version','sessions_authority_generation'].includes(r.column_name);
 assert.deepEqual(after.columns.filter(r=>!fresh(r)),before.columns);assert.equal(after.columns.filter(fresh).length,2);
 const unrelated=r=>!(r.table_schema==='public'&&r.table_name==='app_attest_keys');
 assert.deepEqual(after.acl.filter(unrelated),before.acl.filter(unrelated));
 assert.deepEqual(await keyRights(db),rights,'table-to-column narrowing preserves effective rights on every old key column');
 assert.deepEqual((await db.query("SELECT rolname,has_table_privilege(oid,'public.app_attest_keys','DELETE') AS allowed FROM pg_roles WHERE rolname IN ('lyra_runtime_v1','lyra_account_v1') ORDER BY 1")).rows,deletes);
 assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='listening_v2' ORDER BY 1")).rows.map(r=>r.tablename),relations);
 const funcs=(await db.query(`SELECT proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace='listening_v2'::regnamespace
 AND proname IN ('terminal_payload_valid','protect_terminal_job','protect_install_metadata') ORDER BY 1`)).rows;
 assert.equal(funcs.length,3);for(const f of funcs){assert.equal(f.prosecdef,false);assert.deepEqual(f.proconfig,['search_path=pg_catalog']);}
 for(const signature of ['terminal_payload_valid(jsonb)','protect_terminal_job()','protect_install_metadata()'])
  assert.equal((await one(db,'SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok',['terminal_untrusted','listening_v2.'+signature])).ok,false);
});

test('independent SQL/JS closed acceptance vectors and maximum normalized future payload',async t=>{
 const db=await fixture(t),maxEnv='preview:'+'z'.repeat(120);
 const good=[];for(const s of selectors)for(const e of [{},{cursor:['preview:other',U]},{phase:'complete'},{repair}])good.push(payload(s,e));
 const bad=[payload({...selectors[0],extra:1}),payload({...selectors[1],bindingVersion:2}),
  payload({...selectors[2],toGeneration:2}),payload({...selectors[2],personaID:U.toUpperCase()}),
  payload(selectors[0],{environment:'preview'}),payload(selectors[0],{cursor:['preview',U]}),
  payload(selectors[0],{phase:'complete',cursor:['test',U]}),payload(selectors[0],{extra:1}),
  payload(selectors[0],{invalidatedAtMS:0.5}),payload(selectors[0],{invalidatedAtMS:M+1}),
  payload(selectors[0],{repair:{...repair,repairOrdinal:0}}),payload(selectors[0],{invalidatedAtMS:1,repair})];
 for(const field of Object.keys(payload())){const p=payload();delete p[field];bad.push(p);}
 for(const p of good){assert.deepEqual(parseTerminalPayload(JSON.stringify(p)),p);
  assert.equal((await one(db,'SELECT listening_v2.terminal_payload_valid($1::jsonb) AS ok',[p])).ok,true);}
 for(const p of bad){assert.throws(()=>parseTerminalPayload(JSON.stringify(p)),{code:'invalid_request'});
  assert.equal((await one(db,'SELECT listening_v2.terminal_payload_valid($1::jsonb) AS ok',[p])).ok,false,JSON.stringify(p));}
 for(const s of [selectors[0],{...selectors[1],throughGeneration:M},
  {...selectors[2],targetEnvironment:maxEnv,fromGeneration:M-1,toGeneration:M}]){
  // Independently built maximum postimage, not a call to a codec sizing API.
  const p=payload(s,{environment:maxEnv,invalidatedAtMS:M,cursor:[maxEnv,U],repair:{...repair,
   originalCreatedAtMS:M,originalRetryUntilMS:M,repairOrdinal:M}});
  parseTerminalPayload(JSON.stringify(p));const r=await one(db,
   'SELECT octet_length($1::jsonb::text)::int AS n,listening_v2.terminal_payload_valid($1::jsonb) AS ok',[p]);
  assert.equal(r.ok,true);assert.ok(r.n<=4096);
 }
 // JSONB discards duplicate/escaped-key and exponent spelling; only raw JS is
 // authoritative for those lexical refusals. SQL is authoritative for bytes.
 for(const raw of ['{"version":2,"version":2}',JSON.stringify(payload()).replace('"invalidatedAtMS":0','"invalidatedAtMS":1e0')])
  assert.throws(()=>parseTerminalPayload(raw),{code:'invalid_request'});
 await rejected(insert(db,await job(db,payload(selectors[0],{invalidatedAtMS:M}))));
});

test('legacy NULL/0 metadata and SQL-seeded known v1 preimages: immutable tuple/version, monotone generation, no DELETE',async t=>{
 const db=await fixture(t);await db.exec("INSERT INTO public.library_users(id) VALUES('fixture-owner')");
 const seed=async(key,version=null,extra={})=>{
  const r={key_id:key,user_id:'fixture-owner',audience:'test',bundle_id:'test.lyrica',environment:'development',
   public_key:'fixture-not-attestation',receipt:Buffer.from('fixture'),sessions_install_binding_version:version,...extra};
  const keys=Object.keys(r);return db.query(`INSERT INTO public.app_attest_keys(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r));
 };
 await seed('legacy-unknown');let old=await one(db,"SELECT * FROM public.app_attest_keys WHERE key_id='legacy-unknown'");
 assert.equal(old.sessions_install_binding_version,null);assert.equal(String(old.sessions_authority_generation),'0');
 await rejected(db.exec("UPDATE public.app_attest_keys SET sessions_install_binding_version=1 WHERE key_id='legacy-unknown'"));
 await db.exec("DELETE FROM public.app_attest_keys WHERE key_id='legacy-unknown'");
 const key=Buffer.alloc(32,7).toString('base64');await seed(key,1);
 for(const field of ['key_id','bundle_id','audience','environment'])await rejected(db.query(`UPDATE public.app_attest_keys SET ${field}=$2 WHERE key_id=$1`,[key,'changed']));
 await rejected(db.query('UPDATE public.app_attest_keys SET sessions_install_binding_version=NULL WHERE key_id=$1',[key]));
 for(const k of ['bad',key.replace(/=$/,''),key.slice(0,42)+'B='])await rejected(seed(k,1));
 for(const [field,value] of [['bundle_id','bad bundle'],['audience','bad audience'],['environment','test']])await rejected(seed(Buffer.alloc(32,8).toString('base64'),1,{[field]:value}));
 for(const n of [1,M])await db.query('UPDATE public.app_attest_keys SET sessions_authority_generation=$2 WHERE key_id=$1',[key,n]);
 for(const n of [0,-1,null,'9007199254740992'])await rejected(db.query('UPDATE public.app_attest_keys SET sessions_authority_generation=$2 WHERE key_id=$1',[key,n]));
 await rejected(db.query('DELETE FROM public.app_attest_keys WHERE key_id=$1',[key]));
 // Existing scrub/sign counter writes remain representable; v1 is seeded,
 // syntactically validated metadata here, never attestation/enrollment proof.
 await db.query("UPDATE public.app_attest_keys SET revoked=true,public_key='',receipt=''::bytea,sign_count=1 WHERE key_id=$1",[key]);
 await denied(asRole(db,'lyra_runtime_v1',()=>db.query('UPDATE public.app_attest_keys SET sessions_authority_generation=0 WHERE key_id=$1',[key])));
});

test('real restricted-role default-off guest/ACK/register/session/signIn/signOut/delete retain NULL/0',async t=>{
 const db=await fixture(t,{footprint:'observed'});
 const adapter=role=>({query:(...a)=>asRole(db,role,()=>db.query(...a)),
  transaction:fn=>asRole(db,role,()=>db.transaction(fn))});
 await db.exec('UPDATE public.membership_settings SET public_access_enabled=true');
 const policy={audience:'test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']},bundleID=policy.bundles[0];
 const options={policy,attestFn:()=>({publicKey:'external-crypto-only',receipt:Buffer.from('crypto')}),
  assertionFn:({assertion})=>Number(assertion.toString()),
  apple:{authenticate:async()=>({subjectHash:d(777),refreshTokenEncrypted:'external-Apple-only'}),revoke:async()=>{}},
  spotifyCleanupFn:async()=>{}};
 const accounts=new AccountStore(adapter('lyra_account_v1'),options),auth=new AppAuthStore(adapter('lyra_runtime_v1'),options),keyID=Buffer.alloc(32,1).toString('base64');
 const credential='lyra_g_'+randomUUID().replaceAll('-','')+'abcdefghijk';
 const input={...await accounts.challenge({purpose:'guest',bundleID,keyID},null,'fixture'),credential,keyID,bundleID,attestation:'Y3J5cHRv'};
 assert.deepEqual(await accounts.guest(input),{registered:true});assert.deepEqual(await accounts.guest(input),{registered:true});
 const second=Buffer.alloc(32,2).toString('base64');
 const reg={...await auth.challenge(credential,{purpose:'register',bundleID,keyID:second}),bundleID,keyID:second,attestation:'Y3J5cHRv'};
 await auth.register(credential,reg);await auth.register(credential,reg); // existing-key ACK, no provenance upgrade
 const session=async(token,key,counter)=>{
  const c=await auth.challenge(token,{purpose:'session',bundleID,keyID:key});
  const result=await auth.session(token,{...c,bundleID,keyID:key,assertion:Buffer.from(String(counter)).toString('base64')});
  return {...result,user:await auth.authenticate(result.token)};
 };
 const g=await session(credential,keyID,1),handle=await accounts.prepareWriterAuthentication(g.token);
 const nonce=await accounts.challenge({purpose:'apple',bundleID},g.user);
 const a=await accounts.signIn(g.user,{...nonce,bundleID,identityToken:'external',authorizationCode:'external'},handle);
 const signed=await session(a.credential,keyID,2);
 const delNonce=await accounts.challenge({purpose:'delete',bundleID},signed.user);
 await accounts.delete(signed.user,{...delNonce,bundleID,identityToken:'external',authorizationCode:'external'},await accounts.prepareWriterAuthentication(signed.token));
 // Separate guest signOut avoids reusing deliberately revoked C.
 const cg=await session(credential,second,1).catch(e=>{assert.ok(['unauthorized','session_expired'].includes(e.code));return null;});
 assert.equal(cg,null,'signIn revoked shared old C');
 // Enroll a fresh guest for the actual signOut path.
 const k3=Buffer.alloc(32,3).toString('base64'),c3='lyra_g_'+randomUUID().replaceAll('-','')+'abcdefghijk';
 await accounts.guest({...await accounts.challenge({purpose:'guest',bundleID,keyID:k3},null,'fixture3'),credential:c3,keyID:k3,bundleID,attestation:'Y3J5cHRv'});
 const out=await session(c3,k3,1);await accounts.signOut(out.user,await accounts.prepareWriterAuthentication(out.token));
 const keys=(await db.query('SELECT sessions_install_binding_version,sessions_authority_generation FROM public.app_attest_keys')).rows;
 assert.equal(keys.length,3);for(const r of keys){assert.equal(r.sessions_install_binding_version,null);assert.equal(String(r.sessions_authority_generation),'0');}
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM listening_v2.outbox')).n,0);
});

test('account initial INSERT only, no repair/claim/refund/semantic or wider key privileges; old jobs unchanged',async t=>{
 const db=await fixture(t),j=await job(db);
 await asRole(db,'lyra_account_v1',async()=>{
  await insert(db,j);await denied(change(db,j,{state:'claimed'}));await denied(change(db,j,{attempt_count:0}));
  await denied(insert(db,await job(db,payload(selectors[1],{repair}))));
  await denied(db.exec('DELETE FROM listening_v2.outbox'));await denied(db.exec('TRUNCATE listening_v2.outbox'));
  await denied(db.exec("INSERT INTO listening_v2.semantic_events(environment) VALUES('test')"));
 });
 await asRole(db,'terminal_untrusted',async()=>{await denied(insert(db,await job(db)));await denied(db.exec('SELECT * FROM listening_v2.outbox'));});
 const p={version:2,environment:env,selector:{kind:'credential',value:d(99)},cursor:null,invalidatedAtMS:0};
 const old=await job(db,p,{kind:'privacy_dependency'});old.job_key='privacy-dependency:'+old.job_id;await insert(db,old);
 // Old privacy family's cumulative claim accounting is deliberately untouched.
 await change(db,old,{state:'claimed',attempt_count:1,claim_epoch:1,claim_nonce_hash:d(9),claim_until_ms:old.retry_until_ms});
 await change(db,old,{state:'pending',...cleared,payload:{...p,cursor:['preview:other',U]}});
 assert.equal((await row(db,old)).attempt_count,1);
 for(const field of ['room_id','guard_id','persona_id','asset_id','privacy_generation','guard_revision','send_ordinal'])
  await rejected(insert(db,await job(db,payload(selectors[1]),{[field]:field.endsWith('_id')?U:0})));
 await rejected(insert(db,await job(db,payload(selectors[1]),{job_key:'wrong'})));
 await rejected(insert(db,await job(db,payload(selectors[1]),{state:'cancelled'})));
});

test('row claim/progress/refund: nine failures plus arbitrarily many successful pages including live10 -> pending9',async t=>{
 const db=await fixture(t),j=await job(db);await insert(db,j);
 await asRole(db,'lyra_runtime_v1',async()=>{
  for(let n=1;n<=9;n++){await claim(db,j);await failClaim(db,j);assert.equal((await row(db,j)).attempt_count,n);}
  for(let n=1;n<=12;n++){
   const c=await claim(db,j);assert.equal(c.attempt_count,10);
   await progress(db,j,[n<=6?'preview:a':'preview:z',n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000']);
   assert.equal((await row(db,j)).attempt_count,9);
  }
  await claim(db,j);await publish(db,j);const final=await row(db,j);
  assert.equal(final.state,'published');assert.equal(final.attempt_count,9);assert.equal(Number(final.claim_epoch),22);
  assert.equal(Number(final.created_at_ms),j.created_at_ms);assert.equal(Number(final.retry_until_ms),j.retry_until_ms);
 });
});

test('nonprogress, stale epoch/count/full-row CAS, source/chronology changes and terminal reopen refuse',async t=>{
 const db=await fixture(t),j=await job(db);await insert(db,j);await claim(db,j);
 const old=await row(db,j);
 for(const changes of [{attempt_count:0},{state:'pending',...cleared,attempt_count:0},
  {state:'pending',...cleared,attempt_count:0,payload:{...old.payload,cursor:null}},
  {claim_epoch:0},{claim_nonce_hash:d(999)},{attempt_count:2},{kind:'privacy_dependency'},
  {created_at_ms:j.created_at_ms+1},{retry_until_ms:j.retry_until_ms+1},
  {payload:{...old.payload,invalidatedAtMS:1}},{payload:{...old.payload,selector:selectors[1]}}])await rejected(change(db,j,changes));
 const image=(await one(db,'SELECT to_jsonb(o)::text AS image FROM listening_v2.outbox o WHERE job_id=$1',[j.job_id])).image;
 await progress(db,j,['test',U]);
 const stale=await db.query(`UPDATE listening_v2.outbox o SET attempt_count=0 WHERE job_id=$1 AND to_jsonb(o)=$2::jsonb RETURNING job_id`,[j.job_id,image]);
 assert.equal(stale.rows.length,0);
 await claim(db,j);await rejected(progress(db,j,['test',U]));await rejected(progress(db,j,['preview:a',U]));
 await publish(db,j);
 await rejected(change(db,j,{state:'pending',completed_at_ms:null,delete_after_ms:null,payload:{...old.payload}}));
 await rejected(db.query('DELETE FROM listening_v2.outbox WHERE job_id=$1',[j.job_id]));
});

test('ten genuine failures dead; exact predecessor repair handoff keeps debt truth and unique unfinished selector',async t=>{
 const db=await fixture(t),j=await job(db);await insert(db,j);
 await duplicate(insert(db,await job(db,payload(selectors[0],{invalidatedAtMS:1})))); // timestamp is no new era
 for(let n=0;n<10;n++){await claim(db,j);await failClaim(db,j);}
 const dead=await row(db,j);assert.equal(dead.state,'dead');assert.equal(dead.attempt_count,10);
 await rejected(claim(db,j));await rejected(change(db,j,{state:'pending',completed_at_ms:null,delete_after_ms:null}));
 await duplicate(insert(db,await job(db)));
 await rejected(change(db,j,{state:'published',attempt_count:9}));
 await rejected(change(db,j,{state:'published',payload:{...dead.payload,phase:'complete'}}));
 const successor=await job(db,payload(selectors[0],{repair:{rootJobID:j.job_id,predecessorJobID:j.job_id,
  originalCreatedAtMS:j.created_at_ms,originalRetryUntilMS:j.retry_until_ms,repairOrdinal:1}}));
 // ROW characterization only: no repairTerminalDebt API or source proof exists.
 await assert.rejects(db.transaction(async tx=>{await change(tx,j,{state:'published'});await insert(tx,successor);throw Error('fault');}),/fault/);
 assert.equal((await row(db,j)).state,'dead');assert.equal(await row(db,successor),undefined);
 await db.transaction(async tx=>{await change(tx,j,{state:'published'});await insert(tx,successor);});
 const handed=await row(db,j);assert.deepEqual({...handed,state:'dead'},dead);
 assert.equal((await row(db,successor)).attempt_count,0);
});

test('seeded expired claim retains one debit, fresh reclaim adds one, old full CAS and expired refund refuse',async t=>{
 const db=await fixture(t),at=await clock(db),j=await job(db,payload(),{created_at_ms:at-2000,due_at_ms:at-2000});
 // Owner-only historical PREIMAGE seed. Actual CHECKs remain installed. This
 // does not qualify the real claim/crash path and is not a clock/timing test.
 await db.transaction(async tx=>{await tx.exec('ALTER TABLE listening_v2.outbox DISABLE TRIGGER outbox_terminal_protect');
  await insert(tx,{...j,state:'claimed',attempt_count:1,claim_epoch:1,claim_nonce_hash:d(123),claim_until_ms:at-1});
  await tx.exec('ALTER TABLE listening_v2.outbox ENABLE TRIGGER outbox_terminal_protect');});
 await rejected(progress(db,j,['test',U]));const image=(await one(db,'SELECT to_jsonb(o)::text AS image FROM listening_v2.outbox o WHERE job_id=$1',[j.job_id])).image;
 const c=await claim(db,j);assert.equal(c.attempt_count,2);assert.equal(Number(c.claim_epoch),2);
 assert.equal((await db.query(`UPDATE listening_v2.outbox o SET attempt_count=0 WHERE job_id=$1 AND to_jsonb(o)=$2::jsonb RETURNING job_id`,[j.job_id,image])).rows.length,0);
 await progress(db,j,['test',U]);assert.equal((await row(db,j)).attempt_count,1);
});

// LT01 assertions frozen before the privilege implementation. No semantic red
// has been executed. Old-source 42501 pin/import refusal is never semantic red.
for(const footprint of ['minimal','observed'])test('LT01 '+footprint+': old key rights survive; both metadata columns are withheld',async t=>{
 const db=await fixture(t,{apply:false,footprint}),before=await keyRights(db);
 await db.exec(await sqlFile(migrationName));assert.deepEqual(await keyRights(db),before);
 await db.exec("INSERT INTO library_users(id) VALUES('lt01-owner')");
 const seed=(client,key,metadata=false)=>client.query(`INSERT INTO public.app_attest_keys
 (key_id,user_id,audience,bundle_id,environment,public_key,receipt,sign_count,revoked,created_at${metadata?',sessions_install_binding_version':''})
 VALUES($1,'lt01-owner','test','test.lyrica','development','synthetic-not-attestation',''::bytea,0,false,now()${metadata?',1':''})`,[key]);
 const anchor=Buffer.alloc(32,41).toString('base64');await seed(db,anchor,true); // OWNER ONLY, syntax not provenance.
 for(const role of ['lyra_runtime_v1','lyra_account_v1']){
  for(const column of metadataColumns)for(const action of ['INSERT','UPDATE'])
   assert.equal((await one(db,'SELECT has_column_privilege($1,$2,$3,$4) AS ok',[role,'public.app_attest_keys',column,action])).ok,false);
  await denied(asRole(db,role,()=>seed(db,Buffer.alloc(32,role==='lyra_runtime_v1'?42:43).toString('base64'),true)));
  await denied(asRole(db,role,()=>db.query('UPDATE public.app_attest_keys SET sessions_authority_generation=1 WHERE key_id=$1',[anchor])));
  await denied(asRole(db,role,()=>db.query('UPDATE public.app_attest_keys SET sessions_install_binding_version=NULL WHERE key_id=$1',[anchor])));
  const canWrite=role==='lyra_account_v1'||footprint==='observed',legacy='lt01-'+role;
  if(canWrite){
   await asRole(db,role,()=>seed(db,legacy));
   const r=await one(db,'SELECT sessions_install_binding_version AS v,sessions_authority_generation::text AS g FROM public.app_attest_keys WHERE key_id=$1',[legacy]);
   assert.deepEqual(r,{v:null,g:'0'});
   // Each old column requires its preserved positive UPDATE right. Immutable
   // tuple fields are assigned to themselves; actual edits still hit 23514.
   for(const column of oldKeyColumns)await asRole(db,role,()=>db.query('UPDATE public.app_attest_keys SET '+column+'='+column+' WHERE key_id=$1',[legacy]));
   await asRole(db,role,()=>db.query("UPDATE public.app_attest_keys SET revoked=true,public_key='',receipt=''::bytea,sign_count=1 WHERE key_id=$1",[legacy]));
  }else await denied(asRole(db,role,()=>seed(db,legacy)));
 }
 await assert.rejects(asRole(db,'lyra_account_v1',()=>db.query('DELETE FROM public.app_attest_keys WHERE key_id=$1',[anchor])),{code:'23514'});
 await rejected(db.query("UPDATE public.app_attest_keys SET sessions_install_binding_version=1 WHERE key_id='lt01-lyra_account_v1'"));
 await db.query('UPDATE public.app_attest_keys SET sessions_authority_generation=1 WHERE key_id=$1',[anchor]);
 await rejected(db.query('UPDATE public.app_attest_keys SET sessions_authority_generation=0 WHERE key_id=$1',[anchor]));
});

for(const lateRoles of [false,true])for(const footprint of ['minimal','observed'])test('LT01 actual replay '+footprint+' lateRoles='+lateRoles,async t=>{
 const db=await fixture(t,{footprint,lateRoles});
 if(lateRoles)await replayMembershipRoleGrants({query:text=>db.exec(text)});
 const before=await keyRights(db);
 await replayMembershipRoleGrants({query:text=>db.exec(text)});
 await replayMembershipRoleGrants({query:text=>db.exec(text)});
 assert.deepEqual(await keyRights(db),before);
 for(const role of ['lyra_runtime_v1','lyra_account_v1'])for(const column of metadataColumns)for(const action of ['INSERT','UPDATE'])
  assert.equal((await one(db,'SELECT has_column_privilege($1,$2,$3,$4) AS ok',[role,'public.app_attest_keys',column,action])).ok,false);
});

test('LT01 replay without metadata keeps the schema-absent V1 permissions',async t=>{
 const db=await fixture(t,{apply:false,footprint:'observed'}),before=await keyRights(db);
 await replayMembershipRoleGrants({query:text=>db.exec(text)});assert.deepEqual(await keyRights(db),before);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='public.app_attest_keys'::regclass AND attname=ANY($1::text[]) AND NOT attisdropped",[metadataColumns])).n,0);
});

for(const drift of [
 'ALTER TABLE public.app_attest_keys DROP COLUMN sessions_install_binding_version',
 'ALTER TABLE public.app_attest_keys ADD COLUMN unexpected text',
 'ALTER TABLE public.app_attest_keys ALTER COLUMN sessions_authority_generation DROP DEFAULT',
 'ALTER TABLE public.app_attest_keys ALTER COLUMN sessions_install_binding_version SET DEFAULT 1',
 'ALTER TABLE public.app_attest_keys DISABLE TRIGGER app_attest_keys_sessions_metadata_protect',
 'GRANT INSERT,UPDATE ON public.app_attest_keys TO PUBLIC',
 'ALTER TABLE public.app_attest_keys OWNER TO lyra_account_v1',
 'GRANT INSERT,UPDATE ON public.app_attest_keys TO terminal_untrusted; GRANT terminal_untrusted TO lyra_account_v1 WITH INHERIT TRUE'
])test('LT01 replay refuses catalog/residual authority drift atomically: '+drift,async t=>{
 const db=await fixture(t,{footprint:'observed'});
 await db.exec(drift);
 const before=await catalog(db);
 await assert.rejects(replayMembershipRoleGrants({query:text=>db.exec(text)}),{code:'23514'});
 // No partial replay effects. In particular 025 cannot leave broad key grants.
 assert.deepEqual(await catalog(db),before);
});
