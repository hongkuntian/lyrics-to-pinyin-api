import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {createPrivateAdmissionService} from '../../api/utils/listening-v2/privacy-context.js';
import {createAdmissionState,restoreAdmissionState} from '../../api/utils/listening-v2/admission.js';

const env='test',day=86400000,roomID='00000000-0000-4000-8000-000000000001';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=s=>createHash('sha256').update(s).digest('hex');
const key=n=>Buffer.alloc(32,n+1).toString('base64');
const user=n=>`g${n}`,pid=n=>uuid(100+n),rid=n=>uuid(300+n),mid=n=>uuid(200+n);
const bearer=n=>`lyra_s_privacy_fixture_${n}`,credential=n=>`credential-${n}`;
const policy={audience:'privacy-test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
const binding={version:1,secret:Buffer.alloc(32,4)},pairKey={version:1,secret:Buffer.alloc(32,5)};
const ticket={id:'unused-private',secret:Buffer.alloc(32,6)},hostScope=hash('host-scope');
const pairDigest=n=>createHmac('sha256',pairKey.secret).update(JSON.stringify(['sessions-v2.returning-pair',1,env,hostScope,key(n)])).digest('hex');
const install=n=>({principalID:user(n),keyID:key(n),bundleID:policy.bundles[0],audience:policy.audience,attestEnvironment:policy.environment});
const pref=n=>({id:pid(n),generation:1});
let sql,start,deadline,queries,fault,abuseCalls;
const db={query:(...a)=>sql.query(...a),transaction:fn=>sql.transaction(tx=>fn({query:async(text,params=[])=>{
 queries.push({text,params:structuredClone(params)});const result=await tx.query(text,params);
 if(fault)await fault({text,params,result,tx});return result;
}}))};
function config(extra={}){return {db,environment:env,policy:structuredClone(policy),bindingKeys:[{...binding,secret:Buffer.from(binding.secret)}],
 activeBindingKeyVersion:1,receiptKeyPolicy:{environment:env,keys:[{version:1,verificationHash:createHmac('sha256',binding.secret)
 .update(JSON.stringify(['sessions-v2.receipt-key-check',1,env])).digest('hex')}]},ticketKeys:[ticket],activeTicketKeyID:ticket.id,
 pairKeys:[pairKey],pairPolicyRevision:1,antiAbuse:{authorize:async request=>{
  abuseCalls++;return {...request,status:'allowed',notAfterMS:deadline};
 }},...extra};}
const service=extra=>createPrivateAdmissionService(config(extra));
function command(n,action='admission.decide',payload={requestID:rid(1),decision:'approve'},expected={requestVersion:1},id=randomUUID()){
 return {bearer:bearer(n),rawCommand:JSON.stringify({version:2,action,sessionID:roomID,commandID:id,expected,payload})};
}
const query=n=>({bearer:bearer(n),rawQuery:JSON.stringify({version:2,action:'admission.read',sessionID:roomID,payload:{requestID:rid(n)}})});
const leave=n=>command(n,'leave',{}, {memberLeaseVersion:1});
const cancel=n=>command(n,'admission.cancel',{requestID:rid(n)},{requestVersion:1});
async function room(){return (await sql.query('SELECT * FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2',[env,roomID])).rows[0];}
async function saveState(s){
 s=restoreAdmissionState(JSON.stringify(s));const guests=s.members.filter(m=>m.status==='active'&&m.id!==mid(0)).length;
 const meta={version:1,miscCount:0,reservedEvents:s.pending.length*3+guests,reservedReceipts:s.pending.length*2+guests+1,storefront:'us'};
 await sql.query(`UPDATE listening_v2.rooms SET state=$3,privacy_persona_ids=$4,reserved_semantic_events=$5,reserved_receipts=$6,
 state_version=$7,session_revision=$8,settings_revision=$9,updated_at_ms=$10,invite_generation=1 WHERE environment=$1 AND session_id=$2`,
 [env,roomID,{occurrences:[],visits:[],admission:s,admissionStore:meta},[...new Set([...s.members,...s.pending].map(x=>x.persona.id))].sort(),
 meta.reservedEvents,meta.reservedReceipts,s.stateVersion+1,s.membershipRevision,s.settings.revision,s.updatedAtMS]);
}
async function seedPerson(n,{kind='guest',expires=deadline}={}){
 await sql.query('INSERT INTO library_users(id,access_kind) VALUES($1,$2)',[user(n),kind]);
 await sql.query('INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,to_timestamp($3::numeric/1000))',[hash(credential(n)),user(n),expires]);
 await sql.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
 VALUES($1,$2,$3,$4,$5,'synthetic-external-crypto',decode('00','hex'))`,[key(n),user(n),policy.audience,policy.bundles[0],policy.environment]);
 await sql.query(`INSERT INTO app_auth_sessions(digest,key_id,credential_digest,audience,expires_at)
 VALUES($1,$2,$3,$4,to_timestamp($5::numeric/1000))`,[hash(bearer(n)),key(n),hash(credential(n)),policy.audience,start+600000]);
 await sql.query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
 controller_kind,controller_principal_id,controller_key_id,privacy_generation,guest_credential_digest,guest_credential_expires_at_ms,created_at_ms,updated_at_ms)
 VALUES($1,$2,$3,$4,$5,$3,$6,1,$7,$8,$9,$9)`,[env,pid(n),user(n),key(n),kind,kind==='guest'?key(n):null,
 kind==='guest'?hash(credential(n)):null,kind==='guest'?expires:null,start]);
}
function pending(n){return {id:rid(n),version:1,status:'pending',install:install(n),persona:pref(n),pairDigest:pairDigest(n),
 profileReference:`p${n}`,profileRevision:1,roomConsentRevision:1,inviteGeneration:1,createdAtMS:start,expiresAtMS:start+120000};}
