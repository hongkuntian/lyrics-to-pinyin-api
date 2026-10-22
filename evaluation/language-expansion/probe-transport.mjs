// Evaluation-only zero-call transport proof. No provider, database or packaging
// imports. This file and branch's vercel.json must never be merged into main.
import {createHash} from 'node:crypto';
import {once} from 'node:events';

const emit = async value => {
  if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain');
};
const count = 1200, data = 'original transport fixture; '.repeat(80).slice(0, 2000);
const digest = createHash('sha256');
await emit({event: 'language_expansion_transport_start', version: 1, count,
  commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  node: process.version, vercel: process.env.VERCEL === '1',
  environment: process.env.VERCEL_ENV ?? null,
  providerKeyPresent: Boolean(process.env.OPENAI_API_KEY), providerCalls: 0});
for (let index = 0; index < count; index++) {
  const record = {event: 'language_expansion_transport_chunk', index, data};
  digest.update(JSON.stringify(record) + '\n', 'utf8');
  await emit(record);
}
await emit({event: 'language_expansion_transport_terminal', count,
  sha256: digest.digest('hex'), providerCalls: 0, intentionalBuildFailure: true});
process.exitCode = 1; // Flush stdout; never create a successful deployment.
