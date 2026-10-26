import {types} from 'node:util';
import {parseBoundedSessionJSON, validateCommand} from './protocol.js';
import {canonicalCommandHash} from './tickets.js';
import {SessionV2Error} from './errors.js';

export const ADMISSION_LIMITS = Object.freeze({pendingMS:120000, cooldownMS:60000,
  pending:10, lifetimeMembers:25, lifetimeRequests:300, stateBytes:16384});
const states = new WeakSet();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = () => {throw new SessionV2Error('invalid_request');};
const badFacts = () => {throw new TypeError('Invalid admission server facts');};
const uint = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === 'string' && uuidPattern.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const opaque = value => typeof value === 'string' && value.length <= 160 && /^[\x21-\x7e]+$/.test(value);
const environment = value => typeof value === 'string' &&
  (['production','development','test'].includes(value) || /^preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value));
const same = (a, b, fields) => fields.every(key => a[key] === b[key]);
const installFields = ['principalID','keyID','bundleID','audience','attestEnvironment'];
const sameInstall = (a, b) => same(a, b, installFields);
const samePersona = (a, b) => same(a, b, ['id','generation']);
const samePair = (a, b) => same(a, b, ['environment','hostScope','guestKeyID','digest']);
const copy = value => structuredClone(value);
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// These objects are trusted server-domain values, never req.body. Reject
// accessors/proxies and unknown fields rather than silently trusting extensions.
function record(value, required, optional = [], fail = badFacts) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length || required.some(k => !Object.hasOwn(value, k))) fail();
  for (const key of keys) {
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) fail();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(d, 'value') || !d.enumerable) fail();
  }
}
function install(value) {
  record(value, installFields);
  if (!installFields.every(k => opaque(value[k])) || !['development','production'].includes(value.attestEnvironment)) badFacts();
}
function persona(value) {
  record(value, ['id','generation']);
  if (!uuid(value.id) || !uint(value.generation)) badFacts();
}
function profile(value) {
  record(value, ['reference','revision','roomConsentRevision','persona']); persona(value.persona);
  if (!opaque(value.reference) || !uint(value.revision) || !uint(value.roomConsentRevision) || value.roomConsentRevision === 0) badFacts();
}
function pair(value) {
  record(value, ['environment','hostScope','guestKeyID','digest']);
  if (!environment(value.environment) || !digest(value.hostScope) || !opaque(value.guestKeyID) || !digest(value.digest)) badFacts();
}
function actor(value) {
  record(value, ['install','persona','lease']); install(value.install); persona(value.persona);
  if (value.lease !== null) {
    record(value.lease, ['memberID','version']);
    if (!uuid(value.lease.memberID) || !uint(value.lease.version)) badFacts();
  }
}
function checkGrant(value) {
  if (value === undefined) return;
  record(value, ['status'], ['pair','policyRevision','grantID','generation','grantStatus']);
  if (value.status === 'unavailable') {record(value, ['status']); return;}
  record(value, ['status','pair','policyRevision','grantID','generation','grantStatus']);
  pair(value.pair);
  if (value.status !== 'available' || !uint(value.policyRevision) || !uuid(value.grantID) || !uint(value.generation) ||
      !['none','active','revoked'].includes(value.grantStatus) || value.grantStatus === 'none' && value.generation !== 0) badFacts();
}
function checkFacts(value) {
  record(value, ['nowMS','actor'], ['join','approval','terminal','grant']);
  if (!uint(value.nowMS)) badFacts();
  actor(value.actor); checkGrant(value.grant);
  if (value.join !== undefined) {
    const j = value.join;
    record(j, ['requestID','memberID','pair','cooldownUntilMS','resolve','profile']);
    if (!uuid(j.requestID) || !uuid(j.memberID) || !uint(j.cooldownUntilMS)) badFacts();
    pair(j.pair);
    record(j.resolve, ['ticket','sessionID','environment','install','inviteGeneration','issuedAtMS','expiresAtMS']);
    const r = j.resolve; install(r.install);
    if (!opaque(r.ticket) || !uuid(r.sessionID) || !environment(r.environment) || !uint(r.inviteGeneration) ||
        !uint(r.issuedAtMS) || !uint(r.expiresAtMS) || r.expiresAtMS - r.issuedAtMS !== 60000) badFacts();
    profile(j.profile);
  }
  if (value.approval !== undefined) {
    record(value.approval, ['memberID','pair','requester']);
    if (!uuid(value.approval.memberID)) badFacts();
    pair(value.approval.pair); record(value.approval.requester, ['install','persona']);
    install(value.approval.requester.install); persona(value.approval.requester.persona);
  }
  if (value.terminal !== undefined && value.terminal !== null) checkTerminal(value.terminal);
}
function checkTerminal(t) {
  record(t, ['environment','sessionID','id','version','status','install','persona','pairDigest','memberID','memberLeaseVersion','decidedByMemberID','atMS']);
  install(t.install); persona(t.persona);
  if (!environment(t.environment) || !uuid(t.sessionID) || !uuid(t.id) || t.version !== 2 || !digest(t.pairDigest) || !uint(t.atMS) ||
      !['admitted','denied','cancelled','expired'].includes(t.status) ||
      (t.decidedByMemberID !== null && !uuid(t.decidedByMemberID))) badFacts();
  if (t.status === 'admitted') {
    if (!uuid(t.memberID) || !uint(t.memberLeaseVersion) || t.memberLeaseVersion === 0) badFacts();
  } else if (t.memberID !== null || t.memberLeaseVersion !== null) badFacts();
}
function array(value, max) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1) badFacts();
}
function validateState(s) {
  record(s, ['version','environment','sessionID','status','createdAtMS','updatedAtMS','expiresAtMS','inviteGeneration',
    'originalHost','settings','stateVersion','membershipRevision','lifetimeRequestCount','lifetimeMemberCount','members','pending']);
  if (s.version !== 2 || !environment(s.environment) || !uuid(s.sessionID) || !['active','ended'].includes(s.status) ||
      !['createdAtMS','updatedAtMS','expiresAtMS','inviteGeneration','stateVersion','membershipRevision','lifetimeRequestCount','lifetimeMemberCount'].every(k => uint(s[k])) ||
      s.updatedAtMS < s.createdAtMS || s.expiresAtMS <= s.createdAtMS || s.expiresAtMS - s.createdAtMS > 28800000 ||
      s.lifetimeRequestCount > ADMISSION_LIMITS.lifetimeRequests || s.lifetimeMemberCount < 1 || s.lifetimeMemberCount > ADMISSION_LIMITS.lifetimeMembers) badFacts();
  record(s.originalHost, ['install','persona','memberID','scope']);
  install(s.originalHost.install); persona(s.originalHost.persona);
  if (!uuid(s.originalHost.memberID) || !digest(s.originalHost.scope)) badFacts();
  record(s.settings, ['revision','title','askBeforeJoin','takeTurns']);
  if (!uint(s.settings.revision) || typeof s.settings.title !== 'string' || Buffer.byteLength(s.settings.title) > 320 ||
      typeof s.settings.askBeforeJoin !== 'boolean' || typeof s.settings.takeTurns !== 'boolean') badFacts();
  // Reuse established title/grapheme/control validation without widening core wire.
  validateCommand(JSON.stringify({version:2, action:'settings.update', sessionID:s.sessionID, commandID:s.originalHost.memberID,
    expected:{settingsRevision:s.settings.revision}, payload:{title:s.settings.title, askBeforeJoin:s.settings.askBeforeJoin, takeTurns:s.settings.takeTurns}}));
  array(s.members, ADMISSION_LIMITS.lifetimeMembers); array(s.pending, ADMISSION_LIMITS.pending);
  if (!s.members.length || s.members.length > s.lifetimeMemberCount || s.lifetimeRequestCount < s.lifetimeMemberCount - 1 + s.pending.length) badFacts();
  const ids = new Set(), installs = new Set(), ordinals = new Set();
  for (const m of s.members) {
    record(m, ['id','install','persona','profileReference','profileRevision','roomConsentRevision','status','leaseVersion','firstJoinOrdinal','joinedAtMS','endedAtMS']);
    install(m.install); persona(m.persona);
    const binding = JSON.stringify(installFields.map(k => m.install[k]));
    if (!uuid(m.id) || ids.has(m.id) || installs.has(binding) || !opaque(m.profileReference) || !uint(m.profileRevision) ||
        !uint(m.roomConsentRevision) || m.roomConsentRevision === 0 || !['active','left','removed'].includes(m.status) ||
        !uint(m.leaseVersion) || m.leaseVersion === 0 || !uint(m.firstJoinOrdinal) || m.firstJoinOrdinal >= s.lifetimeMemberCount ||
        ordinals.has(m.firstJoinOrdinal) || !uint(m.joinedAtMS) || m.joinedAtMS < s.createdAtMS || m.joinedAtMS > s.updatedAtMS ||
        (m.status === 'active' ? m.endedAtMS !== null : !uint(m.endedAtMS) || m.endedAtMS < m.joinedAtMS || m.endedAtMS > s.updatedAtMS)) badFacts();
    ids.add(m.id); installs.add(binding); ordinals.add(m.firstJoinOrdinal);
  }
  const host = s.members[0];
  if (host.id !== s.originalHost.memberID || host.status !== 'active' || host.firstJoinOrdinal !== 0 ||
      !sameInstall(host.install, s.originalHost.install) || !samePersona(host.persona, s.originalHost.persona)) badFacts();
  const pendingIDs = new Set(), pendingInstalls = new Set();
  for (const r of s.pending) {
    record(r, ['id','version','status','install','persona','pairDigest','profileReference','profileRevision','roomConsentRevision',
      'inviteGeneration','createdAtMS','expiresAtMS']);
    install(r.install); persona(r.persona);
    const binding = JSON.stringify(installFields.map(k => r.install[k]));
    if (!uuid(r.id) || pendingIDs.has(r.id) || pendingInstalls.has(binding) || r.version !== 1 || r.status !== 'pending' ||
        !digest(r.pairDigest) || !opaque(r.profileReference) || !uint(r.profileRevision) || !uint(r.roomConsentRevision) || r.roomConsentRevision === 0 ||
        r.inviteGeneration !== s.inviteGeneration || !uint(r.createdAtMS) || r.createdAtMS < s.createdAtMS || r.createdAtMS > s.updatedAtMS ||
        !uint(r.expiresAtMS) || r.expiresAtMS !== Math.min(r.createdAtMS + ADMISSION_LIMITS.pendingMS, s.expiresAtMS) ||
        s.members.some(m => m.status === 'active' && sameInstall(m.install, r.install))) badFacts();
    pendingIDs.add(r.id); pendingInstalls.add(binding);
  }
}
function seal(state) {
  validateState(state);
  // Reserve JSON's ordinary normalized separator spaces as well as compact
  // UTF-8 bytes. Real DB encoding/framing still needs its independent budget.
  const encoded = JSON.stringify(state); let bytes = Buffer.byteLength(encoded), quoted = false;
  for (let i = 0; i < encoded.length; i++) {
    if (quoted && encoded[i] === '\\') i++;
    else if (encoded[i] === '"') quoted = !quoted;
    else if (!quoted && (encoded[i] === ',' || encoded[i] === ':')) bytes++;
  }
  if (bytes > ADMISSION_LIMITS.stateBytes) throw new SessionV2Error('unavailable');
  freeze(state); states.add(state); return state;
}
function known(state, nowMS) {
  if (!states.has(state) || !uint(nowMS) || nowMS < state.updatedAtMS) badFacts();
}
function increment(value) {if (value === Number.MAX_SAFE_INTEGER) throw new SessionV2Error('unavailable'); return value + 1;}
function touch(s, nowMS, membership = false) {
  s.stateVersion = increment(s.stateVersion); s.updatedAtMS = nowMS;
  if (membership) s.membershipRevision = increment(s.membershipRevision);
}
function activeMember(s, a) {
  return s.members.find(m => m.status === 'active' && sameInstall(m.install, a.install) && samePersona(m.persona, a.persona) &&
    a.lease !== null && m.id === a.lease.memberID && m.leaseVersion === a.lease.version);
}
function memberResult(m) {return {id:m.id, status:m.status, leaseVersion:m.leaseVersion, firstJoinOrdinal:m.firstJoinOrdinal};}
function summary(r) {
  return r.status === 'pending' ? {id:r.id, version:r.version, status:r.status, expiresAtMS:r.expiresAtMS} :
    {id:r.id, version:r.version, status:r.status, memberID:r.memberID, memberLeaseVersion:r.memberLeaseVersion};
}
function terminal(s, r, status, nowMS, member = null, by = null) {
  return {environment:s.environment, sessionID:s.sessionID, id:r.id, version:increment(r.version), status, install:copy(r.install), persona:copy(r.persona), pairDigest:r.pairDigest,
    memberID:member?.id ?? null, memberLeaseVersion:member?.leaseVersion ?? null, decidedByMemberID:by?.id ?? null, atMS:nowMS};
}
function expire(s, nowMS, effects) {
  const due = s.pending.filter(r => r.expiresAtMS <= nowMS || s.status === 'ended');
  if (!due.length) return;
  effects.terminals.push(...due.map(r => terminal(s, r, 'expired', nowMS)));
  s.pending = s.pending.filter(r => !due.includes(r)); touch(s, nowMS);
}
const emptyEffects = () => ({terminals:[], grant:null, cooldown:null});
function finish(original, s, result, effects) {
  try {
    const state = s.stateVersion === original.stateVersion ? original : seal(s);
    return freeze({state, result, effects});
  } catch (error) {
    if (!(error instanceof SessionV2Error) || error.code !== 'unavailable') throw error;
    return freeze({state:original, result:{status:'unavailable', code:'unavailable'}, effects:emptyEffects()});
  }
}