function member(n,status='active'){return {id:mid(n),install:install(n),persona:pref(n),profileReference:`p${n}`,profileRevision:1,
 roomConsentRevision:1,status,leaseVersion:status==='active'?1:2,firstJoinOrdinal:n,joinedAtMS:start,endedAtMS:status==='active'?null:start};}
async function snapshot(){const rows={};for(const table of ['rooms','privacy_personas','returning_grants','semantic_events','outbox','command_receipts','output_guards'])
 rows[table]=(await sql.query(`SELECT to_jsonb(t) AS row FROM listening_v2.${table} t ORDER BY to_jsonb(t)::text`)).rows;return rows;}
async function refusesUnchanged(work,code){const prior=await snapshot();await assert.rejects(work,{code});assert.deepEqual(await snapshot(),prior);}
before(async()=>{
 sql=new PGlite();for(const file of ['001-song-library.sql','021-app-auth.sql','025-memberships.sql','030-listening-v2-schema.sql','033-listening-v2-lifecycle-composition.sql'])
 await sql.exec(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
 await sql.query(`INSERT INTO listening_v2.output_guards(environment,guard_id,provider,binding_key_version,account_binding,connection_lineage,output_scope,
 scope_kind,original_install_scope,created_at_ms,updated_at_ms,bootstrap_state,lane_state,send_ordinal,execution_id,
 claim_nonce_hash,claim_until_ms,endpoint_body_hash,may_have_been_sent,reserved_visit_credits,reserved_semantic_events)
 VALUES('test',$1,'appleMusic',1,$2,$2,$2,'captured_output',$2,1,1,'legacy_quarantined','uncertain',1,
 '00000000-0000-4000-8000-000000000998',$2,100,$2,true,3,3)`,[uuid(999),hash('guard')]);
});
after(()=>sql.close());
beforeEach(async()=>{
 fault=null;queries=[];abuseCalls=0;
 await sql.exec(`TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,listening_v2.rooms,
 listening_v2.returning_grants,listening_v2.private_profile_assets,listening_v2.privacy_personas;
 TRUNCATE library_users CASCADE;`);
 start=Number((await sql.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms')).rows[0].ms)-100;
 deadline=start+day;for(let n=0;n<4;n++)await seedPerson(n);
 const s=createAdmissionState({environment:env,sessionID:roomID,nowMS:start,expiresAtMS:start+28800000,title:'Private',
 host:{install:install(0),persona:pref(0),profile:{reference:'p0',revision:1,roomConsentRevision:1,persona:pref(0)},memberID:mid(0),scope:hostScope}});
 await sql.query(`INSERT INTO listening_v2.rooms(environment,session_id,host_install_scope,host_persona_id,host_privacy_generation,
 privacy_persona_ids,provider,invite_digest,code_digest,state,created_at_ms,expires_at_ms,updated_at_ms)
 VALUES($1,$2,$3,$4,1,$5,'appleMusic',$6,$7,$8,$9,$10,$9)`,[env,roomID,hostScope,pid(0),[pid(0)],hash('invite'),hash('code'),
 {occurrences:[],visits:[],admission:s},start,start+28800000]);
 await saveState({...s,pending:[pending(1)],lifetimeRequestCount:1,stateVersion:1});queries=[];
});

test('real AppAuthStore/current-auth/admission/receipt composition approves and retries exactly once',async()=>{
 const s=service(),input=command(0);const result=await s.execute(input);
 assert.equal(result.status,'accepted');assert.equal(result.replayed,false);assert.equal((await room()).state.admission.members.length,2);
 const before=await snapshot();assert.equal((await s.execute(input)).replayed,true);assert.deepEqual(await snapshot(),before);assert.equal(abuseCalls,1);
 assert.equal((await sql.query('SELECT grant_generation FROM listening_v2.returning_grants')).rows[0].grant_generation,1);
 assert.equal((await sql.query('SELECT payload FROM listening_v2.semantic_events WHERE event_id=$1',[rid(1)])).rows[0].payload.status,'admitted');
});
test('deny and own cancel execute without an external positive-work permit',async()=>{
 const s=service({antiAbuse:null});assert.equal((await s.execute(command(0,'admission.decide',{requestID:rid(1),decision:'deny'}))).status,'accepted');
 const state=(await room()).state.admission;await saveState({...state,pending:[pending(2)],lifetimeRequestCount:2});
 assert.equal((await s.execute(cancel(2))).status,'accepted');
 assert.equal((await sql.query('SELECT count(*)::int n FROM listening_v2.returning_grants WHERE status=\'active\'')).rows[0].n,0);
});
test('active guest can approve; exact Leave receipt retries and lookup remain readable after lease closes',async()=>{
 const s=service();await s.execute(command(0));const state=(await room()).state.admission;
 await saveState({...state,pending:[pending(2)],lifetimeRequestCount:2});await s.execute(command(1,'admission.decide',{requestID:rid(2),decision:'approve'}));
 const input=leave(1);await s.execute(input);const prior=await snapshot();
 assert.equal((await s.execute(input)).replayed,true);assert.equal((await s.readReceipt(input)).replayed,true);assert.deepEqual(await snapshot(),prior);
 await refusesUnchanged(()=>s.execute(command(1,'admission.decide',{requestID:rid(2),decision:'deny'})),'forbidden');
});
test('revoked OTHER guest blocks host approval, denial and saved receipt before changed-hash disclosure',async()=>{
 const s=service(),input=command(0);await s.execute(input);
 await sql.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[hash(credential(1))]);
 await refusesUnchanged(()=>s.execute(input),'unauthorized');
 const altered={...input,rawCommand:input.rawCommand.replace('approve','deny')};await refusesUnchanged(()=>s.execute(altered),'unauthorized');
 await refusesUnchanged(()=>s.readReceipt(input),'unauthorized');
});
test('all guest dependency checks apply to nonactor pending and grant sides',async()=>{
 const edits=[['UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user(1)]],
 ['UPDATE library_users SET disabled=true WHERE id=$1',[user(1)]],['UPDATE app_attest_keys SET revoked=true WHERE key_id=$1',[key(1)]],
 ['UPDATE library_tokens SET expires_at=NULL WHERE user_id=$1',[user(1)]],
 ['UPDATE library_tokens SET expires_at=expires_at+interval \'1 millisecond\' WHERE user_id=$1',[user(1)]],
 ['UPDATE library_tokens SET expires_at=\'infinity\' WHERE user_id=$1',[user(1)]],
 ['UPDATE library_tokens SET user_id=$2 WHERE digest=$1',[hash(credential(1)),user(2)]],
 ['UPDATE app_attest_keys SET audience=\'wrong\' WHERE key_id=$1',[key(1)]]];
 for(const [text,args] of edits){await sql.query(text,args);
 await assert.rejects(service().execute(command(0)),e=>['unauthorized','unavailable'].includes(e.code));
 await sql.query('UPDATE library_tokens SET user_id=$2,revoked=false,expires_at=to_timestamp($3::numeric/1000) WHERE digest=$1',[hash(credential(1)),user(1),deadline]);
 await sql.query('UPDATE library_users SET disabled=false WHERE id=$1',[user(1)]);
 await sql.query('UPDATE app_attest_keys SET revoked=false,audience=$2 WHERE key_id=$1',[key(1),policy.audience]);}
});
test('closed withdrawn history preserves negative markers without requiring its old credential',async()=>{
 const state=(await room()).state.admission;await saveState({...state,members:[state.members[0],member(1,'removed')],
 pending:[pending(2)],lifetimeMemberCount:2,lifetimeRequestCount:2});
 await sql.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,withdrawn_at_ms=$2,scrub_due_at_ms=$2,
 updated_at_ms=$2 WHERE persona_id=$1`,[pid(1),start]);
 await sql.query('DELETE FROM app_auth_sessions WHERE key_id=$1',[key(1)]);await sql.query('DELETE FROM library_tokens WHERE user_id=$1',[user(1)]);
 await sql.query('UPDATE app_attest_keys SET revoked=true WHERE key_id=$1',[key(1)]);
 assert.equal((await service().execute(cancel(2))).status,'accepted');assert.equal((await room()).state.admission.members[1].status,'removed');
 assert(!queries.some(q=>q.text.includes('library_tokens')&&q.text.includes('FOR UPDATE')&&q.params.includes(hash(credential(1)))));
});
test('withdrawn targeted terminal hydration refuses and preserves the exact winner',async()=>{
 const s=service();await s.execute(command(0,'admission.decide',{requestID:rid(1),decision:'deny'}));
 await sql.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,withdrawn_at_ms=$2,scrub_due_at_ms=$2,
 updated_at_ms=$2 WHERE persona_id=$1`,[pid(1),start]);
 await refusesUnchanged(()=>s.execute(command(0)),'unauthorized');
});
test('targeted admission read is requester-only, minimal and currently authorized',async()=>{
 const s=service();const pendingResult=await s.readAdmission(query(1));assert.equal(pendingResult.admission.status,'pending');
 await refusesUnchanged(()=>s.readAdmission({...query(1),bearer:bearer(0)}),'not_found');
 await s.execute(command(0));const result=await s.readAdmission(query(1));assert.equal(result.admission.status,'admitted');
 assert.equal(result.admission.memberLeaseVersion,1);assert(!JSON.stringify(result).includes('principal'));
 await s.execute(leave(1));assert.equal((await s.readAdmission(query(1))).admission.memberLeaseVersion,1);
 await sql.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user(1)]);
 await assert.rejects(s.readAdmission(query(1)),{code:'unauthorized'});
});
test('new identity or room reference after nonlocking discovery aborts without late earlier locks',async()=>{
 const s=service();let changed=false;
 fault=async({text,tx})=>{if(!changed&&text.includes('library_users')&&text.includes('FOR UPDATE')){
 changed=true;const r=(await tx.query('SELECT state FROM listening_v2.rooms WHERE session_id=$1',[roomID])).rows[0];
 r.state.admission.pending.push(pending(2));r.state.admission.lifetimeRequestCount++;
 await tx.query('UPDATE listening_v2.rooms SET state=$2 WHERE session_id=$1',[roomID,r.state]);
 }};
 await refusesUnchanged(()=>s.execute(command(0)),'conflict');
 assert(changed);assert(!queries.some(q=>q.text.includes('FOR UPDATE')&&q.params.includes(key(2))));
});
test('controller drift and retained installation metadata substitution fail closed',async()=>{
 let changed=false;fault=async({text,tx})=>{if(!changed&&text.includes('library_users')&&text.includes('FOR UPDATE')){
 changed=true;await tx.query(`UPDATE listening_v2.privacy_personas SET controller_kind='apple',controller_principal_id=$2,
 controller_key_id=NULL,guest_credential_digest=NULL,guest_credential_expires_at_ms=NULL,privacy_generation=2,private_transfer_from_generation=1 WHERE persona_id=$1`,[pid(1),user(2)]);
 }};
 await refusesUnchanged(()=>service().execute(command(0)),'conflict');fault=null;
 const state=(await room()).state.admission;state.pending[0].install.bundleID='forged.bundle';await saveState(state);
 await refusesUnchanged(()=>service().execute(command(0)),'unavailable');
});
test('binding descriptors independently reject replacement secrets; config and request extension fields refuse',async()=>{
 assert.throws(()=>service({bindingKeys:[{version:1,secret:Buffer.alloc(32,99)}]}),{code:'unavailable'});
 assert.throws(()=>service({now:()=>0}),{code:'unavailable'});
 await assert.rejects(service().execute({...command(0),authentication:{principalID:user(0)}}),{code:'invalid_request'});
 const c=config(),s=createPrivateAdmissionService(c);c.policy.bundles[0]='changed';c.bindingKeys[0].secret.fill(99);
 c.receiptKeyPolicy.keys[0].verificationHash='0'.repeat(64);assert.equal((await s.execute(command(0))).status,'accepted');
});
test('missing or mismatched external antiabuse and pair boundaries do not authorize positive work',async()=>{
 await refusesUnchanged(()=>service({antiAbuse:null}).execute(command(0)),'unavailable');
 await refusesUnchanged(()=>service({pairKeys:[]}).execute(command(0)),'unavailable');
 await refusesUnchanged(()=>service({antiAbuse:{authorize:async r=>({...r,status:'allowed',keyID:key(2),notAfterMS:deadline})}}).execute(command(0)),'unavailable');
});
test('wrong and renewed exact bearer; actual assertion boundary renewal does not withdraw persona',async()=>{
 const s=service(),input=cancel(1);await s.execute(input);
 const auth=new AppAuthStore(db,{policy,assertionFn:()=>1});
 const {challenge}=await auth.challenge(credential(1),{keyID:key(1),bundleID:policy.bundles[0],purpose:'session'});
 const renewed=await auth.session(credential(1),{keyID:key(1),bundleID:policy.bundles[0],challenge,assertion:'AA=='});
 await assert.rejects(s.execute(input),{code:'unauthorized'});
 assert.equal((await s.execute({...input,bearer:renewed.token})).replayed,true);
 await assert.rejects(s.execute({...input,bearer:'lyra_s_wrong'}),{code:'unauthorized'});
 assert.equal((await sql.query('SELECT privacy_generation FROM listening_v2.privacy_personas WHERE persona_id=$1',[pid(1)])).rows[0].privacy_generation,1);
});
test('unsupported commands cannot enter a transaction or acquire audio/guard authority',async()=>{
 const s=service();for(const action of ['create','profile.update','invitation.resolve','host.capture','end','admission.request','admission.expire','remembered.forget']){
 await assert.rejects(s.execute(command(0,action)),{code:'unavailable'});
 }assert.equal(queries.length,0);
});
test('all transactions use auth anchors before personas, host absence anchor before grants and room; guards unchanged',async()=>{
 const before=(await snapshot()).output_guards;await service().execute(command(0));
 const locks=queries.filter(q=>/FOR UPDATE/.test(q.text));
 const at=s=>locks.findIndex(q=>q.text.includes(s));
 assert(at('library_users')<at('library_tokens'));assert(at('library_tokens')<at('app_attest_keys'));
 assert(at('app_attest_keys')<at('app_auth_sessions'));assert(at('app_auth_sessions')<at('privacy_personas'));
 assert(at('privacy_personas')<at('returning_grants'));assert(at('returning_grants')<at('rooms'));
 assert(locks.some(q=>q.text.includes('app_attest_keys')&&q.params.includes(key(0))));
 assert.equal(queries.filter(q=>q.text==='SELECT pg_current_xact_id()::text AS transaction_id').length>=1,true);
 assert.deepEqual((await snapshot()).output_guards,before);
 assert(!queries.some(q=>/UPDATE|INSERT|DELETE/.test(q.text)&&/output_guards|spotify|app_auth_sessions|privacy_personas/.test(q.text)&&!q.text.includes('FOR UPDATE')));
});

