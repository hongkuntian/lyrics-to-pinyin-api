import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  createVisitEscrow, reduceVisitEscrow, encodeVisitEscrow, restoreVisitEscrow,
  VISIT_ESCROW_LIMITS,
} from '../../api/utils/listening-v2/visit-escrow.js';

// These are synthetic trusted-adapter assertions, NOT qualification receipts.
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hash = text => createHash('sha256').update(text).digest('hex');
const profileHash = 'a'.repeat(64), evidenceHash = 'b'.repeat(64);
const ledgerID = id(1), scopeID = id(2);
const proofs = {
  initialize: ['initialized_scope', 'writer_fence', 'no_remaining_possible_writers',
    'finite_exact_residual', 'room_event_byte_terminal_allowance'],
  reserve: ['single_splice', 'finite_exact_paths', 'repeat_shuffle_autoplay_off',
    'zero_start_when_empty', 'room_event_byte_terminal_allowance'],
  dispatch: ['current_authority', 'no_intersecting_unsettled_writer', 'pre_send_fence'],
  observe: ['fresh_exact_start', 'admitted_continuation', 'navigation_cause'],
  progress: ['fresh_same_visit'],
  release: ['no_remaining_possible_writers', 'qualified_terminal_or_neutralized', 'exact_installed_residual'],
  cancel: ['no_remaining_possible_writers', 'provably_never_dispatched'],
};
function proof(op, raw, extra = []) {
  return JSON.stringify({kind: op, ledgerID, scopeID, commandHash: hash(raw),
    profileHash, evidenceHash, assertions: [...proofs[op], ...extra]});
}
function admitted(result) { assert.equal(result.ok, true, result.code); return result.state; }
function open(path = []) {
  const raw = JSON.stringify({ledgerID, scopeID, residual: path});
  return admitted(createVisitEscrow(raw, proof('initialize', raw)));
}
function attempt(state, command, evidence = true) {
  const raw = JSON.stringify({expectedRevision: state.revision, ...command});
  const extra = command.op === 'reserve' && command.inverse !== null
    ? ['complete_inverse_and_terminal_allowance']
    : command.op === 'release' && command.openUndoAtMS !== null ? ['confirmed_reversible_application'] : [];
  return reduceVisitEscrow(state, raw, evidence && proofs[command.op] ? proof(command.op, raw, extra) : undefined);
}
const act = (state, command) => admitted(attempt(state, command));
function reserve(state, path, options = {}) {
  return act(state, {op: 'reserve', planID: id(1000 + state.revision), path,
    replacePendingID: state.pending?.id ?? null, closePromiseID: state.promise?.plan.id ?? null,
    inverse: null, ...options});
}
const dispatch = state => act(state, {op: 'dispatch', planID: state.pending.id});
function observe(state, occurrenceSlot, options = {}) {
  return act(state, {op: 'observe', observationSequence: state.observationSequence + 1,
    visitID: id(10000 + state.visits.length), occurrenceSlot,
    observedAtMS: state.visits.length, startPositionMS: 0, authorityEpoch: 1,
    transitionRevision: state.visits.length + 1, executionOrdinal: state.lastExecutionOrdinal,
    kind: 'forward', targetVisitID: null, ...options});
}
function release(state, residual, options = {}) {
  return act(state, {op: 'release', executionOrdinal: state.active?.ordinal ?? state.lastExecutionOrdinal,
    observationSequence: state.observationSequence, consumedVisits: state.visits.length,
    residual, openUndoAtMS: null, ...options});
}
const total = s => s.visits.length + s.remaining + (s.pending?.path.length ?? 0) + (s.promise?.plan.path.length ?? 0);
function filled(count, old = []) {
  let s = open([...Array(count).fill(0), ...old]);
  for (let i = 0; i < count; i++) s = observe(s, 0);
  return s;
}
function refused(state, command, code, evidence = true) {
  const before = encodeVisitEscrow(state);
  const result = attempt(state, command, evidence);
  assert.equal(result.ok, false); assert.equal(result.code, code);
  assert.equal(result.state, state);
  assert.deepEqual(encodeVisitEscrow(state), before);
}
function subsequences(xs) {
  return xs.reduce((all, x) => [...all, ...all.map(v => [...v, x])], [[]]);
}

test('old A-B-C-D/new A-C-B-D: old B, qualified D residual, then natural D', () => {
  let s = filled(506, [1, 2, 3]);
  const initialHistory = s.visits;
  s = dispatch(reserve(s, [2, 1, 3]));
  assert.equal(total(s), 512);
  s = observe(s, 1);
  refused(s, {op: 'release', executionOrdinal: s.active.ordinal,
    observationSequence: s.observationSequence, consumedVisits: s.visits.length,
    residual: [3], openUndoAtMS: null}, 'qualification_required', false);
  s = release(s, [3]);
  assert.equal(s.remaining, 1);
  s = observe(s, 3);
  assert.deepEqual(s.visits.slice(506).map(v => v[1]), [1, 3]);
  assert.deepEqual(s.visits.slice(0, 506), initialHistory);
  assert.equal(s.remaining, 0);
});

