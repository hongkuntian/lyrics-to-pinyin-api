import {hash, fail, integer, MAX_PAYLOAD} from './common.mjs';

export const terminalBatch = status => ['completed', 'expired', 'cancelled', 'failed'].includes(status);
const receiptKeys = ['role', 'fileID', 'bytes', 'payloadHash', 'count', 'finalNewline'];
// Called both before emission and during journal replay. A settled case alone
// never establishes that a terminal Batch's second file was fully retrieved.
export function reconciliationFor(manifest, identity, receipts, results) {
  const {batchID, inputFileID, outputFileID = null, errorFileID = null, status, requestCounts} = identity;
  if (manifest.transport !== 'batch' || !terminalBatch(status) || !/^batch_[A-Za-z0-9_-]+$/.test(batchID ?? '') ||
      !/^file-[A-Za-z0-9_-]+$/.test(inputFileID ?? '') ||
      [outputFileID, errorFileID].some(id => id !== null && !/^file-[A-Za-z0-9_-]+$/.test(id)) ||
      (outputFileID && outputFileID === errorFileID)) fail('terminal_batch_identity_required');
  const files = [], rows = [];
  for (const [role, fileID] of [['output', outputFileID], ['error', errorFileID]]) {
    const matches = receipts.filter(r => r.role === role);
    if (!fileID) { if (matches.length) fail('unexpected_batch_file'); continue; }
    if (!matches.length || matches.some(r => r.fileID !== fileID)) fail('incomplete_batch_files');
    const receipt = Object.fromEntries(receiptKeys.map(k => [k, matches.at(-1)[k]]));
    if (matches.some(r => receiptKeys.some(k => r[k] !== receipt[k]))) fail('batch_file_changed');
    const lines = manifest.jobs.map(j => results[j.id]).filter(r => r?.fileID === fileID && r.role === role).sort((a, b) => a.lineIndex - b.lineIndex);
    if (lines.length !== receipt.count || lines.some((r, i) => r.lineIndex !== i || typeof r.rawLine !== 'string')) fail('incomplete_batch_row_coverage');
    const raw = lines.map(r => r.rawLine).join('\n') + (receipt.finalNewline ? '\n' : '');
    if (Buffer.byteLength(raw) !== receipt.bytes || hash(raw) !== receipt.payloadHash) fail('corrupt_retained_file');
    for (const result of lines) {
      const row = JSON.parse(result.rawLine), job = manifest.jobs.find(j => j.id === row.custom_id);
      if (!job || result.id !== job.id || result.definitionHash !== job.definitionHash || result.bodyHash !== job.bodyHash ||
          rows.some(r => r.caseID === job.id)) fail('duplicate_or_unknown_batch_case');
      rows.push({caseID: job.id, definitionHash: job.definitionHash, bodyHash: job.bodyHash, role, fileID,
        lineIndex: result.lineIndex, rawLineHash: hash(result.rawLine), completed: !row.error && row.response?.status_code === 200});
    }
    files.push(receipt);
  }
  if (files.reduce((sum, f) => sum + f.bytes, 0) > MAX_PAYLOAD) fail('retrieval_operation_limit');
  if (rows.length !== manifest.jobs.length) fail('missing_batch_cases_hold_unknown');
  const completed = rows.filter(r => r.completed).length;
  if (!requestCounts || !['total', 'completed', 'failed'].every(k => integer(requestCounts[k])) ||
      Object.keys(requestCounts).sort().join() !== 'completed,failed,total' || requestCounts.total !== rows.length ||
      requestCounts.completed !== completed || requestCounts.failed !== rows.length - completed) fail('invalid_batch_request_counts');
  return {batchID, inputFileID, outputFileID, errorFileID, status, requestCounts, files,
    rowCoverageHash: hash(rows.sort((a, b) => a.caseID.localeCompare(b.caseID))), rowCount: rows.length};
}
