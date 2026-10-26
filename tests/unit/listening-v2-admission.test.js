import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdmissionState, restoreAdmissionState, validateAdmissionCommand, reduceAdmission,
  expireAdmissions, removeAdmissionMember, ADMISSION_LIMITS} from '../../api/utils/listening-v2/admission.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const environment = 'preview:admission.synthetic';
const scope = 'a'.repeat(64), digest = n => n.toString(16).padStart(64, '0');
const install = n => ({principalID:`user-${n}`, keyID:`key-${n}`, bundleID:'test.lyrica', audience:'test', attestEnvironment:'development'});
const persona = n => ({id:id(n + 1000), generation:1});
const actor = (n, member = null) => ({install:install(n), persona:persona(n), lease:member ? {memberID:member.id, version:member.leaseVersion} : null});
const state = () => createAdmissionState({environment, sessionID:id(1), nowMS:1000, expiresAtMS:1000 + 28800000,
  host:{install:install(0), persona:persona(0), profile:{reference:'profile.host', revision:1, roomConsentRevision:1, persona:persona(0)}, memberID:id(2), scope}, title:"Ada's session"});
const host = s => actor(0, s.members[0]);
const pair = n => ({environment, hostScope:scope, guestKeyID:install(n).keyID, digest:digest(n)});
const grant = (n, status = 'none') => ({status:'available', pair:pair(n), policyRevision:1,
  grantID:id(9000 + n), generation:status === 'none' ? 0 : 7, grantStatus:status});
const command = (action, payload = {}, expected = {}) => JSON.stringify({version:2, action, sessionID:id(1), commandID:id(900), expected, payload});
const request = () => command('admission.request', {resolveTicket:'resolve.synthetic', profileReference:'profile.synthetic', profileRevision:1, roomConsentRevision:1});
const facts = (n, nowMS = 1000) => ({nowMS, actor:actor(n), join:{requestID:id(100 + n), memberID:id(200 + n), pair:pair(n), cooldownUntilMS:0,
  resolve:{ticket:'resolve.synthetic', sessionID:id(1), environment, install:install(n), inviteGeneration:1, issuedAtMS:nowMS, expiresAtMS:nowMS + 60000},
  profile:{reference:'profile.synthetic', revision:1, roomConsentRevision:1, persona:persona(n)}}, grant:grant(n)});
const ask = (s, n, nowMS = 1000) => reduceAdmission(s, request(), facts(n, nowMS));
const decision = (s, n, choice = 'approve', by = host(s), nowMS = 1001) => reduceAdmission(s,
  command('admission.decide', {requestID:id(100 + n), decision:choice}, {requestVersion:1}),
  {nowMS, actor:by, approval:{memberID:id(200 + n), pair:pair(n), requester:{install:install(n), persona:persona(n)}}, grant:grant(n)});
const approve = (s, n, nowMS = 1001) => decision(s, n, 'approve', host(s), nowMS);
const settings = (s, payload, by = host(s), nowMS = s.updatedAtMS) => reduceAdmission(s,
  command('settings.update', payload, {settingsRevision:s.settings.revision}), {nowMS, actor:by});
const cancel = (s, n, nowMS = 1001, terminal = null) => reduceAdmission(s,
  command('admission.cancel', {requestID:id(100 + n)}, {requestVersion:1}), {nowMS, actor:actor(n), terminal});
const leave = (s, n, nowMS = s.updatedAtMS) => {
  const member = s.members.find(m => m.install.keyID === install(n).keyID);
  return reduceAdmission(s, command('leave', {}, {memberLeaseVersion:member.leaseVersion}), {nowMS, actor:actor(n, member)});
};
const isCode = code => error => error.code === code && error.message === code;

test('initial state fixes Ask on, Take turns off, original host and separate membership lease', () => {
  const s = state();
  assert.equal(s.settings.askBeforeJoin, true); assert.equal(s.settings.takeTurns, false);
  assert.equal(s.members.length, 1); assert.equal(s.members[0].leaseVersion, 1);
  assert.equal(s.lifetimeRequestCount, 0); assert.equal(s.members[0].firstJoinOrdinal, 0);
  assert.deepEqual(s.originalHost.install, install(0));
  assert.equal(ADMISSION_LIMITS.pendingMS, 120000);
  assert.deepEqual(restoreAdmissionState(JSON.stringify(s)), s);
  assert(Object.isFrozen(s.originalHost.install));
});

