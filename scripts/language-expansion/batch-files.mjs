// Complete-file retrieval is independent of the unchanged per-case payload cap.
import {createHash} from 'node:crypto';
import {hash, fail, integer, MAX_PAYLOAD, recoverPayload} from './common.mjs';

export const BATCH_RETRIEVAL = Object.freeze({version: 'batch-files-1', maxCases: 32,
  fileBytes: 67_108_864, combinedBytes: 67_108_864, lineBytes: MAX_PAYLOAD, chunkBytes: 65_536,
  inputBytes: MAX_PAYLOAD, selectedCasesPerRead: 1});
const hashOK = x => /^[a-f0-9]{64}$/.test(x ?? '');
export const coverageHash = rows => hash([...rows].sort((a, b) => a.caseID < b.caseID ? -1 : a.caseID > b.caseID ? 1 : 0));
export const fileProjection = f => ({role: f.role, fileID: f.fileID, bytes: f.bytes, payloadHash: f.payloadHash,
  count: f.count, finalNewline: f.finalNewline, coverageHash: f.coverageHash});
export function validateFileReceipt(f) {
  if (!['output', 'error'].includes(f.role) || !/^file-[A-Za-z0-9_-]{1,115}$/.test(f.fileID ?? '') ||
      !integer(f.bytes) || f.bytes > BATCH_RETRIEVAL.fileBytes || !integer(f.count) || f.count > BATCH_RETRIEVAL.maxCases ||
      typeof f.finalNewline !== 'boolean' || !hashOK(f.payloadHash) || !hashOK(f.coverageHash) ||
      (!f.count && (f.bytes !== 0 || f.finalNewline || f.payloadHash !== hash('') || f.coverageHash !== coverageHash([])))) fail('invalid_file_receipt');
}
export function rowDescriptor(manifest, row, {role, fileID, lineIndex, rawLine}) {
  const job = manifest.jobs.find(j => j.id === row?.custom_id);
  if (!row || typeof row !== 'object' || Array.isArray(row) || !job) fail('duplicate_or_unknown_batch_case');
  if ((row.error == null && (!row.response || !integer(row.response.status_code))) ||
      (row.error != null && (typeof row.error !== 'object' || Array.isArray(row.error)))) fail('malformed_batch_row');
  return {caseID: job.id, definitionHash: job.definitionHash, bodyHash: job.bodyHash, role, fileID,
    lineIndex, rawLineHash: hash(rawLine), completed: row.error == null && row.response?.status_code === 200};
}
export async function scanFile({stream, role, fileID, manifest, seen, budget, selectedCaseID}) {
  const buffer = Buffer.alloc(BATCH_RETRIEVAL.lineBytes), hasher = createHash('sha256');
  // Preserve a BOM rather than silently stripping it into admissible JSON.
  const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  let used = 0, bytes = 0, count = 0, lastByte = null, selected = null;
  const rows = [];
  const consume = () => {
    if (!used) fail('blank_batch_row');
    const rawLine = decoder.decode(buffer.subarray(0, used));
    let row; try { row = JSON.parse(rawLine); } catch { fail('malformed_or_truncated_batch_row'); }
    const descriptor = rowDescriptor(manifest, row, {role, fileID, lineIndex: count, rawLine});
    if (seen.has(descriptor.caseID)) fail('duplicate_or_unknown_batch_case');
    seen.add(descriptor.caseID); rows.push(descriptor);
    if (descriptor.caseID === selectedCaseID) selected = {row, rawLine, descriptor};
    count++; used = 0;
  };
  for await (const value of stream) {
    if (!(value instanceof Uint8Array)) fail('non_byte_batch_chunk');
    if (value.byteLength > BATCH_RETRIEVAL.chunkBytes) fail('batch_source_chunk_limit');
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    bytes += chunk.length; budget.bytes += chunk.length;
    if (bytes > BATCH_RETRIEVAL.fileBytes || budget.bytes > BATCH_RETRIEVAL.combinedBytes) fail('retrieval_operation_limit');
    hasher.update(chunk); if (chunk.length) lastByte = chunk.at(-1);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      if (used + end - start > buffer.length) fail('batch_line_limit');
      chunk.copy(buffer, used, start, end); used += end - start;
      if (newline >= 0) consume();
      start = newline < 0 ? chunk.length : newline + 1;
    }
  }
  if (used) consume();
  return {receipt: {role, fileID, bytes, payloadHash: hasher.digest('hex'), count,
    finalNewline: lastByte === 10, coverageHash: coverageHash(rows)}, rows, selected};
}

// Native fetch is explicitly adapted. BYOB bounds allocation when supported;
// fallback readers reject an oversize chunk before copying. Failure/early return
// cancels the actual reader and releases its lock; no assumed HTTP chunk size.
export async function* boundedFetchStream(body) {
  if (!body || typeof body.getReader !== 'function') fail('byte_stream_reader_required');
  let reader, byob = false, complete = false;
  try { reader = body.getReader({mode: 'byob'}); byob = true; }
  catch (error) { if (!(error instanceof TypeError)) throw error; reader = body.getReader(); }
  try {
    while (true) {
      const {done, value} = await (byob ? reader.read(new Uint8Array(BATCH_RETRIEVAL.chunkBytes)) : reader.read());
      if (value !== undefined) {
        if (!(value instanceof Uint8Array)) fail('non_byte_batch_chunk');
        if (value.byteLength > BATCH_RETRIEVAL.chunkBytes) fail('batch_source_chunk_limit');
        if (value.byteLength) yield value;
      }
      if (done) { complete = true; break; }
    }
  } finally {
    try { if (!complete) await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

// A full, privately staged replay is required. This helper does not deduplicate
// incoming logs and is never used by direct journal import.
export function freshPayloadRecords(existing, incoming, base) {
  if (!incoming.length || incoming.some(e => !['language_expansion_chunk', 'language_expansion_complete'].includes(e.event) ||
      ['planHash', 'shardHash', 'caseID', 'bodyHash', 'definitionHash'].some(k => e[k] !== base[k]))) fail('single_complete_staged_payload_required');
  recoverPayload(incoming, base);
  const key = e => `${e.event}:${e.event === 'language_expansion_chunk' ? e.index : 'complete'}`;
  const prior = new Map();
  for (const e of existing.filter(e => ['language_expansion_chunk', 'language_expansion_complete'].includes(e.event) &&
    ['planHash', 'shardHash', 'caseID', 'bodyHash', 'definitionHash'].every(k => e[k] === base[k]))) {
    if (prior.has(key(e))) fail('duplicate_retained_payload_record');
    prior.set(key(e), e);
  }
  const received = new Map(incoming.map(e => [key(e), e]));
  for (const [k, e] of prior) if (!received.has(k) || hash(received.get(k)) !== hash(e)) fail('conflicting_retained_payload_record');
  return incoming.filter(e => !prior.has(key(e)));
}