/** A bounded server-domain projection, not a room DTO or an audio authority. */
export function createAdmissionState(facts) {
  record(facts, ['environment','sessionID','nowMS','expiresAtMS','host','title']);
  record(facts.host, ['install','persona','profile','memberID','scope']); install(facts.host.install); persona(facts.host.persona); profile(facts.host.profile);
  if (!uuid(facts.host.memberID) || !digest(facts.host.scope) || !uint(facts.nowMS) ||
      typeof facts.title !== 'string' || Buffer.byteLength(facts.title) > 320 || !samePersona(facts.host.persona, facts.host.profile.persona)) badFacts();
  return seal({version:2, environment:facts.environment, sessionID:facts.sessionID, status:'active', createdAtMS:facts.nowMS,
    updatedAtMS:facts.nowMS, expiresAtMS:facts.expiresAtMS, inviteGeneration:1,
    originalHost:{install:copy(facts.host.install), persona:copy(facts.host.persona), memberID:facts.host.memberID, scope:facts.host.scope},
    settings:{revision:0, title:facts.title, askBeforeJoin:true, takeTurns:false}, stateVersion:0, membershipRevision:0,
    lifetimeRequestCount:0, lifetimeMemberCount:1, members:[{id:facts.host.memberID, install:copy(facts.host.install), persona:copy(facts.host.persona),
      profileReference:facts.host.profile.reference, profileRevision:facts.host.profile.revision, roomConsentRevision:facts.host.profile.roomConsentRevision,
      status:'active', leaseVersion:1, firstJoinOrdinal:0, joinedAtMS:facts.nowMS, endedAtMS:null}], pending:[]});
}
/** Hydrate only this slice from bounded JSON, never a preparsed caller object. */
export function restoreAdmissionState(rawJSON) {return seal(parseBoundedSessionJSON(rawJSON));}