test('client objects and oversized raw JSON refuse before reflection or JSON.parse', () => {
  let touches = 0, parses = 0;
  const proxy = new Proxy({}, {get(){touches++; throw Error('get');}, ownKeys(){touches++; throw Error('keys');}});
  const parse = JSON.parse;
  try {
    JSON.parse = (...args) => {parses++; return parse(...args);};
    for (const input of [proxy, {}, Buffer.from(request()), request() + ' '.repeat(16384), '{"x":"' + '界'.repeat(5500) + '"}']) {
      assert.throws(() => validateAdmissionCommand(input), isCode('invalid_request'));
    }
  } finally { JSON.parse = parse; }
  assert.equal(touches, 0); assert.equal(parses, 0);
});

test('strict V2 local intents refuse forged authority, V1, unknown keys and overwritten invalid numbers', () => {
  const base = JSON.parse(request());
  for (const value of [{...base, version:1}, {...base, actorID:id(2)}, {...base, action:'member.remove'},
    {...base, action:'host.claim'}, {...base, payload:{...base.payload, pairDigest:digest(1)}},
    {...base, expected:{requestVersion:1}}, {...base, payload:{...base.payload, roomConsentRevision:0}}]) {
    assert.throws(() => validateAdmissionCommand(JSON.stringify(value)), isCode('invalid_request'));
  }
  for (const token of ['1.0', '1e0', '1e-1000', '9007199254740992']) {
    assert.throws(() => validateAdmissionCommand(request().replace('"profileRevision":1', `"profileRevision":${token},"profileRevision":1`)), isCode('invalid_request'));
  }
  assert.throws(() => validateAdmissionCommand(request().replace('"version":2', '"version":2,"ver\\u0073ion":2')), isCode('invalid_request'));
  const a = validateAdmissionCommand(request());
  const b = validateAdmissionCommand(JSON.stringify({...base, commandID:id(901)}));
  assert.equal(a.bodyHash, b.bodyHash); assert(Object.isFrozen(a.command.payload));
});

test('server inputs reject proxies, getters, extra authority fields and unvalidated snapshots', () => {
  let touches = 0;
  const proxy = new Proxy({}, {get(){touches++;}, ownKeys(){touches++;}});
  assert.throws(() => reduceAdmission(state(), request(), proxy), TypeError);
  assert.throws(() => reduceAdmission(proxy, request(), facts(1)), TypeError);
  const f = facts(1); Object.defineProperty(f, 'nowMS', {get(){touches++; return 1000;}, enumerable:true});
  assert.throws(() => reduceAdmission(state(), request(), f), TypeError);
  assert.equal(touches, 0);
  const g = facts(1); g.actor.host = true;
  assert.throws(() => reduceAdmission(state(), request(), g), TypeError);
  assert.throws(() => reduceAdmission(JSON.parse(JSON.stringify(state())), request(), facts(1)), TypeError);
});

test('new request binds verified install, pair, resolve generation and fresh room-profile consent', () => {
  const s = state(), result = ask(s, 1);
  assert.equal(result.result.admission.status, 'pending');
  assert.equal(result.state.pending[0].expiresAtMS, 121000);
  assert.equal(result.state.lifetimeRequestCount, 1); assert.equal(result.state.members.length, 1);
  for (const change of [f => {f.join.pair.guestKeyID='key-other';}, f => {f.join.pair.hostScope=digest(8);},
    f => {f.join.pair.environment='preview:other';}, f => {f.join.resolve.install=install(2);},
    f => {f.join.resolve.inviteGeneration=2;}, f => {f.join.resolve.sessionID=id(9);},
    f => {f.join.profile.persona=persona(2);}, f => {f.join.profile.revision=2;}]) {
    const f = facts(1); change(f);
    assert.equal(reduceAdmission(s, request(), f).result.status, 'refused');
  }
  const expired = facts(1, 61000); expired.join.resolve.issuedAtMS=1000; expired.join.resolve.expiresAtMS=61000;
  assert.equal(reduceAdmission(s, request(), expired).result.code, 'expired');
  assert.equal(s.lifetimeRequestCount, 0, 'input never mutates');
});