test('fresh materialized DB time rolls back all writes when OTHER guest expires during receipt insertion',async()=>{
 const expires=Number((await sql.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms)+500;
 await seedPerson(4,{expires});const state=(await room()).state.admission;
 await saveState({...state,pending:[pending(4)]});let crossed=false;
 fault=async({text,tx})=>{if(!crossed&&text.includes('INSERT INTO listening_v2.command_receipts')){
  crossed=true;await new Promise(resolve=>setTimeout(resolve,Math.max(0,expires-Date.now()+10)));
  const r=(await tx.query(`SELECT expires_at>now() AS stale,expires_at<=clock_timestamp() AS expired FROM library_tokens WHERE user_id=$1`,[user(4)])).rows[0];
  assert.equal(r.stale,true);assert.equal(r.expired,true);
 }};
 await refusesUnchanged(()=>service().execute(command(0,'admission.decide',{requestID:rid(4),decision:'approve'})),'unauthorized');assert(crossed);
 fault=null;assert.equal((await sql.query('SELECT status FROM listening_v2.privacy_personas WHERE persona_id=$1',[pid(4)])).rows[0].status,'live');
 await refusesUnchanged(()=>service().execute(command(0,'admission.decide',{requestID:rid(4),decision:'deny'})),'unauthorized');
 await assert.rejects(service().readAdmission(query(4)),{code:'unauthorized'});
});
test('all audiences lose a retained result at the bound OTHER guest deadline without cleanup',async()=>{
 const expires=Number((await sql.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms)+500;
 await seedPerson(4,{expires});const state=(await room()).state.admission;await saveState({...state,pending:[pending(4)]});
 const s=service(),input=command(0,'admission.decide',{requestID:rid(4),decision:'approve'});await s.execute(input);
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,expires-Date.now()+10)));
 await refusesUnchanged(()=>s.execute(input),'unauthorized');await refusesUnchanged(()=>s.readReceipt(input),'unauthorized');
 await assert.rejects(s.readAdmission(query(4)),{code:'unauthorized'});
 assert.equal((await sql.query('SELECT privacy_generation,status FROM listening_v2.privacy_personas WHERE persona_id=$1',[pid(4)])).rows[0].privacy_generation,1);
});
test('hundreds of unrelated historical terminals do not enter auth discovery; each live anchor locks once',async()=>{
 // One retained negative persona, no credential/key requirement for its unrelated history.
 await sql.query(`INSERT INTO listening_v2.semantic_events(environment,session_id,event_id,seq,lane,lane_seq,state_version,type,
 actor_persona_id,actor_privacy_generation,payload,server_at_ms,delete_after_ms)
 SELECT $1,$2,('00000000-0000-4000-8000-'||lpad((10000+n)::text,12,'0'))::uuid,n,'semantic',n,1,'admission.terminal',
 $3,1,jsonb_build_object('version',2,'status','cancelled','pairDigest',$4::text),$5::bigint,$6::bigint FROM generate_series(1,299) n`,
 [env,roomID,pid(3),pairDigest(3),start,start+day]);
 await sql.query('UPDATE listening_v2.rooms SET event_seq=299,semantic_event_count=299 WHERE session_id=$1',[roomID]);
 await sql.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user(3)]);queries=[];
 await service().execute(command(0));
 const locks=queries.filter(q=>q.text.includes('FOR UPDATE'));
 for(const table of ['library_users','library_tokens','app_attest_keys']){
  const relevant=locks.filter(q=>q.text.includes('public.'+table));assert.equal(relevant.length,2);
  assert.equal(new Set(relevant.map(q=>JSON.stringify(q.params))).size,relevant.length);
 }
 assert(!locks.some(q=>q.params.includes(key(3))||q.params.includes(pid(3))||q.params.includes(hash(credential(3)))));
 assert(queries.filter(q=>q.text.includes('FROM listening_v2.semantic_events')).every(q=>q.text.includes('event_id=$2')));
});
test('saved receipt, targeted reference and xid substitution after discovery all roll back',async()=>{
 const s=service(),input=command(0);await s.execute(input);let changed=false;
 fault=async({text,tx})=>{if(!changed&&text.includes('library_users')&&text.includes('FOR UPDATE')){
  changed=true;await tx.query('UPDATE listening_v2.command_receipts SET actor_privacy_generation=2 WHERE command_id=$1',[JSON.parse(input.rawCommand).commandID]);
 }};
 await refusesUnchanged(()=>s.execute(input),'conflict');assert(changed);fault=null;
 let reads=0;fault=async({text,result})=>{if(text==='SELECT pg_current_xact_id()::text AS transaction_id'&&++reads===3)
 result.rows[0].transaction_id=String(BigInt(result.rows[0].transaction_id)+1n);};
 await refusesUnchanged(()=>s.execute(input),'unavailable');assert.equal(reads,3);
});
test('current Apple A can read exact-generation private history after original G credential closes and key moves to B',async()=>{
 const s=service();await s.execute(command(0));await s.execute(leave(1));
 await sql.query("UPDATE library_users SET access_kind='apple' WHERE id=ANY($1::text[])",[[user(2),user(3)]]);
 await sql.query(`UPDATE listening_v2.privacy_personas SET controller_kind='apple',controller_principal_id=$2,controller_key_id=NULL,
 guest_credential_digest=NULL,guest_credential_expires_at_ms=NULL,privacy_generation=2,private_transfer_from_generation=1 WHERE persona_id=$1`,[pid(1),user(2)]);
 await sql.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user(1)]);
 await sql.query('UPDATE app_attest_keys SET user_id=$2,revoked=true WHERE key_id=$1',[key(1),user(3)]);
 // This explicit SQL fixture represents a later coordinated lifecycle rewrite;
 // the composition does NOT silently rewrite generation 1 to generation 2.
 await sql.query('UPDATE listening_v2.semantic_events SET actor_privacy_generation=2 WHERE event_id=$1',[rid(1)]);
 queries=[];const result=await s.readAdmission({...query(1),bearer:bearer(2)});
 assert.equal(result.admission.status,'admitted');assert.equal(result.admission.memberLeaseVersion,1);
 assert(!queries.some(q=>q.text.includes('library_tokens')&&q.text.includes('FOR UPDATE')&&q.params.includes(hash(credential(1)))));
 await assert.rejects(s.readAdmission({...query(1),bearer:bearer(3)}),{code:'not_found'});
 await sql.query('UPDATE library_users SET disabled=true WHERE id=$1',[user(2)]);
 await assert.rejects(s.readAdmission({...query(1),bearer:bearer(2)}),{code:'unauthorized'});
});
test('transfer without retained generation provenance refuses old private history and never maps old write rights',async()=>{
 const s=service();
 await sql.query("UPDATE library_users SET access_kind='apple' WHERE id=$1",[user(2)]);
 // A direct legacy Apple row with no transfer provenance is distinct from a
 // valid new guest->Apple transition, whose 033 trigger requires the bridge.
 await sql.query('DELETE FROM listening_v2.privacy_personas WHERE persona_id=$1',[pid(1)]);
 await sql.query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
 controller_kind,controller_principal_id,privacy_generation,created_at_ms,updated_at_ms)
 VALUES($1,$2,$3,$4,'apple',$5,2,$6,$6)`,[env,pid(1),user(1),key(1),user(2),start]);
 const state=(await room()).state.admission;await saveState({...state,pending:[]});
 await sql.query(`INSERT INTO listening_v2.semantic_events(environment,session_id,event_id,seq,lane,lane_seq,state_version,type,
 actor_persona_id,actor_privacy_generation,payload,server_at_ms,delete_after_ms)
 VALUES($1,$2,$3,1,'semantic',1,1,'admission.terminal',$4,1,$5,$6,$7)`,
 [env,roomID,rid(1),pid(1),{version:2,status:'denied',pairDigest:pairDigest(1),decidedByMemberID:mid(0)},start,start+day]);
 await refusesUnchanged(()=>s.readAdmission({...query(1),bearer:bearer(2)}),'unauthorized');
 await refusesUnchanged(()=>s.execute(cancel(1)),'unauthorized');
});
test('terminal hydration uses original retained metadata; missing, scrubbed or substituted evidence creates no winner',async()=>{
 const s=service();await s.execute(command(0,'admission.decide',{requestID:rid(1),decision:'deny'}));
 await refusesUnchanged(async()=>{
  // Metadata mutation is test-only, outside normal immutable-key policy.
  const prior=(await sql.query('SELECT bundle_id FROM app_attest_keys WHERE key_id=$1',[key(1)])).rows[0].bundle_id;
  await sql.query('UPDATE app_attest_keys SET bundle_id=$2 WHERE key_id=$1',[key(1),'other.bundle']);
  try{await s.execute(command(0));}finally{await sql.query('UPDATE app_attest_keys SET bundle_id=$2 WHERE key_id=$1',[key(1),prior]);}
 },'unauthorized');
 await sql.query('UPDATE listening_v2.semantic_events SET actor_persona_id=NULL,actor_privacy_generation=NULL WHERE event_id=$1',[rid(1)]);
 await refusesUnchanged(()=>s.execute(command(0)),'unauthorized');
});

test('a grant approver outside current room membership still requires actual GuestLive',async()=>{
 await sql.query(`INSERT INTO listening_v2.returning_grants(environment,grant_id,host_install_scope,pair_digest,hmac_key_version,
 grant_generation,status,host_persona_id,host_privacy_generation,guest_persona_id,guest_privacy_generation,
 approver_persona_id,approver_privacy_generation,approved_session_id,created_at_ms,updated_at_ms)
 VALUES($1,$2,$3,$4,1,1,'active',$5,1,$6,1,$7,1,$8,$9,$9)`,[env,uuid(500),hostScope,pairDigest(1),pid(0),pid(1),pid(3),roomID,start]);
 await sql.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user(3)]);
 await refusesUnchanged(()=>service().execute(command(0)),'unauthorized');
});
test('new exact terminal identity after discovery aborts without acquiring its unseen persona',async()=>{
 const state=(await room()).state.admission;await saveState({...state,pending:[]});let changed=false;
 fault=async({text,tx})=>{if(!changed&&text.includes('library_users')&&text.includes('FOR UPDATE')){
 changed=true;await tx.query(`INSERT INTO listening_v2.semantic_events(environment,session_id,event_id,seq,lane,lane_seq,state_version,type,
 actor_persona_id,actor_privacy_generation,payload,server_at_ms,delete_after_ms)
 VALUES($1,$2,$3,1,'semantic',1,1,'admission.terminal',$4,1,$5,$6,$7)`,
 [env,roomID,rid(1),pid(3),{version:2,status:'cancelled',pairDigest:pairDigest(3)},start,start+day]);
 }};
 await refusesUnchanged(()=>service().execute(command(0)),'conflict');assert(changed);
 assert(!queries.some(q=>q.text.includes('FOR UPDATE')&&q.params.includes(pid(3))));
});

test('Apple private controller authority cannot admit an installation whose key moved to another owner',async()=>{
 await seedPerson(4,{kind:'apple'});const state=(await room()).state.admission;await saveState({...state,pending:[pending(4)]});
 await sql.query('UPDATE app_attest_keys SET user_id=$2 WHERE key_id=$1',[key(4),user(3)]);
 await refusesUnchanged(()=>service().execute(command(0,'admission.decide',{requestID:rid(4),decision:'approve'})),'unauthorized');
});

test('pending approval cannot commit after its exact admission deadline even while every credential stays live',async()=>{
 // Synthetic retained SQL rows at a valid earlier creation time; actual SQL
 // clocks remain untouched. This puts the existing 120-second boundary nearby.
 const oldStart=Number((await sql.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms)-119500;
 const r=await room(),persons=(await sql.query('SELECT * FROM listening_v2.privacy_personas')).rows;
 await sql.query('DELETE FROM listening_v2.rooms WHERE session_id=$1',[roomID]);
 await sql.query('DELETE FROM listening_v2.privacy_personas');
 for(const p of persons){p.created_at_ms=oldStart;p.updated_at_ms=oldStart;
  await sql.query('INSERT INTO listening_v2.privacy_personas SELECT * FROM jsonb_populate_record(NULL::listening_v2.privacy_personas,$1::jsonb)',[p]);}
 r.created_at_ms=oldStart;r.updated_at_ms=oldStart;r.expires_at_ms=oldStart+28800000;
 const state=r.state.admission;state.createdAtMS=oldStart;state.updatedAtMS=oldStart;state.expiresAtMS=r.expires_at_ms;
 state.members[0].joinedAtMS=oldStart;state.pending[0].createdAtMS=oldStart;state.pending[0].expiresAtMS=oldStart+120000;
 await sql.query('INSERT INTO listening_v2.rooms SELECT * FROM jsonb_populate_record(NULL::listening_v2.rooms,$1::jsonb)',[r]);
 let crossed=false;fault=async({text,tx})=>{if(!crossed&&text.includes('INSERT INTO listening_v2.command_receipts')){
  crossed=true;await new Promise(resolve=>setTimeout(resolve,Math.max(0,oldStart+120010-Date.now())));
  assert.equal((await tx.query('SELECT clock_timestamp()>=to_timestamp($1::numeric/1000) AS due',[oldStart+120000])).rows[0].due,true);
 }};
 await refusesUnchanged(()=>service().execute(command(0)),'unauthorized');assert(crossed);
});

test('Apple controller epoch withdraws supported private projections and saved outcomes with cleanup stopped',async()=>{
 await seedPerson(4,{kind:'apple'});const initial=(await room()).state.admission;
 await saveState({...initial,pending:[pending(4)]});
 const s=service(),input=command(0,'admission.decide',{requestID:rid(4),decision:'deny'});
 await s.execute(input);assert.equal((await s.readAdmission(query(4))).admission.status,'denied');
 await sql.query('UPDATE library_users SET sessions_privacy_epoch=sessions_privacy_epoch+1 WHERE id=$1',[user(4)]);
 assert.equal((await sql.query('SELECT status FROM listening_v2.privacy_personas WHERE persona_id=$1',[pid(4)])).rows[0].status,'live');
 assert.equal((await sql.query("SELECT count(*)::int n FROM listening_v2.outbox WHERE kind IN ('privacy_dependency','privacy_scrub')")).rows[0].n,0);
 await refusesUnchanged(()=>s.readAdmission(query(4)),'unauthorized');
 await refusesUnchanged(()=>s.execute(input),'unauthorized');
 const changed={...input,rawCommand:input.rawCommand.replace('deny','approve')};
 await refusesUnchanged(()=>s.execute(changed),'unauthorized');
});
test('actual controller epoch recheck after receipt insertion rolls the entire private mutation back',async()=>{
 await seedPerson(4,{kind:'apple'});const initial=(await room()).state.admission;
 await saveState({...initial,pending:[pending(4)]});let advanced=false;
 fault=async({text,tx})=>{if(!advanced&&text.includes('INSERT INTO listening_v2.command_receipts')){
  advanced=true;await tx.query('UPDATE library_users SET sessions_privacy_epoch=sessions_privacy_epoch+1 WHERE id=$1',[user(4)]);
 }};
 await refusesUnchanged(()=>service().execute(command(0,'admission.decide',{requestID:rid(4),decision:'deny'})),'unauthorized');
 assert(advanced);assert.equal(Number((await sql.query('SELECT sessions_privacy_epoch FROM library_users WHERE id=$1',[user(4)])).rows[0].sessions_privacy_epoch),0);
});
test('only the exact retained transfer bridge maps stored private history; old writes and G receipts stay denied',async()=>{
 const s=service();await s.execute(command(0));const left=leave(1);await s.execute(left);
 await sql.query("UPDATE library_users SET access_kind='apple' WHERE id=ANY($1::text[])",[[user(2),user(3)]]);
 await sql.query(`UPDATE listening_v2.privacy_personas SET controller_kind='apple',controller_principal_id=$2,controller_key_id=NULL,
 guest_credential_digest=NULL,guest_credential_expires_at_ms=NULL,privacy_generation=2,private_transfer_from_generation=1 WHERE persona_id=$1`,[pid(1),user(2)]);
 await sql.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user(1)]);
 await sql.query('UPDATE app_attest_keys SET user_id=$2,revoked=true WHERE key_id=$1',[key(1),user(3)]);
 // The stored terminal reference remains generation1; no event/HMAC rewrite.
 assert.equal(Number((await sql.query('SELECT actor_privacy_generation FROM listening_v2.semantic_events WHERE event_id=$1',[rid(1)])).rows[0].actor_privacy_generation),1);
 assert.equal((await s.readAdmission({...query(1),bearer:bearer(2)})).admission.status,'admitted');
 await refusesUnchanged(()=>s.readReceipt({...left,bearer:bearer(2)}),'unauthorized');
 await refusesUnchanged(()=>s.execute({...cancel(1),bearer:bearer(2)}),'unauthorized');
 await refusesUnchanged(()=>s.readAdmission({...query(1),bearer:bearer(3)}),'unauthorized');
 await sql.query('UPDATE library_users SET sessions_privacy_epoch=1 WHERE id=$1',[user(2)]);
 await refusesUnchanged(()=>s.readAdmission({...query(1),bearer:bearer(2)}),'unauthorized');
});


test('reserved Leave and safe own cancel exclude unrelated active credential/epoch failures from positive scope',async()=>{
 const state=(await room()).state.admission;
 await saveState({...state,members:[state.members[0],member(1),member(2)],pending:[pending(3)],lifetimeMemberCount:3,lifetimeRequestCount:3});
 await sql.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user(1)]);queries=[];
 const s=service({antiAbuse:null});assert.equal((await s.execute(cancel(3))).status,'accepted');
 assert.equal((await s.execute(leave(2))).status,'accepted');
 assert(!queries.some(q=>q.text.includes('library_tokens')&&q.text.includes('FOR UPDATE')&&q.params.includes(hash(credential(1)))));
 assert.equal((await room()).state.admission.members[1].status,'active','no fake lifecycle postimage');
});
test('safe negative scope still rejects missing historical metadata and generation regression',async()=>{
 const state=(await room()).state.admission;
 await saveState({...state,members:[state.members[0],member(1),member(2)],pending:[],lifetimeMemberCount:3,lifetimeRequestCount:2});
 await sql.query('UPDATE app_attest_keys SET bundle_id=$2 WHERE key_id=$1',[key(1),'forged.bundle']);
 await refusesUnchanged(()=>service().execute(leave(2)),'unavailable');
 await sql.query('UPDATE app_attest_keys SET bundle_id=$2 WHERE key_id=$1',[key(1),policy.bundles[0]]);
 const r=await room();r.state.admission.members[1].persona.generation=9;
 await sql.query('UPDATE listening_v2.rooms SET state=$2 WHERE session_id=$1',[roomID,r.state]);
 await refusesUnchanged(()=>service().execute(leave(2)),'unavailable');
});
