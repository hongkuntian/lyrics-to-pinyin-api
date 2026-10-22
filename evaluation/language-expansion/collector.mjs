// Offline/dependency-injected research collector. Does not call any MCP itself.
import {createHash} from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const multisetHash = records => sha(JSON.stringify(records.map(r => sha(canonical(r))).sort()));
const stop = (code, details = {}) => { throw Object.assign(new Error(code), {details}); };
const marker = value => typeof value === 'string' ? /(?:\.\.\.|…)\[truncated\]/i.test(value)
  : Array.isArray(value) ? value.some(marker) : value && typeof value === 'object' ? Object.values(value).some(marker) : false;
function eventsOf(raw, eventsFromResult) {
  // readPage MUST preserve ProbeMCP's wrapper. No adapter may silently replace
  // truncated:true with false or discard truncation diagnostics.
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'result')) stop('missing_probe_wrapper');
  // Observed genuine non-truncated MCP form is exactly {result}; diagnostics
  // are present only when truncation occurred. Preserve either raw form.
  const keys = Object.keys(raw), compact = keys.length === 1 && keys[0] === 'result';
  const explicit = typeof raw.truncated === 'boolean' && Object.hasOwn(raw, 'truncation');
  if (!compact && !explicit) stop('missing_probe_wrapper');
  if (explicit && raw.truncated === false && raw.truncation && Object.values(raw.truncation).some(value => value !== 0)) stop('contradictory_truncation_diagnostics');
  if (raw.truncated) stop('truncated_page', {truncation: raw.truncation});
  if (marker(raw.result)) stop('truncation_marker');
  // Optional MCP content decoding runs ONLY after raw retention and wrapper
  // checks. The default matches the saved result.events evidence.
  const events = eventsFromResult(raw.result);
  if (!Array.isArray(events) || events.some(e => !e || typeof e !== 'object' || !Number.isSafeInteger(e.created) ||
      e.created < 0 || typeof e.text !== 'string' || typeof e.type !== 'string' || e.text.length > 2000 ||
      (e.date !== undefined && e.date !== e.created))) stop('invalid_log_page');
  return events;
}

/** Requires a TERMINAL, settled deployment and fixed outer [startMs,endMs].
 * readPage({since,until,limit:20,direction:'forward',follow:0}) resolves
 * {result:{events:[{created,date?,type,text,info?,...}]},truncated, truncation}.
 * If result has an MCP content envelope, eventsFromResult(result) may unwrap it;
 * this callback runs AFTER raw retention and truncation rejection.
 * retainPage({sequence,request,raw}) MUST durably save the raw wrapper before
 * returning, including bad pages. No automatic retries or journal writes.
 * readPage MUST return the FIRST limit events in timestamp-forward order (ties
 * may be unordered). Integer guards cover either endpoint convention. A full
 * page proves only its prefix BEFORE the final timestamp; re-fetch that whole
 * timestamp on the next page. Split windows only on truncation/no progress.
 */
