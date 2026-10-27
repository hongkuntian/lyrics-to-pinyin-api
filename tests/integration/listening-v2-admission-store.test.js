import test, {before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createAdmissionStore} from '../../api/utils/listening-v2/admission-store.js';
import {createCreationTickets,canonicalCommandHash} from '../../api/utils/listening-v2/tickets.js';
import {createAdmissionState,restoreAdmissionState,reduceAdmission,removeAdmissionMember} from '../../api/utils/listening-v2/admission.js';
import {SessionV2Error} from '../../api/utils/listening-v2/errors.js';

const env='preview:admission-store',start=1800000000000,day=86400000;
const binding={version:1,secret:Buffer.alloc(32,4)},ticketKey={id:'admission-test',secret:Buffer.alloc(32,7)};
const digest=n=>createHmac('sha256',Buffer.alloc(32,9)).update(String(n)).digest('hex');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const install=n=>({principalID:`guest-${n}`,keyID:`key-${n}`,bundleID:'test.lyrica.app',audience:'test',attestEnvironment:'development'});
const persona=n=>({id:uuid(n+1000),generation:1});
const profile=n=>({reference:`profile-${n}`,revision:1,roomConsentRevision:1,persona:persona(n)});
const authentication=n=>({...install(n),credentialDigest:digest(`credential-${n}`)});
let sql,clock,queries,fault,resolveOverride,revalidateOverride,lockOverride,resolves,terminalOverride,terminalResolves;
const db={transaction:fn=>sql.transaction(tx=>fn({query:async(text,params)=>{
 queries.push({text,params});const r=await tx.query(text,params);if(fault)await fault(text,tx);return r;
}}))};
before(async()=>{
 sql=new PGlite();await sql.exec(await readFile(new URL('../../db/030-listening-v2-schema.sql',import.meta.url),'utf8'));
 await sql.exec(`CREATE TABLE admission_fixture_auth(principal text PRIMARY KEY,key_id text UNIQUE,enabled boolean,deadline bigint);
 CREATE TABLE admission_fixture_keys(key_id text PRIMARY KEY,principal_id text,bundle_id text,audience text,attest_environment text,enabled boolean,deadline bigint);
 CREATE TABLE admission_fixture_clock(ms bigint);`);
});
after(()=>sql.close());
beforeEach(async()=>{
 await sql.exec(`TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,
 listening_v2.rooms,listening_v2.returning_grants,listening_v2.private_profile_assets,listening_v2.privacy_personas;
 TRUNCATE admission_fixture_auth,admission_fixture_keys,admission_fixture_clock;INSERT INTO admission_fixture_clock VALUES(${start});`);
 clock=start;queries=[];fault=null;resolveOverride=null;revalidateOverride=null;lockOverride=null;resolves=0;terminalOverride=null;terminalResolves=0;
 for(let n=0;n<36;n++){
  const a=install(n),p=persona(n);
  await sql.query('INSERT INTO admission_fixture_keys VALUES($1,$2,$3,$4,$5,true,$6)',[a.keyID,a.principalID,a.bundleID,a.audience,a.attestEnvironment,start+day]);
  await sql.query('INSERT INTO admission_fixture_auth VALUES($1,$2,true,$3)',[a.principalID,a.keyID,start+day]);
  await sql.query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
   controller_kind,controller_principal_id,controller_key_id,privacy_generation,status,created_at_ms,updated_at_ms)
   VALUES($1,$2,$3,$4,'apple',$3,NULL,1,'live',$5,$5)`,[env,p.id,a.principalID,a.keyID,start]);
 }
});
const clockSQL=async tx=>(await tx.query('SELECT ms::text FROM admission_fixture_clock')).rows[0].ms;
async function advance(ms){clock=ms;await sql.query('UPDATE admission_fixture_clock SET ms=$1',[ms]);}
async function lockAuthorization({tx,authentication:a,environment,bindingKeyManifest}){
 if(lockOverride)return lockOverride({tx,authentication:a,environment,bindingKeyManifest});
 const n=Number(a.keyID.slice(4));
 await tx.query('SELECT * FROM admission_fixture_auth WHERE principal=$1 FOR UPDATE',[a.principalID]);
 // Fixture scope set is deliberately small and known before room locking.
 await tx.query('SELECT * FROM admission_fixture_keys ORDER BY key_id FOR SHARE');
 await tx.query('SELECT * FROM listening_v2.privacy_personas WHERE environment=$1 ORDER BY persona_id FOR SHARE',[environment]);
 await tx.query('SELECT * FROM listening_v2.returning_grants WHERE environment=$1 ORDER BY grant_id FOR UPDATE',[environment]);
 const descriptor=bindingKeyManifest.keys[0];
 assert.equal(descriptor.verificationHash,createHmac('sha256',binding.secret)
  .update(JSON.stringify(['sessions-v2.receipt-key-check',1,environment])).digest('hex'));
 return {version:1,environment,principalID:a.principalID,keyID:a.keyID,
  bindingKeyManifestHash:bindingKeyManifest.hash,actorPersonaID:persona(n).id,actorPrivacyGeneration:1,notAfterMS:start+day,
  admissionContext:{version:1,environment,mode:'member',install:install(n),persona:persona(n),notAfterMS:Number(await clockSQL(tx))+60000,
   knownKeys:Array.from({length:36},(_,i)=>install(i).keyID).sort(),
   knownPersonas:Array.from({length:36},(_,i)=>persona(i).id).sort(),hostScopes:[digest('host-0')],
   grantPairs:Array.from({length:36},(_,i)=>pairFor(i).digest).sort(),
   grantIDs:Array.from({length:36},(_,i)=>uuid(3000+i)).sort()},
  revalidate:async({tx:same,nowMS})=>{
   assert.equal(same,tx);
   const row=(await tx.query('SELECT * FROM admission_fixture_auth WHERE principal=$1',[a.principalID])).rows[0];
   return Boolean(row?.enabled&&row.key_id===a.keyID&&Number(row.deadline)>nowMS);
  }};
}
async function resolveFacts({command,nowMS,authorization}){
 resolves++;if(resolveOverride)return resolveOverride({command,nowMS,authorization});
 if(authorization.mode==='lifecycle')return {kind:'plain'};
 const n=Number(authorization.install.keyID.slice(4));
 const antiAbuse={status:'allowed',notAfterMS:nowMS+60000};
 if(command.action==='create')return {kind:'create',antiAbuse,profile:profile(n),hostScope:digest('host-0'),
  memberID:uuid(2000+n),inviteDigest:digest(command.sessionID),codeDigest:digest(`code-${command.sessionID}`),expiresAtMS:nowMS+28800000};
 if(command.action==='admission.request')return {kind:'request',antiAbuse,profile:profile(n),
  resolve:{ticket:command.payload.resolveTicket,sessionID:command.sessionID,environment:env,install:install(n),
   inviteGeneration:1,issuedAtMS:nowMS,expiresAtMS:nowMS+60000},
  pair:{environment:env,hostScope:digest('host-0'),guestKeyID:install(n).keyID,digest:digest(`pair-${n}`)},
  hmacKeyVersion:1,policyRevision:1,grantID:uuid(3000+n),requestID:randomUUID(),memberID:uuid(2000+n)};
 if(command.action==='admission.decide'||command.action==='remembered.forget')return {kind:'pair',antiAbuse,
  // Independent trusted source binding in this fixture; not from deciding actor.
  pair:pairFor(Number(command.payload.requestID?.slice(-12)??1)),hmacKeyVersion:1,policyRevision:1,grantID:uuid(3001),memberID:uuid(2001)};
 return {kind:'plain',...(command.action==='settings.update'?{antiAbuse}:{})};
}
const pairFor=n=>({environment:env,hostScope:digest('host-0'),guestKeyID:install(n).keyID,digest:digest(`pair-${n}`)});
async function resolveTerminalAuthority(args){
 terminalResolves++;if(terminalOverride)return terminalOverride(args);
 const {tx,reference,nowMS}=args;
 const k=(await tx.query('SELECT * FROM admission_fixture_keys WHERE key_id=$1 AND principal_id=$2',
  [reference.originalKeyID,reference.originalPrincipalID])).rows[0];
 if(!k)return {version:1,status:'unavailable'};
 if(!k.enabled||Number(k.deadline)<=nowMS)return {version:1,status:'withdrawn'};
 return {version:1,status:'available',environment:reference.environment,sessionID:reference.sessionID,
  requestID:reference.requestID,persona:reference.persona,notAfterMS:Number(k.deadline),
  install:{principalID:k.principal_id,keyID:k.key_id,bundleID:k.bundle_id,audience:k.audience,attestEnvironment:k.attest_environment}};
}
async function revalidateFacts(args){
 if(revalidateOverride)return revalidateOverride(args);
 if(args.terminalAuthority){
  const t=args.terminalAuthority.terminal;
  const k=(await args.tx.query('SELECT * FROM admission_fixture_keys WHERE key_id=$1',[t.install.keyID])).rows[0];
  if(!k?.enabled||Number(k.deadline)<=args.nowMS)return false;
 }
 return true;
}
function store(extra={}){return createAdmissionStore({db,environment:env,bindingKeys:[binding],activeBindingKeyVersion:1,
 ticketKeys:[ticketKey],activeTicketKeyID:ticketKey.id,now:()=>clock,readClockMS:clockSQL,
 lockAuthorization,resolveFacts,revalidateFacts,resolveTerminalAuthority,...extra});}
function createInput(extra={}){
 const rawCommand=JSON.stringify({version:2,action:'create',expected:{},payload:{provider:'appleMusic',storefront:'us',
 title:'Test room',profileReference:profile(0).reference,profileRevision:1,roomConsentRevision:1,initialIntent:'none',...extra}});
 const t=createCreationTickets({keys:[ticketKey],activeKeyID:ticketKey.id,now:()=>clock}).issue({environment:env,
 principalID:install(0).principalID,keyID:install(0).keyID,action:'create',bodyHash:canonicalCommandHash(rawCommand),sourceRecapRevision:null});
 return {authentication:authentication(0),rawCommand,creationTicket:t.ticket,sessionID:t.sessionID};
}
function mutation(sessionID,n,action,payload={},expected={},commandID=randomUUID()){
 return {authentication:authentication(n),rawCommand:JSON.stringify({version:2,action,sessionID,commandID,expected,payload})};
}
async function create(s=store()) {const c=createInput();const {sessionID:_,...input}=c;await s.execute(input);return c.sessionID;}
async function row(id){return (await sql.query('SELECT * FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2',[env,id])).rows[0];}
async function counts(){const out={};for(const t of ['rooms','returning_grants','semantic_events','outbox','command_receipts'])
 out[t]=(await sql.query('SELECT count(*)::int n FROM listening_v2.'+t)).rows[0].n;return out;}
async function request(s,id,n=1){return s.execute(mutation(id,n,'admission.request',{
 resolveTicket:'resolve-fixture',profileReference:profile(n).reference,profileRevision:1,roomConsentRevision:1}));}
async function decide(s,id,requestID,decision='approve',by=0){
 resolveOverride=({nowMS})=>({kind:'pair',pair:pairFor(1),hmacKeyVersion:1,policyRevision:1,grantID:uuid(3001),memberID:uuid(2001),
  antiAbuse:{status:'allowed',notAfterMS:nowMS+60000}});
 try{return await s.execute(mutation(id,by,'admission.decide',{requestID,decision},{requestVersion:1}));}
 finally{resolveOverride=null;}
}
const rejects=(promise,code)=>assert.rejects(promise,{code});

test('ticketed empty creation persists defaults, mirrors, reservations, expiry and one coalesced wake; retry has no effects',async()=>{
 const s=store(),c=createInput(),{sessionID,...input}=c;
 const a=await s.execute(input),before=await counts(),r=await row(sessionID),calls=resolves;
 assert.equal(a.status,'accepted');assert.equal(r.state.admission.settings.askBeforeJoin,true);
 assert.equal(r.state.admission.settings.takeTurns,false);assert.deepEqual(r.state.occurrences,[]);assert.deepEqual(r.state.visits,[]);
 assert.equal(r.authority_epoch,0);assert.equal(r.reserved_receipts,1);assert.equal(r.terminal_reservation_bytes,8192);
 assert.deepEqual(r.privacy_persona_ids,[persona(0).id]);assert.equal(before.outbox,2);
 assert.equal((await s.execute(input)).replayed,true);assert.deepEqual(await counts(),before);assert.equal(resolves,calls);
});

test('approval commits membership, grant CAS, indexed terminal winner, event and receipt atomically',async()=>{
 const s=store(),id=await create(s),req=await request(s,id),requestID=req.result.admissionID;
 assert(requestID);assert.equal((await row(id)).reserved_receipts,3);
 await decide(s,id,requestID);
 const r=await row(id);assert.equal(r.state.admission.members.length,2);assert.equal(r.reserved_receipts,2);
 const g=(await sql.query('SELECT * FROM listening_v2.returning_grants')).rows[0];assert.equal(g.status,'active');assert.equal(g.grant_generation,1);
 const t=(await sql.query('SELECT * FROM listening_v2.semantic_events WHERE environment=$1 AND event_id=$2',[env,requestID])).rows[0];
 assert.equal(t.payload.status,'admitted');assert.equal(t.payload.memberLeaseVersion,1);
 const count=await counts();await decide(s,id,requestID,'deny');await s.execute(mutation(id,1,'admission.cancel',{requestID},{requestVersion:1}));
 assert.equal((await sql.query('SELECT grant_generation FROM listening_v2.returning_grants')).rows[0].grant_generation,1);
 assert.equal((await row(id)).state.admission.members.length,2);assert.equal((await counts()).semantic_events,count.semantic_events);
});

test('every pending winner defeats later approve/deny/cancel without recreating effects',async()=>{
 for(const winner of ['approve','deny','cancel','expired']){
  // One host can create another room only after a fixture closes/deletes it.
  await sql.exec('TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,listening_v2.rooms,listening_v2.returning_grants');
  await advance(start);const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
  if(winner==='cancel')await s.execute(mutation(id,1,'admission.cancel',{requestID},{requestVersion:1}));
  else if(winner==='expired'){await advance(start+120000);await decide(s,id,requestID);}
  else await decide(s,id,requestID,winner);
  const before=await counts();
  for(const loser of ['approve','deny'])await decide(s,id,requestID,loser);
  await s.execute(mutation(id,1,'admission.cancel',{requestID},{requestVersion:1}));
  const terminal=(await sql.query('SELECT payload a FROM listening_v2.semantic_events WHERE event_id=$1',[requestID])).rows[0].a;
  assert.equal(terminal.status,{approve:'admitted',deny:'denied',cancel:'cancelled',expired:'expired'}[winner]);
  const after=await counts();assert.equal(after.returning_grants,before.returning_grants);assert.equal(after.semantic_events,before.semantic_events);
  assert.equal((await row(id)).state.admission.members.length,winner==='approve'?2:1);
 }
});

test('stored membership lease fences delayed Leave after remembered rejoin; old cancel returns old terminal only',async()=>{
 const s=store(),id=await create(s),firstID=(await request(s,id)).result.admissionID;await decide(s,id,firstID);
 const leave=mutation(id,1,'leave',{}, {memberLeaseVersion:1});await s.execute(leave);
 assert.equal((await row(id)).state.admission.members[1].leaseVersion,2);
 await request(s,id);let r=await row(id);assert.equal(r.state.admission.members[1].leaseVersion,3);
 assert.equal(r.state.admission.members[1].firstJoinOrdinal,1);assert.equal(r.state.admission.lifetimeMemberCount,2);
 const delayed=await s.execute(mutation(id,1,'leave',{}, {memberLeaseVersion:1}));assert.equal(delayed.status,'refused');assert.equal(delayed.result.code,'conflict');
 await s.execute(mutation(id,1,'admission.cancel',{requestID:firstID},{requestVersion:1}));
 r=await row(id);assert.equal(r.state.admission.members[1].status,'active');assert.equal(r.state.admission.members[1].leaseVersion,3);
 assert.equal((await s.execute(leave)).replayed,true);assert.equal((await row(id)).state.admission.members[1].status,'active');
 assert.equal((await sql.query('SELECT grant_generation FROM listening_v2.returning_grants')).rows[0].grant_generation,1);
});

test('Ask change preserves pending work; Ask=false admits without creating remembered grants',async()=>{
 const s=store(),id=await create(s),first=(await request(s,id)).result.admissionID;
 await s.execute(mutation(id,0,'settings.update',{askBeforeJoin:false},{settingsRevision:0}));
 let r=await row(id);assert.equal(r.state.admission.pending.length,1);assert.equal(r.state.admission.pending[0].id,first);
 await request(s,id,2);r=await row(id);assert.equal(r.state.admission.members.length,2);assert.equal(r.state.admission.pending.length,1);
 assert.equal((await counts()).returning_grants,0);
 await decide(s,id,first,'deny');assert.equal((await row(id)).state.admission.members.length,2);
 const refused=await s.execute(mutation(id,2,'settings.update',{title:'forged'},{settingsRevision:1}));assert.equal(refused.result.code,'forbidden');
});

test('host-pair cooldown persists independently of Ask and future room identity; cancellation does not set it',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 await decide(s,id,requestID,'deny');
 const g=(await sql.query('SELECT * FROM listening_v2.returning_grants')).rows[0];assert.equal(g.cooldown_until_ms,start+60000);
 await s.execute(mutation(id,0,'settings.update',{askBeforeJoin:false},{settingsRevision:0}));
 const before=await counts();await rejects(request(s,id),'rate_limited');
 assert.deepEqual(await counts(),before);
 // Keep the denial grant; replace only this room's fixtures, including all FKs.
 await sql.exec('TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,listening_v2.rooms');
 const other=await create(s);await rejects(request(s,other),'rate_limited');
 await advance(start+60000);const pending=(await request(s,other)).result.admissionID;
 await s.execute(mutation(other,1,'admission.cancel',{requestID:pending},{requestVersion:1}));
 assert.equal((await sql.query('SELECT cooldown_until_ms FROM listening_v2.returning_grants')).rows[0].cooldown_until_ms,start+60000);
 const reads=queries.filter(q=>q.text.includes('SELECT * FROM listening_v2.returning_grants')&&q.params.length===3);
 assert(reads.every(q=>q.text.includes('host_install_scope=$2 AND pair_digest=$3')));
});

test('Forget CAS changes future bypass and explicit later approval regrants; current member remains',async()=>{
 const s=store(),id=await create(s),first=(await request(s,id)).result.admissionID;await decide(s,id,first);
 resolveOverride=({nowMS})=>({kind:'pair',pair:pairFor(1),hmacKeyVersion:1,policyRevision:1,grantID:uuid(3001),memberID:uuid(2001),
  antiAbuse:{status:'allowed',notAfterMS:nowMS+60000}});
 await s.execute(mutation(id,0,'remembered.forget',{grantID:uuid(3001)},{grantGeneration:1}));resolveOverride=null;
 assert.equal((await row(id)).state.admission.members[1].status,'active');
 await s.execute(mutation(id,1,'leave',{}, {memberLeaseVersion:1}));
 const second=(await request(s,id)).result.admissionID;assert.equal((await row(id)).state.admission.pending.length,1);
 await decide(s,id,second);assert.equal((await sql.query('SELECT grant_generation FROM listening_v2.returning_grants')).rows[0].grant_generation,3);
 assert.equal((await row(id)).state.admission.members[1].leaseVersion,3);
});

test('faults after real room/grant/event/outbox/receipt SQL roll the entire approval back',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 const before=await counts(),state=await row(id);
 for(const point of ['UPDATE listening_v2.rooms SET state=','INSERT INTO listening_v2.semantic_events',
  'INSERT INTO listening_v2.outbox','INSERT INTO listening_v2.command_receipts']){
  fault=text=>{if(text.includes(point))throw Error('synthetic after-write failure');};
  await rejects(decide(s,id,requestID),'unavailable');fault=null;
  assert.deepEqual(await counts(),before);assert.deepEqual(await row(id),state);
 }
 await decide(s,id,requestID);assert.equal((await counts()).returning_grants,1);
});

test('grant generation CAS failure rolls membership, terminal and receipt back',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 await sql.query(`INSERT INTO listening_v2.returning_grants(environment,grant_id,host_install_scope,pair_digest,hmac_key_version,
 grant_generation,status,created_at_ms,revoked_at_ms,updated_at_ms) VALUES($1,$2,$3,$4,1,0,'revoked',$5,$5,$5)`,
 [env,uuid(3001),digest('host-0'),pairFor(1).digest,start]);
 const before=await counts();let injected=false;
 fault=async(text,tx)=>{if(!injected&&text.includes('SELECT * FROM listening_v2.returning_grants')&&text.includes('host_install_scope=$2 AND pair_digest=$3')){
  injected=true;await tx.query('UPDATE listening_v2.returning_grants SET grant_generation=1');
 }};
 await rejects(decide(s,id,requestID),'conflict');fault=null;assert(injected);assert.deepEqual(await counts(),before);
 assert.equal((await row(id)).state.admission.pending.length,1);
 assert.equal((await sql.query('SELECT grant_generation FROM listening_v2.returning_grants')).rows[0].grant_generation,0);
});

function lifecycleStore(){return store({lockAuthorization:async args=>{
 const p=await lockAuthorization(args);return {...p,actorPersonaID:null,actorPrivacyGeneration:null,
  admissionContext:{...p.admissionContext,mode:'lifecycle',install:null,persona:null}};
}});}

test('authorized internal expiry is atomic and idempotent; member callers cannot select lifecycle authority',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 await rejects(s.execute(mutation(id,0,'admission.expire')),'forbidden');await advance(start+120000);
 const internal=lifecycleStore(),command=mutation(id,0,'admission.expire');await internal.execute(command);
 assert.equal((await row(id)).state.admission.pending.length,0);
 assert.equal((await row(id)).reserved_receipts,1);
 const terminal=(await sql.query('SELECT payload a FROM listening_v2.semantic_events WHERE event_id=$1',[requestID])).rows[0].a;
 assert.equal(terminal.status,'expired');const c=await counts();assert.equal((await internal.execute(command)).replayed,true);assert.deepEqual(await counts(),c);
});

test('trusted removal uses the stored lease and can settle its withdrawn target without resurrecting it',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;await decide(s,id,requestID);
 await sql.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,
  withdrawn_at_ms=$3::bigint,scrub_due_at_ms=$3::bigint+86400000 WHERE environment=$1 AND persona_id=$2`,[env,persona(1).id,start]);
 const internal=lifecycleStore(),m=mutation(id,0,'admission.remove',{memberID:uuid(2001),reason:'authorization_withdrawn'},{memberLeaseVersion:1});
 await internal.execute(m);const r=await row(id);assert.equal(r.state.admission.members[1].status,'removed');
 assert.equal(r.state.admission.members[1].leaseVersion,2);assert.equal(r.reserved_receipts,1);
 assert.equal((await internal.execute(m)).replayed,true);
});