test('missing or unavailable returning authority never silently changes Ask to immediate admission', () => {
  for (const authority of [undefined, {status:'unavailable'}]) {
    const f = facts(1); if (authority) f.grant=authority; else delete f.grant;
    const r = reduceAdmission(state(), request(), f);
    assert.equal(r.result.status, 'unavailable'); assert.equal(r.result.code, 'unavailable');
    assert.equal(r.state.lifetimeRequestCount, 0); assert.equal(r.effects.grant, null);
  }
  const f = facts(1); f.grant.pair=pair(2);
  assert.equal(reduceAdmission(state(), request(), f).result.code, 'forbidden');
});

test('returning active grant auto-admits only its exact current pair, without issuing a grant', () => {
  const f = facts(1); f.grant=grant(1, 'active');
  const r = reduceAdmission(state(), request(), f);
  assert.equal(r.result.admission.status, 'admitted'); assert.equal(r.result.member.leaseVersion, 1);
  assert.equal(r.state.members.length, 2); assert.equal(r.state.pending.length, 0);
  assert.equal(r.effects.grant, null);
  assert.equal(ask(state(), 1).result.admission.status, 'pending');
  f.grant=grant(1, 'revoked');
  assert.equal(reduceAdmission(state(), request(), f).result.admission.status, 'pending');
});

test('same-key principal move may use a newly validated install grant but cannot inherit membership', () => {
  const f = facts(1); f.actor.install.principalID='signed-in-new'; f.join.resolve.install.principalID='signed-in-new';
  f.grant=grant(1, 'active');
  const r = reduceAdmission(state(), request(), f);
  assert.equal(r.result.admission.status, 'admitted');
  assert.equal(r.state.members[1].install.principalID, 'signed-in-new');
  assert.equal(settings(r.state, {title:'stolen'}, {...host(r.state), install:{...install(0), principalID:'other'}}).result.code, 'forbidden');
});

test('active guest may approve with current lease; grant intent records host-scoped approver provenance', () => {
  let s = approve(ask(state(), 1).state, 1).state;
  s = ask(s, 2, 1002).state;
  const r = decision(s, 2, 'approve', actor(1, s.members[1]), 1003);
  assert.equal(r.result.admission.status, 'admitted'); assert.equal(r.state.members.length, 3);
  assert.deepEqual(r.effects.grant.approverPersona, persona(1));
  assert.deepEqual(r.effects.grant.hostPersona, persona(0));
  assert.equal(r.effects.grant.pair.hostScope, scope);
  assert.equal(r.effects.grant.expectedPolicyRevision, 1);
  assert.equal(r.effects.grant.nextGeneration, 1);
  assert.equal(r.effects.terminals.length, 1);
});

test('nonmember, stale lease, other installation and stale request CAS cannot decide', () => {
  const s = ask(state(), 1).state;
  for (const by of [actor(2), {...host(s), lease:{memberID:id(2), version:0}},
    {...host(s), install:{...install(0), keyID:'another-key'}}, {...host(s), persona:persona(2)}]) {
    const r = decision(s, 1, 'approve', by);
    assert.equal(r.result.code, 'forbidden'); assert.equal(r.effects.grant, null);
  }
  const r = reduceAdmission(s, command('admission.decide', {requestID:id(101), decision:'approve'}, {requestVersion:0}),
    {nowMS:1001, actor:host(s), approval:{memberID:id(201), pair:pair(1), requester:{install:install(1), persona:persona(1)}}, grant:grant(1)});
  assert.equal(r.result.code, 'conflict'); assert.equal(r.state.pending.length, 1);
});

test('approval requires current requester binding and available grant write authority', () => {
  const s = ask(state(), 1).state;
  for (const g of [undefined, {status:'unavailable'}]) {
    const r = reduceAdmission(s, command('admission.decide', {requestID:id(101), decision:'approve'}, {requestVersion:1}),
      {nowMS:1001, actor:host(s), approval:{memberID:id(201), pair:pair(1), requester:{install:install(1), persona:persona(1)}}, ...(g ? {grant:g} : {})});
    assert.equal(r.result.status, 'unavailable'); assert.equal(r.state.members.length, 1); assert.equal(r.state.pending.length, 1);
  }
  const r = reduceAdmission(s, command('admission.decide', {requestID:id(101), decision:'approve'}, {requestVersion:1}),
    {nowMS:1001, actor:host(s), approval:{memberID:id(201), pair:pair(2), requester:{install:install(1), persona:persona(1)}}, grant:grant(1)});
  assert.equal(r.result.code, 'forbidden');
});

