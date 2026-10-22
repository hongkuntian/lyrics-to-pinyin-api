import {createHash} from 'node:crypto';
import {hash, fail, integer, MAX_PAYLOAD} from './common.mjs';
import {batchInput} from './plan.mjs';
import {BATCH_RETRIEVAL, coverageHash, fileProjection, validateFileReceipt, rowDescriptor} from './batch-files.mjs';
import {responseResult} from './transport.mjs';

export const terminalBatch = status => ['completed', 'expired', 'cancelled', 'failed'].includes(status);
export function terminalIdentity(manifest, value) {
  const {batchID, inputFileID, outputFileID = null, errorFileID = null, status, requestCounts} = value;
  if (manifest.transport !== 'batch' || !terminalBatch(status) || !/^batch_[A-Za-z0-9_-]{1,114}$/.test(batchID ?? '') ||
      !/^file-[A-Za-z0-9_-]{1,115}$/.test(inputFileID ?? '') ||
      [outputFileID, errorFileID].some(id => id !== null && (!/^file-[A-Za-z0-9_-]{1,115}$/.test(id) || id === inputFileID)) ||
      (outputFileID && outputFileID === errorFileID)) fail('terminal_batch_identity_required');
  if (!requestCounts || Object.keys(requestCounts).sort().join() !== 'completed,failed,total' ||
      !Object.values(requestCounts).every(integer) || requestCounts.total !== manifest.jobs.length ||
      requestCounts.completed + requestCounts.failed > requestCounts.total) fail('invalid_batch_request_counts');
  if (['planHash', 'shardHash', 'inputHash'].some(k => value[k] !== undefined && value[k] !== ({planHash: manifest.planHash, shardHash: hash(manifest), inputHash: hash(batchInput(manifest))})[k])) fail('batch_identity_changed');
  return {planHash: manifest.planHash, shardHash: hash(manifest), inputHash: hash(batchInput(manifest)),
    batchID, inputFileID, outputFileID, errorFileID, status,
    requestCounts: {total: requestCounts.total, completed: requestCounts.completed, failed: requestCounts.failed}};
}
export function scanReceipt(identity, files, rows) {
  if (rows.length !== identity.requestCounts.total) fail('missing_batch_cases_hold_unknown');
  const completed = rows.filter(r => r.completed).length;
  if (completed !== identity.requestCounts.completed || rows.length - completed !== identity.requestCounts.failed) fail('invalid_batch_request_counts');
  return {version: BATCH_RETRIEVAL.version, identityHash: hash(identity), files: files.map(fileProjection),
    rowCoverageHash: coverageHash(rows), rowCount: rows.length};
}
export function verifyBatchResult(plan, job, result, row) {
  const expected = responseResult(plan, job, row.response?.body ?? null, 'batch',
    row.error != null ? 'batch_case_error' : row.response?.status_code !== 200 ? 'batch_http_error' : null);
  Object.assign(expected, {fileID: result.fileID, role: result.role, lineIndex: result.lineIndex,
    rawLine: result.rawLine, filePayloadHash: result.filePayloadHash});
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PAYLOAD || hash(expected) !== hash(result)) fail('retained_batch_result_changed');
}
// Local-only finalization. Hash one retained row at a time, never join files.
// This same production-parser/accounting reconstruction runs on every replay.
export function reconciliationFor(manifest, terminal, fileReceipts, results, scans, plan) {
  const identity = terminalIdentity(manifest, terminal);
  if (!scans?.length || !plan) fail('complete_batch_scan_required');
  const files = [], rows = [], used = new Set();
  for (const [role, fileID] of [['output', identity.outputFileID], ['error', identity.errorFileID]]) {
    const matches = fileReceipts.filter(r => r.role === role);
    if (!fileID) { if (matches.length) fail('unexpected_batch_file'); continue; }
    if (!matches.length || matches.some(r => r.fileID !== fileID || r.identityHash !== hash(identity) ||
        r.version !== BATCH_RETRIEVAL.version || hash(fileProjection(r)) !== hash(fileProjection(matches[0])))) fail('batch_file_changed');
    const receipt = fileProjection(matches[0]); validateFileReceipt(receipt);
    const index = new Map();
    for (const job of manifest.jobs) {
      const r = results[job.id];
      if (!r || r.fileID !== fileID || r.role !== role) continue;
      if (!integer(r.lineIndex) || index.has(r.lineIndex) || r.filePayloadHash !== receipt.payloadHash) fail('conflicting_result_identity');
      index.set(r.lineIndex, job);
    }
    if (index.size !== receipt.count) fail('incomplete_batch_row_coverage');
    const hasher = createHash('sha256'), fileRows = []; let bytes = 0;
    for (let i = 0; i < receipt.count; i++) {
      const job = index.get(i), r = results[job?.id];
      if (!job || typeof r.rawLine !== 'string' || Buffer.byteLength(r.rawLine) > BATCH_RETRIEVAL.lineBytes || /\n/.test(r.rawLine)) fail('incomplete_batch_row_coverage');
      const row = JSON.parse(r.rawLine), descriptor = rowDescriptor(manifest, row, {role, fileID, lineIndex: i, rawLine: r.rawLine});
      if (descriptor.caseID !== job.id || used.has(job.id)) fail('duplicate_or_unknown_batch_case');
      verifyBatchResult(plan, job, r, row);
      used.add(job.id); rows.push(descriptor); fileRows.push(descriptor);
      hasher.update(r.rawLine); bytes += Buffer.byteLength(r.rawLine);
      if (i + 1 < receipt.count || receipt.finalNewline) { hasher.update('\n'); bytes++; }
    }
    if (bytes !== receipt.bytes || hasher.digest('hex') !== receipt.payloadHash || coverageHash(fileRows) !== receipt.coverageHash) fail('corrupt_retained_file');
    files.push(receipt);
  }
  if (files.reduce((sum, f) => sum + f.bytes, 0) > BATCH_RETRIEVAL.combinedBytes) fail('retrieval_operation_limit');
  if (used.size !== manifest.jobs.length) fail('missing_batch_cases_hold_unknown');
  const expected = scanReceipt(identity, files, rows);
  if (scans.some(r => hash(scanProjection(r)) !== hash(expected))) fail('batch_scan_changed');
  return {version: BATCH_RETRIEVAL.version, ...identity, files, rowCoverageHash: expected.rowCoverageHash, rowCount: rows.length};
}
export const scanProjection = r => ({version: r.version, identityHash: r.identityHash, files: r.files,
  rowCoverageHash: r.rowCoverageHash, rowCount: r.rowCount});