test('pending reservations fund approval and subsequent Leave at semantic/receipt saturation',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 await sql.query(`UPDATE listening_v2.rooms SET semantic_event_count=19997,event_seq=19997,receipt_count=29997 WHERE session_id=$1`,[id]);
 const before=await counts();await rejects(s.execute(mutation(id,0,'settings.update',{title:'full'},{settingsRevision:0})),'rate_limited');
 assert.deepEqual(await counts(),before);
 await decide(s,id,requestID);let r=await row(id);assert.equal(r.semantic_event_count,19999);assert.equal(r.reserved_semantic_events,1);
 assert.equal(r.receipt_count,29998);assert.equal(r.reserved_receipts,2);
 await s.execute(mutation(id,1,'leave',{}, {memberLeaseVersion:1}));r=await row(id);
 assert.equal(r.semantic_event_count,20000);assert.equal(r.reserved_semantic_events,0);assert.equal(r.receipt_count,29999);assert.equal(r.reserved_receipts,1);
 assert.equal(r.end_event_reserved,true);assert.equal(r.terminal_reservation_bytes,8192);
});

test('same body retry skips facts/effects, changed body conflicts and current auth still denies replay',async()=>{
 const s=store(),id=await create(s),m=mutation(id,0,'settings.update',{title:'saved'},{settingsRevision:0});
 await s.execute(m);const before=await counts(),calls=resolves;
 assert.equal((await s.execute(m)).replayed,true);assert.equal(resolves,calls);assert.deepEqual(await counts(),before);
 const c=JSON.parse(m.rawCommand);await rejects(s.execute({...m,rawCommand:JSON.stringify({...c,payload:{title:'other'}})}),'conflict');
 await sql.query('UPDATE admission_fixture_auth SET enabled=false WHERE principal=$1',[install(0).principalID]);
 await rejects(s.execute(m),'unauthorized');assert.deepEqual(await counts(),before);
});

