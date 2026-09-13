import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parse as parseEnv} from 'dotenv';
import {probe, providerNames} from './compare.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const providers = arg('--providers', providerNames.join(',')).split(',');
if (providers.some(p => !providerNames.includes(p))) throw new Error('Unknown provider');
const cases = JSON.parse(await fs.readFile(new URL('./cases.json', import.meta.url)));
const selected = arg('--cases', '').split(',').filter(Boolean);
if (selected.some(id => !cases.some(c => c.id === id))) throw new Error('Unknown case');
const tracks = cases.filter(c => !selected.length || selected.includes(c.id));
const output = arg('--output', `tmp/provider-experiment/run-${Date.now()}.json`);
const envFile = arg('--env-file', '.env.local');
let localEnv = {};
try { localEnv = parseEnv(await fs.readFile(envFile)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const env = {...localEnv, ...process.env};
const budgets = Object.fromEntries(providers.map(p => [p, {remaining: p.startsWith('musixmatch') || p === 'musicae' ? 5 : 40}]));
const report = {schemaVersion: 1, startedAt: new Date().toISOString(),
  notice: 'Single-pass exploratory evidence. Text equality is not audio alignment or proof of source independence.',
  cases: tracks, results: []};
await fs.mkdir(path.dirname(output), {recursive: true});
for (const track of tracks) {
  // Sequential provider requests keep upstream load and free-tier usage bounded.
  for (const provider of providers) {
    if (provider === 'musicbrainz') await delay(1100);
    const result = await probe(provider, track, {env, budget: budgets[provider]});
    const row = {caseId: track.id, provider, ...result};
    report.results.push(row);
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify({caseId: track.id, provider, status: row.status,
      verdict: row.verdict, reason: row.reason, ms: row.elapsedMs}));
  }
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
console.log(`Saved ${report.results.length} observations to ${output}`);