/** Local reducer intent contract; no route or shared wire schema is enabled. */
export function validateAdmissionCommand(rawJSON) {
  const c = parseBoundedSessionJSON(rawJSON);
  record(c, ['version','action','sessionID','commandID','expected','payload'], [], invalid);
  if (c.version !== 2 || !uuid(c.sessionID) || !uuid(c.commandID)) invalid();
  const expected = fields => {record(c.expected, fields, [], invalid); if (!fields.every(k => uint(c.expected[k]))) invalid();};
  switch (c.action) {
  case 'admission.request':
    expected([]); record(c.payload, ['resolveTicket','profileReference','profileRevision','roomConsentRevision'], [], invalid);
    if (!opaque(c.payload.resolveTicket) || !opaque(c.payload.profileReference) || !uint(c.payload.profileRevision) ||
        !uint(c.payload.roomConsentRevision) || c.payload.roomConsentRevision === 0) invalid();
    break;
  case 'admission.decide':
    expected(['requestVersion']); record(c.payload, ['requestID','decision'], [], invalid);
    if (!uuid(c.payload.requestID) || !['approve','deny'].includes(c.payload.decision)) invalid();
    break;
  case 'admission.cancel':
    expected(['requestVersion']); record(c.payload, ['requestID'], [], invalid);
    if (!uuid(c.payload.requestID)) invalid();
    break;
  case 'leave': expected(['memberLeaseVersion']); record(c.payload, [], [], invalid); break;
  case 'settings.update': return validateCommand(rawJSON);
  default: invalid();
  }
  const bodyHash = canonicalCommandHash(JSON.stringify({version:2, action:c.action, sessionID:c.sessionID, expected:c.expected, payload:c.payload}));
  return freeze({command:c, bodyHash});
}