test('missing hooks, caller facts, malformed raw intentions and malformed resolver results refuse before mutation',async()=>{
 assert.throws(()=>createAdmissionStore(),{code:'unavailable'});assert.throws(()=>store({resolveFacts:undefined}),{code:'unavailable'});
 const s=store(),c=createInput(),{sessionID:_,...input}=c;
 for(const extra of [{facts:{}},{actor:install(0)},{tx:{}},{environment:env}])await rejects(s.execute({...input,...extra}),'invalid_request');
 let touched=0;const proxy=new Proxy({}, {get(){touched++;throw Error('read');},ownKeys(){touched++;throw Error('keys');}});
 await rejects(s.execute({...input,rawCommand:proxy}),'invalid_request');assert.equal(touched,0);
 const raw=JSON.parse(input.rawCommand);
 for(const payload of [{...raw.payload,initialIntent:'adopt_current'},{...raw.payload,actorID:uuid(1)},
  {...raw.payload,title:'\u202ebidi'},{...raw.payload,roomConsentRevision:0}])
  await rejects(s.execute({...input,rawCommand:JSON.stringify({...raw,payload})}),'invalid_request');
 resolveOverride=()=>({kind:'create'});await rejects(s.execute(input),'unavailable');
 resolveOverride=()=>({kind:'create',antiAbuse:{status:'allowed',notAfterMS:start+1000},profile:proxy,
  hostScope:digest('host-0'),memberID:uuid(2000),inviteDigest:digest('invite'),codeDigest:digest('code'),expiresAtMS:start+1000});
 await rejects(s.execute(input),'unavailable');assert.equal(touched,0);
 assert.equal((await counts()).rooms,0);assert.equal((await counts()).command_receipts,0);
});

