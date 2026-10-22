// Zero-call probe. Imports common serialization only; no provider/environment,
// fetch, credentials, journal, admission, deploy, API, or build preflight import.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPacedEmitter, PACE_MS} from './paced-emitter.mjs';
import {multisetHash} from './collector.mjs';
export async function probeFixture({commonPath, cases = 1, payloadBytes = 1048576}) {
  if (!Number.isSafeInteger(cases) || cases < 1 || cases > 4 || !Number.isSafeInteger(payloadBytes) || payloadBytes < 32 || payloadBytes > 1048576) throw new Error('invalid_probe_size');
  const {payloadEvents, hash, SCHEMA} = await import(pathToFileURL(path.resolve(commonPath)));
  const value = {text: 'x'.repeat(payloadBytes - Buffer.byteLength(JSON.stringify({text: ''})))};
  const bases = Array.from({length: cases}, (_, i) => ({schema: SCHEMA, planHash: hash('transport-probe-plan'),
    shardHash: hash('transport-probe-shard'), caseID: 'c'.repeat(80) + '--translated--zh-Hans--zh-Hans--confirmation--' + 'n'.repeat(79) + i, bodyHash: hash('transport-probe-body-' + i),
    definitionHash: hash('transport-probe-definition-' + i), reservedMicros: 0, transport: 'standard'}));
  const body = bases.flatMap(base => [{...base, event: 'language_expansion_submitting'}, ...payloadEvents(base, value)]);
  const bodyMultisetHash = multisetHash(body), probeID = hash({bases, payloadBytes, bodyMultisetHash});
  const records = [{event: 'language_expansion_transport_start', probeID, cases, payloadBytes, paceMs: PACE_MS, providerCalls: 0},
    ...body, {event: 'language_expansion_transport_terminal', probeID, bodyRecords: body.length,
      bodyMultisetHash, providerCalls: 0, intentionalBuildFailure: true}];
  return {records, expected: {probeID, cases, payloadBytes, bases, payloadHash: hash(JSON.stringify(value)),
    records: records.length, bodyRecords: body.length, bodyMultisetHash, recordsMultisetHash: multisetHash(records),
    stdoutBytes: records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)) + 1, 0),
    maxRecordBytes: Math.max(...records.map(r => Buffer.byteLength(JSON.stringify(r)))),
    nominalPacingMs: records.length * PACE_MS, providerCalls: 0}};
}
export async function verifyProbe({records, expected, commonPath}) {
  const {recoverPayload, hash} = await import(pathToFileURL(path.resolve(commonPath)));
  if (records.length !== expected.records || multisetHash(records) !== expected.recordsMultisetHash) throw new Error('probe_records_missing_altered_or_duplicate');
  for (const base of expected.bases) {
    const value = recoverPayload(records, base);
    if (Buffer.byteLength(JSON.stringify(value)) !== expected.payloadBytes || hash(JSON.stringify(value)) !== expected.payloadHash) throw new Error('probe_payload_changed');
  }
  return {probeID: expected.probeID, records: records.length, payloads: expected.cases,
    recordsMultisetHash: multisetHash(records), providerCalls: 0};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (async () => {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--manifest-only') options.manifestOnly = true;
      else if (['--common', '--cases', '--payload-bytes'].includes(args[i]) && args[i + 1]) options[args[i++].slice(2)] = args[i];
      else throw new Error('invalid_probe_arguments');
    }
    if (!options.common) throw new Error('explicit_common_path_required');
    const {records, expected} = await probeFixture({commonPath: options.common,
      cases: options.cases === undefined ? 1 : Number(options.cases), payloadBytes: options['payload-bytes'] === undefined ? 1048576 : Number(options['payload-bytes'])});
    if (options.manifestOnly) { process.stdout.write(JSON.stringify(expected) + '\n'); return; }
    if (expected.cases !== 1) throw new Error('single_case_remote_probe_required');
    const emit = createPacedEmitter({maxStreamBytes: 2_600_000});
    for (const record of records) await emit(record);
    process.exitCode = 1; // Intentional ERROR after terminal; allow stdout flush.
  })().catch(error => { process.stderr.write('transport_probe_failed:' + error.message + '\n'); process.exitCode = 1; });
}
