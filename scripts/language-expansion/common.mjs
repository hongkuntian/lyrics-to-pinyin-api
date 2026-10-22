import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const ROOT = new URL('../../', import.meta.url);
export const SCHEMA = 'language-expansion-1';
export const MAX_PAYLOAD = 1_048_576;
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const fail = message => { throw new Error(message); };
export const integer = n => Number.isSafeInteger(n) && n >= 0;
export const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export async function save(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  await fs.writeFile(file, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
}
// Include added/removed files, not just hashes of a caller-provided subset.
export async function codeHashes() {
  const files = ['scripts/evaluate-language-expansion.mjs', 'scripts/language-expansion-build.mjs', 'scripts/evaluate-content-quality.mjs',
    'api/utils/lyric-annotations.js', 'api/utils/lyric-selection.js', 'api/utils/vocal-timing.js', 'api/utils/rejected-lyrics.js',
    'api/data/lyric-performers.json', 'api/data/rejected-lyrics.json', 'package.json', 'package-lock.json'];
  for (const dir of ['scripts/language-expansion', 'api/utils/song-library']) {
    for (const name of (await fs.readdir(new URL(dir + '/', ROOT))).sort()) {
      if (/\.(mjs|js|json)$/.test(name)) files.push(dir + '/' + name);
    }
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, hash(await fs.readFile(new URL(file, ROOT)))])));
}
export function emitRecord(sink, value) {
  if (!/^language_expansion_[a-z_]+$/.test(value.event ?? '') || Buffer.byteLength(JSON.stringify(value)) > 16_384) fail('invalid_event_record');
  return sink(value);
}
export function boundedSink(sink, secret) {
  let bytes = 0;
  return value => {
    const json = JSON.stringify(value);
    if (secret && json.includes(secret)) fail('provider_echoed_credentials');
    bytes += Buffer.byteLength(json) + 1;
    // Leave a whole record for the evaluation-only terminal event.
    if (bytes > 16 * 1024 * 1024 - 16_384) fail('operation_output_limit');
    return sink(value);
  };
}
export function payloadEvents(base, value) {
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length > MAX_PAYLOAD) fail('payload_limit');
  const data = raw.toString('base64'), count = Math.ceil(data.length / 2000);
  const meta = {...base, payloadHash: hash(raw), bytes: raw.length, count};
  return [
    ...Array.from({length: count}, (_, index) => ({...meta, event: 'language_expansion_chunk', index, data: data.slice(index * 2000, (index + 1) * 2000)})),
    {...meta, event: 'language_expansion_complete'}
  ];
}
export function recoverPayload(events, base) {
  const matches = events.filter(e => e.planHash === base.planHash && e.shardHash === base.shardHash && e.caseID === base.caseID && e.bodyHash === base.bodyHash && e.definitionHash === base.definitionHash);
  const ends = matches.filter(e => e.event === 'language_expansion_complete');
  const chunks = matches.filter(e => e.event === 'language_expansion_chunk');
  if (ends.length !== 1) fail('incomplete_or_duplicate_payload');
  const end = ends[0];
  if (!integer(end.bytes) || end.bytes > MAX_PAYLOAD || !integer(end.count) || end.count < 1 || chunks.length !== end.count) fail('incomplete_payload');
  const ordered = new Map();
  for (const chunk of chunks) {
    if (!integer(chunk.index) || chunk.index >= end.count || ordered.has(chunk.index) ||
        ['count', 'bytes', 'payloadHash'].some(k => chunk[k] !== end[k]) ||
        typeof chunk.data !== 'string' || chunk.data.length > 2000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)) fail('corrupt_or_duplicate_chunk');
    ordered.set(chunk.index, chunk.data);
  }
  const encoded = Array.from({length: end.count}, (_, i) => ordered.get(i)).join('');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded || raw.length !== end.bytes || hash(raw) !== end.payloadHash) fail('corrupt_payload');
  return JSON.parse(raw.toString('utf8'));
}
