import {createHash} from 'node:crypto';
import {SessionV2Error} from './errors.js';

const fail=(code='unavailable')=>{throw new SessionV2Error(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
 (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const userID=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\s\x00-\x1f\x7f]/u.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const keyID=value=>typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value)&&
 Buffer.from(value,'base64').length===32&&Buffer.from(value,'base64').toString('base64')===value;
const bundleID=value=>typeof value==='string'&&/^[A-Za-z0-9.-]{1,128}$/.test(value);
// Canonical UTF-8 byte order, including existing opaque non-ASCII principal IDs.
// Other cooperating writers must use this order (SQL COLLATE "C" equivalent).
const sorted=values=>[...new Set(values)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
const bound=values=>{if(values.length>64)fail();return values;};
const freezePlan=value=>{
 for(const list of Object.values(value))if(Array.isArray(list))Object.freeze(list);
 return Object.freeze(value);
};
async function safe(fn){
 try{return await fn();}
 catch(error){if(error instanceof SessionV2Error)throw error;fail();}
}

/** Decode decimal int8/numeric text before coercion; no rounding or Date parsing.
 * SQL floors epoch milliseconds, conservatively refusing sub-ms expiry edges.
 */
export function decodeAuthTimeMS(value){
 if(typeof value==='number'){
  if(!Number.isSafeInteger(value)||value<0)fail();
  return value;
 }
 if(typeof value==='string'){
  if(value.length>16||!/^(0|[1-9]\d*)$/.test(value))fail();
  value=BigInt(value);
 }
 if(typeof value!=='bigint'||value<0n||value>9007199254740991n)fail();
 return Number(value);
}

function configuration(authStore,environment){
 if(!authStore||typeof authStore.authenticate!=='function'||typeof environment!=='string'||
  !/^(production|development|test|preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119})$/.test(environment??''))fail();
 const p=authStore.policy;
 if(!object(p)||typeof p.audience!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(p.audience)||
  !['production','development'].includes(p.environment)||!/^[A-Z0-9]{10}$/.test(p.prefix??'')||
  !Array.isArray(p.bundles)||p.bundles.length<1||p.bundles.length>32||!p.bundles.every(bundleID)||
  (environment==='production'?p.environment!=='production':p.environment!=='development'||p.audience==='lyra-production'))fail();
 return Object.freeze({audience:p.audience,attestEnvironment:p.environment,bundles:Object.freeze([...p.bundles])});
}

// The exact submitted bearer digest is always the selector. Never discover a
// replacement session by key/credential, and never use transaction-start now().
const currentSQL=`WITH auth_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT pg_current_xact_id()::text AS transaction_id,
  s.digest AS session_digest,s.key_id,s.credential_digest,s.audience AS session_audience,
  s.revoked AS session_revoked,k.user_id AS key_owner,k.bundle_id,k.audience AS key_audience,
  k.environment AS attest_environment,k.revoked AS key_revoked,t.user_id AS token_owner,
  t.revoked AS token_revoked,u.id AS user_id,u.disabled,u.access_kind,
  floor(extract(epoch FROM s.expires_at)*1000)::text AS session_expires_ms,
  CASE WHEN t.expires_at IS NULL THEN NULL ELSE floor(extract(epoch FROM t.expires_at)*1000)::text END AS credential_expires_ms,
  floor(extract(epoch FROM auth_clock.at)*1000)::text AS now_ms
 FROM public.app_auth_sessions s JOIN public.app_attest_keys k ON k.key_id=s.key_id
 JOIN public.library_tokens t ON t.digest=s.credential_digest JOIN public.library_users u ON u.id=k.user_id
 CROSS JOIN auth_clock WHERE s.digest=$1`;
const identityFields=['session_digest','key_id','credential_digest','key_owner','token_owner','user_id'];

/** Disabled internal SQL primitive, NOT the receipt lockAuthorization hook.
 * No pool, route, runtime import, capabilities or auth lifecycle writes.
 *
 * prepare calls the actual injected AppAuthStore.authenticate(bearer) and binds
 * SHA256 of THAT bearer server-side. Its opaque evidence property survives the
 * receipt store's shallow authentication copy; it cannot be JSON-reconstructed.
 * discover runs before lower locks, incorporating every caller-precollected
 * user/token/key identity. lock consumes that same-connection discovery once.
 * All settings/identity anchors must already be held by the trusted composer.
 * The caller MUST propagate failures to its immediate transaction rollback.
 */
export function createCurrentAuthContext({authStore,environment}={}){
 const policy=configuration(authStore,environment);
 const evidence=new WeakMap(),plans=new WeakMap(),transactions=new WeakMap();
 const checkTX=tx=>{if(!tx||typeof tx!=='object'||typeof tx.query!=='function')fail();};
 const transactionID=async tx=>{
  const id=(await tx.query('SELECT pg_current_xact_id()::text AS transaction_id')).rows[0]?.transaction_id;
  // xid8 is an opaque transaction identity, never a JavaScript number/time.
  if(typeof id!=='string'||!/^[1-9]\d{0,19}$/.test(id)||BigInt(id)>18446744073709551615n)fail();
  return id;
 };
 const sameTransaction=(state,row)=>{if(row?.transaction_id!==state.id)fail();};
 function authenticationFor(value){
  if(!object(value)||Object.keys(value).some(k=>!['principalID','keyID','bundleID','evidence'].includes(k)))fail('unauthorized');
  const expected=object(value.evidence)?evidence.get(value.evidence):null;
  if(!expected||value.principalID!==expected.principalID||value.keyID!==expected.keyID||value.bundleID!==expected.bundleID)fail('unauthorized');
  return expected;
 }
 const read=async(tx,expected)=>(await tx.query(currentSQL,[expected.sessionDigest])).rows[0];
 function authority(row,expected){
  if(!row)fail('unauthorized');
  // Invalid persisted timestamps are configuration/data failure, not silently
  // infinite auth. Null is allowed only for the existing credential semantics.
  const nowMS=decodeAuthTimeMS(row.now_ms),sessionExpiresAtMS=decodeAuthTimeMS(row.session_expires_ms);
  const credentialExpiresAtMS=row.credential_expires_ms===null?null:decodeAuthTimeMS(row.credential_expires_ms);
  const notAfterMS=Math.min(sessionExpiresAtMS,credentialExpiresAtMS??Number.MAX_SAFE_INTEGER);
  if(row.session_digest!==expected.sessionDigest||row.key_id!==expected.keyID||
   row.credential_digest!==expected.credentialDigest||row.user_id!==expected.principalID||
   row.key_owner!==expected.principalID||row.token_owner!==expected.principalID||row.bundle_id!==expected.bundleID||
   row.session_audience!==policy.audience||row.key_audience!==policy.audience||
   row.attest_environment!==policy.attestEnvironment||!policy.bundles.includes(row.bundle_id)||
   row.disabled!==false||row.session_revoked!==false||row.key_revoked!==false||row.token_revoked!==false||
   !['guest','apple','beta'].includes(row.access_kind)||nowMS>=notAfterMS)fail('unauthorized');
  return {sessionExpiresAtMS,credentialExpiresAtMS,notAfterMS};
 }
 function scopesFor(value={}){
  if(!object(value)||Object.keys(value).some(k=>!['userIDs','credentialDigests','keyIDs'].includes(k)))fail();
  const lists={};
  for(const [field,valid] of [['userIDs',userID],['credentialDigests',digest],['keyIDs',keyID]]){
   const list=value[field]??[];
   if(!Array.isArray(list)||list.length>64||!list.every(valid))fail();
   lists[field]=sorted(list);
  }
  return lists;
 }
 async function owners(tx,credentials,keys){
  const tokens=(await tx.query('SELECT digest,user_id FROM public.library_tokens WHERE digest=ANY($1::text[])',[credentials])).rows;
  const attestKeys=(await tx.query('SELECT key_id,user_id FROM public.app_attest_keys WHERE key_id=ANY($1::text[])',[keys])).rows;
  if(tokens.length!==credentials.length||attestKeys.length!==keys.length||
   [...tokens,...attestKeys].some(row=>!userID(row.user_id)))fail();
  return {tokens:new Map(tokens.map(row=>[row.digest,row.user_id])),keys:new Map(attestKeys.map(row=>[row.key_id,row.user_id]))};
 }
 function sameIdentity(before,after){
  if(!after)fail('unauthorized');
  if(identityFields.some(field=>before[field]!==after[field]))fail('conflict');
 }
 async function sameOwners(tx,plan,retained){
  const current=await owners(tx,plan.credentialDigests,plan.keyIDs);
  if(plan.credentialDigests.some(id=>current.tokens.get(id)!==retained.tokens.get(id))||
   plan.keyIDs.some(id=>current.keys.get(id)!==retained.keys.get(id)))fail('conflict');
 }
 return Object.freeze({
  async prepare(bearer){return safe(async()=>{
   // The existing HTTP extractor allows 6..256 URL-safe characters and requires
   // lyra_s_. Keep its bounded normal-session namespace; no guest credential.
   if(typeof bearer!=='string'||!/^lyra_s_[A-Za-z0-9_-]{1,249}$/.test(bearer))fail('unauthorized');
   // Hash before awaiting: never accept a digest or prior auth tuple from HTTP.
   const sessionDigest=createHash('sha256').update(bearer).digest('hex');
   let user;
   try{user=await authStore.authenticate(bearer);}
   catch(error){
    if(['session_expired','unauthorized','app_access_revoked'].includes(error?.code))fail('unauthorized');
    fail();
   }
   if(!object(user)||!userID(user.id)||!keyID(user.keyID)||!bundleID(user.bundleID)||
    !policy.bundles.includes(user.bundleID)||!digest(user.credentialDigest))fail('unauthorized');
   const handle=Object.freeze({});
   const expected=Object.freeze({principalID:user.id,keyID:user.keyID,bundleID:user.bundleID,
    credentialDigest:user.credentialDigest,sessionDigest});
   evidence.set(handle,expected);
   return Object.freeze({principalID:user.id,keyID:user.keyID,bundleID:user.bundleID,evidence:handle});
  });},
  async discover({tx,authentication,requiredScopes}={}){return safe(async()=>{
   checkTX(tx);const expected=authenticationFor(authentication),required=scopesFor(requiredScopes);
   const id=await transactionID(tx);
   if(transactions.get(tx)?.id===id)fail();
   const state={phase:'discovering',id};transactions.set(tx,state);
   try{
    const row=await read(tx,expected);
    if(!row)fail('unauthorized');
    sameTransaction(state,row);authority(row,expected);
    const credentialDigests=bound(sorted([...required.credentialDigests,expected.credentialDigest]));
    const keyIDs=bound(sorted([...required.keyIDs,expected.keyID]));
    const retained=await owners(tx,credentialDigests,keyIDs);
    // Recheck actor owner consistency across discovery statements. Never let
    // a move manufacture a new owner under this bearer evidence.
    if(retained.tokens.get(expected.credentialDigest)!==expected.principalID||
     retained.keys.get(expected.keyID)!==expected.principalID)fail('conflict');
    const userIDs=bound(sorted([...required.userIDs,expected.principalID,...retained.tokens.values(),...retained.keys.values()]));
    if(await transactionID(tx)!==id)fail();
    const plan=freezePlan({environment,userIDs,credentialDigests,keyIDs});
    plans.set(plan,{tx,state,expected,row,retained});state.phase='discovered';
    return plan;
   }catch(error){state.phase='failed';throw error;}
  });},
  async lock({tx,discovery}={}){return safe(async()=>{
   checkTX(tx);const retained=object(discovery)?plans.get(discovery):null;
   if(!retained||retained.tx!==tx||retained.state.phase!=='discovered')fail();
   const {state,expected,row,retained:initialOwners}=retained;state.phase='locking';
   try{
    if(await transactionID(tx)!==state.id)fail();
    // Separate ordered statements make the order explicit, independent of DB
    // collation/planner choice. Every identity was collected before these locks.
    for(const id of discovery.userIDs){
     if((await tx.query('SELECT id FROM public.library_users WHERE id=$1 FOR UPDATE',[id])).rows.length!==1)fail();
    }
    for(const id of discovery.credentialDigests){
     const current=(await tx.query('SELECT digest,user_id FROM public.library_tokens WHERE digest=$1 FOR UPDATE',[id])).rows[0];
     if(!current)fail('unauthorized');
     if(current.user_id!==initialOwners.tokens.get(id))fail('conflict');
    }
    for(const id of discovery.keyIDs){
     const current=(await tx.query('SELECT key_id,user_id FROM public.app_attest_keys WHERE key_id=$1 FOR UPDATE',[id])).rows[0];
     if(!current)fail('unauthorized');
     if(current.user_id!==initialOwners.keys.get(id))fail('conflict');
    }
    // Also serialize direct session revocation/deletion, which need not touch
    // the key in existing writers. Session locks follow ALL keys, before lower
    // connection/guard/persona locks. The exact key remains the replay anchor.
    const session=(await tx.query('SELECT digest,key_id,credential_digest FROM public.app_auth_sessions WHERE digest=$1 FOR UPDATE',
     [expected.sessionDigest])).rows[0];
    if(!session)fail('unauthorized');
    if(session.key_id!==expected.keyID||session.credential_digest!==expected.credentialDigest)fail('conflict');
    const current=await read(tx,expected);sameIdentity(row,current);sameTransaction(state,current);
    const deadlines=authority(current,expected);
    state.phase='locked';
    return Object.freeze({environment,principalID:expected.principalID,keyID:expected.keyID,bundleID:expected.bundleID,
     audience:policy.audience,attestEnvironment:policy.attestEnvironment,credentialDigest:expected.credentialDigest,
     accessKind:current.access_kind,...deadlines,
     async revalidate({tx:again}={}){return safe(async()=>{
      if(again!==tx||state.phase!=='locked')fail();
      try{
       // Read only, same connection, fresh wall time. No discovery, lock,
       // renewal, scrub, identity substitution or client-supplied clock.
       if(await transactionID(tx)!==state.id)fail();
       await sameOwners(tx,discovery,initialOwners);
       const latest=await read(tx,expected),next=authority(latest,expected);
       sameTransaction(state,latest);
       if(next.sessionExpiresAtMS!==deadlines.sessionExpiresAtMS||
        next.credentialExpiresAtMS!==deadlines.credentialExpiresAtMS||latest.access_kind!==current.access_kind)fail('unauthorized');
       return true;
      }catch(error){state.phase='failed';throw error;}
     });}
    });
   }catch(error){state.phase='failed';throw error;}
  });}
 });
}
