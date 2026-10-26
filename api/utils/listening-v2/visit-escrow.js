import {createHash} from 'node:crypto';
import {parseBoundedSessionJSON} from './protocol.js';

// Pure accounting only. Evidence below is a TRUSTED ADAPTER assertion, not a
// provider proof or authentication mechanism. Never forward request evidence.
export const VISIT_ESCROW_LIMITS = Object.freeze({
  visits: 512, occurrences: 100, visitBytes: 192, executorBytes: 32768,
  roomBytes: 262144, executionOrdinals: 1000, commandBytes: 16384,
});
const CAP = 512;
// Worst-case record bytes, with 64 bytes reserved for the page wrapper.
// 85 rows also fit the accepted parser's 4096-node bound (18 nodes/row).
const PAGE_ROWS = Math.floor((16384 - 64) / 192);
const MAX_PAGES = Math.ceil(CAP / PAGE_ROWS);
const branded = new WeakSet();
const uuidRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestRE = /^[0-9a-f]{64}$/;
const kinds = ['forward', 'restart', 'back', 'undo'];
const stateKeys = ['version', 'ledgerID', 'scopeID', 'revision', 'ended', 'observationSequence',
  'observationDigest', 'remaining', 'residual', 'residualProfileHash', 'releaseEvidenceHash',
  'pending', 'promise', 'active', 'lastExecutionOrdinal', 'visits'];