test('profile/resolve/pair/antiabuse authority is mandatory and validated; no fake default permits a join',async()=>{
 const s=store(),id=await create(s),before=await counts();
 const good=await resolveFacts({command:JSON.parse(mutation(id,1,'admission.request',{
  resolveTicket:'resolve-fixture',profileReference:profile(1).reference,profileRevision:1,roomConsentRevision:1}).rawCommand),nowMS:start,
  authorization:{install:install(1)}});
 for(const change of [f=>delete f.profile,f=>f.profile.persona=persona(2),f=>f.resolve.install=install(2),
  f=>f.pair.hostScope=digest('other'),f=>f.antiAbuse.status='unavailable']){
  resolveOverride=()=>{const f=structuredClone(good);change(f);return f;};
  const answer=await request(s,id).catch(e=>e);assert(answer instanceof SessionV2Error||answer.status==='refused');
  assert.equal((await row(id)).state.admission.pending.length,0);assert.equal((await counts()).semantic_events,before.semantic_events);
 }
 resolveOverride=null;revalidateOverride=()=>false;await rejects(request(s,id),'unavailable');
 assert.equal((await row(id)).state.admission.pending.length,0);
});

test('final same-connection fact/current-auth failure rolls all writes back',async()=>{
 const s=store(),id=await create(s),before=await counts(),old=await row(id);let checks=0;
 revalidateOverride=async({tx})=>{checks++;if(checks===2){await tx.query('UPDATE admission_fixture_auth SET enabled=false');return false;}return true;};
 await rejects(request(s,id),'unavailable');assert.deepEqual(await counts(),before);assert.deepEqual(await row(id),old);
 assert.equal((await sql.query('SELECT bool_and(enabled) ok FROM admission_fixture_auth')).rows[0].ok,true);
});

async function jsonBytes(value){return Number((await sql.query('SELECT octet_length($1::jsonb::text)::text n',[JSON.stringify(value)])).rows[0].n);}
async function seededMembers(id,targetBytes=null){
 let state=createAdmissionState({environment:env,sessionID:id,nowMS:start,expiresAtMS:start+28800000,
  host:{install:install(0),persona:persona(0),profile:profile(0),memberID:uuid(2000),scope:digest('host-0')},title:'Test session!'});
 const command=(action,payload,expected={})=>JSON.stringify({version:2,action,sessionID:id,commandID:randomUUID(),expected,payload});
 const actor={install:install(0),persona:persona(0),lease:{memberID:uuid(2000),version:1}};
 state=reduceAdmission(state,command('settings.update',{askBeforeJoin:false},{settingsRevision:0}),{nowMS:start,actor}).state;
 for(let n=1;n<25;n++){
  const raw=command('admission.request',{resolveTicket:'resolve-fixture',profileReference:profile(n).reference,profileRevision:1,roomConsentRevision:1});
  const f=await resolveFacts({command:JSON.parse(raw),nowMS:start,authorization:{install:install(n)}});
  const result=reduceAdmission(state,raw,{nowMS:start,actor:{install:install(n),persona:persona(n),lease:null},
   join:{requestID:f.requestID,memberID:f.memberID,pair:f.pair,cooldownUntilMS:0,resolve:f.resolve,profile:f.profile}});
  assert.equal(result.result.status,'accepted');state=result.state;
 }
 const copy=structuredClone(state);
 if(targetBytes!==null){
  let remaining=targetBytes-await jsonBytes(copy);
  assert(remaining>=0);
  for(const member of copy.members){const padding=Math.min(remaining,160-member.profileReference.length);member.profileReference+='x'.repeat(padding);remaining-=padding;}
  // The fixture's immutable authenticated identities remain unchanged.
  assert.equal(remaining,0,'the exact boundary fits bounded profile references');
 }
 state=restoreAdmissionState(JSON.stringify(copy));
 const current=await row(id),stateJSON={...current.state,admission:state,admissionStore:{...current.state.admissionStore,
  reservedEvents:24,reservedReceipts:25}};
 await sql.query(`UPDATE listening_v2.rooms SET state=$2,settings_revision=1,state_version=$3,session_revision=24,
  privacy_persona_ids=$4,reserved_semantic_events=24,reserved_receipts=25 WHERE session_id=$1`,[
  id,stateJSON,state.stateVersion+1,state.members.map(m=>m.persona.id)]);
 return state;
}

test('exact 16072/16379/16386/16389-byte counterexample: title expansion refuses before commit and Leave remains possible',async()=>{
 const s=store(),id=await create(s),initial=await seededMembers(id,16072);
 assert.equal(await jsonBytes(initial),16072);const title='🎵'.repeat(80);
 const wire=JSON.stringify({version:2,action:'settings.update',sessionID:id,commandID:randomUUID(),expected:{settingsRevision:1},payload:{title}});
 const host={install:install(0),persona:persona(0),lease:{memberID:uuid(2000),version:1}};
 const unsafe=reduceAdmission(initial,wire,{nowMS:start,actor:host});assert.equal(unsafe.result.status,'accepted');
 assert.equal(await jsonBytes(unsafe.state),16379);
 const unsafeCopy=structuredClone(unsafe.state);unsafeCopy.members[1].status='left';unsafeCopy.members[1].leaseVersion=2;
 unsafeCopy.members[1].endedAtMS=start;unsafeCopy.stateVersion++;unsafeCopy.membershipRevision++;
 assert.equal(await jsonBytes(unsafeCopy),16386);unsafeCopy.members[1].status='removed';assert.equal(await jsonBytes(unsafeCopy),16389);
 const before=await row(id),countsBefore=await counts();
 await rejects(s.execute({authentication:authentication(0),rawCommand:wire}),'rate_limited');
 assert.deepEqual(await row(id),before);assert.deepEqual(await counts(),countsBefore);
 const result=await s.execute(mutation(id,1,'leave',{}, {memberLeaseVersion:1}));assert.equal(result.status,'accepted');
 assert.equal((await row(id)).state.admission.members[1].status,'left');
});

test('service-created memberships reserve all closed lifecycle postimages, and preserve queue/visit state and End bytes',async()=>{
 const s=store(),id=await create(s);await s.execute(mutation(id,0,'settings.update',{askBeforeJoin:false},{settingsRevision:0}));
 // Opaque retained queue/visit data belongs to Root's separately typed slices.
 const occurrences=[{exact:'fixture-recording'}],visits=[{exact:'fixture-visit'}];
 await sql.query(`UPDATE listening_v2.rooms SET state=jsonb_set(jsonb_set(state,'{occurrences}',$2::jsonb),'{visits}',$3::jsonb),
  occurrence_count=1,observed_visit_count=1 WHERE session_id=$1`,[id,JSON.stringify(occurrences),JSON.stringify(visits)]);
 for(let n=1;n<25;n++)assert.equal((await request(s,id,n)).status,'accepted');
 const r=await row(id);assert.equal(r.state.admission.members.length,25);
 assert.deepEqual(r.state.occurrences,occurrences);assert.deepEqual(r.state.visits,visits);assert.equal(r.occurrence_count,1);assert.equal(r.observed_visit_count,1);
 const internal=lifecycleStore();
 for(let n=1;n<25;n++)await internal.execute(mutation(id,0,'admission.remove',{
  memberID:uuid(2000+n),reason:'participation_closed'},{memberLeaseVersion:1}));
 const end=await row(id);assert(end.state.admission.members.slice(1).every(m=>m.status==='removed'));
 assert.equal(end.reserved_receipts,1);assert.equal(end.reserved_semantic_events,0);assert.equal(end.terminal_reservation_bytes,8192);
 assert(await jsonBytes(end.state)<=262144-8192);assert.deepEqual(end.state.occurrences,occurrences);assert.deepEqual(end.state.visits,visits);
});

test('new pending work cannot borrow the fixed End budget from a nearly full surrounding room',async()=>{
 const s=store(),id=await create(s),old=await row(id);
 // This opaque executor stand-in deliberately uses the surrounding budget.
 const state={...old.state,executor:'x'.repeat(262144-8192-await jsonBytes(old.state)-16)};
 assert(await jsonBytes(state)<=262144-8192);
 await sql.query('UPDATE listening_v2.rooms SET state=$2 WHERE session_id=$1',[id,state]);const before=await row(id);
 await rejects(request(s,id),'rate_limited');assert.deepEqual(await row(id),before);
 assert.equal((await counts()).semantic_events,1);assert.equal((await counts()).command_receipts,1);
});