export async function collectLogs({readPage, retainPage, startMs, endMs,
  eventsFromResult = result => result?.events,
  pageLimit = 20, maxPages = 200, maxEvents = 20000, maxBytes = 32 * 1024 * 1024}) {
  if (typeof readPage !== 'function' || typeof retainPage !== 'function' || typeof eventsFromResult !== 'function' ||
      !Number.isSafeInteger(startMs) || startMs < 1 || !Number.isSafeInteger(endMs) || endMs < startMs ||
      endMs >= Number.MAX_SAFE_INTEGER || endMs - startMs > 45 * 60 * 1000 ||
      !Number.isSafeInteger(pageLimit) || pageLimit < 2 || pageLimit > 50 ||
      ![maxPages, maxEvents, maxBytes].every(n => Number.isSafeInteger(n) && n > 0)) stop('invalid_collection_bounds');
  const pending = [[startMs, endMs]], retained = new Map();
  let pages = 0, bytes = 0, count = 0, overlaps = 0;
  function merge(events) {
    // Every merged prefix covers ALL records at each included timestamp.
    // Preserve within-page multiplicity. Across overlapping complete prefixes take
    // the maximum observed multiplicity, never a Set of payload/chunk IDs.
    const local = new Map();
    for (const event of events) {
      if (event.created < startMs || event.created > endMs) continue;
      const key = canonical(event), row = local.get(key);
      if (row) row.count++; else local.set(key, {event, count: 1});
    }
    for (const [key, row] of local) {
      const prior = retained.get(key)?.count ?? 0;
      overlaps += Math.min(prior, row.count);
      if (row.count > prior) {
        const added = row.count - prior;
        count += added; bytes += Buffer.byteLength(key) * added;
        if (count > maxEvents || bytes > maxBytes) stop('collection_output_limit');
        retained.set(key, row);
      }
    }
  }
  while (pending.length) {
    let [lo, hi] = pending.pop();
    while (lo <= hi) {
      if (pages >= maxPages) stop('page_budget_exhausted', {pages, lo, hi});
      const request = {since: lo - 1, until: hi + 1, limit: pageLimit, direction: 'forward', follow: 0};
      const raw = await readPage(request);
      await retainPage({sequence: pages++, request, raw});
      let events, truncated = null;
      try { events = eventsOf(raw, eventsFromResult); }
      catch (error) {
        if (!['truncated_page', 'truncation_marker'].includes(error.message)) throw error;
        truncated = error.message; // Refused raw page: no data from it is merged.
      }
      if (events && (events.length > pageLimit || events.some(e => e.created < request.since || e.created > request.until))) stop('page_contract_changed');
      if (events && events.length < pageLimit) { merge(events); break; }
      const boundary = events ? Math.max(...events.map(e => e.created)) : lo;
      if (events && boundary > lo) {
        merge(events.filter(e => e.created < boundary));
        if (boundary > hi) break; // Whole logical window precedes the guard.
        lo = boundary; // No +1: the full final timestamp was NOT yet accepted.
        continue;
      }
      if (lo === hi) {
        if (truncated) stop('unrecoverable_truncated_timestamp', {timestamp: lo, cause: truncated});
        stop('same_timestamp_overflow_or_saturation', {timestamp: lo, returned: pageLimit,
          atTimestamp: events.filter(e => e.created === lo).length, guardEventsMayContribute: true,
          returnedTimestamps: Object.fromEntries([...new Set(events.map(e => e.created))].map(t => [t, events.filter(e => e.created === t).length]))});
      }
      const mid = lo + Math.floor((hi - lo) / 2);
      pending.push([mid + 1, hi], [lo, mid]);
      break; // Split only a truncated or non-advancing window.
    }
  }
  const logs = [...retained.values()].flatMap(({event, count}) => Array.from({length: count}, () => event))
    .sort((a, b) => a.created - b.created || canonical(a).localeCompare(canonical(b)));
  // Timestamp ties have NO guaranteed source order. Payload recovery is already
  // index-based; Root must validate exact records before journal import.
  return {logs, pages, overlaps, bytes, logMultisetHash: multisetHash(logs)};
}

export function decodeRecords(logs) {
  const records = [];
  for (const log of logs) {
    // Exact pinned direct-entry footer is build noise, not a JSON event. Keep
    // it in raw logs; never generalize this to ignore malformed protocol lines.
    if (log.type === 'stderr' && log.text === 'language_expansion_evaluation_only_build_failed; retain streamed records and reconcile Root journal') continue;
    if (!log.text.includes('language_expansion_')) continue;
    if (marker(log.text) || Buffer.byteLength(log.text) > 1900) stop('invalid_transport_record');
    let record;
    try { record = JSON.parse(log.text); } catch { stop('invalid_transport_json'); }
    if (!/^language_expansion_[a-z_]+$/.test(record.event ?? '')) stop('invalid_transport_event');
    records.push(record);
  }
  return records;
}
