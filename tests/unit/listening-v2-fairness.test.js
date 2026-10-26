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
// Test fixtures only: serialize known bounded data, never hostile caller objects.
// Production must construct this projection from its locked room upstream.
const raw = slots => JSON.stringify({slots});
const fixtureFair = (slots, turns, firstJoins) => fair(raw(slots), turns, firstJoins);
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
    assert.deepEqual(fixtureFair(slots, new Map(turns), joins()), ids(expected));
  });
}
test('approved example: Take turns off appends in accepted order without fair()', () => {
  const upcoming = [a1, a2].concat(b1);
  assert.deepEqual(ids(upcoming), ids([a1, a2, b1]));
  const frozen = upcoming.map(s => ({...s, automatic: false}));
  assert.deepEqual(fixtureFair(frozen, new Map(), new Map()), ids(upcoming));
});

test('acceptance sequence assigns pending ordinals even after arbitrary displayed moves', () => {
  assert.deepEqual(fixtureFair([a2, b2, b1, a1], new Map(), joins()), ids([a1, b1, a2, b2]));
});
test('equal projected turns and join ordinals use acceptance sequence', () => {
  const sameJoin = new Map([[A, 0], [B, 0], [C, 0]]);
  assert.deepEqual(fixtureFair([c1, b1, a1, a2], new Map(), sameJoin), ids([a1, b1, c1, a2]));
  assert.deepEqual(fixtureFair([a1, b1, b2], new Map([[A, 1]]), sameJoin), ids([b1, a1, b2]));
});
test('fixed items contribute neither pending ordinals nor inferred observed turns', () => {
  const fixed = {...a1, automatic: false};
  assert.deepEqual(fixtureFair([fixed, a2, b1], new Map(), joins()), ids([fixed, a2, b1]));
  assert.deepEqual(fixtureFair([fixed, a2, b1], new Map([[A, 1]]), joins()), ids([fixed, b1, a2]));
});
test('counts represent actual visits including repeated starts, without being incremented', () => {
  const turns = new Map([[A, 3], [B, 1]]);
  assert.deepEqual(fixtureFair([a1, b1, b2], turns, joins()), ids([b1, b2, a1]));
  assert.deepEqual([...turns], [[A, 3], [B, 1]]);
  assert.deepEqual(fixtureFair([a1, b1, b2], turns, joins()), ids([b1, b2, a1]));
});
test('removal/skip and qualified observed-start composition differ only in supplied counts', () => {
  const remaining = [a2, b1];
  assert.deepEqual(fixtureFair(remaining, new Map(), joins()), ids([a2, b1]));
  assert.deepEqual(fixtureFair(remaining, new Map([[A, 1]]), joins()), ids([b1, a2]));
});
test('latest accepted Play Next stays first; previous head pins stay fixed', () => {
  const olderNext = pick(6, C, 6, false), newerNext = pick(7, B, 7, false);
  assert.deepEqual(fixtureFair([newerNext, olderNext, a1, a2, b1], new Map(), joins()),
    ids([newerNext, olderNext, a1, b1, a2]));
});
test('moving another contributor\'s pick pins its index without transferring credit', () => {
  const movedB = {...b1, automatic: false};
  const upcoming = [a1, movedB, a2, b2];
  assert.deepEqual(fixtureFair(upcoming, new Map(), joins()), ids([a1, movedB, b2, a2]));
  assert.equal(movedB.contributorID, B);
  assert.deepEqual(fixtureFair(upcoming.filter(s => s !== movedB), new Map([[B, 1]]), joins()), ids([a1, a2, b2]));
});
test('toggle on preserves old fixed order while new End adds interleave', () => {
  const frozen = [a1, a2, b1].map(s => ({...s, automatic: false}));
  const a3 = pick(8, A, 8), b3 = pick(9, B, 9);
  assert.deepEqual(fixtureFair([...frozen, a3, b2, b3], new Map(), joins()), ids([...frozen, a3, b2, b3]));
  assert.deepEqual(fixtureFair([...frozen, a3, b2, b3], new Map([[A, 1]]), joins()), ids([...frozen, b2, a3, b3]));
});
test('API takes upcoming only and cannot accept a current/history wrapper or recording metadata', () => {
  invalid(() => fixtureFair({upcoming: [a1], current: b1, played: []}, new Map(), joins()));
  invalid(() => fixtureFair([{...a1, current: true}], new Map(), joins()));
  invalid(() => fixtureFair([{...a1, recording: {provider: 'spotify', catalogID: 'exact'}}], new Map(), joins()));
  assert.deepEqual(fixtureFair([a2, b1], new Map(), joins()), ids([a2, b1]));
});
test('empty/all-fixed input needs no contributor lookups and returns immutable fresh IDs', () => {
  const empty = fixtureFair([], new Map(), new Map());
  assert.deepEqual(empty, []);
  assert(Object.isFrozen(empty));
  assert.notEqual(empty, fixtureFair([], new Map(), new Map()));
  const slots = [{...a1, automatic: false}, {...b1, automatic: false}];
  assert.deepEqual(fixtureFair(slots, new Map([[A, 'unused']]), new Map()), ids(slots));
});
test('frozen caller data and maps are unmodified and output has no mutable object references', () => {
  const slots = Object.freeze([a2, b1, a1].map(s => Object.freeze({...s})));
  const turns = Object.freeze(new Map([[A, 1]])), firstJoins = Object.freeze(joins());
  const before = structuredClone({slots, turns, firstJoins});
  const result = fixtureFair(slots, turns, firstJoins);
  assert.deepEqual({slots, turns, firstJoins}, before);
  assert(Object.isFrozen(result));
  assert(result.every(id => typeof id === 'string'));
  assert.throws(() => result.push(uuid(9)), TypeError);
  assert.throws(() => { result[0] = uuid(9); }, TypeError);
});
test('changing caller objects after return cannot change the result', () => {
  const slots = [{...a1}, {...b1}], turns = new Map(), firstJoins = joins();
  const result = fixtureFair(slots, turns, firstJoins);
  slots[0].id = uuid(50); slots[1].contributorID = A;
  turns.set(A, 512); firstJoins.clear(); slots.reverse();
  assert.deepEqual(result, ids([a1, b1]));
});
test('exact occurrence and contributor UUID spelling is preserved with exact Map keys', () => {
  const who = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
  const exact = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDE0';
  const slots = [{id: exact, contributorID: who, acceptanceSeq: 1, automatic: true},
    pick(2, who, 2)];
  assert.deepEqual(fixtureFair(slots, new Map(), new Map([[who, 0]])), [exact, uuid(2)]);
  assert.equal(slots[0].contributorID, who);
  invalid(() => fixtureFair(slots, new Map(), new Map([[who.toLowerCase(), 0]])));
});
test('ambiguous case aliases of one contributor cannot split its pending ordinals', () => {
  const who = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  invalid(() => fixtureFair([pick(1, who, 1), pick(2, who.toUpperCase(), 2)], new Map(),
    new Map([[who, 0], [who.toUpperCase(), 1]])));
});