test('lifetime request and pending quotas refuse without allocating another pending/event/job',async()=>{
 const s=store(),id=await create(s);
 for(let n=1;n<=10;n++)await request(s,id,n);
 let r=await row(id);assert.equal(r.state.admission.pending.length,10);
 const before=await counts();assert.equal((await request(s,id,11)).result.code,'conflict');assert.equal((await counts()).semantic_events,before.semantic_events);
 const state=structuredClone(r.state);state.admission.pending=[];state.admission.lifetimeRequestCount=300;
 state.admissionStore.reservedEvents=0;state.admissionStore.reservedReceipts=1;
 await sql.query('UPDATE listening_v2.rooms SET state=$2,reserved_semantic_events=0,reserved_receipts=1,privacy_persona_ids=$3 WHERE session_id=$1',[
  id,state,[persona(0).id]]);
 const events=(await counts()).semantic_events;assert.equal((await request(s,id,12)).result.code,'conflict');
 r=await row(id);assert.equal(r.state.admission.lifetimeRequestCount,300);assert.equal((await counts()).semantic_events,events);
});

test('terminal authority is targeted through the existing unique event ID; room JSON never accumulates outcomes',async()=>{
 const s=store(),id=await create(s);let last;
 for(let i=0;i<300;i++){
  last=(await request(s,id)).result.admissionID;
  await s.execute(mutation(id,1,'admission.cancel',{requestID:last},{requestVersion:1}));
 }
 const r=await row(id);assert.equal(r.state.admission.pending.length,0);assert.equal(r.state.admission.lifetimeRequestCount,300);
 assert(!Object.hasOwn(r.state.admission,'terminals'));
 const reads=queries.filter(q=>q.text.includes('SELECT event_id,session_id,environment,payload')&&!q.text.includes('WHERE false'));
 await decide(s,id,last,'deny');
 const lookups=queries.filter(q=>q.text.includes('SELECT event_id,session_id,environment,payload')&&!q.text.includes('WHERE false'));
 assert(lookups.length>reads.length);assert(lookups.every(q=>q.text.includes('event_id=$2 AND session_id=$3')));
 await sql.exec('ANALYZE listening_v2.semantic_events;SET enable_seqscan=off');
 const plan=await sql.query(`EXPLAIN SELECT payload FROM listening_v2.semantic_events
  WHERE environment=$1 AND event_id=$2 AND session_id=$3 AND type='admission.terminal'`,[env,last,id]);
 assert(JSON.stringify(plan.rows).includes('semantic_events_environment_event_id_key'),JSON.stringify(plan.rows));await sql.exec('RESET enable_seqscan');
});

test('separate environments cannot read/mutate the same room identity or reuse another environment grant',async()=>{
 const other='preview:admission-store-b',s=store(),id=await create(s);
 await sql.query(`INSERT INTO listening_v2.privacy_personas(environment,persona_id,original_principal_id,original_key_id,
  controller_kind,controller_principal_id,controller_key_id,privacy_generation,status,created_at_ms,updated_at_ms)
  SELECT $1,persona_id,original_principal_id,original_key_id,controller_kind,controller_principal_id,controller_key_id,
  privacy_generation,status,created_at_ms,updated_at_ms FROM listening_v2.privacy_personas WHERE environment=$2`,[other,env]);
 const second=store({environment:other}),c=createInput(),raw=c.rawCommand;
 const ticket=createCreationTickets({keys:[ticketKey],activeKeyID:ticketKey.id,now:()=>clock}).issue({environment:other,
  principalID:install(0).principalID,keyID:install(0).keyID,action:'create',bodyHash:canonicalCommandHash(raw),sourceRecapRevision:null});
 await second.execute({authentication:authentication(0),rawCommand:raw,creationTicket:ticket.ticket});
 await rejects(second.execute(mutation(id,0,'settings.update',{title:'cross'},{settingsRevision:0})),'not_found');
 await rejects(s.execute(mutation(ticket.sessionID,0,'settings.update',{title:'cross'},{settingsRevision:0})),'not_found');
 assert.equal((await counts()).rooms,2);
});

test('full terminal identity cannot be the public payload; compact metadata uses existing columns and exact references',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 const pending=(await row(id)).state.admission.pending[0];
 await s.execute(mutation(id,1,'admission.cancel',{requestID},{requestVersion:1}));
 const event=(await sql.query('SELECT * FROM listening_v2.semantic_events WHERE event_id=$1',[requestID])).rows[0];
 assert.deepEqual(event.payload,{version:2,status:'cancelled',pairDigest:pending.pairDigest});
 assert.equal(event.actor_persona_id,pending.persona.id);assert.equal(event.actor_privacy_generation,1);
 assert.equal(event.server_at_ms,start);assert.equal(event.session_id,id);assert.equal(event.environment,env);
 assert(!Object.hasOwn(event,'admission_authority'));
 const full={environment:env,sessionID:id,id:requestID,version:2,status:'cancelled',install:pending.install,
  persona:pending.persona,pairDigest:pending.pairDigest,memberID:null,memberLeaseVersion:null,decidedByMemberID:null,atMS:start};
 assert(await jsonBytes(full)>512);assert(await jsonBytes(event.payload)<=512);
 await assert.rejects(sql.query('UPDATE listening_v2.semantic_events SET payload=$2 WHERE event_id=$1',[requestID,full]),{code:'23514'});
});

test('fresh fact deadline crossing at final receipt SQL rolls back instead of committing an expired resolve',async()=>{
 const s=store(),id=await create(s),before=await counts(),old=await row(id);
 fault=async(text,tx)=>{if(text.includes('INSERT INTO listening_v2.command_receipts'))
  await tx.query('UPDATE admission_fixture_clock SET ms=$1',[start+60000]);};
 await rejects(request(s,id),'unauthorized');fault=null;
 assert.deepEqual(await counts(),before);assert.deepEqual(await row(id),old);
 assert.equal(Number((await sql.query('SELECT ms FROM admission_fixture_clock')).rows[0].ms),start);
});

test('undeclared earlier identity scopes abort rather than locking them after the room',async()=>{
 const s=store(),id=await create(s),before=await counts();
 const missing=store({lockAuthorization:async args=>{const p=await lockAuthorization(args);
  return {...p,admissionContext:{...p.admissionContext,knownKeys:[install(0).keyID]}};}});
 await rejects(request(missing,id),'unavailable');assert.deepEqual(await counts(),before);
});

test('rate limiter outage blocks positive work and preserves reserved internal expiry',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 resolveOverride=()=>({kind:'plain',antiAbuse:{status:'unavailable',notAfterMS:start+60000}});
 const before=await counts();await rejects(s.execute(mutation(id,0,'settings.update',{title:'closed'},{settingsRevision:0})),'unavailable');
 assert.deepEqual(await counts(),before);resolveOverride=null;await advance(start+120000);
 await lifecycleStore().execute(mutation(id,0,'admission.expire'));
 assert.equal((await sql.query('SELECT payload a FROM listening_v2.semantic_events WHERE event_id=$1',[requestID])).rows[0].a.status,'expired');
});

test('room-expiry boundary is explicitly left to Root End/fencing; no admission gateway bypass is fabricated',async()=>{
 const s=store(),id=await create(s),expiry=Number((await row(id)).expires_at_ms);await advance(expiry);
 const before=await counts();await rejects(lifecycleStore().execute(mutation(id,0,'admission.expire')),'expired');
 assert.deepEqual(await counts(),before);
 const outbox=(await sql.query("SELECT * FROM listening_v2.outbox WHERE kind='room_expiry' AND payload->>'scope'='room'")).rows[0];
 assert.equal(Number(outbox.due_at_ms),expiry);assert.equal(outbox.state,'pending');
});

test('positive work reserves room scalar revision headroom for later terminal changes',async()=>{
 const s=store(),id=await create(s);await sql.query('UPDATE listening_v2.rooms SET state_version=$2 WHERE session_id=$1',[id,Number.MAX_SAFE_INTEGER-1]);
 const before=await row(id);await rejects(s.execute(mutation(id,0,'settings.update',{title:'cannot terminalize'},{settingsRevision:0})),'rate_limited');
 assert.deepEqual(await row(id),before);assert.equal((await counts()).command_receipts,1);
});

test('maximum terminal public payload fits the unchanged 512-byte PG jsonb bound, independent of identity widths',async()=>{
 const payload={version:2,status:'admitted',pairDigest:'f'.repeat(64),memberID:uuid(4),
  memberLeaseVersion:Number.MAX_SAFE_INTEGER,decidedByMemberID:uuid(5)};
 assert.equal(await jsonBytes(payload),271);assert(await jsonBytes(payload)<=512);
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;await decide(s,id,requestID);
 await sql.query('UPDATE listening_v2.semantic_events SET payload=$2 WHERE event_id=$1',[requestID,payload]);
 assert.deepEqual((await sql.query('SELECT payload FROM listening_v2.semantic_events WHERE event_id=$1',[requestID])).rows[0].payload,payload);
});

