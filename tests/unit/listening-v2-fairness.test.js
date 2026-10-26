import test from 'node:test';
import assert from 'node:assert/strict';
import {fair} from '../../api/utils/listening-v2/fairness.js';

const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const A = uuid(101), B = uuid(102), C = uuid(103);
const pick = (n, contributorID, acceptanceSeq, automatic = true) => ({
  id: uuid(n), contributorID, acceptanceSeq, automatic,
});
const a1 = pick(1, A, 1), a2 = pick(2, A, 2);
const b1 = pick(3, B, 3), b2 = pick(4, B, 4), c1 = pick(5, C, 5);
const joins = () => new Map([[A, 0], [B, 1], [C, 2]]);
const ids = slots => slots.map(slot => slot.id);
const invalid = fn => assert.throws(fn, error =>
  error instanceof TypeError && error.message === 'Invalid fairness input');

// Direct tuple transcription of architecture lines 249-258, kept independent
// of the implementation and its object representation/validation.
function reference(slots, turns, firstJoins) {
  const tuples = slots.map(s => [s.id, s.contributorID, s.acceptanceSeq, s.automatic]);
  const pending = new Map(), ranked = [];
  for (const item of tuples.filter(s => s[3]).sort((a, b) => a[2] - b[2])) {
    const who = item[1], ordinal = (pending.get(who) ?? 0) + 1;
    pending.set(who, ordinal);
    ranked.push([[(turns.get(who) ?? 0) + ordinal, firstJoins.get(who), item[2]], item]);
  }
  ranked.sort(([a], [b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const ordered = ranked.map(([, item]) => item)[Symbol.iterator]();
  return tuples.map(item => (item[3] ? ordered.next().value : item)[0]);
}

const approvedExamples = [
  ['interleaves contributors', [a1, a2, b1, b2], [], [a1, b1, a2, b2]],
  ['two observed A turns', [a1, b1, b2], [[A, 2]], [b1, b2, a1]],
  ['concurrent C/B accepts use first join before acceptance sequence', [c1, b1], [], [b1, c1]],
  ['removing B1 makes B2 the first pending B turn', [a1, a2, b2], [], [a1, b2, a2]],
  ['observed A1 earns a turn', [a2, b1], [[A, 1]], [b1, a2]],
  ['unobserved skipped A1 earns no turn', [a2, b1], [], [a2, b1]],
  ['Play Next pins the head', [pick(6, C, 6, false), a1, a2, b1], [], [pick(6, C, 6, false), a1, b1, a2]],
  ['drag pins the chosen index', [a1, pick(7, C, 7, false), a2, b1], [], [a1, pick(7, C, 7, false), b1, a2]],
  ['off/on freezes old items, only new End adds are automatic',
    [a1, a2, b1].map(s => ({...s, automatic: false})).concat(b2), [], [a1, a2, b1, b2]],
];
for (const [name, slots, turns, expected] of approvedExamples) {
  test(`approved example: ${name}`, () => {
    assert.deepEqual(fair(slots, new Map(turns), joins()), ids(expected));
  });
}
test('approved example: Take turns off appends in accepted order without fair()', () => {
  const upcoming = [a1, a2].concat(b1);
  assert.deepEqual(ids(upcoming), ids([a1, a2, b1]));
  const frozen = upcoming.map(s => ({...s, automatic: false}));
  assert.deepEqual(fair(frozen, new Map(), new Map()), ids(upcoming));
});

test('acceptance sequence assigns pending ordinals even after arbitrary displayed moves', () => {
  assert.deepEqual(fair([a2, b2, b1, a1], new Map(), joins()), ids([a1, b1, a2, b2]));
});
test('equal projected turns and join ordinals use acceptance sequence', () => {
  const sameJoin = new Map([[A, 0], [B, 0], [C, 0]]);
  assert.deepEqual(fair([c1, b1, a1, a2], new Map(), sameJoin), ids([a1, b1, c1, a2]));
  assert.deepEqual(fair([a1, b1, b2], new Map([[A, 1]]), sameJoin), ids([b1, a1, b2]));
});
test('fixed items contribute neither pending ordinals nor inferred observed turns', () => {
  const fixed = {...a1, automatic: false};
  assert.deepEqual(fair([fixed, a2, b1], new Map(), joins()), ids([fixed, a2, b1]));
  assert.deepEqual(fair([fixed, a2, b1], new Map([[A, 1]]), joins()), ids([fixed, b1, a2]));
});
test('counts represent actual visits including repeated starts, without being incremented', () => {
  const turns = new Map([[A, 3], [B, 1]]);
  assert.deepEqual(fair([a1, b1, b2], turns, joins()), ids([b1, b2, a1]));
  assert.deepEqual([...turns], [[A, 3], [B, 1]]);
  assert.deepEqual(fair([a1, b1, b2], turns, joins()), ids([b1, b2, a1]));
});
test('removal/skip and qualified observed-start composition differ only in supplied counts', () => {
  const remaining = [a2, b1];
  assert.deepEqual(fair(remaining, new Map(), joins()), ids([a2, b1]));
  assert.deepEqual(fair(remaining, new Map([[A, 1]]), joins()), ids([b1, a2]));
});
test('latest accepted Play Next stays first; previous head pins stay fixed', () => {
  const olderNext = pick(6, C, 6, false), newerNext = pick(7, B, 7, false);
  assert.deepEqual(fair([newerNext, olderNext, a1, a2, b1], new Map(), joins()),
    ids([newerNext, olderNext, a1, b1, a2]));
});
test('moving another contributor\'s pick pins its index without transferring credit', () => {
  const movedB = {...b1, automatic: false};
  const upcoming = [a1, movedB, a2, b2];
  assert.deepEqual(fair(upcoming, new Map(), joins()), ids([a1, movedB, b2, a2]));
  assert.equal(movedB.contributorID, B);
  assert.deepEqual(fair(upcoming.filter(s => s !== movedB), new Map([[B, 1]]), joins()), ids([a1, a2, b2]));
});
test('toggle on preserves old fixed order while new End adds interleave', () => {
  const frozen = [a1, a2, b1].map(s => ({...s, automatic: false}));
  const a3 = pick(8, A, 8), b3 = pick(9, B, 9);
  assert.deepEqual(fair([...frozen, a3, b2, b3], new Map(), joins()), ids([...frozen, a3, b2, b3]));
  assert.deepEqual(fair([...frozen, a3, b2, b3], new Map([[A, 1]]), joins()), ids([...frozen, b2, a3, b3]));
});
test('API takes upcoming only and cannot accept a current/history wrapper or recording metadata', () => {
  invalid(() => fair({upcoming: [a1], current: b1, played: []}, new Map(), joins()));
  invalid(() => fair([{...a1, current: true}], new Map(), joins()));
  invalid(() => fair([{...a1, recording: {provider: 'spotify', catalogID: 'exact'}}], new Map(), joins()));
  assert.deepEqual(fair([a2, b1], new Map(), joins()), ids([a2, b1]));
});
test('empty/all-fixed input needs no contributor lookups and returns immutable fresh IDs', () => {
  const empty = fair([], new Map(), new Map());
  assert.deepEqual(empty, []);
  assert(Object.isFrozen(empty));
  assert.notEqual(empty, fair([], new Map(), new Map()));
  const slots = [{...a1, automatic: false}, {...b1, automatic: false}];
  assert.deepEqual(fair(slots, new Map([[A, 'unused']]), new Map()), ids(slots));
});
test('frozen caller data and maps are unmodified and output has no mutable object references', () => {
  const slots = Object.freeze([a2, b1, a1].map(s => Object.freeze({...s})));
  const turns = Object.freeze(new Map([[A, 1]])), firstJoins = Object.freeze(joins());
  const before = structuredClone({slots, turns, firstJoins});
  const result = fair(slots, turns, firstJoins);
  assert.deepEqual({slots, turns, firstJoins}, before);
  assert(Object.isFrozen(result));
  assert(result.every(id => typeof id === 'string'));
  assert.throws(() => result.push(uuid(9)), TypeError);
  assert.throws(() => { result[0] = uuid(9); }, TypeError);
});
test('changing caller objects after return cannot change the result', () => {
  const slots = [{...a1}, {...b1}], turns = new Map(), firstJoins = joins();
  const result = fair(slots, turns, firstJoins);
  slots[0].id = uuid(50); slots[1].contributorID = A;
  turns.set(A, 512); firstJoins.clear(); slots.reverse();
  assert.deepEqual(result, ids([a1, b1]));
});
test('exact occurrence and contributor UUID spelling is preserved with exact Map keys', () => {
  const who = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
  const exact = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDE0';
  const slots = [{id: exact, contributorID: who, acceptanceSeq: 1, automatic: true},
    pick(2, who, 2)];
  assert.deepEqual(fair(slots, new Map(), new Map([[who, 0]])), [exact, uuid(2)]);
  assert.equal(slots[0].contributorID, who);
  invalid(() => fair(slots, new Map(), new Map([[who.toLowerCase(), 0]])));
});
test('ambiguous case aliases of one contributor cannot split its pending ordinals', () => {
  const who = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  invalid(() => fair([pick(1, who, 1), pick(2, who.toUpperCase(), 2)], new Map(),
    new Map([[who, 0], [who.toUpperCase(), 1]])));
});

test('100 slots and 100 needed contributors fit; projected turns can exceed 512', () => {
  const slots = Array.from({length: 100}, (_, i) => pick(i + 1, uuid(1000 + i), i));
  const firstJoins = new Map(slots.map((s, i) => [s.contributorID, i]));
  assert.deepEqual(fair(slots, new Map(), firstJoins), ids(slots));
  const sameContributor = slots.map(s => ({...s, contributorID: A}));
  assert.deepEqual(fair(sameContributor, new Map([[A, 512]]), joins()), ids(sameContributor));
});
test('safe integer endpoints are accepted without coercion or rank overflow', () => {
  const slots = [pick(1, A, Number.MAX_SAFE_INTEGER), pick(2, B, 0)];
  assert.deepEqual(fair(slots, new Map(), new Map([[A, Number.MAX_SAFE_INTEGER], [B, 0]])), ids([slots[1], slots[0]]));
});
test('rejects more than 100 slots before touching elements', () => {
  let reads = 0;
  const slots = Array(101);
  Object.defineProperty(slots, '0', {get() { reads++; throw Error('read'); }});
  invalid(() => fair(slots, new Map(), joins()));
  assert.equal(reads, 0);
});
test('requires dense ordinary arrays with no unknown own keys', () => {
  for (const slots of [null, undefined, {}, 'slots', new Set([a1]), new Uint8Array(1), [, a1], [undefined]]) {
    invalid(() => fair(slots, new Map(), joins()));
  }
  for (const key of ['extra', Symbol('extra')]) {
    const slots = [a1]; Object.defineProperty(slots, key, {value: true});
    invalid(() => fair(slots, new Map(), joins()));
  }
  class SlotArray extends Array {}
  invalid(() => fair(new SlotArray(a1), new Map(), joins()));
});
test('slots require exactly four own data fields, including nonenumerable/symbol checks', () => {
  for (const value of [null, [], new Date(), 1, 'slot', Object.create(a1)]) {
    invalid(() => fair([value], new Map(), joins()));
  }
  for (const field of Object.keys(a1)) {
    const slot = {...a1}; delete slot[field];
    invalid(() => fair([slot], new Map(), joins()));
  }
  for (const key of ['provider', Symbol('provider')]) {
    const slot = {...a1}; Object.defineProperty(slot, key, {value: true});
    invalid(() => fair([slot], new Map(), joins()));
  }
  const nullPrototype = Object.assign(Object.create(null), a1);
  assert.deepEqual(fair([nullPrototype], new Map(), joins()), [a1.id]);
});
test('refuses slot and array accessors without invoking them', () => {
  let reads = 0;
  for (const field of [...Object.keys(a1), 'unknown']) {
    const slot = {...a1};
    Object.defineProperty(slot, field, {get() { reads++; throw Error('getter'); }});
    invalid(() => fair([slot], new Map(), joins()));
  }
  const slots = [a1];
  Object.defineProperty(slots, '0', {get() { reads++; throw Error('getter'); }});
  invalid(() => fair(slots, new Map(), joins()));
  assert.equal(reads, 0);
});
test('refuses proxies, including revoked proxies, without invoking traps', () => {
  let touches = 0;
  const traps = new Proxy({}, {get() { touches++; throw Error('trap requested'); }});
  for (const target of [[a1], a1, new Map()]) {
    const proxy = new Proxy(target, traps);
    const revoked = Proxy.revocable(target, {}); revoked.revoke();
    for (const value of [proxy, revoked.proxy]) {
      if (Array.isArray(target)) invalid(() => fair(value, new Map(), joins()));
      else if (target instanceof Map) {
        invalid(() => fair([a1], value, joins()));
        invalid(() => fair([a1], new Map(), value));
      } else invalid(() => fair([value], new Map(), joins()));
    }
  }
  assert.equal(touches, 0);
});
test('invalid UUIDs, nonbooleans and unsafe/negative/fractional sequences refuse', () => {
  for (const field of ['id', 'contributorID']) {
    for (const value of [null, 1, {}, '', 'x'.repeat(10000), 'not-a-uuid',
      '00000000-0000-0000-0000-000000000000', uuid(1).replace('-4000-', '-9000-'), uuid(1).replace('-8000-', '-7000-')]) {
      invalid(() => fair([{...a1, [field]: value}], new Map(), joins()));
    }
  }
  for (const automatic of [0, 1, 'true', null, undefined, new Boolean(true)]) {
    invalid(() => fair([{...a1, automatic}], new Map(), joins()));
  }
  for (const acceptanceSeq of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n, null]) {
    invalid(() => fair([{...a1, acceptanceSeq}], new Map(), joins()));
  }
});
test('rejects duplicate occurrence UUIDs (including case aliases) and acceptance sequences', () => {
  invalid(() => fair([a1, {...b1, id: a1.id}], new Map(), joins()));
  const id = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  invalid(() => fair([{...a1, id}, {...b1, id: id.toUpperCase()}], new Map(), joins()));
  invalid(() => fair([a1, {...b1, acceptanceSeq: a1.acceptanceSeq}], new Map(), joins()));
  invalid(() => fair([{...a1, automatic: false}, {...b1, acceptanceSeq: a1.acceptanceSeq}], new Map(), joins()));
});
test('requires native Maps even for empty queues; ignores object getters/provider hooks', () => {
  let reads = 0;
  const provider = {get get() { reads++; throw Error('provider hook'); }};
  for (const value of [undefined, null, {}, provider, [], new WeakMap(), () => 0]) {
    invalid(() => fair([], value, new Map()));
    invalid(() => fair([], new Map(), value));
  }
  assert.equal(reads, 0);
});
test('intrinsic Map lookups never call caller methods, getters, iteration or provider hooks', () => {
  let touches = 0;
  class DomainMap extends Map {
    get() { touches++; throw Error('get'); }
    has() { touches++; throw Error('has'); }
    entries() { touches++; throw Error('entries'); }
    [Symbol.iterator]() { touches++; throw Error('iterator'); }
  }
  const turns = new DomainMap([[A, 1]]), firstJoins = new DomainMap([[A, 0], [B, 1]]);
  for (const map of [turns, firstJoins]) {
    for (const key of ['size', 'get', 'has', 'entries', 'forEach', Symbol.iterator]) {
      Object.defineProperty(map, key, {get() { touches++; throw Error('getter'); }});
    }
  }
  assert.deepEqual(fair([a2, b1], turns, firstJoins), ids([b1, a2]));
  assert.equal(touches, 0);
});
test('reads only needed automatic contributors, never enumerates or validates unrelated map entries', () => {
  const turns = new Map(), firstJoins = new Map([[A, 0]]);
  const poisonous = {get valueOf() { throw Error('coercion'); }};
  for (let i = 0; i < 20000; i++) { turns.set(`unused-${i}`, poisonous); firstJoins.set(`unused-${i}`, poisonous); }
  turns.set(B, poisonous);
  assert.deepEqual(fair([a1, {...b1, automatic: false}], turns, firstJoins), ids([a1, b1]));
  assert.equal(turns.size, 20001); assert.equal(firstJoins.size, 20001);
});
test('missing turns default to zero, but missing joins and present invalid values refuse', () => {
  assert.deepEqual(fair([a1], new Map(), joins()), [a1.id]);
  invalid(() => fair([a1], new Map(), new Map()));
  for (const value of [undefined, null, '1', 1n, {}, NaN, Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    invalid(() => fair([a1], new Map([[A, value]]), joins()));
    invalid(() => fair([a1], new Map(), new Map([[A, value]])));
  }
});
test('consulted observed counts and their sum cannot exceed the 512 actual visit bound', () => {
  invalid(() => fair([a1], new Map([[A, 513]]), joins()));
  invalid(() => fair([a1, b1], new Map([[A, 300], [B, 213]]), joins()));
  assert.deepEqual(fair([a1, b1], new Map([[A, 300], [B, 212]]), joins()), ids([b1, a1]));
});
test('invalid inputs are not coerced, logged in errors, or partially mutated', () => {
  let touches = 0;
  const hostile = {valueOf() { touches++; throw Error('valueOf'); }, toString() { touches++; throw Error('toString'); }};
  const slot = {...a1, acceptanceSeq: hostile};
  invalid(() => fair([slot], new Map(), joins()));
  invalid(() => fair([a1], new Map([[A, hostile]]), joins()));
  assert.equal(slot.acceptanceSeq, hostile); assert.equal(touches, 0);
});

test('750 deterministic randomized cases match reference and preserve order/positions/inputs', () => {
  let seed = 0x57e55102;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let run = 0; run < 750; run++) {
    const contributors = Array.from({length: 1 + random(12)}, (_, i) => uuid(1000 + i));
    const firstJoins = new Map(contributors.map(who => [who, random(8)]));
    const turns = new Map(contributors.map(who => [who, random(20)]));
    const slots = Array.from({length: random(101)}, (_, i) =>
      pick(i + 1, contributors[random(contributors.length)], i, random(4) !== 0));
    for (let i = slots.length - 1; i > 0; i--) {
      const j = random(i + 1); [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const before = structuredClone({slots, turns, firstJoins});
    const result = fair(slots, turns, firstJoins);
    assert.deepEqual(result, reference(slots, turns, firstJoins), `reference run ${run}`);
    assert.deepEqual(result, fair(slots, turns, firstJoins), `determinism run ${run}`);
    assert.deepEqual({slots, turns, firstJoins}, before, `mutation run ${run}`);
    assert.deepEqual([...result].sort(), ids(slots).sort(), `UUID permutation run ${run}`);
    const byID = new Map(slots.map(s => [s.id, s]));
    slots.forEach((s, i) => { if (!s.automatic) assert.equal(result[i], s.id, `fixed slot run ${run}`); });
    for (const who of contributors) {
      const expected = slots.filter(s => s.automatic && s.contributorID === who)
        .sort((a, b) => a.acceptanceSeq - b.acceptanceSeq);
      const actual = result.map(id => byID.get(id)).filter(s => s.automatic && s.contributorID === who);
      assert.deepEqual(ids(actual), ids(expected), `contributor acceptance order run ${run}`);
    }
    assert(Object.isFrozen(result));
  }
});