test('Ask false admits new requests without remembering and never drains existing pending', () => {
  let s = ask(state(), 1).state;
  s = settings(s, {askBeforeJoin:false}, host(s), 1001).state;
  assert.equal(s.pending.length, 1);
  const f = facts(2, 1002); delete f.grant;
  const r = reduceAdmission(s, request(), f);
  assert.equal(r.result.admission.status, 'admitted'); assert.equal(r.effects.grant, null);
  assert.equal(r.state.pending.length, 1);
  assert.equal(ask(s, 1, 1002).state.lifetimeRequestCount, 1, 'one live request per verified install');
});

test('settings are original-host-only with settings CAS and no audio authority output', () => {
  const s = approve(ask(state(), 1).state, 1).state;
  assert.equal(settings(s, {takeTurns:true}, actor(1, s.members[1])).result.code, 'forbidden');
  for (const field of ['principalID','keyID','bundleID','audience','attestEnvironment']) {
    const a = host(s); a.install[field] = field === 'attestEnvironment' ? 'production' : a.install[field] + '-other';
    assert.equal(settings(s, {takeTurns:true}, a).result.code, 'forbidden');
  }
  const r = settings(s, {title:'新しい夜', askBeforeJoin:false, takeTurns:true});
  assert.equal(r.state.settings.revision, 1); assert.equal(r.state.settings.title, '新しい夜');
  assert.deepEqual(r.state.originalHost, s.originalHost);
  assert.deepEqual(Object.keys(r.effects).sort(), ['cooldown','grant','terminals']);
  const stale = reduceAdmission(r.state, command('settings.update', {title:'old'}, {settingsRevision:0}), {nowMS:1001, actor:host(r.state)});
  assert.equal(stale.result.code, 'conflict');
});

test('denial emits a bound 60s cooldown; cancel is requester-only and neither writes a grant', () => {
  const s = ask(state(), 1).state, denied = decision(s, 1, 'deny');
  assert.equal(denied.result.admission.status, 'denied'); assert.equal(denied.effects.cooldown.untilMS, 61001);
  assert.equal(denied.effects.grant, null);
  const f = facts(1, 1002); f.join.cooldownUntilMS=61001; f.grant=grant(1, 'active');
  assert.equal(reduceAdmission(denied.state, request(), f).result.code, 'rate_limited');
  f.nowMS=61001; f.join.resolve.issuedAtMS=61001; f.join.resolve.expiresAtMS=121001;
  assert.equal(reduceAdmission(denied.state, request(), f).result.admission.status, 'admitted');
  const cancelled = cancel(s, 1); assert.equal(cancelled.result.admission.status, 'cancelled');
  assert.equal(cancelled.effects.cooldown, null); assert.equal(cancelled.effects.grant, null);
  const other = reduceAdmission(s, command('admission.cancel', {requestID:id(101)}, {requestVersion:1}), {nowMS:1001, actor:actor(2)});
  assert.equal(other.result.code, 'not_found');
});

test('120s expiry wins at the exact deadline, frees pending slots and keeps lifetime accounting', () => {
  const s = ask(state(), 1).state;
  assert.equal(approve(s, 1, 120999).result.admission.status, 'admitted');
  const r = approve(s, 1, 121000);
  assert.equal(r.result.admission.status, 'expired'); assert.equal(r.effects.grant, null);
  assert.equal(r.state.pending.length, 0); assert.equal(r.state.lifetimeRequestCount, 1);
  assert.equal(r.effects.terminals[0].version, 2);
  assert.equal(expireAdmissions(r.state, 121001).effects.terminals.length, 0);
});

test('serialized terminal orderings return first result; losers cannot allocate grant or membership', () => {
  for (const first of ['approve','deny','cancel','expire']) {
    const s = ask(state(), 1).state;
    const winner = first === 'cancel' ? cancel(s, 1) : first === 'expire' ? expireAdmissions(s, 121000) : decision(s, 1, first);
    const terminal = winner.effects.terminals[0];
    const at = first === 'expire' ? 121000 : 1002;
    const loser = reduceAdmission(winner.state, command('admission.decide', {requestID:id(101), decision:'approve'}, {requestVersion:1}),
      {nowMS:at, actor:host(winner.state), terminal});
    assert.equal(loser.result.admission.status, terminal.status);
    assert.equal(loser.state, winner.state); assert.equal(loser.effects.grant, null);
    assert.equal(loser.effects.terminals.length, 0);
    assert.equal(cancel(winner.state, 1, at, terminal).result.admission.status, terminal.status);
  }
});