test('100 slots and 100 needed contributors fit; projected turns can exceed 512', () => {
  const slots = Array.from({length: 100}, (_, i) => pick(i + 1, uuid(1000 + i), i));
  const firstJoins = new Map(slots.map((s, i) => [s.contributorID, i]));
  const maximal = slots.map((s, i) => ({...s, acceptanceSeq: Number.MAX_SAFE_INTEGER - i, automatic: false}));
  assert(Buffer.byteLength(raw(maximal)) <= 16384);
  assert.deepEqual(fair(raw(maximal), new Map(), firstJoins), ids(maximal));
  assert.deepEqual(fixtureFair(slots, new Map(), firstJoins), ids(slots));
  const sameContributor = slots.map(s => ({...s, contributorID: A}));
  assert.deepEqual(fixtureFair(sameContributor, new Map([[A, 512]]), joins()), ids(sameContributor));
});
test('safe integer endpoints are accepted without coercion or rank overflow', () => {
  const slots = [pick(1, A, Number.MAX_SAFE_INTEGER), pick(2, B, 0)];
  assert.deepEqual(fixtureFair(slots, new Map(), new Map([[A, Number.MAX_SAFE_INTEGER], [B, 0]])), ids([slots[1], slots[0]]));
});
test('rejects more than 100 slots; preparsed oversize arrays never touch elements', () => {
  invalid(() => fair(raw(Array.from({length: 101}, (_, i) => pick(i + 1, A, i))), new Map(), joins()));
  let reads = 0;
  const slots = Array(101);
  Object.defineProperty(slots, '0', {get() { reads++; throw Error('read'); }});
  invalid(() => fair(slots, new Map(), joins()));
  assert.equal(reads, 0);
});
test('requires a dense JSON slots array and refuses all preparsed array variants/extras', () => {
  for (const slots of [null, {}, 'slots', 1, true, [null]]) {
    invalid(() => fair(raw(slots), new Map(), joins()));
  }
  invalid(() => fair('{"slots":[,]}', new Map(), joins()));
  invalid(() => fair('{"slots":{"0":null,"length":1,"extra":true}}', new Map(), joins()));
  class SlotArray extends Array {}
  for (const slots of [undefined, new Set([a1]), new Uint8Array(1), [, a1], [undefined], new SlotArray(a1)]) {
    invalid(() => fair(slots, new Map(), joins()));
  }
  for (const key of ['extra', Symbol('extra')]) {
    const slots = [a1]; Object.defineProperty(slots, key, {value: true});
    invalid(() => fair(slots, new Map(), joins()));
  }
});
test('slots require exactly four JSON fields; preparsed nonenumerable/symbol fields refuse', () => {
  for (const value of [null, [], 1, 'slot', {}]) {
    invalid(() => fixtureFair([value], new Map(), joins()));
  }
  for (const field of Object.keys(a1)) {
    const slot = {...a1}; delete slot[field];
    invalid(() => fixtureFair([slot], new Map(), joins()));
  }
  invalid(() => fixtureFair([{...a1, provider: true}], new Map(), joins()));
  for (const key of ['provider', Symbol('provider')]) {
    const slot = {...a1}; Object.defineProperty(slot, key, {value: true});
    invalid(() => fair([slot], new Map(), joins()));
  }
  invalid(() => fair([Object.create(a1)], new Map(), joins()));
  invalid(() => fair([new Date(0)], new Map(), joins()));
  const nullPrototype = Object.assign(Object.create(null), a1);
  invalid(() => fair([nullPrototype], new Map(), joins()));
  assert.deepEqual(fixtureFair([nullPrototype], new Map(), joins()), [a1.id]);
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
      invalid(() => fair(value, new Map(), joins()));
      if (target instanceof Map) {
        invalid(() => fair(raw([a1]), value, joins()));
        invalid(() => fair(raw([a1]), new Map(), value));
      } else invalid(() => fair([value], new Map(), joins()));
    }
  }
  assert.equal(touches, 0);
});
test('invalid UUIDs, nonbooleans and unsafe/negative/fractional sequences refuse', () => {
  for (const field of ['id', 'contributorID']) {
    for (const value of [null, 1, {}, '', 'x'.repeat(10000), 'not-a-uuid',
      '00000000-0000-0000-0000-000000000000', uuid(1).replace('-4000-', '-9000-'), uuid(1).replace('-8000-', '-7000-')]) {
      invalid(() => fixtureFair([{...a1, [field]: value}], new Map(), joins()));
    }
  }
  for (const automatic of [0, 1, 'true', null, undefined]) {
    invalid(() => fixtureFair([{...a1, automatic}], new Map(), joins()));
  }
  invalid(() => fair([{...a1, automatic: new Boolean(true)}], new Map(), joins()));
  for (const acceptanceSeq of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    invalid(() => fixtureFair([{...a1, acceptanceSeq}], new Map(), joins()));
  }
  invalid(() => fair([{...a1, acceptanceSeq: 1n}], new Map(), joins()));
});
test('rejects duplicate occurrence UUIDs (including case aliases) and acceptance sequences', () => {
  invalid(() => fixtureFair([a1, {...b1, id: a1.id}], new Map(), joins()));
  const id = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  invalid(() => fixtureFair([{...a1, id}, {...b1, id: id.toUpperCase()}], new Map(), joins()));
  invalid(() => fixtureFair([a1, {...b1, acceptanceSeq: a1.acceptanceSeq}], new Map(), joins()));
  invalid(() => fixtureFair([{...a1, automatic: false}, {...b1, acceptanceSeq: a1.acceptanceSeq}], new Map(), joins()));
});
test('requires native Maps even for empty queues; ignores object getters/provider hooks', () => {
  let reads = 0;
  const provider = {get get() { reads++; throw Error('provider hook'); }};
  for (const value of [undefined, null, {}, provider, [], new WeakMap(), () => 0]) {
    invalid(() => fixtureFair([], value, new Map()));
    invalid(() => fixtureFair([], new Map(), value));
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
  assert.deepEqual(fixtureFair([a2, b1], turns, firstJoins), ids([b1, a2]));
  assert.equal(touches, 0);
});
test('reads only needed automatic contributors, never enumerates or validates unrelated map entries', () => {
  const turns = new Map(), firstJoins = new Map([[A, 0]]);
  const poisonous = {get valueOf() { throw Error('coercion'); }};
  for (let i = 0; i < 20000; i++) { turns.set(`unused-${i}`, poisonous); firstJoins.set(`unused-${i}`, poisonous); }
  turns.set(B, poisonous);
  assert.deepEqual(fixtureFair([a1, {...b1, automatic: false}], turns, firstJoins), ids([a1, b1]));
  assert.equal(turns.size, 20001); assert.equal(firstJoins.size, 20001);
});
test('missing turns default to zero, but missing joins and present invalid values refuse', () => {
  assert.deepEqual(fixtureFair([a1], new Map(), joins()), [a1.id]);
  invalid(() => fixtureFair([a1], new Map(), new Map()));
  for (const value of [undefined, null, '1', 1n, {}, NaN, Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    invalid(() => fixtureFair([a1], new Map([[A, value]]), joins()));
    invalid(() => fixtureFair([a1], new Map(), new Map([[A, value]])));
  }
});
test('consulted observed counts and their sum cannot exceed the 512 actual visit bound', () => {
  invalid(() => fixtureFair([a1], new Map([[A, 513]]), joins()));
  invalid(() => fixtureFair([a1, b1], new Map([[A, 300], [B, 213]]), joins()));
  assert.deepEqual(fixtureFair([a1, b1], new Map([[A, 300], [B, 212]]), joins()), ids([b1, a1]));
});
test('invalid inputs are not coerced, logged in errors, or partially mutated', () => {
  let touches = 0;
  const hostile = {valueOf() { touches++; throw Error('valueOf'); }, toString() { touches++; throw Error('toString'); }};
  const slot = {...a1, acceptanceSeq: hostile};
  invalid(() => fair([slot], new Map(), joins()));
  invalid(() => fixtureFair([a1], new Map([[A, hostile]]), joins()));
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
    const result = fixtureFair(slots, turns, firstJoins);
    assert.deepEqual(result, reference(slots, turns, firstJoins), `reference run ${run}`);
    assert.deepEqual(result, fixtureFair(slots, turns, firstJoins), `determinism run ${run}`);
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

test('raw wrapper is closed and strings must encode an object with only slots', () => {
  for (const value of [undefined, null, 0, true, new String(raw([a1])), [], {}, [a1]]) {
    invalid(() => fair(value, new Map(), joins()));
  }
  for (const value of ['', 'null', 'true', '0', '"slots"', '[]', '{}', '{"slots":[]',
    '{"slots":[],"current":null}', '{"upcoming":[]}', '{"slots":[],"played":[]}']) {
    invalid(() => fair(value, new Map(), joins()));
  }
  assert.deepEqual(fair(' { "slots" : [] } ', new Map(), new Map()), []);
});
test('raw byte admission includes exactly 16 KiB and checks UTF8 before any JSON.parse', () => {
  const base = raw([a1]);
  const exact = base + ' '.repeat(16384 - Buffer.byteLength(base));
  assert.deepEqual(fair(exact, new Map(), joins()), [a1.id]);
  const utf8 = JSON.stringify({slots: [], ['é'.repeat(8200)]: 0});
  assert(utf8.length < 16384 && Buffer.byteLength(utf8) > 16384);
  const escaped = JSON.stringify({slots: [], extra: '\u0000'.repeat(3000)});
  const wide = '{"slots":[],' + Array.from({length: 2000}, (_, i) => `"k${i}":0`).join(',') + '}';
  const largeKey = JSON.stringify({slots: [], ['k'.repeat(20000)]: 0});
  const parse = JSON.parse;
  let parses = 0;
  try {
    JSON.parse = () => { parses++; throw Error('oversize input reached JSON.parse'); };
    for (const value of [exact + ' ', utf8, escaped, wide, largeKey]) {
      assert(Buffer.byteLength(value) > 16384);
      invalid(() => fair(value, new Map(), joins()));
    }
  } finally { JSON.parse = parse; }
  assert.equal(parses, 0);
});
test('bounded extra fields and large keys refuse after admission without changing valid slots', () => {
  const before = structuredClone(a1);
  for (const value of [JSON.stringify({slots: [a1], ['k'.repeat(8000)]: 0}),
    raw([{...a1, ['k'.repeat(8000)]: 0}]), raw([{...a1, extra: null}]),
    '{"slots":[],"__proto__":{}}']) {
    invalid(() => fair(value, new Map(), joins()));
  }
  assert.deepEqual(a1, before);
});
test('duplicate and escaped alias keys refuse even when JSON.parse would erase them', () => {
  const slot = JSON.stringify(a1);
  for (const value of ['{"slots":[],"slots":[]}', '{"slots":[],"s\\u006cots":[]}',
    `{"slots":[${slot.replace('"acceptanceSeq":1', '"acceptanceSeq":0,"acceptanceSeq":1')}]}`,
    `{"slots":[${slot.replace('"automatic":true', '"automatic":false,"auto\\u006datic":true')}]}`]) {
    invalid(() => fair(value, new Map(), joins()));
  }
  assert.deepEqual(fair('{"s\\u006cots":[' + slot + ']}', new Map(), joins()), [a1.id]);
});
test('numeric source text cannot round, underflow or overwrite into a valid sequence', () => {
  const base = raw([a1]);
  for (const token of ['9007199254740993', '9007199254740991.1', '1.0000000000000001',
    '1e0', '1e-999', '0.0', 'NaN', 'Infinity']) {
    invalid(() => fair(base.replace('"acceptanceSeq":1', `"acceptanceSeq":${token}`), new Map(), joins()));
  }
  invalid(() => fair(base.replace('"acceptanceSeq":1', '"acceptanceSeq":1e-999,"acceptanceSeq":1'), new Map(), joins()));
  assert.deepEqual(fair(base.replace('"acceptanceSeq":1', '"acceptanceSeq":9007199254740991'), new Map(), joins()), [a1.id]);
});
test('shared depth and node admission refuses bounded raw structures', () => {
  for (const extra of ['['.repeat(25) + '0' + ']'.repeat(25), '[' + '0,'.repeat(4096) + '0]']) {
    const value = '{"slots":[],"extra":' + extra + '}';
    assert(Buffer.byteLength(value) < 16384);
    invalid(() => fair(value, new Map(), joins()));
  }
});
test('preparsed wide objects and arrays refuse before reflection, serialization or hooks', () => {
  let touches = 0;
  const hook = () => { touches++; throw Error('caller hook'); };
  const slot = {...a1}, slots = [slot], wrapper = {slots};
  const getterWrapper = {get slots() { return hook(); }};
  for (let i = 0; i < 20000; i++) { slot[`slotExtra${i}`] = 0; slots[`arrayExtra${i}`] = 0; }
  for (const value of [slot, slots, wrapper]) {
    Object.defineProperty(value, 'toJSON', {get: hook});
    Object.defineProperty(value, Symbol.iterator, {get: hook});
  }
  const originals = [Reflect.ownKeys, Object.keys, Object.getOwnPropertyDescriptor, Object.getPrototypeOf, JSON.stringify];
  const forbidden = () => { touches++; throw Error('preparsed reflection'); };
  try {
    Reflect.ownKeys = forbidden; Object.keys = forbidden; Object.getOwnPropertyDescriptor = forbidden;
    Object.getPrototypeOf = forbidden; JSON.stringify = forbidden;
    for (const value of [slot, slots, wrapper, getterWrapper]) invalid(() => fair(value, new Map(), joins()));
  } finally {
    [Reflect.ownKeys, Object.keys, Object.getOwnPropertyDescriptor, Object.getPrototypeOf, JSON.stringify] = originals;
  }
  assert.equal(touches, 0);
});