test('a terminal approval loser needs no fresh grant/profile/positive-work permit and returns the original admission reference',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;await decide(s,id,requestID,'deny');
 const before=await counts();resolveOverride=()=>({kind:'plain'});
 const loser=await s.execute(mutation(id,0,'admission.decide',{requestID,decision:'approve'},{requestVersion:1}));
 assert.equal(loser.status,'accepted');assert.equal(loser.result.admissionID,requestID);
 assert.equal((await counts()).semantic_events,before.semantic_events);assert.equal((await counts()).returning_grants,before.returning_grants);
});

async function cancelledFixture(){
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 const pending=(await row(id)).state.admission.pending[0];
 const cancel=mutation(id,1,'admission.cancel',{requestID},{requestVersion:1});await s.execute(cancel);
 return {s,id,requestID,pending,cancel};
}

test('terminal resolver is mandatory at construction; no client facts or permissive fallback replaces it',()=>{
 assert.throws(()=>store({resolveTerminalAuthority:undefined}),{code:'unavailable'});
});

test('compact references reconstruct exact full authority on the same held transaction and keep requester-only cancellation',async()=>{
 const wide={...install(1),bundleID:'b'.repeat(160),audience:'a'.repeat(160)};
 const s=store({lockAuthorization:async args=>{
  const p=await lockAuthorization(args);return args.authentication.keyID===wide.keyID?
   {...p,admissionContext:{...p.admissionContext,install:wide}}:p;
 }}),id=await create(s);let resolverTX,authority;
 // Prepare the exact immutable source metadata before the original request.
 await sql.query('UPDATE admission_fixture_keys SET bundle_id=$2,audience=$3 WHERE key_id=$1',
  [wide.keyID,wide.bundleID,wide.audience]);
 const raw=mutation(id,1,'admission.request',{resolveTicket:'resolve-fixture',profileReference:profile(1).reference,
  profileRevision:1,roomConsentRevision:1});
 const facts=await resolveFacts({command:JSON.parse(raw.rawCommand),nowMS:start,authorization:{install:install(1)}});
 facts.resolve.install=wide;resolveOverride=()=>facts;
 const requestID=(await request(s,id)).result.admissionID;resolveOverride=null;
 const pending=(await row(id)).state.admission.pending[0];assert.deepEqual(pending.install,wide);
 await s.execute(mutation(id,1,'admission.cancel',{requestID},{requestVersion:1}));
 terminalOverride=async args=>{
  resolverTX=args.tx;assert(Object.isFrozen(args.reference));
  assert.deepEqual(args.reference,{version:1,environment:env,sessionID:id,requestID,persona:pending.persona,
   atMS:start,originalPrincipalID:pending.install.principalID,originalKeyID:pending.install.keyID,
   pairDigest:pending.pairDigest,status:'cancelled',memberID:null,memberLeaseVersion:null,decidedByMemberID:null});
  terminalOverride=null;return resolveTerminalAuthority(args);
 };
 revalidateOverride=async args=>{
  if(args.terminalAuthority){assert.equal(args.tx,resolverTX);assert.equal(args.phase,'commit');authority=args.terminalAuthority;
   assert(Object.isFrozen(authority.terminal.install));}
  return true;
 };
 const answer=await decide(s,id,requestID,'approve');assert.equal(answer.result.admissionID,requestID);
 assert.deepEqual(authority.terminal,{environment:env,sessionID:id,id:requestID,version:2,status:'cancelled',
  install:pending.install,persona:pending.persona,pairDigest:pending.pairDigest,
  memberID:null,memberLeaseVersion:null,decidedByMemberID:null,atMS:start});
 revalidateOverride=null;
 // A different live installation/persona does not become the original requester.
 const other=await s.execute(mutation(id,2,'admission.cancel',{requestID},{requestVersion:1}));assert.equal(other.result.code,'not_found');
 assert.equal((await s.execute(mutation(id,1,'admission.cancel',{requestID},{requestVersion:1}))).status,'accepted');
 assert.equal((await row(id)).state.admission.members.length,1);assert.equal((await counts()).returning_grants,0);
});

test('lost immutable key metadata refuses every terminal loser and the retained UUID still blocks a replacement request',async()=>{
 const {s,id,requestID}=await cancelledFixture();await sql.query('DELETE FROM admission_fixture_keys WHERE key_id=$1',[install(1).keyID]);
 const before=await counts(),roomBefore=await row(id);
 await rejects(decide(s,id,requestID),'unavailable');
 await rejects(s.execute(mutation(id,1,'admission.cancel',{requestID},{requestVersion:1})),'unavailable');
 assert.deepEqual(await counts(),before);assert.deepEqual(await row(id),roomBefore);
 const command=JSON.parse(mutation(id,1,'admission.request',{
  resolveTicket:'resolve-fixture',profileReference:profile(1).reference,profileRevision:1,roomConsentRevision:1}).rawCommand);
 const facts=await resolveFacts({command,nowMS:start,authorization:{install:install(1)}});
 resolveOverride=()=>({...facts,requestID});await rejects(request(s,id),'conflict');
 assert.deepEqual(await counts(),before);assert.deepEqual(await row(id),roomBefore);
});

