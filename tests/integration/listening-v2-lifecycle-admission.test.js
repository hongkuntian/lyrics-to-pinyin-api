import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {libraryDB} from '../helpers/library-db.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {createPrivatePersonaService} from '../../api/utils/listening-v2/private-persona-service.js';
import {createPrivateAdmissionService} from '../../api/utils/listening-v2/privacy-context.js';
import {createPrivacyLifecycle} from '../../api/utils/listening-v2/privacy-lifecycle.js';
import {createAdmissionState,restoreAdmissionState} from '../../api/utils/listening-v2/admission.js';

// Authored/sealed before behavior; NOT RUN by this source-only worker.
// Root overlays the completed writer/cutoff, epoch, processor, codec and 033
// dependencies. All auth is actual guest/register/session/current-auth. Only
// Apple/App Attest crypto, antiabuse and postcommit queue are external fixtures.
// Room/pending preimages may be seeded; no withdrawal/transfer success is seeded.
const env='test',coordinator='preview:negative-admission',DAY=86400000;
const policy={audience:'test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
const key=n=>Buffer.alloc(32,n+1).toString('base64');
const hash=x=>createHash('sha256').update(String(x)).digest('hex');
const binding={version:1,secret:Buffer.alloc(32,41)},pairKey={version:1,secret:Buffer.alloc(32,42)},ticket={id:'negative',secret:Buffer.alloc(32,43)};
const scalar=async(db,q,args=[])=>(await db.query(q,args)).rows[0];
const now=async db=>Number((await scalar(db,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms')).ms);
async function fixture(t,{count=4,expiresGuest=null}={}){
 const f=await libraryDB();t.after(()=>f.db.close());
 for(const name of ['027-spotify-background.sql','029-listening-sessions.sql','030-listening-v2-schema.sql',
  '031-listening-v2-lifecycle-support.sql','032-auth-token-row-locks.sql','033-listening-v2-lifecycle-composition.sql'])
  await f.db.exec(await readFile(new URL('../../db/'+name,import.meta.url),'utf8'));
 await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
 const trace=[];let fault=null;
 const db={query:(...args)=>f.store.db.query(...args),transaction:fn=>f.store.db.transaction(tx=>fn({query:async(q,args=[])=>{
  trace.push({q,args:structuredClone(args)});const r=await tx.query(q,args);if(fault)await fault({q,args,r,tx});return r;
 }}))};
 const external={attestFn:()=>({publicKey:'external-crypto',receipt:Buffer.from('external-crypto')}),assertionFn:({signCount})=>signCount+1};
 const account=new AccountStore(db,{policy,...external,sessionsPrivacy:{coordinatorEnvironment:coordinator},
  apple:{authenticate:async()=>({subjectHash:hash('Apple-A'),refreshTokenEncrypted:'external-crypto'}),revoke:async()=>{}},
  spotifyCleanupFn:async()=>{}}),auth=new AppAuthStore(db,{policy,...external});
 const common={db,environment:env,policy,bindingKeys:[binding],activeBindingKeyVersion:1,
  receiptKeyPolicy:{environment:env,keys:[{version:1,verificationHash:createHmac('sha256',binding.secret)
   .update(JSON.stringify(['sessions-v2.receipt-key-check',1,env])).digest('hex')}]},ticketKeys:[ticket],activeTicketKeyID:ticket.id};
 const personas=createPrivatePersonaService({...common,coordinatorEnvironment:coordinator});
 const admission=createPrivateAdmissionService({...common,pairKeys:[pairKey],pairPolicyRevision:1,
  antiAbuse:{authorize:async r=>({...r,status:'allowed',notAfterMS:Date.now()+60000})}});
 const engine=createPrivacyLifecycle({db,coordinatorEnvironment:coordinator}),actors=[];
 for(let n=0;n<count;n++){
  const credential='lyra_g_'+randomUUID().replaceAll('-','')+'abcdefghijk',keyID=key(n),bundleID=policy.bundles[0];
  const nonce=await account.challenge({purpose:'guest',bundleID,keyID},null,'negative-fixture-'+n);
  await account.guest({...nonce,bundleID,keyID,credential,attestation:'Y3J5cHRv'});
  const challenge=await auth.challenge(credential,{purpose:'session',bundleID,keyID});
  const session=await auth.session(credential,{...challenge,bundleID,keyID,assertion:'Y3J5cHRv'});
  const user=await auth.authenticate(session.token);let expires=null;
  if(n===expiresGuest){expires=(await now(db))+3000;
   // Dependency PREimage before first retention; this is not a withdrawal.
   await db.query('UPDATE library_tokens SET expires_at=to_timestamp($2::numeric/1000) WHERE digest=$1',[user.credentialDigest,expires]);}
  const persona=await personas.retain({bearer:session.token,rawIntent:JSON.stringify({version:2,action:'privacy.retain',payload:{scope:'my_sessions_persona',confirmed:true}})});
  actors.push({credential,keyID,user,bearer:session.token,persona,expires});
 }
 const sessionID=randomUUID(),hostScope=hash('host:'+sessionID),at=await now(db);
 const install=n=>({principalID:actors[n].user.id,keyID:actors[n].keyID,bundleID:policy.bundles[0],audience:policy.audience,attestEnvironment:policy.environment});
 const hostMemberID=randomUUID(),state=createAdmissionState({environment:env,sessionID,nowMS:at,expiresAtMS:at+28800000,title:'Private night',
  host:{install:install(0),persona:actors[0].persona,profile:{reference:'profile-0',revision:1,roomConsentRevision:1,persona:actors[0].persona},memberID:hostMemberID,scope:hostScope}});
 await db.query(`INSERT INTO listening_v2.rooms(environment,session_id,host_install_scope,host_persona_id,host_privacy_generation,
 privacy_persona_ids,provider,invite_digest,code_digest,state,created_at_ms,expires_at_ms,updated_at_ms,reserved_receipts,invite_generation)
 VALUES($1,$2,$3,$4,1,$5,'appleMusic',$6,$7,$8,$9,$10,$9,1,$11)`,[env,sessionID,hostScope,actors[0].persona.id,[actors[0].persona.id],
 hash('invite:'+sessionID),hash('code:'+sessionID),{occurrences:[],visits:[],admission:state,
 admissionStore:{version:1,miscCount:0,reservedEvents:0,reservedReceipts:1,storefront:'us'}},at,at+28800000,state.inviteGeneration]);
 const requests=new Map();
 const room=()=>scalar(db,'SELECT * FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2',[env,sessionID]);
 const command=(n,action,payload={},expected={},commandID=randomUUID())=>({bearer:actors[n].bearer,
  rawCommand:JSON.stringify({version:2,action,sessionID,commandID,expected,payload})});
 async function pending(n){
  const r=await room(),s=structuredClone(r.state.admission),when=await now(db),requestID=randomUUID();
  const pairDigest=createHmac('sha256',pairKey.secret).update(JSON.stringify(['sessions-v2.returning-pair',1,env,hostScope,actors[n].keyID])).digest('hex');
  s.pending.push({id:requestID,version:1,status:'pending',install:install(n),persona:actors[n].persona,pairDigest,
   profileReference:'profile-'+n,profileRevision:1,roomConsentRevision:1,inviteGeneration:s.inviteGeneration,createdAtMS:when,expiresAtMS:Math.min(when+120000,s.expiresAtMS)});
  s.lifetimeRequestCount++;s.stateVersion++;s.updatedAtMS=when;restoreAdmissionState(JSON.stringify(s));
  const guests=s.members.filter(m=>m.status==='active'&&m.id!==hostMemberID).length;
  const meta={...r.state.admissionStore,reservedEvents:3*s.pending.length+guests,reservedReceipts:2*s.pending.length+guests+1};
  await db.query(`UPDATE listening_v2.rooms SET state=$3,privacy_persona_ids=$4,state_version=state_version+1,
   reserved_semantic_events=$5,reserved_receipts=$6,updated_at_ms=$7 WHERE environment=$1 AND session_id=$2`,
   [env,sessionID,{...r.state,admission:s,admissionStore:meta},[...new Set([...s.members,...s.pending].map(x=>x.persona.id))].sort(),meta.reservedEvents,meta.reservedReceipts,when]);
  requests.set(n,requestID);return requestID;
 }
 const approve=async(n,by=0)=>{const requestID=await pending(n);return admission.execute(command(by,'admission.decide',{requestID,decision:'approve'},{requestVersion:1}));};
 const leave=n=>command(n,'leave',{}, {memberLeaseVersion:1});
 const cancel=n=>command(n,'admission.cancel',{requestID:requests.get(n)},{requestVersion:1});
 const read=n=>({bearer:actors[n].bearer,rawQuery:JSON.stringify({version:2,action:'admission.read',sessionID,payload:{requestID:requests.get(n)}})});
 const erase=n=>personas.erase({bearer:actors[n].bearer,rawCommand:JSON.stringify({version:2,action:'privacy.erase',sessionID:actors[n].persona.id,
  commandID:randomUUID(),expected:{privacyGeneration:1},payload:{scope:'my_sessions_persona',confirmed:true}})});
 const scrub=async()=>{const claim=await engine.claimScrub();assert(claim);return engine.processScrub(claim);};
 const snapshot=async()=>{const v={};for(const table of ['rooms','privacy_personas','semantic_events','command_receipts','returning_grants','outbox','output_guards'])
  v[table]=(await db.query('SELECT to_jsonb(t) AS row FROM listening_v2.'+table+' t ORDER BY to_jsonb(t)::text')).rows;return v;};
 return {db,actors,admission,personas,engine,account,auth,room,command,approve,pending,leave,cancel,read,erase,scrub,snapshot,requests,trace,
  fault:fn=>{fault=fn;},sessionID,hostScope};
}
async function unchanged(f,work,code){const before=await f.snapshot();await assert.rejects(work,{code});assert.deepEqual(await f.snapshot(),before);}
const waitExpiry=async a=>new Promise(resolve=>setTimeout(resolve,Math.max(0,a.expires-Date.now()+5)));

test('live guest reserved Leave after actual other C expiry succeeds with dependency processor stopped',async t=>{
 const f=await fixture(t,{expiresGuest:1});await f.approve(1);await f.approve(2);await waitExpiry(f.actors[1]);
 const before=await f.room();assert.equal(Number((await scalar(f.db,'SELECT privacy_generation FROM listening_v2.privacy_personas WHERE persona_id=$1',[f.actors[1].persona.id])).privacy_generation),1);
 const input=f.leave(2);assert.equal((await f.admission.execute(input)).status,'accepted');
 const after=await f.room();assert.deepEqual(after.state.admission.members[1],before.state.admission.members[1]);
 assert.equal(after.state.admission.members[2].status,'left');assert.equal(after.state.admission.lifetimeMemberCount,3);
 assert.equal((await f.admission.readReceipt(input)).replayed,true);
});
test('actual erase and room scrub tombstone permit another exact Leave without resurrection or reserve reuse',async t=>{
 const f=await fixture(t);await f.approve(1);await f.approve(2);await f.erase(1);assert.equal((await f.scrub()).processed,1);
 const before=await f.room(),tombstone=before.state.admission.members[1];assert.equal(tombstone.persona,null);assert.equal(tombstone.install,null);
 assert.equal(tombstone.status,'removed');assert.equal(tombstone.leaseVersion,2);
 const input=f.leave(2);assert.equal((await f.admission.execute(input)).status,'accepted');const after=await f.room();
 assert.deepEqual(after.state.admission.members[1],tombstone);assert.deepEqual(after.privacy_persona_ids,before.privacy_persona_ids);
 assert.equal(after.reserved_semantic_events,before.reserved_semantic_events-1);assert.equal(after.reserved_receipts,before.reserved_receipts-1);
 assert.equal(after.state.admission.lifetimeRequestCount,before.state.admission.lifetimeRequestCount);
 assert.equal(after.state.admission.lifetimeMemberCount,before.state.admission.lifetimeMemberCount);
 assert.equal((await f.admission.execute(input)).replayed,true);assert.equal((await f.admission.readReceipt(input)).replayed,true);
 await unchanged(f,()=>f.admission.execute(f.leave(1)),'unauthorized');
});
for(const reverse of [false,true])test('reserved departures at capacity preserve scrub tombstones, order '+reverse,async t=>{
 const f=await fixture(t);await f.approve(1);await f.approve(2);await f.approve(3);await f.erase(1);await f.scrub();
 const before=await f.room();await f.db.query(`UPDATE listening_v2.rooms SET semantic_event_count=20000-reserved_semantic_events,
  event_seq=20000-reserved_semantic_events,receipt_count=30000-reserved_receipts WHERE session_id=$1`,[f.sessionID]);
 for(const n of reverse?[3,2]:[2,3])assert.equal((await f.admission.execute(f.leave(n))).status,'accepted');
 const after=await f.room();assert.equal(after.receipt_count+after.reserved_receipts,30000);
 assert.equal(after.semantic_event_count+after.reserved_semantic_events,20000);
 assert.equal(after.end_event_reserved,true);assert.equal(after.terminal_reservation_bytes,8192);
 assert.deepEqual(after.state.admission.members[1],before.state.admission.members[1]);assert.equal(after.state.admission.lifetimeMemberCount,4);
});
test('withdrawn pending requester cannot poison another requester own cancel or a guest Leave',async t=>{
 const f=await fixture(t);await f.approve(2);await f.pending(1);await f.pending(3);await f.erase(1);
 assert.equal((await f.admission.execute(f.cancel(3))).status,'accepted');assert.equal((await f.admission.execute(f.leave(2))).status,'accepted');
 assert.equal((await f.room()).state.admission.pending[0].id,f.requests.get(1));
 await f.scrub();assert.deepEqual((await f.room()).state.admission.pending,[]);
 await unchanged(f,()=>f.admission.execute(f.cancel(1)),'unauthorized');
});
test('host withdrawal ends and clears pending, refuses live control and preserves another guest private history',async t=>{
 const f=await fixture(t);await f.approve(2);await f.pending(3);const prior=(await f.room()).state.admission.members[1];
 await f.erase(0);await f.scrub();const r=await f.room();
 assert.equal(r.status,'ended');assert.equal(r.host_persona_id,null);assert.equal(r.state.admission.originalHost.persona,null);
 assert.equal(r.state.admission.originalHost.install,null);assert.equal(r.state.admission.settings.title,'');assert.deepEqual(r.state.admission.pending,[]);
 assert.deepEqual(r.state.admission.members[1],prior);assert.equal((await f.admission.readAdmission(f.read(2))).admission.status,'admitted');
 await unchanged(f,()=>f.admission.execute(f.leave(2)),'expired');
 await unchanged(f,()=>f.admission.execute(f.command(2,'end')),'unavailable');
});
test('null tombstone grants no actor/positive target; legitimate host, requester and decider remain necessary',async t=>{
 const f=await fixture(t);await f.approve(1);await f.approve(2);await f.pending(3);await f.erase(1);await f.scrub();
 const dead=(await f.room()).state.admission.members[1];
 await unchanged(f,()=>f.admission.execute(f.command(1,'admission.decide',{requestID:f.requests.get(3),decision:'approve'},{requestVersion:1})),'unauthorized');
 assert.equal((await f.admission.execute(f.command(2,'admission.decide',{requestID:f.requests.get(3),decision:'approve'},{requestVersion:1}))).status,'accepted');
 assert.deepEqual((await f.room()).state.admission.members[1],dead);
 const g=await scalar(f.db,'SELECT * FROM listening_v2.returning_grants WHERE guest_persona_id=$1',[f.actors[3].persona.id]);
 assert.equal(g.host_persona_id,f.actors[0].persona.id);assert.equal(g.approver_persona_id,f.actors[2].persona.id);
});
test('actual event and receipt scrub return existing denial before conflict, never canonical positive terminal',async t=>{
 const f=await fixture(t);await f.pending(1);const saved=f.cancel(1);await f.admission.execute(saved);await f.erase(1);
 // Exactly bounded actual processor phases; stop once receipt actor is scrubbed.
 for(let n=0;n<10;n++){
  const row=await scalar(f.db,'SELECT actor_persona_id FROM listening_v2.command_receipts WHERE command_id=$1',[JSON.parse(saved.rawCommand).commandID]);
  if(row.actor_persona_id===null)break;await f.scrub();
 }
 const event=await scalar(f.db,'SELECT * FROM listening_v2.semantic_events WHERE event_id=$1',[f.requests.get(1)]);
 assert.equal(event.actor_persona_id,null);assert.equal(event.actor_privacy_generation,null);assert.equal(event.payload.status,'cancelled');
 const receipt=await scalar(f.db,'SELECT * FROM listening_v2.command_receipts WHERE command_id=$1',[JSON.parse(saved.rawCommand).commandID]);
 assert.equal(receipt.actor_persona_id,null);assert.deepEqual(receipt.result,{version:2,redacted:true});
 await unchanged(f,()=>f.admission.readReceipt(saved),'unauthorized');await unchanged(f,()=>f.admission.execute(saved),'unauthorized');
 const changed={...saved,rawCommand:saved.rawCommand.replace('requestVersion":1','requestVersion":9')};
 await unchanged(f,()=>f.admission.execute(changed),'unauthorized');
 await unchanged(f,()=>f.admission.readAdmission(f.read(1)),'unauthorized');
});
test('discovery-to-lock tombstone/lease tampering rolls back instead of accepting replaced DB source',async t=>{
 const f=await fixture(t);await f.approve(1);await f.approve(2);await f.erase(1);await f.scrub();let injected=false;
 f.fault(async({q,tx})=>{if(!injected&&q.includes('public.library_users')&&q.includes('FOR UPDATE')){
  injected=true;const r=await scalar(tx,'SELECT state FROM listening_v2.rooms WHERE session_id=$1',[f.sessionID]);
  r.state.admission.members[1].leaseVersion++;await tx.query('UPDATE listening_v2.rooms SET state=$2 WHERE session_id=$1',[f.sessionID,r.state]);
 }});
 await unchanged(f,()=>f.admission.execute(f.leave(2)),'conflict');assert(injected);f.fault(null);
});
test('actual configured signIn with affected history retains PW-02 refusal, never fakes a transfer proof',async t=>{
 const f=await fixture(t);await f.approve(1);const a=f.actors[1],prior=await f.snapshot();
 const prepared=await f.account.prepareWriterAuthentication(a.bearer);
 const nonce=await f.account.challenge({purpose:'apple',bundleID:policy.bundles[0]},a.user);
 await assert.rejects(()=>f.account.signIn(a.user,{...nonce,bundleID:policy.bundles[0],identityToken:'crypto',authorizationCode:'crypto'},prepared),
  {code:'sessions_privacy_transition_unavailable'});
 assert.deepEqual(await f.snapshot(),prior);
 const p=await scalar(f.db,'SELECT * FROM listening_v2.privacy_personas WHERE persona_id=$1',[a.persona.id]);
 assert.equal(p.controller_kind,'guest');assert.equal(p.private_transfer_from_generation,null);
});


// NAC-R1-01 accounting-stage regressions: appended/sealed before R2 behavior.
// These use the real service/gateway/auth/SQL. Faults execute additional SQL;
// no clock, authorization, reducer result or successful SQL row is fabricated.
async function accountingInput(f,kind){
 if(kind==='approval'){
  const requestID=await f.pending(1);
  return f.command(0,'admission.decide',{requestID,decision:'approve'},{requestVersion:1});
 }
 if(kind==='leave'){await f.approve(1);return f.leave(1);}
 if(kind==='cancel'){await f.pending(1);return f.cancel(1);}
 if(kind==='terminal-cancel'){
  await f.pending(1);await f.admission.execute(f.cancel(1));return f.cancel(1);
 }
 if(kind==='scrubbed-leave'){
  await f.approve(1);await f.approve(2);await f.erase(1);assert.equal((await f.scrub()).processed,1);
  return f.leave(2);
 }
 assert.equal(kind,'scrubbed-cancel');
 await f.approve(1);await f.pending(2);await f.erase(1);assert.equal((await f.scrub()).processed,1);
 return f.cancel(2);
}
const accountingRoom=(f,tx)=>scalar(tx,'SELECT * FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2',[env,f.sessionID]);
const reducerRoomWrite=q=>q.includes('UPDATE listening_v2.rooms SET state=$3');
const gatewayAccountingWrite=q=>q.includes('UPDATE listening_v2.rooms SET receipt_count=receipt_count+1');
const gatewayReceiptWrite=q=>q.includes('INSERT INTO listening_v2.command_receipts');
for(const kind of ['approval','leave','cancel','terminal-cancel','scrubbed-leave','scrubbed-cancel']){
 test('NAC-R1-01 '+kind+' commits exactly one receipt and its exact owned reserve share',async t=>{
  const f=await fixture(t),input=await accountingInput(f,kind),before=await f.room(),stages={};
  const beforeReceipts=(await scalar(f.db,'SELECT count(*)::int AS n FROM listening_v2.command_receipts WHERE environment=$1 AND session_id=$2',[env,f.sessionID])).n;
  f.fault(async({q,tx})=>{
   const stage=reducerRoomWrite(q)?'reducer':gatewayAccountingWrite(q)?'accounted':gatewayReceiptWrite(q)?'inserted':null;
   if(stage){assert.equal(stages[stage],undefined);stages[stage]=structuredClone(await accountingRoom(f,tx));}
  });
  let result;try{result=await f.admission.execute(input);}finally{f.fault(null);}
  assert.equal(result.status,'accepted');assert.equal(result.replayed,false);
  assert.deepEqual(Object.keys(stages),['reducer','accounted','inserted']);
  const consume=kind==='terminal-cancel'?0:1,release=kind.includes('cancel')&&kind!=='terminal-cancel'?2:consume;
  assert.equal(stages.reducer.receipt_count,before.receipt_count,'reducer must not spend gateway receipt count');
  assert.equal(stages.reducer.reserved_receipts,before.reserved_receipts-release+consume);
  const exactAccounted={...stages.reducer,receipt_count:before.receipt_count+1,
   reserved_receipts:stages.reducer.reserved_receipts-consume};
  assert.deepEqual(stages.accounted,exactAccounted,'only the exact owned gateway accounting may change the reducer row');
  assert.deepEqual(stages.inserted,exactAccounted);
  const after=await f.room();assert.deepEqual(after,exactAccounted);
  assert.equal(after.receipt_count,before.receipt_count+1);assert.equal(after.reserved_receipts,before.reserved_receipts-release);
  assert.equal((await scalar(f.db,'SELECT count(*)::int AS n FROM listening_v2.command_receipts WHERE environment=$1 AND session_id=$2',[env,f.sessionID])).n,beforeReceipts+1);
  const receipt=await scalar(f.db,'SELECT * FROM listening_v2.command_receipts WHERE environment=$1 AND session_id=$2 AND command_id=$3',
   [env,f.sessionID,JSON.parse(input.rawCommand).commandID]);
  assert.equal(receipt.status,'accepted');assert.deepEqual(receipt.result,result.result);
  assert.equal(after.end_event_reserved,true);assert.equal(after.terminal_reservation_bytes,8192);
  assert.equal(after.state.admission.lifetimeRequestCount,before.state.admission.lifetimeRequestCount);
  assert.equal(after.state.admission.lifetimeMemberCount,before.state.admission.lifetimeMemberCount+(kind==='approval'?1:0));
  for(const tombstone of before.state.admission.members.filter(m=>m.persona===null))
   assert.deepEqual(after.state.admission.members.find(m=>m.id===tombstone.id),tombstone);
  if(kind==='cancel'){
   assert.equal(before.privacy_persona_ids.includes(f.actors[1].persona.id),true);
   assert.deepEqual(after.privacy_persona_ids,before.privacy_persona_ids.filter(id=>id!==f.actors[1].persona.id));
  }else assert.deepEqual(after.privacy_persona_ids,before.privacy_persona_ids);
  if(kind==='approval'){
   const grant=await scalar(f.db,'SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND guest_persona_id=$2',[env,f.actors[1].persona.id]);
   assert.equal(grant.grant_generation,1);assert.equal(grant.status,'active');
   assert.equal(after.state.admission.members[1].status,'active');
  }else if(kind.endsWith('leave')){
   const actor=kind==='leave'?1:2,member=after.state.admission.members.find(m=>m.persona?.id===f.actors[actor].persona.id);
   assert.equal(member.status,'left');assert.equal(member.leaseVersion,2);
  }
  if(kind.includes('cancel')){
   const id=JSON.parse(input.rawCommand).payload.requestID;
   const terminal=await scalar(f.db,'SELECT * FROM listening_v2.semantic_events WHERE environment=$1 AND event_id=$2',[env,id]);
   assert.equal(terminal.payload.status,'cancelled');assert.equal(terminal.actor_persona_id,receipt.actor_persona_id);
  }
  const committed=await f.snapshot();assert.equal((await f.admission.execute(input)).replayed,true);
  assert.equal((await f.admission.readReceipt(input)).replayed,true);assert.deepEqual(await f.snapshot(),committed);
 });
}
for(const kind of ['approval','leave','cancel','terminal-cancel'])for(const stage of ['after-reducer','after-receipt'])
 for(const fault of ['extra-count','extra-reserve','missing-reserve']){
 test('NAC-R1-01 '+kind+' refuses '+fault+' '+stage+' and rolls back every write',async t=>{
  const f=await fixture(t),input=await accountingInput(f,kind);let injected=false;
  f.fault(async({q,tx})=>{
   if(injected||!(stage==='after-reducer'?reducerRoomWrite(q):gatewayReceiptWrite(q)))return;
   injected=true;const prior=await accountingRoom(f,tx);
   const change={
    'extra-count':'UPDATE listening_v2.rooms SET receipt_count=receipt_count+1 WHERE environment=$1 AND session_id=$2',
    'extra-reserve':'UPDATE listening_v2.rooms SET reserved_receipts=reserved_receipts+1 WHERE environment=$1 AND session_id=$2',
    'missing-reserve':'UPDATE listening_v2.rooms SET reserved_receipts=reserved_receipts-1 WHERE environment=$1 AND session_id=$2'
   }[fault];
   await tx.query(change,[env,f.sessionID]);const changed=await accountingRoom(f,tx);
   assert.equal(changed.receipt_count,prior.receipt_count+(fault==='extra-count'?1:0));
   assert.equal(changed.reserved_receipts,prior.reserved_receipts+(fault==='extra-reserve'?1:fault==='missing-reserve'?-1:0));
  });
  try{await unchanged(f,()=>f.admission.execute(input),'conflict');assert.equal(injected,true);}
  finally{f.fault(null);}
 });
}
test('NAC-R1-01 final exact actor auth precedes accounting-drift conflict and rolls back both',async t=>{
 const f=await fixture(t),input=await accountingInput(f,'approval');let injected=false;
 f.fault(async({q,tx})=>{
  if(injected||!gatewayReceiptWrite(q))return;injected=true;
  await tx.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[f.actors[0].user.credentialDigest]);
  await tx.query('UPDATE listening_v2.rooms SET receipt_count=receipt_count+1 WHERE environment=$1 AND session_id=$2',[env,f.sessionID]);
 });
 try{await unchanged(f,()=>f.admission.execute(input),'unauthorized');assert.equal(injected,true);}
 finally{f.fault(null);}
 assert.equal((await scalar(f.db,'SELECT revoked FROM library_tokens WHERE digest=$1',[f.actors[0].user.credentialDigest])).revoked,false);
});
