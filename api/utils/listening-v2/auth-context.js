import {createHash} from 'node:crypto';
import {SessionV2Error,transactionRetrySignal} from './errors.js';

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
 catch(error){if(error instanceof SessionV2Error)throw error;const signal=transactionRetrySignal(error);if(signal)throw signal;fail();}
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
  s.expires_at::text AS session_deadline,t.expires_at::text AS credential_deadline,
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
     async assertFreshSession({tx:again,maxAgeMS}={}){return safe(async()=>{
      try{
       if(again!==tx||state.phase!=='locked')fail();
       return await freshSession(tx,{expected,policy,id:state.id,
       sessionDeadline:current.session_deadline,credentialDeadline:current.credential_deadline,maxAgeMS});}
      catch(error){state.phase='failed';throw error;}
     });},
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

// Shared exact-S freshness assertion. No Date, epoch-ms rounding, supplied
// clock, renewal or positive authority from supplemental scopes. The SQL checks
// ordinary auth first; only an otherwise valid, unchanged S can be 'expired'
// for freshness. The method itself does not authorize Sessions erasure.
async function freshSession(tx,{expected,policy,id,sessionDeadline,credentialDeadline,maxAgeMS}){
 if(!Number.isSafeInteger(maxAgeMS)||maxAgeMS<0||maxAgeMS>900000)fail('invalid_request');
 const row=(await tx.query(`WITH auth_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT pg_current_xact_id()::text AS transaction_id,
 EXISTS(SELECT 1 FROM public.app_auth_sessions s
 JOIN public.app_attest_keys k ON k.key_id=s.key_id
 JOIN public.library_tokens t ON t.digest=s.credential_digest
 JOIN public.library_users u ON u.id=k.user_id CROSS JOIN auth_clock c
 WHERE s.digest=$1 AND s.key_id=$2 AND s.credential_digest=$3
 AND k.user_id=$4 AND t.user_id=$4 AND u.id=$4 AND k.bundle_id=$5
 AND s.audience=$6 AND k.audience=$6 AND k.environment=$7 AND k.bundle_id=ANY($8::text[])
 AND NOT s.revoked AND NOT k.revoked AND NOT t.revoked AND NOT u.disabled
 AND u.access_kind IN ('guest','apple','beta')
 AND s.expires_at=$9::timestamptz AND t.expires_at IS NOT DISTINCT FROM $10::timestamptz
 AND isfinite(s.expires_at) AND s.expires_at>c.at
 AND (t.expires_at IS NULL OR (isfinite(t.expires_at) AND t.expires_at>c.at))) AS authorized,
 (c.at >= $9::timestamptz-interval '15 minutes'
  AND c.at <= $9::timestamptz-interval '15 minutes'+$11::integer*interval '1 millisecond') AS fresh
 FROM auth_clock c`,[expected.sessionDigest,expected.keyID,expected.credentialDigest,expected.principalID,
 expected.bundleID,policy.audience,policy.attestEnvironment,policy.bundles,sessionDeadline,credentialDeadline,maxAgeMS])).rows[0];
 if(row?.transaction_id!==id)fail();
 if(row.authorized!==true)fail('unauthorized');
 if(row.fresh!==true)fail('expired');
 return true;
}