test('all terminal winner/loser pairs keep one membership/grant and never reuse a stale terminal lease', () => {
  for (const first of ['approve','deny','cancel','expire']) {
    const s = ask(state(), 1).state;
    const winner = first === 'cancel' ? cancel(s, 1) : first === 'expire' ? expireAdmissions(s, 121000) : decision(s, 1, first);
    const t = winner.effects.terminals[0], at = t.atMS + 1;
    for (const next of ['approve','deny','cancel','expire']) {
      const loser = next === 'expire' ? expireAdmissions(winner.state, at) : next === 'cancel' ? cancel(winner.state, 1, at, t) :
        reduceAdmission(winner.state, command('admission.decide', {requestID:t.id, decision:next}, {requestVersion:1}),
          {nowMS:at, actor:host(winner.state), terminal:t});
      assert.equal(loser.state, winner.state); assert.equal(loser.effects.grant, null);
      assert.equal(loser.effects.terminals.length, 0);
      if (next !== 'expire') assert.equal(loser.result.admission.status, t.status);
    }
    if (first === 'approve') {
      const left = leave(winner.state, 1, at).state;
      const result = cancel(left, 1, at + 1, t).result;
      assert.equal(result.admission.memberLeaseVersion, 1);
      assert.equal(left.members[1].leaseVersion, 2);
      assert(!Object.hasOwn(result, 'member'), 'terminal result cannot restore a current member lease');
    }
  }
});

test('terminal lookup is scoped to room, environment, requester and server time', () => {
  const s = ask(state(), 1).state, won = cancel(s, 1), terminal = won.effects.terminals[0];
  for (const patch of [{environment:'preview:other'}, {sessionID:id(99)}, {atMS:9999}, {id:id(99)}]) {
    const r = cancel(won.state, 1, 1002, {...terminal, ...patch});
    assert.equal(r.result.code, 'not_found'); assert.equal(r.effects.grant, null);
  }
  const r = reduceAdmission(won.state, command('admission.cancel', {requestID:terminal.id}, {requestVersion:1}),
    {nowMS:1002, actor:actor(2), terminal});
  assert.equal(r.result.code, 'not_found');
  assert.equal(cancel(won.state, 1, 1002).result.code, 'not_found', 'absence never invents terminal success');
});

test('at most ten pending requests, independent of 25 lifetime members; expiry releases only pending capacity', () => {
  let s = state();
  for (let n = 1; n <= 10; n++) s = ask(s, n).state;
  const r = ask(s, 11); assert.equal(r.result.code, 'conflict');
  assert.equal(r.state.lifetimeRequestCount, 10);
  const expired = expireAdmissions(s, 121000);
  assert.equal(expired.effects.terminals.length, 10);
  const next = ask(expired.state, 11, 121001);
  assert.equal(next.state.pending.length, 1); assert.equal(next.state.lifetimeRequestCount, 11);
});

test('capacity is checked on approval, and leave does not recycle lifetime member slots', () => {
  let s = settings(state(), {askBeforeJoin:false}).state;
  for (let n = 1; n <= 23; n++) s = ask(s, n).state;
  s = settings(s, {askBeforeJoin:true}).state;
  s = ask(s, 24).state; s = ask(s, 25).state;
  s = approve(s, 24).state;
  assert.equal(s.members.length, 25);
  assert.equal(approve(s, 25).result.code, 'conflict');
  s = leave(s, 1).state;
  assert.equal(approve(s, 25).result.code, 'conflict');
  assert.equal(s.members.length, 25);
  const compacted = JSON.parse(JSON.stringify(s));
  compacted.members = compacted.members.filter(m => m.status === 'active');
  const restored = restoreAdmissionState(JSON.stringify(compacted));
  assert.equal(restored.members.length, 24); assert.equal(restored.lifetimeMemberCount, 25);
  assert.equal(approve(restored, 25).result.code, 'conflict', 'a future privacy compactor cannot recycle the independent lifetime count');
});

