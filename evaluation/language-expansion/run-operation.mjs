// EVALUATION BRANCH ONLY. Never merge this entry/configuration into main.
// Every path ends nonzero. A transport probe imports no provider/API code.
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPacedEmitter} from './paced-emitter.mjs';

const directory = new URL('./', import.meta.url);
const read = async name => JSON.parse(await fs.readFile(new URL(name, directory), 'utf8'));

async function main() {
  if (process.env.VERCEL !== '1' || process.env.VERCEL_ENV !== 'production'
      || process.env.VERCEL_GIT_COMMIT_REF !== 'codex/language-expansion-evaluation-20261022'
      || !/^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA ?? '')
      || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('evaluation_environment_required');
  const config = await read('current-operation.json');
  if (config.version !== 1) throw new Error('unknown_evaluation_configuration');
  // Keep complete stdout below Vercel's 4 MB build-log cap, leaving room for
  // installation/platform messages. The same exact emitter serves both paths.
  const emit = createPacedEmitter({maxStreamBytes: 2_600_000});
  if (config.kind === 'transport') {
    const {probeFixture} = await import('./probe.mjs');
    const {records, expected} = await probeFixture({commonPath:fileURLToPath(new URL('../../scripts/language-expansion/common.mjs',directory)),cases:1,payloadBytes:1_048_576});
    if (expected.stdoutBytes > 2_600_000) throw new Error('probe_exceeds_log_budget');
    for (const record of records) await emit(record);
    return;
  }
  if (config.kind !== 'standard' || config.build?.operation !== 'standard') throw new Error('unsupported_evaluation_operation');
  const manifest = JSON.parse(await fs.readFile(config.build.manifestPath,'utf8'));
  if (manifest.transport !== 'standard' || manifest.jobs?.length !== 1) throw new Error('one_remote_standard_case_required');
  const {payloadEvents,MAX_PAYLOAD} = await import('../../scripts/language-expansion/common.mjs');
  const {baseEvent} = await import('../../scripts/language-expansion/journal.mjs');
  const base = baseEvent(manifest,manifest.jobs[0]);
  const fullSize = {text:'x'.repeat(MAX_PAYLOAD-Buffer.byteLength(JSON.stringify({text:''})))};
  const prospective = payloadEvents(base,fullSize);
  const maximumBytes = prospective.reduce((sum,event)=>sum+Buffer.byteLength(JSON.stringify(event))+1,0)
    + Buffer.byteLength(JSON.stringify({...base,event:'language_expansion_submitting'}))+1+2*1901;
  if (maximumBytes > 2_600_000) throw new Error('one_case_exceeds_log_budget');
  const {runLanguageExpansionBuild} = await import('../../scripts/language-expansion-build.mjs');
  await runLanguageExpansionBuild(config.build,{emit,fetchFn:globalThis.fetch});
}

main().catch(() => {
  // No raw exception, credential or provider body is emitted outside the
  // reviewed structured protocol. Earlier complete records remain recoverable.
  process.stderr.write('evaluation_only_operation_failed; reconcile exact deployment before further work\n');
}).finally(() => { process.exitCode = 1; });