function boundPair(s, p, who) {
  return p.environment === s.environment && p.hostScope === s.originalHost.scope && p.guestKeyID === who.keyID;
}
function admit(s, r, memberID, nowMS) {
  let m = s.members.find(m => sameInstall(m.install, r.install));
  if (m) {
    if (!samePersona(m.persona, r.persona)) return {code:'forbidden'};
    if (m.status === 'active') return {member:m};
    if (m.id !== memberID) return {code:'conflict'};
    m.status = 'active'; m.leaseVersion = increment(m.leaseVersion); m.joinedAtMS = nowMS; m.endedAtMS = null;
    m.profileReference = r.profileReference; m.profileRevision = r.profileRevision; m.roomConsentRevision = r.roomConsentRevision;
  } else {
    if (s.lifetimeMemberCount >= ADMISSION_LIMITS.lifetimeMembers || s.members.some(m => m.id === memberID)) return {code:'conflict'};
    m = {id:memberID, install:copy(r.install), persona:copy(r.persona), status:'active', leaseVersion:1,
      profileReference:r.profileReference, profileRevision:r.profileRevision, roomConsentRevision:r.roomConsentRevision,
      firstJoinOrdinal:s.lifetimeMemberCount, joinedAtMS:nowMS, endedAtMS:null};
    s.members.push(m); s.lifetimeMemberCount++;
  }
  return {member:m};
}