test('A-B-C-B hybrid creates separate actual B visits, without predecessor-token dedup', () => {
  let s = observe(open([0, 1, 2, 3]), 0);
  s = dispatch(reserve(s, [2, 1, 3]));
  for (const item of [1, 2, 1]) s = observe(s, item);
  assert.deepEqual(s.visits.map(v => v[1]), [0, 1, 2, 1]);
  assert.equal(new Set(s.visits.map(v => v[0])).size, 4);
  assert.deepEqual(s.visits.map(v => v[2]), [null, 0, 1, 2]);
  assert.equal(s.remaining, 3); // No credit retirement just because B looks new.
});

test('all old then all new is funded; second dispatch refuses even at zero remaining', () => {
  let s = dispatch(reserve(filled(506, [1, 2, 3]), [2, 1, 3]));
  for (const item of [1, 2, 3, 2, 1, 3]) s = observe(s, item);
  assert.equal(s.visits.length, 512); assert.equal(s.remaining, 0);
  s = reserve(s, []);
  refused(s, {op: 'dispatch', planID: s.pending.id}, 'output_quarantined');
  s = release(s, []);
  s = dispatch(s); // A separately qualified zero-start operation remains possible.
  assert.equal(s.remaining, 0);
});

test('every old prefix/new subsequence and every settlement split retains next natural advance', () => {
  const initial = filled(506, [1, 2, 3]);
  for (let i = 0; i <= 3; i++) {
    for (const tail of subsequences([2, 1, 3])) {
      for (let j = 0; j <= tail.length; j++) {
        let s = dispatch(reserve(initial, [2, 1, 3]));
        for (const item of [1, 2, 3].slice(0, i).concat(tail.slice(0, j))) s = observe(s, item);
        assert.equal(total(s), 512);
        s = release(s, tail.slice(j));
        for (const item of tail.slice(j)) s = observe(s, item);
        assert.equal(s.visits.length, 506 + i + tail.length);
        assert.equal(s.remaining, 0);
      }
    }
  }
});

test('coalescing replaces only untouched desired credits, atomically, at the 500 boundary', () => {
  let s = filled(500, Array(6).fill(1));
  s = reserve(s, Array(6).fill(2)); s = reserve(s, Array(5).fill(2));
  s = dispatch(s); const e = s.remaining;
  s = reserve(s, [3]);
  refused(s, {op: 'reserve', planID: id(9000), path: [3, 3], inverse: null,
    replacePendingID: s.pending.id, closePromiseID: null}, 'visit_capacity');
  assert.equal(s.remaining, e); assert.equal(s.pending.path.length, 1);
});

test('504 forward/inverse arithmetic and entire restored tail; accepted inverse survives expiry and End', () => {
  let s = filled(504, [1, 2]);
  const preimage = s.visits.at(-1)[0], inverseID = id(700);
  s = reserve(s, [3, 4], {inverse: {planID: inverseID, path: [0, 5, 6], preimageVisitID: preimage}});
  assert.equal(total(s), 511);
  s = dispatch(s); s = observe(s, 3); s = release(s, [4], {openUndoAtMS: 1000});
  const frozenPromise = s.promise;
  s = act(s, {op: 'progress', observationSequence: s.observationSequence + 1, visitID: s.visits.at(-1)[0]});
  assert.equal(s.promise, frozenPromise);
  s = act(s, {op: 'accept_undo', promiseID: inverseID, nowMS: 8999});
  assert.equal(s.promise, null); assert.equal(s.pending.mode, 'inverse');
  refused(s, {op: 'reserve', planID: id(9000), path: [], inverse: null,
    replacePendingID: s.pending.id, closePromiseID: null}, 'inverse_pending');
  s = dispatch(s); assert.equal(s.remaining, 4);
  refused(s, {op: 'close_undo', promiseID: inverseID, reason: 'expired', nowMS: 9000}, 'promise_conflict');
  s = act(s, {op: 'end'});
  assert.equal(s.remaining, 4); assert(s.active); assert.equal(s.promise, null);
  s = observe(s, 0, {kind: 'undo', targetVisitID: preimage});
  s = release(s, [5, 6]); s = observe(s, 5); s = observe(s, 6);
  assert.equal(s.visits.length, 508); assert.equal(s.remaining, 0); assert.equal(s.ended, true);
});

test('508 cannot reserve old two plus forward two plus inverse three; 511 natural advances to 512', () => {
  const s = filled(508, [1, 2]);
  refused(s, {op: 'reserve', planID: id(901), path: [3, 4], inverse: {
    planID: id(902), path: [0, 5, 6], preimageVisitID: s.visits.at(-1)[0]},
    replacePendingID: null, closePromiseID: null}, 'visit_capacity');
  let full = filled(511, [1]); full = observe(full, 1);
  assert.equal(full.visits.length, 512); assert.equal(full.remaining, 0);
  refused(full, {op: 'reserve', planID: id(903), path: [1], inverse: null,
    replacePendingID: null, closePromiseID: null}, 'visit_capacity');
  full = dispatch(reserve(full, [])); full = release(full, []);
  assert.equal(full.visits.length, 512);
});