test('withdrawn and erased canonical persona authority refuses without reopening a cancelled request',async()=>{
 const {s,id,requestID}=await cancelledFixture(),before=await counts();
 await sql.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,
  withdrawn_at_ms=$3::bigint,scrub_due_at_ms=$3::bigint+86400000 WHERE environment=$1 AND persona_id=$2`,[env,persona(1).id,start]);
 await rejects(decide(s,id,requestID),'unauthorized');assert.equal(terminalResolves,0);
 await sql.query(`UPDATE listening_v2.privacy_personas SET status='erased',controller_kind='erased',controller_principal_id=NULL,
  privacy_generation=3 WHERE environment=$1 AND persona_id=$2`,[env,persona(1).id]);
 await rejects(s.execute(mutation(id,1,'admission.cancel',{requestID},{requestVersion:1})),'unauthorized');
 assert.deepEqual(await counts(),before);assert.equal((await row(id)).state.admission.pending.length,0);
});

test('scrubbed event authority is a denial marker, including after receipt removal; it never allocates another winner',async()=>{
 const {s,id,requestID,cancel}=await cancelledFixture();
 await sql.query("UPDATE listening_v2.semantic_events SET actor_persona_id=NULL,actor_privacy_generation=NULL,payload='{}' WHERE event_id=$1",[requestID]);
 await sql.query('DELETE FROM listening_v2.command_receipts WHERE command_id=$1',[JSON.parse(cancel.rawCommand).commandID]);
 const before=await counts();await rejects(s.execute(cancel),'unauthorized');await rejects(decide(s,id,requestID),'unauthorized');
 assert.deepEqual(await counts(),before);assert.equal((await row(id)).state.admission.pending.length,0);
 assert.equal((await sql.query('SELECT event_id FROM listening_v2.semantic_events WHERE event_id=$1',[requestID])).rows.length,1);
});

test('terminal resolver rejects identity substitution, missing trusted metadata, stale deadlines and undeclared earlier scopes',async()=>{
 const {s,id,requestID}=await cancelledFixture(),before=await counts();
 const good={version:1,status:'available',environment:env,sessionID:id,requestID,persona:persona(1),install:install(1),notAfterMS:start+day};
 for(const change of [a=>a.install=install(2),a=>a.install.principalID=install(0).principalID,
  a=>a.install.keyID=install(0).keyID,a=>a.persona=persona(2),a=>a.persona.generation=2,a=>a.environment='test',
  a=>a.sessionID=uuid(99),a=>a.requestID=uuid(99),a=>delete a.install.bundleID,a=>a.install.audience='',
  a=>a.install.attestEnvironment='unknown',a=>a.notAfterMS=start+59999,a=>a.notAfterMS=start,
  a=>a.privacyOK=true,a=>a.install.bundleID='b'.repeat(161)]){
  terminalOverride=()=>{const a=structuredClone(good);change(a);return a;};
  await rejects(decide(s,id,requestID),'unavailable');assert.deepEqual(await counts(),before);
 }
 terminalOverride=()=>({version:1,status:'withdrawn'});await rejects(decide(s,id,requestID),'unauthorized');
 let touches=0;terminalOverride=()=>new Proxy({}, {ownKeys(){touches++;throw Error('proxy');}});
 await rejects(decide(s,id,requestID),'unavailable');assert.equal(touches,0);terminalOverride=null;
 const n=terminalResolves;
 for(const field of ['knownKeys','knownPersonas']){
  const limited=store({lockAuthorization:async args=>{const p=await lockAuthorization(args);
   return {...p,admissionContext:{...p.admissionContext,[field]:[field==='knownKeys'?install(0).keyID:persona(0).id]}};}});
  await rejects(decide(limited,id,requestID),'unavailable');
 }
 assert.equal(terminalResolves,n);assert.deepEqual(await counts(),before);
});

test('malformed compact payloads fail closed without accepting duplicated metadata or full identities',async()=>{
 const {s,id,requestID}=await cancelledFixture(),before=await counts();
 const payload={version:2,status:'cancelled',pairDigest:pairFor(1).digest};
 for(const bad of [{...payload,install:install(1)},{...payload,id:requestID},{...payload,atMS:start},
  {...payload,memberID:uuid(2001)},{...payload,decidedByMemberID:uuid(2000)},
  {...payload,status:'admitted'},{...payload,status:'denied'},{...payload,pairDigest:'short'},{...payload,version:3}]){
  await sql.query('UPDATE listening_v2.semantic_events SET payload=$2 WHERE event_id=$1',[requestID,bad]);
  await rejects(decide(s,id,requestID),'unavailable');assert.deepEqual(await counts(),before);
 }
});

test('terminal deadline or current dependency loss during receipt INSERT rolls back the new loser receipt',async()=>{
 const {s,id,requestID}=await cancelledFixture(),before=await counts(),old=await row(id);
 fault=async(text,tx)=>{if(text.includes('INSERT INTO listening_v2.command_receipts'))
  await tx.query('UPDATE admission_fixture_clock SET ms=$1',[start+60000]);};
 await rejects(decide(s,id,requestID),'unauthorized');fault=null;
 assert.deepEqual(await counts(),before);assert.deepEqual(await row(id),old);
 fault=async(text,tx)=>{if(text.includes('INSERT INTO listening_v2.command_receipts'))
  await tx.query('UPDATE admission_fixture_keys SET enabled=false WHERE key_id=$1',[install(1).keyID]);};
 await rejects(decide(s,id,requestID),'unavailable');fault=null;assert.deepEqual(await counts(),before);
 assert.equal((await sql.query('SELECT enabled FROM admission_fixture_keys WHERE key_id=$1',[install(1).keyID])).rows[0].enabled,true);
 fault=async(text,tx)=>{if(text.includes('INSERT INTO listening_v2.command_receipts'))await tx.query(`UPDATE listening_v2.privacy_personas
  SET status='withdrawn',privacy_generation=2,withdrawn_at_ms=$3::bigint,scrub_due_at_ms=$3::bigint+86400000
  WHERE environment=$1 AND persona_id=$2`,[env,persona(1).id,start]);};
 await rejects(decide(s,id,requestID),'unauthorized');fault=null;assert.deepEqual(await counts(),before);
});

test('receipt replay skips terminal resolution and every write but requires current privacy read authorization',async()=>{
 const {s,id,requestID}=await cancelledFixture();
 const command=mutation(id,0,'admission.decide',{requestID,decision:'approve'},{requestVersion:1});
 await s.execute(command);const before=await counts(),n=terminalResolves,calls=resolves;
 terminalOverride=()=>{throw Error('replay must not resolve');};
 const queryStart=queries.length;assert.equal((await s.execute(command)).replayed,true);
 assert.equal(terminalResolves,n);assert.equal(resolves,calls);assert.deepEqual(await counts(),before);
 assert(!queries.slice(queryStart).some(q=>/^\s*(INSERT|UPDATE|DELETE)\b/.test(q.text)));
 const denied=store({lockAuthorization:async args=>{
  const p=await lockAuthorization(args);return {...p,revalidate:async phase=>phase.receipt?false:p.revalidate(phase)};
 }});
 await rejects(denied.execute(command),'unauthorized');assert.deepEqual(await counts(),before);
 // The current privacy read check precedes disclosing even a changed-body conflict.
 const raw=JSON.parse(command.rawCommand);raw.payload.decision='deny';
 await rejects(denied.execute({...command,rawCommand:JSON.stringify(raw)}),'unauthorized');
});

test('all 24 service-admitted guests Leave with captured leases at reserved semantic/receipt saturation',async()=>{
 const s=store(),id=await create(s);await s.execute(mutation(id,0,'settings.update',{askBeforeJoin:false},{settingsRevision:0}));
 for(let n=1;n<25;n++)assert.equal((await request(s,id,n)).status,'accepted');
 await sql.query('UPDATE listening_v2.rooms SET semantic_event_count=19976,event_seq=19976,receipt_count=29975 WHERE session_id=$1',[id]);
 for(let n=1;n<25;n++)assert.equal((await s.execute(mutation(id,n,'leave',{}, {memberLeaseVersion:1}))).status,'accepted');
 const end=await row(id);assert(end.state.admission.members.slice(1).every(m=>m.status==='left'&&m.leaseVersion===2));
 assert.equal(end.semantic_event_count,20000);assert.equal(end.receipt_count,29999);
 assert.equal(end.reserved_receipts,1);assert.equal(end.reserved_semantic_events,0);assert.equal(end.terminal_reservation_bytes,8192);
 assert(await jsonBytes(end.state.admission)<=16384);assert(await jsonBytes(end.state)<=262144-8192);
});

test('any current guest can approve another requester and compact provenance binds the original host pair',async()=>{
 const s=store(),id=await create(s),first=(await request(s,id)).result.admissionID;await decide(s,id,first);
 const second=(await request(s,id,2)).result.admissionID;
 resolveOverride=({nowMS})=>({kind:'pair',pair:pairFor(2),hmacKeyVersion:1,policyRevision:1,grantID:uuid(3002),memberID:uuid(2002),
  antiAbuse:{status:'allowed',notAfterMS:nowMS+60000}});
 await s.execute(mutation(id,1,'admission.decide',{requestID:second,decision:'approve'},{requestVersion:1}));resolveOverride=null;
 const g=(await sql.query('SELECT * FROM listening_v2.returning_grants WHERE grant_id=$1',[uuid(3002)])).rows[0];
 assert.equal(g.host_install_scope,digest('host-0'));assert.equal(g.approver_persona_id,persona(1).id);assert.equal(g.guest_persona_id,persona(2).id);
 const e=(await sql.query('SELECT * FROM listening_v2.semantic_events WHERE event_id=$1',[second])).rows[0];
 assert.deepEqual(e.payload,{version:2,status:'admitted',pairDigest:pairFor(2).digest,memberID:uuid(2002),memberLeaseVersion:1,decidedByMemberID:uuid(2001)});
 assert.equal(e.actor_persona_id,persona(2).id);
 await s.execute(mutation(id,2,'admission.cancel',{requestID:second},{requestVersion:1}));
 assert.equal((await row(id)).state.admission.members.length,3);
});

test('denial keeps an existing active remembered grant distinct from the independent cooldown',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 await sql.query(`INSERT INTO listening_v2.returning_grants(environment,grant_id,host_install_scope,pair_digest,hmac_key_version,
  grant_generation,status,host_persona_id,host_privacy_generation,guest_persona_id,guest_privacy_generation,
  approver_persona_id,approver_privacy_generation,approved_session_id,created_at_ms,updated_at_ms)
  VALUES($1,$2,$3,$4,1,7,'active',$5,1,$6,1,$5,1,$7,$8,$8)`,[
  env,uuid(3001),digest('host-0'),pairFor(1).digest,persona(0).id,persona(1).id,id,start]);
 await decide(s,id,requestID,'deny');const g=(await sql.query('SELECT * FROM listening_v2.returning_grants')).rows[0];
 assert.equal(g.status,'active');assert.equal(g.grant_generation,7);assert.equal(g.revoked_at_ms,null);assert.equal(g.cooldown_until_ms,start+60000);
 await rejects(request(s,id),'rate_limited');await advance(start+60000);
 await request(s,id);assert.equal((await row(id)).state.admission.members[1].status,'active');
 assert.equal((await sql.query('SELECT grant_generation FROM listening_v2.returning_grants')).rows[0].grant_generation,7);
});

test('a closed withdrawn member cannot block another reserved Leave or regain admission authority',async()=>{
 const s=store(),id=await create(s);await s.execute(mutation(id,0,'settings.update',{askBeforeJoin:false},{settingsRevision:0}));
 const first=(await request(s,id,1)).result.admissionID;await request(s,id,2);
 await sql.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,
  withdrawn_at_ms=$3::bigint,scrub_due_at_ms=$3::bigint+86400000 WHERE environment=$1 AND persona_id=$2`,[env,persona(1).id,start]);
 await lifecycleStore().execute(mutation(id,0,'admission.remove',{
  memberID:uuid(2001),reason:'authorization_withdrawn'},{memberLeaseVersion:1}));
 const closed=(await row(id)).state.admission.members[1];
 // The retired row is history, not a dependency that grants current authority.
 await sql.query('UPDATE listening_v2.rooms SET semantic_event_count=19999,event_seq=19999,receipt_count=29998 WHERE session_id=$1',[id]);
 assert.equal((await s.execute(mutation(id,2,'leave',{}, {memberLeaseVersion:1}))).status,'accepted');
 const end=await row(id);assert.deepEqual(end.state.admission.members[1],closed);
 assert.equal(end.state.admission.members[2].status,'left');assert.equal(end.receipt_count,29999);
 assert.equal(end.reserved_receipts,1);assert.equal(end.semantic_event_count,20000);assert.equal(end.terminal_reservation_bytes,8192);
 const before=await counts();
 await rejects(s.execute(mutation(id,1,'admission.cancel',{requestID:first},{requestVersion:1})),'unauthorized');
 await rejects(request(s,id,1),'unauthorized');
 assert.deepEqual(await row(id),end);assert.deepEqual(await counts(),before);assert.equal(terminalResolves,0);
});