/** Pure state transition. The caller owns current authorization, lock order,
 * receipt dedupe, grant/cooldown CAS, terminal retention and atomic commit of
 * ALL returned state/effects. Structural server facts do not prove liveness.
 */
export function reduceAdmission(state, rawJSON, facts) {
  const {command:c} = validateAdmissionCommand(rawJSON);
  checkFacts(facts); known(state, facts.nowMS);
  const {nowMS, actor:a} = facts, s = copy(state), effects = emptyEffects();
  const done = result => finish(state, s, result, effects);
  const refuse = code => done({status:code === 'unavailable' ? 'unavailable' : 'refused', code});
  try {
    if (c.sessionID !== s.sessionID) return refuse('not_found');
    expire(s, nowMS, effects);
    if (s.status !== 'active' || nowMS >= s.expiresAtMS) return refuse('expired');
    if (c.action === 'admission.request') {
      const j = facts.join;
      if (!j) return refuse('unavailable');
      const resolve = j.resolve, p = c.payload;
      if (!boundPair(s, j.pair, a.install) || resolve.environment !== s.environment || resolve.sessionID !== s.sessionID ||
          !sameInstall(resolve.install, a.install) || resolve.ticket !== p.resolveTicket || resolve.inviteGeneration !== s.inviteGeneration ||
          !samePersona(j.profile.persona, a.persona) || j.profile.reference !== p.profileReference || j.profile.revision !== p.profileRevision ||
          j.profile.roomConsentRevision !== p.roomConsentRevision) return refuse('forbidden');
      if (resolve.issuedAtMS > nowMS || resolve.expiresAtMS <= nowMS) return refuse('expired');
      if (s.members.some(m => m.status === 'active' && m.install.keyID === a.install.keyID && !sameInstall(m.install, a.install))) return refuse('forbidden');
      const existing = s.members.find(m => m.status === 'active' && sameInstall(m.install, a.install) && samePersona(m.persona, a.persona));
      if (existing) return done({status:'accepted', member:memberResult(existing)});
      const pending = s.pending.find(r => sameInstall(r.install, a.install));
      if (pending) return samePersona(pending.persona, a.persona) && pending.pairDigest === j.pair.digest ?
        done({status:'accepted', admission:summary(pending)}) : refuse('forbidden');
      if (j.cooldownUntilMS > nowMS) return refuse('rate_limited');
      let immediate = !s.settings.askBeforeJoin;
      if (!immediate) {
        if (!facts.grant || facts.grant.status !== 'available') return refuse('unavailable');
        if (!samePair(facts.grant.pair, j.pair)) return refuse('forbidden');
        immediate = facts.grant.grantStatus === 'active';
      }
      if (s.lifetimeRequestCount >= ADMISSION_LIMITS.lifetimeRequests || !immediate && s.pending.length >= ADMISSION_LIMITS.pending ||
          s.pending.some(r => r.id === j.requestID)) return refuse('conflict');
      const r = {id:j.requestID, version:1, status:'pending', install:copy(a.install), persona:copy(a.persona), pairDigest:j.pair.digest,
        profileReference:p.profileReference, profileRevision:p.profileRevision, roomConsentRevision:p.roomConsentRevision,
        inviteGeneration:s.inviteGeneration, createdAtMS:nowMS, expiresAtMS:Math.min(nowMS + ADMISSION_LIMITS.pendingMS, s.expiresAtMS)};
      if (immediate) {
        const admitted = admit(s, r, j.memberID, nowMS);
        if (admitted.code) return refuse(admitted.code);
        s.lifetimeRequestCount++; touch(s, nowMS, true);
        const t = terminal(s, r, 'admitted', nowMS, admitted.member); effects.terminals.push(t);
        return done({status:'accepted', admission:summary(t), member:memberResult(admitted.member)});
      }
      s.lifetimeRequestCount++; s.pending.push(r); touch(s, nowMS);
      return done({status:'accepted', admission:summary(r)});
    }
    if (c.action === 'settings.update' || c.action === 'leave') {
      const m = activeMember(s, a);
      if (!m) return refuse('forbidden');
      const original = m.id === s.originalHost.memberID && sameInstall(a.install, s.originalHost.install);
      if (c.action === 'settings.update') {
        if (!original) return refuse('forbidden');
        if (c.expected.settingsRevision !== s.settings.revision) return refuse('conflict');
        s.settings = {...s.settings, ...c.payload, revision:increment(s.settings.revision)}; touch(s, nowMS);
        return done({status:'accepted'});
      }
      if (original) return refuse('forbidden');
      if (c.expected.memberLeaseVersion !== m.leaseVersion) return refuse('conflict');
      m.status = 'left'; m.leaseVersion = increment(m.leaseVersion); m.endedAtMS = nowMS; touch(s, nowMS, true);
      return done({status:'accepted', member:memberResult(m)});
    }
    const decider = c.action === 'admission.decide' ? activeMember(s, a) : null;
    if (c.action === 'admission.decide' && !decider) return refuse('forbidden');
    const r = s.pending.find(r => r.id === c.payload.requestID);
    const prior = effects.terminals.find(t => t.id === c.payload.requestID) ?? facts.terminal;
    if (!r) {
      if (!prior || prior.environment !== s.environment || prior.sessionID !== s.sessionID || prior.id !== c.payload.requestID || prior.atMS > nowMS) return refuse('not_found');
      if (c.action === 'admission.cancel' && (!sameInstall(prior.install, a.install) || !samePersona(prior.persona, a.persona))) return refuse('not_found');
      // Return the winning terminal result, never reconstruct a grant/lease.
      return done({status:'accepted', admission:summary(prior)});
    }
    if (c.action === 'admission.cancel' && (!sameInstall(r.install, a.install) || !samePersona(r.persona, a.persona))) return refuse('not_found');
    if (c.expected.requestVersion !== r.version) return refuse('conflict');
    let m = null;
    if (c.action === 'admission.decide') {
      const approval = facts.approval;
      if (!approval) return refuse('unavailable');
      if (!boundPair(s, approval.pair, r.install) || approval.pair.digest !== r.pairDigest ||
          !sameInstall(approval.requester.install, r.install) || !samePersona(approval.requester.persona, r.persona)) return refuse('forbidden');
      if (c.payload.decision === 'approve') {
        const g = facts.grant;
        if (!g || g.status !== 'available') return refuse('unavailable');
        if (!samePair(g.pair, approval.pair)) return refuse('forbidden');
        const admitted = admit(s, r, approval.memberID, nowMS);
        if (admitted.code) return refuse(admitted.code);
        m = admitted.member;
        effects.grant = {pair:copy(g.pair), grantID:g.grantID, expectedPolicyRevision:g.policyRevision,
          expectedGeneration:g.generation, nextGeneration:increment(g.generation), hostPersona:copy(s.originalHost.persona),
          guestPersona:copy(r.persona), approverPersona:copy(a.persona), approverMemberID:decider.id, sessionID:s.sessionID, requestID:r.id};
      } else {
        const untilMS = nowMS + ADMISSION_LIMITS.cooldownMS;
        if (!uint(untilMS)) return refuse('unavailable');
        effects.cooldown = {pair:copy(approval.pair), untilMS};
      }
    }
    const status = c.action === 'admission.cancel' ? 'cancelled' : m ? 'admitted' : 'denied';
    const t = terminal(s, r, status, nowMS, m, decider);
    s.pending = s.pending.filter(p => p !== r); touch(s, nowMS, m !== null); effects.terminals.push(t);
    return done({status:'accepted', admission:summary(t), ...(m ? {member:memberResult(m)} : {})});
  } catch (error) {
    if (!(error instanceof SessionV2Error) || error.code !== 'unavailable') throw error;
    return freeze({state, result:{status:'unavailable', code:'unavailable'}, effects:emptyEffects()});
  }
}

