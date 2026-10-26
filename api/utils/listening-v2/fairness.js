import {types} from 'node:util';

const {isMap, isProxy} = types;
const mapGet = Function.prototype.call.bind(Map.prototype.get);
const mapHas = Function.prototype.call.bind(Map.prototype.has);
const slotFields = ['id', 'contributorID', 'acceptanceSeq', 'automatic'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => { throw new TypeError('Invalid fairness input'); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === 'string' && value.length === 36 && uuidPattern.test(value);

function dataProperty(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

function copySlots(slots) {
  // Reject proxies before any reflection, including revoked proxies. Read only
  // own data descriptors: caller iterators, accessors and coercions never run.
  if (isProxy(slots) || !Array.isArray(slots) || Object.getPrototypeOf(slots) !== Array.prototype) invalid();
  const length = dataProperty(slots, 'length');
  if (length > 100 || Reflect.ownKeys(slots).length !== length + 1) invalid();
  const copied = [], ids = new Set(), sequences = new Set(), contributors = new Map();
  for (let i = 0; i < length; i++) {
    const slot = dataProperty(slots, i);
    if (slot === null || typeof slot !== 'object' || isProxy(slot)) invalid();
    const prototype = Object.getPrototypeOf(slot);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    if (Reflect.ownKeys(slot).length !== slotFields.length) invalid();
    const id = dataProperty(slot, 'id');
    const contributorID = dataProperty(slot, 'contributorID');
    const acceptanceSeq = dataProperty(slot, 'acceptanceSeq');
    const automatic = dataProperty(slot, 'automatic');
    if (!uuid(id) || !uuid(contributorID) || !integer(acceptanceSeq) || typeof automatic !== 'boolean') invalid();
    const identity = id.toLowerCase();
    if (ids.has(identity) || sequences.has(acceptanceSeq)) invalid();
    const contributorIdentity = contributorID.toLowerCase();
    if (contributors.has(contributorIdentity) && contributors.get(contributorIdentity) !== contributorID) invalid();
    ids.add(identity); sequences.add(acceptanceSeq);
    contributors.set(contributorIdentity, contributorID);
    copied.push({id, contributorID, acceptanceSeq, automatic});
  }
  return copied;
}

/** Pure upcoming-only implementation of the approved fair(slots, turns, joins).
 * Maps are trusted server-domain snapshots, read without calling their methods.
 * Keys exactly match contributor UUID strings; missing observed counts mean zero.
 * Returns a frozen array of original occurrence UUID strings. See the fairness
 * design note for the upstream observation, pinning and toggle responsibilities.
 */
export function fair(slots, observedTurns, firstJoinOrdinals) {
  if (isProxy(observedTurns) || !isMap(observedTurns) ||
      isProxy(firstJoinOrdinals) || !isMap(firstJoinOrdinals)) invalid();
  const copied = copySlots(slots);
  const automatic = copied.filter(slot => slot.automatic).sort((a, b) => a.acceptanceSeq - b.acceptanceSeq);
  const contributors = new Map(), ranked = [];
  let consultedTurns = 0;
  for (const slot of automatic) {
    const who = slot.contributorID;
    let contributor = contributors.get(who);
    if (!contributor) {
      const turns = mapHas(observedTurns, who) ? mapGet(observedTurns, who) : 0;
      const firstJoin = mapGet(firstJoinOrdinals, who);
      if (!integer(turns) || turns > 512 || !integer(firstJoin)) invalid();
      consultedTurns += turns;
      if (consultedTurns > 512) invalid();
      contributor = {turns, firstJoin, pending: 0};
      contributors.set(who, contributor);
    }
    contributor.pending++;
    ranked.push({slot, projectedTurns: contributor.turns + contributor.pending, firstJoin: contributor.firstJoin});
  }
  ranked.sort((a, b) => a.projectedTurns - b.projectedTurns || a.firstJoin - b.firstJoin ||
    a.slot.acceptanceSeq - b.slot.acceptanceSeq);
  let next = 0;
  return Object.freeze(copied.map(slot => slot.automatic ? ranked[next++].slot.id : slot.id));
}