test('all 24 guests can close sequentially after withdrawal without reopening earlier historical members',async()=>{
 const s=store(),id=await create(s);await s.execute(mutation(id,0,'settings.update',{askBeforeJoin:false},{settingsRevision:0}));
 for(let n=1;n<25;n++)await request(s,id,n);
 await sql.query('UPDATE listening_v2.rooms SET semantic_event_count=19976,event_seq=19976,receipt_count=29975 WHERE session_id=$1',[id]);
 const internal=lifecycleStore();
 for(let n=1;n<25;n++){
  await sql.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,
   withdrawn_at_ms=$3::bigint,scrub_due_at_ms=$3::bigint+86400000 WHERE environment=$1 AND persona_id=$2`,[env,persona(n).id,start]);
  assert.equal((await internal.execute(mutation(id,0,'admission.remove',{
   memberID:uuid(2000+n),reason:'authorization_withdrawn'},{memberLeaseVersion:1}))).status,'accepted');
 }
 const end=await row(id);assert(end.state.admission.members.slice(1).every(m=>m.status==='removed'&&m.leaseVersion===2&&m.persona.generation===1));
 assert.equal(end.semantic_event_count,20000);assert.equal(end.receipt_count,29999);assert.equal(end.reserved_receipts,1);
 assert.equal(end.reserved_semantic_events,0);assert.equal(end.end_event_reserved,true);assert.equal(end.terminal_reservation_bytes,8192);
 assert(await jsonBytes(end.state.admission)<=16384);assert(await jsonBytes(end.state)<=262144-8192);
});

test('a retained scrubbed winner UUID defeats a stale pending approval atomically at the unique constraint',async()=>{
 const s=store(),id=await create(s),requestID=(await request(s,id)).result.admissionID;
 // Deliberately inconsistent recovered pending state: the durable erased
 // marker wins. This is uniqueness/rollback proof, not a PostgreSQL race.
 await sql.query(`INSERT INTO listening_v2.semantic_events(environment,session_id,event_id,seq,lane,lane_seq,
  state_version,type,payload,server_at_ms,delete_after_ms)
  VALUES($1,$2,$3,19999,'semantic',19999,2,'admission.terminal','{}',$4,$5)`,[env,id,requestID,start,start+day]);
 const before=await counts(),previous=await row(id);
 await rejects(decide(s,id,requestID),'unavailable');
 assert.deepEqual(await counts(),before);assert.deepEqual(await row(id),previous);
 const marker=(await sql.query('SELECT actor_persona_id,payload FROM listening_v2.semantic_events WHERE environment=$1 AND event_id=$2',[env,requestID])).rows;
 assert.deepEqual(marker,[{actor_persona_id:null,payload:{}}]);assert.equal((await counts()).returning_grants,0);
});

for(const action of ['admission.remove','remembered.forget']){
 test('review regression: '+action+' stays available with unrelated overdue admissions',async()=>{
  const s=store(),id=await create(s),first=(await request(s,id)).result.admissionID;
  await decide(s,id,first);await request(s,id,2);
  const expiryJob=async()=>(await sql.query('SELECT * FROM listening_v2.outbox WHERE environment=$1 AND job_key=$2',
   [env,`admission-expiry:${id}`])).rows[0];
  const scheduled=await expiryJob();assert.equal(Number(scheduled.due_at_ms),start+120000);
  const before=await row(id);await advance(start+120001);
  const command=action==='admission.remove'
   ?mutation(id,0,action,{memberID:uuid(2001),reason:'participation_closed'},{memberLeaseVersion:1})
   :mutation(id,0,action,{grantID:uuid(3001)},{grantGeneration:1});
  const result=await (action==='admission.remove'?lifecycleStore():s).execute(command);
  assert.equal(result.status,'accepted');
  const current=await row(id),job=await expiryJob();
  assert.deepEqual(current.state.admission.pending,before.state.admission.pending);
  assert.equal(job.state,'pending');assert.equal(Number(job.created_at_ms),clock);assert.equal(Number(job.due_at_ms),clock);
  assert.equal(Number(job.claim_epoch),Number(scheduled.claim_epoch)+1);
  assert.equal(current.end_event_reserved,true);assert.equal(current.terminal_reservation_bytes,8192);
  if(action==='admission.remove'){
   assert.equal(current.state.admission.members[1].status,'removed');
   assert.equal(current.reserved_semantic_events,before.reserved_semantic_events-1);
   assert.equal(current.reserved_receipts,before.reserved_receipts-1);
  }else{
   assert.equal((await sql.query('SELECT status FROM listening_v2.returning_grants WHERE grant_id=$1',[uuid(3001)])).rows[0].status,'revoked');
   assert.equal(current.reserved_semantic_events,before.reserved_semantic_events);
   assert.equal(current.reserved_receipts,before.reserved_receipts);
  }
  await lifecycleStore().execute(mutation(id,0,'admission.expire'));
  assert.equal((await row(id)).state.admission.pending.length,0);assert.equal((await expiryJob()).state,'cancelled');
 });
}

for(const phase of ['creation','update']){
 test('review regression: '+phase+' wake watermarks decode decimal-string bigint rows',async()=>{
  // Only the driver result representation changes. Actual SQL still executes
  // in PGlite; this is not a real PostgreSQL driver/consumer receipt.
  const driverDB={transaction:fn=>db.transaction(tx=>fn({query:async(text,params)=>{
   const r=await tx.query(text,params);
   if(/^\s*(INSERT INTO listening_v2.rooms|UPDATE listening_v2.rooms SET state=)/.test(text))
    return {...r,rows:r.rows.map(value=>({...value,event_seq:String(value.event_seq)}))};
   return r;
  }}))};
  const s=store({db:driverDB}),c=createInput(),{sessionID,...input}=c;
  let result=await s.execute(input);
  if(phase==='update')result=await s.execute(mutation(sessionID,0,'settings.update',{title:'Driver result'},{settingsRevision:0}));
  const wake=(await sql.query('SELECT payload FROM listening_v2.outbox WHERE environment=$1 AND job_key=$2',
   [env,`wake:${sessionID}`])).rows[0].payload;
  assert.equal(typeof wake.eventSeq,'number');assert.equal(wake.eventSeq,result.result.eventSeq);
  assert.equal(wake.eventSeq,Number((await row(sessionID)).event_seq));
 });
}


// New service-only regression; real positive authorization is covered in the
// separate actual-method lifecycle suite, never by this legacy fixture permit.
test('negative departure validates retained source without reviving unrelated active withdrawn refs',async()=>{
 const s=store(),id=await create(s);await s.execute(mutation(id,0,'settings.update',{askBeforeJoin:false},{settingsRevision:0}));
 await request(s,id,1);await request(s,id,2);
 await sql.query(`UPDATE listening_v2.privacy_personas SET status='withdrawn',privacy_generation=2,
  withdrawn_at_ms=$3::bigint,scrub_due_at_ms=$3::bigint+86400000 WHERE environment=$1 AND persona_id=$2`,[env,persona(1).id,start]);
 const before=(await row(id)).state.admission.members[1];
 await sql.query('UPDATE listening_v2.rooms SET semantic_event_count=19998,event_seq=19998,receipt_count=29997 WHERE session_id=$1',[id]);
 assert.equal((await s.execute(mutation(id,2,'leave',{}, {memberLeaseVersion:1}))).status,'accepted');
 const after=await row(id);assert.deepEqual(after.state.admission.members[1],before);
 assert.equal(after.state.admission.members[2].status,'left');assert.equal(after.semantic_event_count,19999);
 assert.equal(after.reserved_semantic_events,1);assert.equal(after.reserved_receipts,2);assert.equal(after.receipt_count,29998);
 assert.equal(after.state.admission.lifetimeMemberCount,3);assert.equal(after.terminal_reservation_bytes,8192);
});

// Last: damage only this disposable fixture after every positive case used the
// maintained migration directly. Missing representation cannot enable writes.
test('missing cooldown representation fails closed before room or receipt mutation',async()=>{
 await sql.exec('ALTER TABLE listening_v2.returning_grants DROP COLUMN cooldown_until_ms');
 await rejects(create(),'unavailable');
 assert.deepEqual(await counts(),{rooms:0,returning_grants:0,semantic_events:0,outbox:0,command_receipts:0});
});