test('a pruned inactive record retains lifetime accounting and future join ordinals', () => {
  const left = leave(approve(ask(state(), 1).state, 1).state, 1, 1002).state;
  const projection = JSON.parse(JSON.stringify(left)); projection.members.splice(1, 1);
  const s = restoreAdmissionState(JSON.stringify(projection));
  const pending = ask(s, 2, 1003).state, joined = approve(pending, 2, 1004);
  assert.equal(joined.state.lifetimeMemberCount, 3); assert.equal(joined.state.members.length, 2);
  assert.equal(joined.result.member.firstJoinOrdinal, 2);
});

test('300 request lifetime cap never resets through cancellation; duplicate live/active requests spend no slot', () => {
  let s = state();
  for (let n = 0; n < 300; n++) {
    const f = facts(1, 1000 + n); f.join.requestID=id(10000 + n);
    const pending = reduceAdmission(s, request(), f);
    assert.equal(pending.result.admission.status, 'pending');
    const duplicate = reduceAdmission(pending.state, request(), f);
    assert.equal(duplicate.state.lifetimeRequestCount, n + 1);
    s = reduceAdmission(pending.state, command('admission.cancel', {requestID:f.join.requestID}, {requestVersion:1}), {nowMS:1000+n, actor:actor(1)}).state;
  }
  assert.equal(ask(s, 1, 1400).result.code, 'conflict'); assert.equal(s.lifetimeRequestCount, 300);
  const active = approve(ask(state(), 1).state, 1).state;
  const r = ask(active, 1, 1002);
  assert.equal(r.result.member.id, id(201)); assert.equal(r.state.lifetimeRequestCount, 1); assert.equal(r.effects.grant, null);
});

test('guest leave/rejoin invalidates old membership lease without changing host or granting playback', () => {
  const initial = approve(ask(state(), 1).state, 1).state;
  const old = initial.members[1], exited = leave(initial, 1, 1002);
  assert.equal(exited.state.members[1].status, 'left'); assert.equal(exited.state.members[1].leaseVersion, 2);
  const f = facts(1, 1003); f.grant=grant(1, 'active');
  const r = reduceAdmission(exited.state, request(), f);
  assert.equal(r.state.members.length, 2); assert.equal(r.result.member.id, old.id);
  assert.equal(r.result.member.firstJoinOrdinal, old.firstJoinOrdinal); assert.equal(r.result.member.leaseVersion, 3);
  assert.deepEqual(r.state.originalHost, initial.originalHost);
  const pending = ask(r.state, 2, 1004).state;
  assert.equal(decision(pending, 2, 'approve', actor(1, old), 1005).result.code, 'forbidden');
  assert.equal(reduceAdmission(r.state, command('leave', {}, {memberLeaseVersion:1}), {nowMS:1004, actor:actor(1, r.state.members[1])}).result.code, 'conflict');
  assert.equal(reduceAdmission(r.state, command('leave', {}, {memberLeaseVersion:1}), {nowMS:1004, actor:host(r.state)}).result.code, 'forbidden');
});

test('rejoin requires a fresh resolved profile binding, preserves ordinal and does not revive an altered persona', () => {
  const s = leave(approve(ask(state(), 1).state, 1).state, 1, 1002).state;
  const f = facts(1, 1003); f.join.profile.reference='profile.new'; f.join.profile.revision=2;
  f.join.profile.roomConsentRevision=3; f.grant=grant(1, 'active');
  const raw = command('admission.request', {resolveTicket:'resolve.synthetic', profileReference:'profile.new', profileRevision:2, roomConsentRevision:3});
  const r = reduceAdmission(s, raw, f);
  assert.equal(r.state.members[1].profileReference, 'profile.new'); assert.equal(r.state.members[1].roomConsentRevision, 3);
  f.actor.persona.generation=2; f.join.profile.persona.generation=2;
  assert.equal(reduceAdmission(s, raw, f).result.code, 'forbidden');
  const newPrincipal = facts(1, 1003); newPrincipal.actor.install.principalID='new'; newPrincipal.join.resolve.install.principalID='new';
  newPrincipal.grant=grant(1, 'active');
  assert.equal(reduceAdmission(r.state, request(), newPrincipal).result.code, 'forbidden', 'old active same-key authority must first be invalidated by the lifecycle transaction');
});