/** Server-clock sweep; emitted terminal records must commit with the new slice. */
export function expireAdmissions(state, nowMS) {
  known(state, nowMS); const s = copy(state), effects = emptyEffects();
  try {expire(s, nowMS, effects); return finish(state, s, {status:'accepted'}, effects);}
  catch (error) {
    if (!(error instanceof SessionV2Error) || error.code !== 'unavailable') throw error;
    return freeze({state, result:{status:'unavailable', code:'unavailable'}, effects:emptyEffects()});
  }
}

/** Trusted lifecycle invalidation, NOT a user moderation action or privacy hook.
 * Does not revoke grants, End the host, transfer audio or release output guards.
 */
export function removeAdmissionMember(state, facts) {
  record(facts, ['nowMS','memberID','expectedLeaseVersion','reason']);
  if (!uuid(facts.memberID) || !uint(facts.expectedLeaseVersion) ||
      !['authorization_withdrawn','participation_closed'].includes(facts.reason)) badFacts();
  known(state, facts.nowMS); const s = copy(state), effects = emptyEffects();
  const m = s.members.find(m => m.id === facts.memberID);
  const refuse = code => finish(state, s, {status:'refused', code}, effects);
  if (!m) return refuse('not_found');
  if (m.id === s.originalHost.memberID) return refuse('forbidden');
  if (m.leaseVersion !== facts.expectedLeaseVersion) return refuse('conflict');
  if (m.status !== 'active') return finish(state, s, {status:'accepted', member:memberResult(m)}, effects);
  try {
    m.status = 'removed'; m.leaseVersion = increment(m.leaseVersion); m.endedAtMS = facts.nowMS; touch(s, facts.nowMS, true);
    return finish(state, s, {status:'accepted', member:memberResult(m)}, effects);
  } catch (error) {
    if (!(error instanceof SessionV2Error) || error.code !== 'unavailable') throw error;
    return freeze({state, result:{status:'unavailable', code:'unavailable'}, effects:emptyEffects()});
  }
}