test('restart consumes a new credit, preserves Back ancestry, and cannot borrow D or I', () => {
  let s = observe(open([0]), 0);
  s = reserve(s, [0], {inverse: {planID: id(910), path: [0], preimageVisitID: s.visits[0][0]}});
  const command = {op: 'observe', observationSequence: 2, visitID: id(11111), occurrenceSlot: 0,
    observedAtMS: 1, startPositionMS: 0, authorityEpoch: 1, transitionRevision: 2,
    executionOrdinal: 0, kind: 'restart', targetVisitID: null};
  refused(s, command, 'unfunded_observation');
  s = dispatch(s); s = observe(s, 0, {kind: 'restart'});
  assert.equal(s.visits.length, 2); assert.equal(s.visits[1][3], null);
  assert.equal(s.promise.plan.path.length, 1);
});

test('missed B earns no record; cancel/reuse cannot change observed C->A ancestry', () => {
  let s = open([0, 1, 2]); s = observe(s, 0); s = observe(s, 2);
  const original = s.visits;
  assert.deepEqual(s.visits[1].slice(1, 4), [2, 0, 0]);
  assert.equal(s.remaining, 1); // Missed observation did NOT create history or retire credit.
  for (const path of [[1], [3, 1], [1]]) s = reserve(s, path);
  s = act(s, {op: 'cancel', planID: s.pending.id});
  assert.deepEqual(s.visits, original);
  s = release(s, []); // A qualified residual, not mere absence of B.
  s = dispatch(reserve(s, [0])); s = observe(s, 0, {kind: 'back', targetVisitID: original[0][0]});
  assert.deepEqual(s.visits[2].slice(1, 4), [0, 1, null]);
  assert.equal(s.visits[1][3], 0);
});

test('UndoNext and UndoBack restore frozen preimage navigation, never chronological history', () => {
  for (const op of ['next', 'back']) {
    let s = open([0, 1, 2]); for (const x of [0, 1, 2]) s = observe(s, x);
    const preimage = s.visits[2], target = op === 'next' ? 3 : 1;
    s = reserve(s, [target], {inverse: {planID: id(930), path: [2], preimageVisitID: preimage[0]}});
    s = dispatch(s);
    s = observe(s, target, op === 'back' ? {kind: 'back', targetVisitID: s.visits[1][0]} : {});
    s = release(s, [], {openUndoAtMS: 100});
    s = act(s, {op: 'accept_undo', promiseID: id(930), nowMS: 8099}); s = dispatch(s);
    s = observe(s, 2, {kind: 'undo', targetVisitID: preimage[0]});
    assert.deepEqual(s.visits.at(-1).slice(1, 4), [2, 3, 1]);
    assert.deepEqual(s.visits[2], preimage);
  }
  // Exact design Z->A->B, UndoNext A' has previous B, Back Z.
  let s = observe(observe(open([0, 1]), 0), 1);
  const a = s.visits[1][0];
  s = dispatch(reserve(s, [2], {inverse: {planID: id(931), path: [1], preimageVisitID: a}}));
  s = observe(s, 2); s = release(s, [], {openUndoAtMS: 0});
  s = dispatch(act(s, {op: 'accept_undo', promiseID: id(931), nowMS: 7999}));
  s = observe(s, 1, {kind: 'undo', targetVisitID: a});
  assert.deepEqual(s.visits[3].slice(1, 4), [1, 2, 0]);
  s = release(s, []); s = dispatch(reserve(s, [1])); s = observe(s, 1, {kind: 'restart'});
  assert.equal(s.visits[4][3], 0);
});

test('Undo deadline equality refuses; natural observation closes only an unaccepted promise', () => {
  let s = observe(open([0]), 0);
  s = dispatch(reserve(s, [1, 2], {inverse: {planID: id(950), path: [0], preimageVisitID: s.visits[0][0]}}));
  s = observe(s, 1); s = release(s, [2], {openUndoAtMS: 100});
  refused(s, {op: 'accept_undo', promiseID: id(950), nowMS: 8100}, 'undo_expired');
  const expired = act(s, {op: 'close_undo', promiseID: id(950), reason: 'expired', nowMS: 8100});
  assert.equal(expired.remaining, 1); assert.equal(expired.promise, null);
  s = observe(s, 2); assert.equal(s.promise, null); assert.equal(s.visits.length, 3);
});