const proofAssertions = {
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
class Refusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code = 'invalid_input') => { throw new Refusal(code); };
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const uuid = v => typeof v === 'string' && v.length === 36 && uuidRE.test(v);
const digest = v => typeof v === 'string' && digestRE.test(v);
const sha = s => createHash('sha256').update(s).digest('hex');
function keys(v, expected) {
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).length !== expected.length || expected.some(k => !Object.hasOwn(v, k))) fail();
}
function raw(s) {
  // Crucially, reject objects before even asking the shared parser to reflect.
  if (typeof s !== 'string') fail();
  try { return parseBoundedSessionJSON(s); } catch { fail(); }
}
function path(v) {
  if (!Array.isArray(v) || v.length > CAP || v.some(n => !integer(n, 99))) fail();
  return v;
}
function freeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const child of Object.values(v)) freeze(child);
    Object.freeze(v);
  }
  return v;
}
function known(s) { if (!branded.has(s)) fail('invalid_state'); }
function attempt(s, body) {
  try { return body(); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return Object.freeze({ok: false, code: error.code, state: s});
  }
}
function evidence(s, commandJSON, evidenceJSON, kind, extra = [], profileHash = null) {
  if (typeof evidenceJSON !== 'string') fail('qualification_required');
  const p = raw(evidenceJSON);
  keys(p, ['kind', 'ledgerID', 'scopeID', 'commandHash', 'profileHash', 'evidenceHash', 'assertions']);
  const required = [...proofAssertions[kind], ...extra];
  if (p.kind !== kind || p.ledgerID !== s.ledgerID || p.scopeID !== s.scopeID ||
      p.commandHash !== sha(commandJSON) || !digest(p.profileHash) || !digest(p.evidenceHash) ||
      (profileHash !== null && p.profileHash !== profileHash) || !Array.isArray(p.assertions) ||
      p.assertions.length !== required.length || required.some(a => !p.assertions.includes(a))) {
    fail('qualification_required');
  }
  return p;
}
function findVisit(s, id) {
  if (!uuid(id)) fail();
  const index = s.visits.findIndex(v => v[0] === id);
  if (index < 0) fail('unknown_visit');
  return index;
}
function planShape(p, visits) {
  keys(p, ['id', 'path', 'mode', 'preimageSlot', 'profileHash', 'evidenceHash']);
  if (!uuid(p.id) || !['desired', 'control', 'inverse'].includes(p.mode) ||
      !digest(p.profileHash) || !digest(p.evidenceHash)) fail();
  path(p.path);
  if (p.preimageSlot === null ? p.mode !== 'desired' :
    !integer(p.preimageSlot, visits.length - 1)) fail();
  if (p.mode === 'inverse' && p.path.length && p.path[0] !== visits[p.preimageSlot][1]) fail();
}
function header(s) {
  // Only branded/generated or already bounded-and-validated state reaches here.
  const {visits, ...h} = s;
  return {...h, visitCount: visits.length};
}
function accounting(s) {
  const committed = s.visits.length, pending = s.pending?.path.length ?? 0;
  const inverse = s.promise?.plan.path.length ?? 0;
  const funded = committed + s.remaining + pending + inverse;
  if (!integer(funded, CAP)) fail('visit_capacity');
  // Empty paths still need dispatch ordinals. Active already owns its ordinal;
  // pending and unaccepted inverse each reserve one not-yet-assigned ordinal.
  if (!integer(s.lastExecutionOrdinal + (s.pending === null ? 0 : 1) +
      (s.promise === null ? 0 : 1), 1000)) fail('execution_capacity');
  const executorBytes = Buffer.byteLength(JSON.stringify(header(s))) + 1;
  if (executorBytes > 32768) fail('executor_capacity');
  // This schema's header is small enough for a single existing parser chunk.
  // Refuse rather than raising that global wire limit if the schema grows.
  if (executorBytes > 16384) fail('checkpoint_header_capacity');
  return freeze({committed, activeCredits: s.remaining, pendingCredits: pending,
    inverseCredits: inverse, fundedVisits: funded, maximumVisitBytes: funded * 192,
    committedVisitEvents: committed, reservedVisitEvents: funded - committed, executorBytes});
}
function publish(s) {
  const budget = accounting(s);
  freeze(s); branded.add(s);
  return Object.freeze({ok: true, state: s, accounting: budget});
}
function bump(s, patch) {
  if (s.revision === Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
  return publish({...s, ...patch, revision: s.revision + 1});
}
function shape(s) {
  // Used only on parser-produced checkpoint chunks, never caller objects.
  keys(s, stateKeys);
  if (s.version !== 1 || !uuid(s.ledgerID) || !uuid(s.scopeID) || !integer(s.revision) ||
      typeof s.ended !== 'boolean' || !integer(s.observationSequence) ||
      !integer(s.remaining, CAP) || !integer(s.lastExecutionOrdinal, 1000) ||
      !digest(s.residualProfileHash) || !digest(s.releaseEvidenceHash) ||
      (s.observationSequence === 0 ? s.observationDigest !== null : !digest(s.observationDigest))) fail();
  path(s.residual);
  if (!Array.isArray(s.visits) || s.visits.length > CAP) fail();
  const ids = new Set();
  for (let i = 0; i < s.visits.length; i++) {
    const v = s.visits[i];
    if (!Array.isArray(v) || v.length !== 11 || !uuid(v[0]) || ids.has(v[0]) ||
        !integer(v[1], 99) || v[2] !== (i === 0 ? null : i - 1) ||
        (v[3] !== null && !integer(v[3], i - 1)) || !integer(v[4]) || !integer(v[5], 2147483647) ||
        !integer(v[6]) || !integer(v[7]) || !integer(v[8], s.lastExecutionOrdinal) ||
        !integer(v[9], kinds.length - 1) || !Array.isArray(v[10]) || v[10].length !== 6 ||
        v[10].some(n => !integer(n, 10000)) || Buffer.byteLength(JSON.stringify(v)) + 1 > 192) fail();
    ids.add(v[0]);
    if (v[9] === 0 && v[3] !== v[2]) fail();
    if (v[9] === 1 && (i === 0 || v[1] !== s.visits[i - 1][1] || v[3] !== s.visits[i - 1][3])) fail();
    if (v[9] === 2) {
      // A delayed Back may depart from an older dispatched preimage, not the
      // chronological predecessor. Persisted pages are trusted: check possible
      // observed ancestry here, not provider causality or an absent effect log.
      const hasTarget = s.visits.slice(0, i).some(preimage => {
        const target = preimage[3];
        return target !== null && v[1] === s.visits[target][1] && v[3] === s.visits[target][3];
      });
      if (!hasTarget) fail();
    }
  }
  if (s.observationSequence < s.visits.length || (s.visits.length === 0 && s.observationSequence !== 0)) fail();
  if (s.pending !== null) {
    planShape(s.pending, s.visits);
    if (s.pending.mode === 'desired' && s.pending.preimageSlot !== null) fail();
  }
  if (s.active !== null) {
    keys(s.active, ['ordinal', 'plan']);
    if (s.active.ordinal !== s.lastExecutionOrdinal || !integer(s.active.ordinal, 1000) || s.active.ordinal === 0) fail();
    planShape(s.active.plan, s.visits);
    if (s.active.plan.id === s.pending?.id) fail();
  }
  if (s.remaining > s.residual.length + (s.active?.plan.path.length ?? 0)) fail();
  if (s.promise !== null) {
    keys(s.promise, ['plan', 'sourcePlanID', 'untilMS', 'postimageSlot']);
    const p = s.promise;
    planShape(p.plan, s.visits);
    if (s.ended || p.plan.mode !== 'inverse' || !uuid(p.sourcePlanID) || p.sourcePlanID === p.plan.id ||
        p.plan.id === s.pending?.id || p.plan.id === s.active?.plan.id ||
        (p.untilMS === null ? p.postimageSlot !== null :
          !integer(p.untilMS) || p.untilMS < 8000 || p.postimageSlot !== s.visits.length - 1)) fail();
    if (p.untilMS === null && ![s.pending?.id, s.active?.plan.id].includes(p.sourcePlanID)) fail();
    if (p.untilMS !== null && (s.active !== null || s.pending !== null)) fail();
  }
  accounting(s);
}

/** Initialize an EMPTY observed history with a qualified finite applied tail.
 * This does not initialize an output guard or grant playback authority.
 */
export function createVisitEscrow(rawInitJSON, rawTrustedEvidenceJSON) {
  return attempt(null, () => {
    const init = raw(rawInitJSON);
    keys(init, ['ledgerID', 'scopeID', 'residual']);
    if (!uuid(init.ledgerID) || !uuid(init.scopeID)) fail();
    path(init.residual);
    const p = evidence(init, rawInitJSON, rawTrustedEvidenceJSON, 'initialize');
    return publish({version: 1, ledgerID: init.ledgerID, scopeID: init.scopeID,
      revision: 0, ended: false, observationSequence: 0, observationDigest: null,
      visits: [], remaining: init.residual.length, residual: init.residual,
      residualProfileHash: p.profileHash, releaseEvidenceHash: p.evidenceHash,
      pending: null, promise: null, active: null, lastExecutionOrdinal: 0});
  });
}

/** Transactional reducer building block. All commands are bounded raw JSON;
 * state must be module-produced/restored. Refusals return the SAME state object.
 * The owning reducer commits state, guards, queue, receipts/events atomically.
 */
export function reduceVisitEscrow(s, rawCommandJSON, rawTrustedEvidenceJSON) {
  return attempt(s, () => {
    known(s);
    const c = raw(rawCommandJSON);
    if (!integer(c.expectedRevision) || c.expectedRevision !== s.revision) fail('revision_conflict');
    const fields = rest => keys(c, ['expectedRevision', 'op', ...rest]);
    const prove = (extra = [], profile = null) => evidence(s, rawCommandJSON, rawTrustedEvidenceJSON, c.op, extra, profile);
    switch (c.op) {
    case 'reserve': {
      fields(['planID', 'path', 'replacePendingID', 'closePromiseID', 'inverse']);
      if (s.ended) fail('ended');
      if (!uuid(c.planID)) fail();
      path(c.path);
      if (s.pending?.mode === 'inverse') fail('inverse_pending');
      if (c.replacePendingID !== (s.pending?.id ?? null)) fail('pending_conflict');
      if (c.closePromiseID !== (s.promise?.plan.id ?? null)) fail('promise_conflict');
      if ([s.pending?.id, s.active?.plan.id, s.promise?.plan.id].includes(c.planID)) fail('plan_conflict');
      let preimageSlot = null;
      if (c.inverse !== null) {
        keys(c.inverse, ['planID', 'path', 'preimageVisitID']);
        if (!uuid(c.inverse.planID) || [c.planID, s.pending?.id, s.active?.plan.id, s.promise?.plan.id].includes(c.inverse.planID)) fail();
        path(c.inverse.path);
        preimageSlot = findVisit(s, c.inverse.preimageVisitID);
        if (preimageSlot !== s.visits.length - 1) fail('preimage_conflict');
        if (c.inverse.path.length && c.inverse.path[0] !== s.visits[preimageSlot][1]) fail('preimage_conflict');
        if (s.active !== null) fail('output_quarantined');
      }
      const p = prove(c.inverse === null ? [] : ['complete_inverse_and_terminal_allowance']);
      const make = (id, vector, mode) => ({id, path: vector, mode, preimageSlot,
        profileHash: p.profileHash, evidenceHash: p.evidenceHash});
      const pending = make(c.planID, c.path, c.inverse === null ? 'desired' : 'control');
      const promise = c.inverse === null ? null : {plan: make(c.inverse.planID, c.inverse.path, 'inverse'),
        sourcePlanID: c.planID, untilMS: null, postimageSlot: null};
      return bump(s, {pending, promise});
    }
    case 'dispatch': {
      fields(['planID']);
      if (s.ended) fail('ended');
      if (s.active !== null) fail('output_quarantined');
      if (c.planID !== s.pending?.id) fail('pending_conflict');
      if (s.lastExecutionOrdinal === 1000) fail('execution_capacity');
      if (s.pending.mode === 'control' && s.pending.preimageSlot !== s.visits.length - 1) fail('preimage_conflict');
      prove([], s.pending.profileHash);
      const ordinal = s.lastExecutionOrdinal + 1;
      // Controls keep their acceptance preimage. A path-only desired role has
      // no accepted control preimage; capture its observed departure at send.
      const plan = s.pending.mode === 'desired' ? {...s.pending,
        preimageSlot: s.visits.length ? s.visits.length - 1 : null} : s.pending;
      return bump(s, {remaining: s.remaining + s.pending.path.length, pending: null,
        active: {ordinal, plan}, lastExecutionOrdinal: ordinal});
    }
    case 'observe':
    case 'progress': {
      fields(c.op === 'progress' ? ['observationSequence', 'visitID'] :
        ['observationSequence', 'visitID', 'occurrenceSlot', 'observedAtMS', 'startPositionMS',
          'authorityEpoch', 'transitionRevision', 'executionOrdinal', 'kind', 'targetVisitID']);
      if (!integer(c.observationSequence) || c.observationSequence === 0 || !uuid(c.visitID)) fail();
      const sample = c.op === 'progress' ? [c.op, c.observationSequence, c.visitID] :
        [c.op, c.observationSequence, c.visitID, c.occurrenceSlot, c.observedAtMS, c.startPositionMS,
          c.authorityEpoch, c.transitionRevision, c.executionOrdinal, c.kind, c.targetVisitID];
      const observationDigest = sha(JSON.stringify(sample));
      if (c.observationSequence < s.observationSequence ||
          (c.observationSequence === s.observationSequence && observationDigest !== s.observationDigest)) fail('observation_conflict');
      prove([], c.op === 'observe' && c.kind === 'back' ? s.active?.plan.profileHash ?? null : null);
      if (c.observationSequence === s.observationSequence) return publish(s);
      const common = {observationSequence: c.observationSequence, observationDigest};
      if (c.op === 'progress') {
        if (c.visitID !== s.visits.at(-1)?.[0]) fail('observation_conflict');
        return bump(s, common);
      }
      if (!integer(c.occurrenceSlot, 99) || !integer(c.observedAtMS) || !integer(c.startPositionMS, 2147483647) ||
          !integer(c.authorityEpoch) || !integer(c.transitionRevision) || !integer(c.executionOrdinal, s.lastExecutionOrdinal) ||
          !kinds.includes(c.kind) || (c.targetVisitID !== null && !uuid(c.targetVisitID))) fail();
      if (s.visits.some(v => v[0] === c.visitID)) fail('visit_exists');
      if (s.remaining === 0) fail('unfunded_observation');
      const previous = s.visits.length ? s.visits.length - 1 : null;
      let back = previous;
      if (c.kind === 'forward') {
        if (c.targetVisitID !== null) fail();
      } else if (c.kind === 'restart') {
        if (c.targetVisitID !== null || previous === null || s.visits[previous][1] !== c.occurrenceSlot) fail('navigation_conflict');
        back = s.visits[previous][3];
      } else {
        const target = findVisit(s, c.targetVisitID);
        if (s.visits[target][1] !== c.occurrenceSlot) fail('navigation_conflict');
        if (c.kind === 'back') {
          const active = s.active, preimage = active?.plan.preimageSlot;
          if (!active || active.plan.mode === 'inverse' || preimage === null ||
              s.visits[preimage][3] !== target || active.plan.path[0] !== c.occurrenceSlot ||
              c.executionOrdinal !== active.ordinal) fail('navigation_conflict');
        }
        if (c.kind === 'undo' && (s.active?.plan.mode !== 'inverse' || s.active.plan.preimageSlot !== target)) fail('navigation_conflict');
        back = s.visits[target][3];
      }
      const record = [c.visitID, c.occurrenceSlot, previous, back, c.observedAtMS, c.startPositionMS,
        c.authorityEpoch, c.transitionRevision, c.executionOrdinal, kinds.indexOf(c.kind), [0, 0, 0, 0, 0, 0]];
      if (Buffer.byteLength(JSON.stringify(record)) + 1 > 192) fail('visit_record_capacity');
      // A new observed transition invalidates only an already-open Undo window.
      // Forward observation before Release must keep the promised inverse funded.
      const promise = s.promise !== null && s.promise.untilMS !== null ? null : s.promise;
      return bump(s, {...common, visits: [...s.visits, record], remaining: s.remaining - 1, promise});
    }
    case 'release': {
      fields(['executionOrdinal', 'observationSequence', 'consumedVisits', 'residual', 'openUndoAtMS']);
      path(c.residual);
      if (c.executionOrdinal !== s.lastExecutionOrdinal || c.observationSequence !== s.observationSequence ||
          c.consumedVisits !== s.visits.length) fail('settlement_conflict');
      if (c.residual.length > s.remaining) fail('residual_exceeds_escrow');
      if (c.openUndoAtMS !== null && (!integer(c.openUndoAtMS) || !integer(c.openUndoAtMS + 8000))) fail();
      const p = prove(c.openUndoAtMS === null ? [] : ['confirmed_reversible_application'],
        s.active?.plan.profileHash ?? s.residualProfileHash);
      let promise = s.promise;
      if (c.openUndoAtMS !== null) {
        if (s.ended || promise === null || promise.untilMS !== null ||
            promise.sourcePlanID !== s.active?.plan.id || s.visits.length === 0 || s.pending !== null) fail('promise_conflict');
        promise = {...promise, untilMS: c.openUndoAtMS + 8000, postimageSlot: s.visits.length - 1};
      } else if (promise?.sourcePlanID === s.active?.plan.id && promise !== null) {
        // Terminal but not confirmed reversible: explicitly close the promise.
        promise = null;
      }
      return bump(s, {remaining: c.residual.length, residual: c.residual, active: null, promise,
        residualProfileHash: p.profileHash, releaseEvidenceHash: p.evidenceHash});
    }
    case 'accept_undo': {
      fields(['promiseID', 'nowMS']);
      if (s.ended) fail('ended');
      if (!integer(c.nowMS)) fail();
      const p = s.promise;
      if (c.promiseID !== p?.plan.id || p.untilMS === null || p.postimageSlot !== s.visits.length - 1) fail('promise_conflict');
      if (c.nowMS >= p.untilMS) fail('undo_expired');
      if (c.nowMS < p.untilMS - 8000) fail('invalid_time');
      if (s.pending !== null || s.active !== null) fail('output_quarantined');
      return bump(s, {pending: p.plan, promise: null});
    }
    case 'close_undo': {
      fields(['promiseID', 'reason', 'nowMS']);
      if (!integer(c.nowMS) || !['expired', 'invalidated'].includes(c.reason)) fail();
      if (c.promiseID !== s.promise?.plan.id) fail('promise_conflict');
      if (c.reason === 'expired' && (s.promise.untilMS === null || c.nowMS < s.promise.untilMS)) fail('undo_not_expired');
      return bump(s, {promise: null});
    }
    case 'cancel': {
      fields(['planID']);
      if (c.planID !== s.pending?.id) fail('pending_conflict');
      prove([], s.pending.profileHash);
      return bump(s, {pending: null, promise: s.promise?.sourcePlanID === c.planID ? null : s.promise});
    }
    case 'end':
      fields([]);
      // End alone is not never-dispatched cancellation or Release. Even pending
      // accepted work remains funded until cancel supplies the exact proof.
      return s.ended ? publish(s) : bump(s, {ended: true, promise: null});
    default: fail();
    }
  });
}

/** Internal persistence codec; NOT a new HTTP command or authority boundary.
 * Never serialize arbitrary caller objects. Only module-branded state is read.
 */
export function encodeVisitEscrow(s) {
  return attempt(s, () => {
    known(s);
    const pages = [];
    for (let offset = 0; offset < s.visits.length; offset += PAGE_ROWS) {
      pages.push(JSON.stringify({offset, visits: s.visits.slice(offset, offset + PAGE_ROWS)}));
    }
    return freeze({ok: true, header: JSON.stringify(header(s)), pages});
  });
}

/** Restore trusted persisted chunks. EACH raw chunk goes through the existing
 * <=16 KiB numeric/duplicate/depth/node parser before reflection. No arbitrary
 * state objects, full-ledger JSON parsing, omitted history or cap override.
 * Storage adapter must atomically bind all pages/header to the same room revision.
 */
export function restoreVisitEscrow(rawHeaderJSON, ...rawPagesJSON) {
  return attempt(null, () => {
    if (rawPagesJSON.length > MAX_PAGES) fail();
    const h = raw(rawHeaderJSON);
    keys(h, [...stateKeys.filter(k => k !== 'visits'), 'visitCount']);
    if (!integer(h.visitCount, CAP) || rawPagesJSON.length !== Math.ceil(h.visitCount / PAGE_ROWS)) fail();
    const visits = [];
    for (const pageJSON of rawPagesJSON) {
      const page = raw(pageJSON);
      keys(page, ['offset', 'visits']);
      if (page.offset !== visits.length || !Array.isArray(page.visits) ||
          page.visits.length !== Math.min(PAGE_ROWS, h.visitCount - visits.length)) fail();
      visits.push(...page.visits);
    }
    const {visitCount, ...fields} = h;
    const s = {...fields, visits};
    shape(s);
    return publish(s);
  });
}