test('normalized slice byte exhaustion rolls back member/counter/grant changes rather than truncating identity', () => {
  let s = settings(state(), {askBeforeJoin:false}).state, exhausted = false;
  for (let n = 1; n <= 24; n++) {
    const f = facts(n);
    for (const key of ['principalID','keyID','bundleID','audience']) {
      const value = `${key}-${n}-` + 'x'.repeat(120);
      f.actor.install[key]=value; f.join.resolve.install[key]=value;
    }
    f.join.pair.guestKeyID=f.actor.install.keyID; delete f.grant;
    const r = reduceAdmission(s, request(), f);
    if (r.result.status === 'unavailable') {
      assert.equal(r.state, s); assert.equal(r.effects.grant, null); assert.equal(r.effects.terminals.length, 0);
      assert.equal(r.state.lifetimeRequestCount, s.lifetimeRequestCount); exhausted = true; break;
    }
    assert.deepEqual(restoreAdmissionState(JSON.stringify(r.state)), r.state);
    s = r.state;
  }
  assert(exhausted, 'byte capacity is independent of count capacity');
});

test('trusted removal is guest-only, CAS-bound and rejoin uses a new lease; it is not a kick route', () => {
  const s = approve(ask(state(), 1).state, 1).state;
  const r = removeAdmissionMember(s, {nowMS:1002, memberID:id(201), expectedLeaseVersion:1, reason:'authorization_withdrawn'});
  assert.equal(r.state.members[1].status, 'removed'); assert.equal(r.state.members[1].leaseVersion, 2);
  assert.equal(removeAdmissionMember(r.state, {nowMS:1003, memberID:id(201), expectedLeaseVersion:1, reason:'authorization_withdrawn'}).result.code, 'conflict');
  assert.equal(removeAdmissionMember(s, {nowMS:1002, memberID:id(2), expectedLeaseVersion:1, reason:'authorization_withdrawn'}).result.code, 'forbidden');
  assert.throws(() => removeAdmissionMember(s, {nowMS:1002, memberID:id(201), expectedLeaseVersion:1, reason:'host_kick'}), TypeError);
  const f = facts(1, 1003); f.grant=grant(1, 'revoked');
  const pending = reduceAdmission(r.state, request(), f);
  assert.equal(pending.result.admission.status, 'pending', 'removal does not manufacture a current grant');
  const joined = approve(pending.state, 1, 1004);
  assert.equal(joined.result.member.leaseVersion, 3); assert.equal(joined.state.members.length, 2);
});

test('ended/expired rooms refuse new work; pending deadline never exceeds room expiry', () => {
  const s = state(), nearEnd = s.expiresAtMS - 100;
  const pending = ask(s, 1, nearEnd);
  assert.equal(pending.state.pending[0].expiresAtMS, s.expiresAtMS);
  assert.equal(ask(s, 1, s.expiresAtMS).result.code, 'expired');
  const ended = JSON.parse(JSON.stringify(s)); ended.status='ended';
  assert.equal(ask(restoreAdmissionState(JSON.stringify(ended)), 1).result.code, 'expired');
});

test('restoration rejects corrupt counters, duplicate identities, host substitution and over-budget state', () => {
  const base = JSON.parse(JSON.stringify(state()));
  for (const change of [s => {s.lifetimeRequestCount=301;}, s => {s.members.push({...s.members[0]});},
    s => {s.originalHost.install.keyID='substitute';}, s => {s.members[0].status='left';},
    s => {s.settings.askBeforeJoin='true';}, s => {s.audioAuthority=true;}, s => {s.pending=Array(11).fill({});}]) {
    const s = structuredClone(base); change(s);
    assert.throws(() => restoreAdmissionState(JSON.stringify(s)));
  }
  assert.throws(() => restoreAdmissionState(JSON.stringify(base) + ' '.repeat(16384)), isCode('invalid_request'));
});

test('returned snapshots/effects are deeply frozen and time/revision overflow fails closed', () => {
  const r = approve(ask(state(), 1).state, 1);
  assert(Object.isFrozen(r.effects.grant.approverPersona)); assert(Object.isFrozen(r.effects.terminals[0].install));
  assert.throws(() => {r.state.members[1].leaseVersion=99;}, TypeError);
  assert.throws(() => ask(r.state, 2, 999), TypeError);
  const raw = JSON.parse(JSON.stringify(state())); raw.stateVersion=Number.MAX_SAFE_INTEGER;
  const overflow = ask(restoreAdmissionState(JSON.stringify(raw)), 1);
  assert.equal(overflow.result.status, 'unavailable'); assert.equal(overflow.state.stateVersion, Number.MAX_SAFE_INTEGER);
});