test('Release CAS binds exact ordinal, sequence and total consumed; residual cannot create credits', () => {
  let s = dispatch(reserve(open([1]), [2])); s = observe(s, 1);
  const command = {op: 'release', executionOrdinal: s.active.ordinal,
    observationSequence: s.observationSequence, consumedVisits: s.visits.length, residual: [], openUndoAtMS: null};
  for (const changes of [{executionOrdinal: 0}, {observationSequence: 0}, {consumedVisits: 0}]) {
    refused(s, {...command, ...changes}, 'settlement_conflict');
  }
  refused(s, {...command, residual: [2, 2]}, 'residual_exceeds_escrow');
  const raw = JSON.stringify({expectedRevision: s.revision, ...command});
  const evidence = JSON.parse(proof('release', raw));
  for (const changes of [{commandHash: 'c'.repeat(64)}, {scopeID: id(77)}, {ledgerID: id(78)},
    {profileHash: 'd'.repeat(64)}, {assertions: ['fresh_snapshot']}, {assertions: []}]) {
    const result = reduceVisitEscrow(s, raw, JSON.stringify({...evidence, ...changes}));
    assert.equal(result.ok, false); assert.equal(result.state, s);
  }
});

test('End keeps the non-PII quarantine even with zero credits; no new dispatch or reserve', () => {
  let s = dispatch(reserve(open(), [])); s = act(s, {op: 'end'});
  assert(s.active); assert.equal(s.remaining, 0);
  refused(s, {op: 'reserve', planID: id(960), path: [], inverse: null,
    replacePendingID: null, closePromiseID: null}, 'ended');
  s = release(s, []); assert.equal(s.active, null); assert.equal(s.ended, true);
});

test('progress and identical sequence retries consume no visits; altered or stale observations refuse', () => {
  let s = observe(open([0, 1]), 0);
  const command = {op: 'progress', observationSequence: 2, visitID: s.visits[0][0]};
  s = act(s, command); const current = s;
  assert.equal(act(s, command), current);
  assert.equal(s.remaining, 1); assert.equal(s.visits.length, 1);
  refused(s, {...command, visitID: id(999)}, 'observation_conflict');
  refused(s, {...command, observationSequence: 1}, 'observation_conflict');
});

test('bounded persistence round-trips all 512 immutable records without lifting external 16 KiB cap', () => {
  const s = filled(512), encoded = encodeVisitEscrow(s);
  assert.equal(encoded.ok, true);
  assert(Buffer.byteLength(JSON.stringify(s)) > 16384);
  assert(encoded.pages.length > 1);
  for (const raw of [encoded.header, ...encoded.pages]) assert(Buffer.byteLength(raw) <= 16384);
  const restored = admitted(restoreVisitEscrow(encoded.header, ...encoded.pages));
  assert.deepEqual(restored, s); assert(Object.isFrozen(restored.visits[511][10]));
  assert.equal(restoreVisitEscrow(encoded.header, ...encoded.pages.slice(1)).ok, false);
  assert.equal(restoreVisitEscrow(encoded.header, ...encoded.pages, encoded.pages[0]).ok, false);
  const page = JSON.parse(encoded.pages[0]); page.visits[1][0] = page.visits[0][0];
  assert.equal(restoreVisitEscrow(encoded.header, JSON.stringify(page), ...encoded.pages.slice(1)).ok, false);
  page.visits[1][0] = id(99999); page.visits[1][2] = 99;
  assert.equal(restoreVisitEscrow(encoded.header, JSON.stringify(page), ...encoded.pages.slice(1)).ok, false);
});

test('maximal compact bytes and room-slice arithmetic use exact safe integers', () => {
  assert.equal(VISIT_ESCROW_LIMITS.roomBytes, 262144);
  assert.equal(100 * 1024 + 512 * 192 + 16384 + 32768 + 4096 + 8192, 262144);
  const maximal = [id(42), 99, 511, 511, Number.MAX_SAFE_INTEGER, 2147483647,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1000, 9, Array(6).fill(10000)];
  assert(Buffer.byteLength(JSON.stringify(maximal)) + 1 <= 192);
  const state = open(), raw = JSON.stringify({expectedRevision: 0, op: 'end'});
  const exact = raw + ' '.repeat(16384 - Buffer.byteLength(raw));
  assert.equal(reduceVisitEscrow(state, exact).ok, true);
  assert.equal(reduceVisitEscrow(state, exact + ' ').ok, false);
  for (const token of ['9007199254740993', '1.0000000000000001', '1e-999', '0.0', '-1']) {
    assert.equal(reduceVisitEscrow(state, raw.replace('"expectedRevision":0', `"expectedRevision":${token}`)).ok, false);
  }
});

test('all raw boundaries reject preparsed hostile objects without reflection, getters or serialization', () => {
  let touches = 0;
  const hook = () => { touches++; throw Error('caller hook'); };
  const hostile = new Proxy({}, {ownKeys: hook, get: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook});
  const s = open(), raw = JSON.stringify({expectedRevision: 0, op: 'end'});
  for (const bad of [hostile, {get toJSON() { return hook(); }}, new String(raw), null, []]) {
    assert.equal(createVisitEscrow(bad, bad).ok, false);
    assert.equal(reduceVisitEscrow(s, bad, bad).ok, false);
    assert.equal(reduceVisitEscrow(bad, raw).ok, false);
    assert.equal(restoreVisitEscrow(bad, bad).ok, false);
  }
  assert.equal(touches, 0);
});