// Fixed writer factory. Ordinary createCurrentAuthContext never accepts a lock
// mode. All state, raw operation, deadlines and session digests stay private.
// No V2 relation, identity verifier, lower-row hook or lifecycle permit here.
export function createWriterAuthContext({authStore,environment}={}){
 const policy=configuration(authStore,environment);
 const evidence=new WeakMap(),plans=new WeakMap(),transactions=new WeakMap();
 const checkTX=tx=>{if(!tx||typeof tx!=='object'||typeof tx.query!=='function')fail();};
 const transactionID=async tx=>{
  const id=(await tx.query('SELECT pg_current_xact_id()::text AS transaction_id')).rows[0]?.transaction_id;
  if(typeof id!=='string'||!/^[1-9]\d{0,19}$/.test(id)||BigInt(id)>18446744073709551615n)fail();
  return id;
 };
 function authenticationFor(value){
  if(!object(value)||Object.keys(value).some(k=>!['principalID','keyID','bundleID','evidence'].includes(k)))fail('unauthorized');
  const e=object(value.evidence)?evidence.get(value.evidence):null;
  if(!e||value.principalID!==e.principalID||value.keyID!==e.keyID||value.bundleID!==e.bundleID)fail('unauthorized');
  return e;
 }
 function scopesFor(value={}){
  if(!object(value)||Object.keys(value).some(k=>!['userIDs','credentialDigests','keyIDs'].includes(k)))fail();
  const out={};
  for(const [field,valid] of [['userIDs',userID],['credentialDigests',digest],['keyIDs',keyID]]){
   const list=value[field]??[];
   if(!Array.isArray(list)||list.length>64||!list.every(valid))fail();
   out[field]=sorted(list);
  }
  return freezePlan(out);
 }
 function operationFor(raw){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>2048)fail('invalid_request');
  let value;try{value=JSON.parse(raw);}catch{fail('invalid_request');}
  if(!object(value))fail('invalid_request');
  const fields=value.kind==='signIn'?['kind','targetPrincipalID','targetCredentialDigest']:['kind'];
  if(!['signIn','signOut','delete'].includes(value.kind)||Object.keys(value).length!==fields.length||
   Object.keys(value).some(k=>!fields.includes(k)))fail('invalid_request');
  // All permitted values are strings. Tokenize complete JSON strings after
  // JSON.parse has validated syntax, so escaped quotes/colons in opaque IDs
  // cannot masquerade as member names. Refuse duplicate (also escaped) keys.
  const strings=raw.match(/"(?:[^"\\]|\\.)*"/gs)??[];
  const names=strings.filter((_,i)=>i%2===0).map(s=>JSON.parse(s));
  if(strings.length!==2*fields.length||names.length!==fields.length||new Set(names).size!==fields.length)fail('invalid_request');
  if(value.kind==='signIn'&&(!userID(value.targetPrincipalID)||!digest(value.targetCredentialDigest)))fail('invalid_request');
  return Object.freeze({...value});
 }
 const query=async(tx,sql,args)=>(await tx.query(sql,args)).rows;
 // Stable text images preserve all unrelated fields, including int8 sign_count
 // and exact datetimes, without JSON number or JS Date coercion.
 const usersSQL=`SELECT id,disabled,access_kind,
  (to_jsonb(u)-'disabled'-'auth_count'-'auth_window'-'refresh_count'-'refresh_window')::text AS stable
  FROM public.library_users u WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"`;
 const tokensSQL=`SELECT digest,user_id,revoked,expires_at::text AS deadline,
  isfinite(expires_at) AS finite,(to_jsonb(t)-'revoked')::text AS stable
  FROM public.library_tokens t WHERE digest=ANY($1::text[]) ORDER BY digest COLLATE "C"`;
 const keysSQL=`SELECT key_id,user_id,revoked,public_key,encode(receipt,'hex') AS receipt,
  (to_jsonb(k)-'user_id'-'revoked'-'public_key'-'receipt')::text AS stable
  FROM public.app_attest_keys k WHERE key_id=ANY($1::text[]) ORDER BY key_id COLLATE "C"`;
 const sessionsSQL=`SELECT digest,key_id,credential_digest,(to_jsonb(s))::text AS stable
  FROM public.app_auth_sessions s WHERE key_id=ANY($1::text[]) OR digest=$2
  ORDER BY digest COLLATE "C" LIMIT 65`;
 const map=(rows,field)=>new Map(rows.map(row=>[row[field],Object.freeze({...row})]));
 const identical=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const equal=(a,b)=>{if(!identical(a,b))fail('conflict');};
 async function sourceLists(tx,expected,op){
  const keys=op.kind==='signIn'?[expected.keyID]:bound((await query(tx,
   'SELECT key_id FROM public.app_attest_keys WHERE user_id=$1 ORDER BY key_id COLLATE "C" LIMIT 65',
   [expected.principalID])).map(r=>r.key_id));
  const tokens=op.kind!=='delete'?[expected.credentialDigest]:bound((await query(tx,
   'SELECT digest FROM public.library_tokens WHERE user_id=$1 ORDER BY digest COLLATE "C" LIMIT 65',
   [expected.principalID])).map(r=>r.digest));
  return {keys:sorted(keys),tokens:sorted(tokens)};
 }
 async function snapshot(tx,plan,expected){
  const users=await query(tx,usersSQL,[plan.userIDs]);
  const tokens=await query(tx,tokensSQL,[plan.credentialDigests]);
  const keys=await query(tx,keysSQL,[plan.keyIDs]);
  const sessions=bound(await query(tx,sessionsSQL,[plan.keyIDs,expected.sessionDigest]));
  if(users.length!==plan.userIDs.length||tokens.length!==plan.credentialDigests.length||keys.length!==plan.keyIDs.length)fail('conflict');
  return {users,tokens,keys,sessions};
 }
 async function absentTarget(tx,op){
  if(op.kind==='signIn'&&(await query(tx,'SELECT digest FROM public.library_tokens WHERE digest=$1',[op.targetCredentialDigest])).length)fail('conflict');
 }
 const exactSQL=`WITH auth_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT pg_current_xact_id()::text AS transaction_id,
 s.expires_at::text AS session_deadline,t.expires_at::text AS credential_deadline,
 s.key_id,s.credential_digest,k.user_id AS key_owner,t.user_id AS token_owner,u.id AS user_id,
 k.bundle_id,k.audience AS key_audience,k.environment,s.audience AS session_audience,
 u.access_kind,u.disabled,k.revoked AS key_revoked,t.revoked AS token_revoked,s.revoked AS session_revoked,
 (isfinite(s.expires_at) AND s.expires_at>c.at AND
  (t.expires_at IS NULL OR (isfinite(t.expires_at) AND t.expires_at>c.at))) AS live
 FROM public.app_auth_sessions s JOIN public.app_attest_keys k ON k.key_id=s.key_id
 JOIN public.library_tokens t ON t.digest=s.credential_digest JOIN public.library_users u ON u.id=k.user_id
 CROSS JOIN auth_clock c WHERE s.digest=$1`;
 async function source(tx,expected,id){
  const r=(await query(tx,exactSQL,[expected.sessionDigest]))[0];
  if(!r)fail('unauthorized');
  if(r.transaction_id!==id)fail();
  if(r.live!==true||r.key_id!==expected.keyID||r.credential_digest!==expected.credentialDigest||
   r.key_owner!==expected.principalID||r.token_owner!==expected.principalID||r.user_id!==expected.principalID||
   r.bundle_id!==expected.bundleID||r.key_audience!==policy.audience||r.session_audience!==policy.audience||
   r.environment!==policy.attestEnvironment||!policy.bundles.includes(r.bundle_id)||
   r.disabled!==false||r.key_revoked!==false||r.token_revoked!==false||r.session_revoked!==false||
   !['guest','apple','beta'].includes(r.access_kind))fail('unauthorized');
  return Object.freeze({...r});
 }
 function sameSource(before,after){
  if(before.session_deadline!==after.session_deadline||before.credential_deadline!==after.credential_deadline||
   before.access_kind!==after.access_kind)fail('unauthorized');
 }
 async function unchanged(tx,retained){
  const {plan,expected,op,state,before,lists,source:initial}=retained;
  if(await transactionID(tx)!==state.id)fail();
  equal(await sourceLists(tx,expected,op),lists);await absentTarget(tx,op);
  const current=await snapshot(tx,plan,expected);
  sameSource(initial,await source(tx,expected,state.id));
  equal(current,before);
 }
 async function verify(tx,r,notAfterMS){
  const {plan,expected,op,state,before,lists,source:initial}=r;
  if(await transactionID(tx)!==state.id)fail();
  equal(await sourceLists(tx,expected,op),lists);
  const after=await snapshot(tx,plan,expected);
  const oldUsers=map(before.users,'id'),oldTokens=map(before.tokens,'digest'),oldKeys=map(before.keys,'key_id');
  for(const row of after.users){
   const old=oldUsers.get(row.id),next={...old};
   if(op.kind==='delete'&&row.id===expected.principalID)next.disabled=true;
   if(op.kind==='signIn'&&row.id===op.targetPrincipalID)next.disabled=false;
   equal(row,next);
  }
  for(const row of after.tokens){
   const old=oldTokens.get(row.digest),next={...old};
   if(row.digest===expected.credentialDigest||op.kind==='delete'&&lists.tokens.includes(row.digest))next.revoked=true;
   equal(row,next);
  }
  for(const row of after.keys){
   const old=oldKeys.get(row.key_id),next={...old};
   if(op.kind==='signIn'&&row.key_id===expected.keyID)next.user_id=op.targetPrincipalID;
   if(op.kind==='delete'&&lists.keys.includes(row.key_id))Object.assign(next,{revoked:true,public_key:'',receipt:''});
   equal(row,next);
  }
  const removed=op.kind==='signIn'?[expected.keyID]:op.kind==='delete'?lists.keys:[];
  equal(after.sessions,before.sessions.filter(s=>!removed.includes(s.key_id)));
  let targetDeadline=null;
  if(op.kind==='signIn'){
   const target=(await query(tx,tokensSQL,[[op.targetCredentialDigest]]))[0];
   if(!target||target.user_id!==op.targetPrincipalID||target.revoked!==false||target.finite!==true||target.deadline===null)fail('conflict');
   targetDeadline=target.deadline;
  }
  // This MUST be the last SQL/IO before the caller returns directly to COMMIT.
  // Captured exact source deadlines remain authoritative after deliberate
  // source key move/C revocation/S deletion. No unchanged-source test here.
  const clock=(await query(tx,`WITH auth_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
   SELECT pg_current_xact_id()::text AS transaction_id,
   (isfinite($1::timestamptz) AND $1::timestamptz>c.at AND
    ($2::timestamptz IS NULL OR (isfinite($2::timestamptz) AND $2::timestamptz>c.at))) AS source_live,
   ($3::timestamptz IS NULL OR (isfinite($3::timestamptz) AND $3::timestamptz>c.at)) AS target_live${
    notAfterMS===undefined?'':', ($4::numeric>extract(epoch FROM c.at)*1000) AS privacy_live'}
   FROM auth_clock c`,[initial.session_deadline,initial.credential_deadline,targetDeadline,
    ...(notAfterMS===undefined?[]:[notAfterMS])]))[0];
  if(clock?.transaction_id!==state.id)fail();
  if(clock.source_live!==true)fail('unauthorized');
  if(clock.target_live!==true)fail('conflict');
  if(notAfterMS!==undefined&&clock.privacy_live!==true)fail('unauthorized');
  return true;
 }
 return Object.freeze({
  async prepare(bearer){return safe(async()=>{
   if(typeof bearer!=='string'||!/^lyra_s_[A-Za-z0-9_-]{1,249}$/.test(bearer))fail('unauthorized');
   const sessionDigest=createHash('sha256').update(bearer).digest('hex');
   let user;try{user=await authStore.authenticate(bearer);}catch(error){
    if(['session_expired','unauthorized','app_access_revoked'].includes(error?.code))fail('unauthorized');fail();
   }
   if(!object(user)||!userID(user.id)||!keyID(user.keyID)||!bundleID(user.bundleID)||
    !policy.bundles.includes(user.bundleID)||!digest(user.credentialDigest))fail('unauthorized');
   const handle=Object.freeze({}),expected=Object.freeze({principalID:user.id,keyID:user.keyID,bundleID:user.bundleID,
    credentialDigest:user.credentialDigest,sessionDigest});
   evidence.set(handle,expected);
   return Object.freeze({principalID:user.id,keyID:user.keyID,bundleID:user.bundleID,evidence:handle});
  });},
  async discover({tx,authentication,operationRawJSON,requiredScopes}={}){return safe(async()=>{
   checkTX(tx);
   // Capture every caller-owned value synchronously before the first await.
   const expected=authenticationFor(authentication),op=operationFor(operationRawJSON),required=scopesFor(requiredScopes);
   const id=await transactionID(tx);if(transactions.get(tx)?.id===id)fail();
   const state={id,phase:'discovering'};transactions.set(tx,state);
   try{
    const initial=await source(tx,expected,id);await absentTarget(tx,op);
    const lists=await sourceLists(tx,expected,op);
    const credentialDigests=bound(sorted([...required.credentialDigests,...lists.tokens,expected.credentialDigest]));
    const keyIDs=bound(sorted([...required.keyIDs,...lists.keys,expected.keyID]));
    const tokens=await query(tx,tokensSQL,[credentialDigests]),keys=await query(tx,keysSQL,[keyIDs]);
    if(tokens.length!==credentialDigests.length||keys.length!==keyIDs.length)fail();
    if(tokens.some(t=>!userID(t.user_id))||keys.some(k=>!userID(k.user_id)))fail();
    const userIDs=bound(sorted([...required.userIDs,expected.principalID,...tokens.map(t=>t.user_id),...keys.map(k=>k.user_id),
     ...(op.kind==='signIn'?[op.targetPrincipalID]:[])]));
    const plan=freezePlan({userIDs,credentialDigests,keyIDs});
    const before=await snapshot(tx,plan,expected);
    equal(before.tokens,tokens);equal(before.keys,keys);
    const tokenMap=map(before.tokens,'digest'),keyMap=map(before.keys,'key_id');
    if(tokenMap.get(expected.credentialDigest)?.user_id!==expected.principalID||keyMap.get(expected.keyID)?.user_id!==expected.principalID)fail('conflict');
    // All observed owners must be in the precomputed user set; never repair it
    // by appending a newly discovered owner after this point.
    if(before.tokens.some(t=>!userIDs.includes(t.user_id))||before.keys.some(k=>!userIDs.includes(k.user_id)))fail('conflict');
    if(op.kind==='signIn'&&before.users.find(u=>u.id===op.targetPrincipalID)?.access_kind!=='apple')fail('conflict');
    if(await transactionID(tx)!==id)fail();
    const discovery=Object.freeze({environment});
    const retained={tx,expected,op,plan,before,lists,source:initial,state};
    plans.set(discovery,retained);state.phase='discovered';return discovery;
   }catch(error){state.phase='failed';throw error;}
  });},
  async lock({tx,discovery}={}){return safe(async()=>{
   checkTX(tx);const r=object(discovery)?plans.get(discovery):null;
   if(!r||r.tx!==tx||r.state.phase!=='discovered')fail();
   const {state,plan,before,expected}=r;state.phase='locking';
   try{
    if(await transactionID(tx)!==state.id)fail();await absentTarget(tx,r.op);
    for(const id of plan.userIDs)if((await query(tx,'SELECT id FROM public.library_users WHERE id=$1 FOR NO KEY UPDATE',[id])).length!==1)fail('conflict');
    // User anchors now exclude cooperating registration/rotation/owner moves.
    // Recheck the FULL enumeration before tokens, never append extra rows.
    equal(await sourceLists(tx,expected,r.op),r.lists);
    const oldTokens=map(before.tokens,'digest'),oldKeys=map(before.keys,'key_id');
    for(const id of plan.credentialDigests){
     const row=(await query(tx,'SELECT digest,user_id FROM public.library_tokens WHERE digest=$1 FOR UPDATE',[id]))[0];
     if(!row||row.user_id!==oldTokens.get(id)?.user_id)fail('conflict');
    }
    for(const id of plan.keyIDs){
     const row=(await query(tx,'SELECT key_id,user_id FROM public.app_attest_keys WHERE key_id=$1 FOR UPDATE',[id]))[0];
     if(!row||row.user_id!==oldKeys.get(id)?.user_id)fail('conflict');
    }
    const sessions=bound(await query(tx,sessionsSQL,[plan.keyIDs,expected.sessionDigest]));
    equal(sessions,before.sessions);
    for(const s of sessions){
     const row=(await query(tx,'SELECT digest,key_id,credential_digest FROM public.app_auth_sessions WHERE digest=$1 FOR UPDATE',[s.digest]))[0];
     if(!row||row.key_id!==s.key_id||row.credential_digest!==s.credential_digest)fail('conflict');
    }
    await unchanged(tx,r);state.phase='locked';
    return Object.freeze({environment,principalID:expected.principalID,keyID:expected.keyID,bundleID:expected.bundleID,
     audience:policy.audience,attestEnvironment:policy.attestEnvironment,credentialDigest:expected.credentialDigest,
     accessKind:r.source.access_kind,
     async revalidate({tx:again}={}){return safe(async()=>{
      try{
       if(again!==tx||state.phase!=='locked')fail();
       await unchanged(tx,r);return true;
      }catch(error){state.phase='failed';throw error;}
     });},
     async assertFreshSession({tx:again,maxAgeMS}={}){return safe(async()=>{
      try{
       if(again!==tx||state.phase!=='locked')fail();
       return await freshSession(tx,{expected,policy,id:state.id,
       sessionDeadline:r.source.session_deadline,credentialDeadline:r.source.credential_deadline,maxAgeMS});}
      catch(error){state.phase='failed';throw error;}
     });},
     async verifyPostimage({tx:again,notAfterMS}={}){return safe(async()=>{
      if(state.phase!=='locked')fail();state.phase='verifying';
      try{
       if(again!==tx||notAfterMS!==undefined&&(!Number.isSafeInteger(notAfterMS)||notAfterMS<0))fail();
       // Negative-only server bound; never substitutes for exact S/C/C2.
       const result=await verify(tx,r,notAfterMS);state.phase='consumed';return result;}
      catch(error){state.phase='failed';throw error;}
     });}
    });
   }catch(error){state.phase='failed';throw error;}
  });}
 });
}