test('unknown/duplicate keys, UUID aliases, unsafe slots and malformed trusted evidence refuse unchanged', () => {
  const s = open(), valid = JSON.stringify({expectedRevision: 0, op: 'end'});
  for (const raw of ['{"expectedRevision":0,"op":"end","op":"end"}',
    '{"expectedRevision":0,"op":"end","o\\u0070":"end"}',
    valid.replace('}', ',"extra":0}'), valid.replace('}', ',"__proto__":{}}')]) {
    const result = reduceVisitEscrow(s, raw); assert.equal(result.ok, false); assert.equal(result.state, s);
  }
  for (const path of [[100], [-1], [0.1], ['1'], Array(513).fill(0)]) {
    const result = attempt(s, {op: 'reserve', planID: id(970), path, inverse: null,
      replacePendingID: null, closePromiseID: null});
    assert.equal(result.ok, false); assert.equal(result.state, s);
  }
  const init = JSON.stringify({ledgerID: 'abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase(), scopeID, residual: []});
  assert.equal(createVisitEscrow(init, proof('initialize', init)).ok, false);
});

test('source-visible coalescing/claim race has one winner; cancellation cannot retire a sent step', () => {
  const s = reserve(open([0]), [1]);
  const oldCommand = JSON.stringify({op: 'dispatch', expectedRevision: s.revision, planID: s.pending.id});
  const replacement = reserve(s, [2]);
  const lateClaim = reduceVisitEscrow(replacement, oldCommand, proof('dispatch', oldCommand));
  assert.equal(lateClaim.code, 'revision_conflict'); assert.equal(lateClaim.state, replacement);
  const sent = dispatch(s);
  refused(sent, {op: 'cancel', planID: s.pending.id}, 'pending_conflict');
  const ended = act(replacement, {op: 'end'});
  assert.equal(ended.pending, replacement.pending);
  refused(ended, {op: 'cancel', planID: ended.pending.id}, 'qualification_required', false);
  const cancelled = act(ended, {op: 'cancel', planID: ended.pending.id});
  assert.equal(cancelled.pending, null); assert.equal(cancelled.remaining, 1);
});

test('qualification is mandatory at initialization and before merging pending credits', () => {
  const raw = JSON.stringify({ledgerID, scopeID, residual: [0]});
  assert.equal(createVisitEscrow(raw).code, 'qualification_required');
  const s = reserve(open(), [0]);
  refused(s, {op: 'dispatch', planID: s.pending.id}, 'qualification_required', false);
  assert.equal(s.remaining, 0); assert.equal(s.pending.path.length, 1);
});

test('full compact histories reject lost pages and fake counts; observed slots never recycle', () => {
  const s = filled(100), encoded = encodeVisitEscrow(s), h = JSON.parse(encoded.header);
  h.visitCount = 99;
  assert.equal(restoreVisitEscrow(JSON.stringify(h), ...encoded.pages).ok, false);
  const page = JSON.parse(encoded.pages[0]); page.visits[2][3] = null;
  assert.equal(restoreVisitEscrow(encoded.header, JSON.stringify(page), ...encoded.pages.slice(1)).ok, false);
  h.visitCount = 100; h.remaining = 413;
  assert.equal(restoreVisitEscrow(JSON.stringify(h), ...encoded.pages).ok, false);
});

test('revision/deadline arithmetic refuses overflow and bounded checkpoint preserves uncertainty', () => {
  let s = observe(open([0]), 0);
  s = dispatch(reserve(s, [1], {inverse: {planID: id(980), path: [0], preimageVisitID: s.visits[0][0]}}));
  s = observe(s, 1);
  refused(s, {op: 'release', executionOrdinal: 1, observationSequence: s.observationSequence,
    consumedVisits: 2, residual: [], openUndoAtMS: Number.MAX_SAFE_INTEGER}, 'invalid_input');
  let encoded = encodeVisitEscrow(s);
  assert.deepEqual(admitted(restoreVisitEscrow(encoded.header, ...encoded.pages)), s);
  const h = JSON.parse(encoded.header); h.revision = Number.MAX_SAFE_INTEGER;
  const exhausted = admitted(restoreVisitEscrow(JSON.stringify(h), ...encoded.pages));
  refused(exhausted, {op: 'end'}, 'revision_exhausted');
  s = act(s, {op: 'end'}); encoded = encodeVisitEscrow(s);
  const restored = admitted(restoreVisitEscrow(encoded.header, ...encoded.pages));
  assert(restored.active); assert.equal(restored.ended, true);
  assert.equal(restored.remaining, s.remaining);
});

test('qualified same-visit Pause/Undo at 512 retains zero-credit execution roles', () => {
  let s = filled(512), current = s.visits.at(-1)[0];
  s = dispatch(reserve(s, [], {inverse: {planID: id(990), path: [], preimageVisitID: current}}));
  assert(s.promise); assert.equal(total(s), 512);
  s = act(s, {op: 'progress', observationSequence: s.observationSequence + 1, visitID: current});
  s = release(s, [], {openUndoAtMS: 0});
  s = dispatch(act(s, {op: 'accept_undo', promiseID: id(990), nowMS: 1}));
  s = act(s, {op: 'end'});
  assert(s.active); assert.equal(s.active.plan.mode, 'inverse'); assert.equal(s.remaining, 0);
  s = release(s, []); assert.equal(s.visits.length, 512); assert.equal(s.active, null);
});

test('natural advance after acceptance cannot silently retarget a frozen control preimage', () => {
  let s = observe(open([0, 1]), 0);
  s = reserve(s, [2], {inverse: {planID: id(991), path: [0, 1], preimageVisitID: s.visits[0][0]}});
  s = observe(s, 1);
  refused(s, {op: 'dispatch', planID: s.pending.id}, 'preimage_conflict');
  assert.equal(s.visits.length, 2); assert.equal(s.promise.plan.path.length, 2);
  s = act(s, {op: 'cancel', planID: s.pending.id});
  assert.equal(s.pending, null); assert.equal(s.promise, null);
});

// R2 regressions: synthetic trusted-adapter/codec fixtures only. The original
// 24 tests above are unchanged. Root executes these same bytes against R1/R2.
function backCommand(s, target, changes = {}) {
  return {op: 'observe', observationSequence: s.observationSequence + 1,
    visitID: id(10000 + s.visits.length), occurrenceSlot: target[1],
    observedAtMS: s.visits.length, startPositionMS: 0, authorityEpoch: 1,
    transitionRevision: s.visits.length + 1, executionOrdinal: s.lastExecutionOrdinal,
    kind: 'back', targetVisitID: target[0], ...changes};
}
function backFixture(path = [1]) {
  let s = open([0, 1, 2, 3]);
  for (const x of [0, 1, 2]) s = observe(s, x);
  return dispatch(reserve(s, path, {inverse: {
    planID: id(99001), path: [2, 3], preimageVisitID: s.visits[2][0],
  }}));
}
function roundTrip(s) {
  const encoded = encodeVisitEscrow(s);
  assert.equal(encoded.ok, true);
  const restored = admitted(restoreVisitEscrow(encoded.header, ...encoded.pages));
  assert.deepEqual(restored, s);
  return restored;
}

for (const advance of [false, true]) {
  test(`R2 F1: frozen Back target survives ${advance ? 'intervening old C' : 'no intervening advance'} and restoration`, () => {
    let s = backFixture();
    const oldHistory = s.visits, oldA = s.visits[1], oldB = s.visits[2];
    if (advance) s = observe(s, 3);
    const chronology = s.visits, remaining = s.remaining, promise = s.promise;
    s = act(s, backCommand(s, oldA));
    assert.deepEqual(s.visits.slice(0, chronology.length), chronology);
    assert.deepEqual(s.visits.slice(0, 3), oldHistory);
    assert.deepEqual(s.visits.at(-1).slice(1, 4), [1, advance ? 3 : 2, 0]);
    assert.equal(s.visits.at(-1)[9], 2); // Proven Back, never relabeled forward.
    assert.notEqual(s.visits.at(-1)[0], oldA[0]);
    assert.equal(s.active.plan.preimageSlot, 2); assert.deepEqual(s.visits[2], oldB);
    assert.equal(s.remaining, remaining - 1); assert.equal(s.promise, promise);
    assert.equal(total(s), 7);
    s = roundTrip(s);
    s = release(s, [], {openUndoAtMS: 0});
    s = roundTrip(s); // The historical Back remains restorable after active is gone.
    assert.equal(s.active, null); assert.equal(s.promise.postimageSlot, s.visits.length - 1);
  });
}

test('R2 F1: trusted persisted delayed Back ancestry restores independently of the observation reducer', () => {
  let s = observe(backFixture(), 3);
  const command = backCommand(s, s.visits[1]);
  // Construct the required persisted postimage without using Back acceptance,
  // so R1 restoration has its own discriminating failure. This is trusted codec
  // fixture construction, not a claim that a forward start proves Back causality.
  s = observe(s, 1);
  const encoded = encodeVisitEscrow(s), page = JSON.parse(encoded.pages[0]);
  page.visits[4][3] = 0; page.visits[4][9] = 2;
  const h = JSON.parse(encoded.header);
  h.observationDigest = hash(JSON.stringify(['observe', command.observationSequence,
    command.visitID, command.occurrenceSlot, command.observedAtMS, command.startPositionMS,
    command.authorityEpoch, command.transitionRevision, command.executionOrdinal,
    command.kind, command.targetVisitID]));
  const restored = admitted(restoreVisitEscrow(JSON.stringify(h), JSON.stringify(page)));
  assert.deepEqual(restored.visits.map(v => v[1]), [0, 1, 2, 3, 1]);
  assert.deepEqual(restored.visits[4].slice(1, 4), [1, 3, 0]);
  roundTrip(release(restored, []));
  // An observed target with this occurrence/ancestry never existed.
  page.visits[4][3] = 2;
  assert.equal(restoreVisitEscrow(JSON.stringify(h), JSON.stringify(page)).ok, false);
});

test('R2 F1: Back rejects the newest predecessor when it differs from the frozen control target', () => {
  const s = observe(backFixture(), 3);
  refused(s, backCommand(s, s.visits[2]), 'navigation_conflict');
  refused(s, backCommand(s, s.visits[0], {occurrenceSlot: 1}), 'navigation_conflict');
  refused(s, backCommand(s, s.visits[1], {executionOrdinal: 0}), 'navigation_conflict');
});

test('R2 F1: false Back without a matching dispatched target or causal evidence refuses unchanged', () => {
  const wrongTarget = backFixture([3]);
  refused(wrongTarget, backCommand(wrongTarget, wrongTarget.visits[1]), 'navigation_conflict');
  let idle = open([0, 1, 2, 3]);
  for (const x of [0, 1, 2]) idle = observe(idle, x);
  refused(idle, backCommand(idle, idle.visits[1]), 'navigation_conflict');
  const s = backFixture(), command = backCommand(s, s.visits[1]);
  refused(s, command, 'qualification_required', false);
  const raw = JSON.stringify({expectedRevision: s.revision, ...command});
  const p = JSON.parse(proof('observe', raw)), before = encodeVisitEscrow(s);
  for (const changes of [{assertions: ['fresh_exact_start', 'admitted_continuation']},
    {profileHash: 'c'.repeat(64)}, {commandHash: 'd'.repeat(64)}]) {
    const result = reduceVisitEscrow(s, raw, JSON.stringify({...p, ...changes}));
    assert.equal(result.ok, false); assert.equal(result.code, 'qualification_required');
    assert.equal(result.state, s); assert.deepEqual(encodeVisitEscrow(s), before);
  }
  let inverse = act(s, command);
  inverse = release(inverse, [], {openUndoAtMS: 0});
  inverse = dispatch(act(inverse, {op: 'accept_undo', promiseID: id(99001), nowMS: 1}));
  refused(inverse, backCommand(inverse, inverse.visits[0]), 'navigation_conflict');
});

test('R2 F1: same occurrence in different observed visits cannot substitute the frozen Back target', () => {
  let s = open([0, 1, 2, 1, 3]);
  for (const x of [0, 1, 2, 1, 3]) s = observe(s, x);
  s = dispatch(reserve(s, [1], {inverse: {
    planID: id(99002), path: [3], preimageVisitID: s.visits[4][0],
  }}));
  refused(s, backCommand(s, s.visits[1]), 'navigation_conflict');
  s = act(s, backCommand(s, s.visits[3]));
  assert.deepEqual(s.visits.at(-1).slice(1, 4), [1, 4, 2]);
  roundTrip(s);
});

test('R2 F1: path-only dispatch freezes observed departure before a delayed Back', () => {
  let s = open([0, 1, 2, 3]);
  for (const x of [0, 1, 2]) s = observe(s, x);
  const target = s.visits[1];
  s = dispatch(reserve(s, [1])); // Preserve the original path-only Back API.
  s = roundTrip(s); s = observe(s, 3);
  s = act(s, backCommand(s, target));
  assert.deepEqual(s.visits.at(-1).slice(1, 4), [1, 3, 0]);
  roundTrip(release(s, []));
});

function ordinalFixture(lastExecutionOrdinal) {
  // Trusted restoration fixture for qualified settled queue edits that created
  // no new visits. Those executions consume ordinals, but no history rows.
  // This avoids executing 998/999 setup operations; it is not a replay receipt.
  const s = release(observe(open([0, 1, 2]), 0), [1, 2]);
  const encoded = encodeVisitEscrow(s), h = JSON.parse(encoded.header);
  h.lastExecutionOrdinal = lastExecutionOrdinal; h.revision += 3 * lastExecutionOrdinal;
  return admitted(restoreVisitEscrow(JSON.stringify(h), ...encoded.pages));
}
function reserveCommand(s, reversible, changes = {}) {
  return {op: 'reserve', planID: id(200000 + s.revision), path: [],
    replacePendingID: s.pending?.id ?? null, closePromiseID: s.promise?.plan.id ?? null,
    inverse: reversible ? {planID: id(300000 + s.revision), path: [],
      preimageVisitID: s.visits.at(-1)[0]} : null, ...changes};
}
const progress = s => act(s, {op: 'progress', observationSequence: s.observationSequence + 1,
  visitID: s.visits.at(-1)[0]});

test('R2 F2: ordinal 998 admits zero-start Pause and accepted Undo through ordinal 1000', () => {
  let s = ordinalFixture(998); const history = s.visits;
  s = act(s, reserveCommand(s, true)); const inverseID = s.promise.plan.id;
  assert.equal(total(s), 3); s = dispatch(s);
  assert.equal(s.lastExecutionOrdinal, 999);
  s = release(progress(s), [1, 2], {openUndoAtMS: 0}); s = roundTrip(s);
  s = act(s, {op: 'accept_undo', promiseID: inverseID, nowMS: 7999});
  refused(s, {op: 'close_undo', promiseID: inverseID, reason: 'expired', nowMS: 8000}, 'promise_conflict');
  s = roundTrip(s); s = dispatch(s);
  assert.equal(s.lastExecutionOrdinal, 1000); assert.equal(s.active.plan.mode, 'inverse');
  s = release(progress(s), [1, 2]);
  assert.deepEqual(s.visits, history); assert.equal(s.remaining, 2);
  roundTrip(s);
});

test('R2 F2: ordinal 999 refuses a pair unchanged but admits a single zero-start step', () => {
  let s = ordinalFixture(999);
  refused(s, reserveCommand(s, true), 'execution_capacity');
  s = act(s, reserveCommand(s, false)); s = dispatch(s);
  assert.equal(s.lastExecutionOrdinal, 1000);
  s = release(progress(s), [1, 2]);
  assert.equal(s.visits.length, 1); assert.equal(s.remaining, 2);
});

test('R2 F2: ordinal 1000 refuses every new step even with zero visit credits required', () => {
  const s = ordinalFixture(1000);
  for (const path of [[], [1]]) refused(s, reserveCommand(s, false, {path}), 'execution_capacity');
  refused(s, reserveCommand(s, true), 'execution_capacity');
});

test('R2 F2: replacement and qualified cancellation transfer only unused ordinal roles', () => {
  let s = ordinalFixture(998);
  s = act(s, reserveCommand(s, true)); const first = s.pending.id;
  s = act(s, reserveCommand(s, true)); assert.notEqual(s.pending.id, first);
  assert.equal(s.lastExecutionOrdinal, 998); assert(s.promise);
  s = act(s, reserveCommand(s, false)); assert.equal(s.promise, null);
  s = act(s, reserveCommand(s, true));
  refused(s, {op: 'cancel', planID: s.pending.id}, 'qualification_required', false);
  s = act(s, {op: 'cancel', planID: s.pending.id});
  assert.equal(s.pending, null); assert.equal(s.promise, null); assert.equal(s.lastExecutionOrdinal, 998);
  s = act(s, reserveCommand(s, true)); s = dispatch(s); // 999 assigned; inverse still reserved.
  const active = s.active;
  s = act(s, reserveCommand(s, false)); // Explicitly close promise, reuse its unused slot.
  assert.equal(s.promise, null); assert.equal(s.active, active);
  refused(s, {op: 'dispatch', planID: s.pending.id}, 'output_quarantined');
  s = act(s, {op: 'cancel', planID: s.pending.id});
  assert.equal(s.lastExecutionOrdinal, 999); assert.equal(s.active, active);
  s = act(s, reserveCommand(s, false));
  s = release(s, [1, 2]);
  refused(s, reserveCommand(s, true), 'execution_capacity'); // Failed replacement retains single slot.
  s = act(s, reserveCommand(s, false)); // Replacing that single slot must still fit.
  s = dispatch(s); assert.equal(s.lastExecutionOrdinal, 1000);
  s = release(s, [1, 2]);
  refused(s, reserveCommand(s, false), 'execution_capacity'); // Spent ordinals never return.
});

test('R2 F2: closing only an unaccepted Undo frees its ordinal, acceptance and End retain work', () => {
  let s = ordinalFixture(998); s = dispatch(act(s, reserveCommand(s, true)));
  s = release(progress(s), [1, 2], {openUndoAtMS: 0}); const inverseID = s.promise.plan.id;
  let closed = act(s, {op: 'close_undo', promiseID: inverseID, reason: 'expired', nowMS: 8000});
  assert.equal(closed.lastExecutionOrdinal, 999);
  closed = dispatch(act(closed, reserveCommand(closed, false)));
  assert.equal(closed.lastExecutionOrdinal, 1000);
  let accepted = act(s, {op: 'accept_undo', promiseID: inverseID, nowMS: 7999});
  refused(accepted, {op: 'close_undo', promiseID: inverseID, reason: 'expired', nowMS: 8000}, 'promise_conflict');
  refused(accepted, reserveCommand(accepted, false), 'inverse_pending');
  accepted = act(accepted, {op: 'end'}); accepted = roundTrip(accepted);
  assert.equal(accepted.pending.mode, 'inverse'); assert.equal(accepted.lastExecutionOrdinal, 999);
  refused(accepted, {op: 'dispatch', planID: inverseID}, 'ended');
  refused(accepted, {op: 'cancel', planID: inverseID}, 'qualification_required', false);
  accepted = act(accepted, {op: 'cancel', planID: inverseID});
  assert.equal(accepted.pending, null); assert.equal(accepted.lastExecutionOrdinal, 999);
  assert.equal(accepted.remaining, 2);
});

test('R2 F2: trusted restore refuses overcommitted ordinal reservations without dropping roles', () => {
  let s = ordinalFixture(998); s = act(s, reserveCommand(s, true));
  const encoded = encodeVisitEscrow(s), h = JSON.parse(encoded.header);
  h.lastExecutionOrdinal = 999;
  const result = restoreVisitEscrow(JSON.stringify(h), ...encoded.pages);
  assert.equal(result.ok, false); assert.equal(result.code, 'execution_capacity'); assert.equal(result.state, null);
  roundTrip(s); // Unaltered two-role reservation is valid at 998.
});
