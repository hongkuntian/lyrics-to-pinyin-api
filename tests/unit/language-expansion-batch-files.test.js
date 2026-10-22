import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {hash, payloadEvents, recoverPayload, MAX_PAYLOAD, SCHEMA} from '../../scripts/language-expansion/common.mjs';
import {shard, batchInput} from '../../scripts/language-expansion/plan.mjs';
import {BATCH_RETRIEVAL, scanFile, boundedFetchStream, freshPayloadRecords} from '../../scripts/language-expansion/batch-files.mjs';
import {terminalIdentity, reconciliationFor, verifyBatchResult} from '../../scripts/language-expansion/reconciliation.mjs';
import {retrieveBatch, validateManifest, responseResult, openAIClient} from '../../scripts/language-expansion/transport.mjs';
import {baseEvent, append, claimStart, snapshot, importEvents, finalizeBatch, importReadReplay, admitShard} from '../../scripts/language-expansion/journal.mjs';
import {execute} from '../../scripts/evaluate-language-expansion.mjs';
import {runLanguageExpansionBuild, evaluateLanguageExpansionInBuild} from '../../scripts/language-expansion-build.mjs';
import {planFixture, fakeResponse, batchObject, byteStream, ticketFor, journalFixture, directory} from '../fixtures/language-expansion.mjs';

const chunks = (raw, size = 65_536, end) => (async function* () {
  try { const b = Buffer.from(raw); for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size); }
  finally { end?.(); }
})();
const rowFor = (plan, j, extra = {}) => ({custom_id: j.id, error: null, response: {status_code: 200, body: fakeResponse(plan, j, extra)}});
async function fixture(count = 2, options = {}) {
  const plan = await planFixture(), jobs = plan.jobs.filter(j => j.kind === 'translation').slice(0, count);
  const manifest = shard(plan, jobs.map(j => j.id), {}, 'batch');
  const batch = batchObject(manifest, options.batch);
  const output = options.output ?? jobs.map(j => JSON.stringify(rowFor(plan, j, options.response))).join('\n') + '\n';
  const error = options.error ?? '';
  const client = {inspect: async () => batch, file: async id => chunks(id === 'file-output' ? output : error),
    standard: () => assert.fail('generation forbidden'), upload: () => assert.fail('upload forbidden'), create: () => assert.fail('create forbidden')};
  return {plan, jobs, manifest, batch, output, error, client};
}
async function read(f, index = 0, options = {}) {
  const events = [];
  const value = await retrieveBatch({plan: f.plan, manifest: f.manifest, approvedHash: hash(f.manifest), batchID: f.batch.id,
    inputFileID: f.batch.input_file_id, selectedCaseID: f.jobs[index].id, client: f.client, emit: e => events.push(e), ...options});
  return {value, events, result: recoverPayload(events, baseEvent(f.manifest, f.jobs[index]))};
}
// Seed-complete journals remain subject to the real admission path. All fake
// seed results have production-validated body/source/parser/accounting identity.
async function admitted(t, f) {
  const dir = await journalFixture(t, f.plan, {priorMicros: 137, unknownHeldMicros: 251});
  for (const dependent of [false, true]) {
    const ids = f.plan.seedIDs.filter(id => (f.plan.jobs.find(j => j.id === id).kind === 'translated') === dependent);
    for (let i = 0; i < ids.length; i += 4) {
      const state = await snapshot(dir), m = shard(f.plan, ids.slice(i, i + 4), state.results);
      const ticket = await admitShard({directory: dir, plan: f.plan, manifest: m, executionID: 'seed_' + i + '_' + dependent});
      let k = 0; await execute({directory: dir, plan: f.plan, manifest: m, ticket, operation: 'standard', client: {standard: async () => fakeResponse(f.plan, m.jobs[k++])}});
    }
  }
  // Use nonseed cases for the actual Batch fixture.
  f.jobs = f.plan.jobs.filter(j => j.kind === 'translation' && !f.plan.seedIDs.includes(j.id)).slice(0, f.jobs.length);
  f.manifest = shard(f.plan, f.jobs.map(j => j.id), {}, 'batch'); f.batch = batchObject(f.manifest, {error_file_id: 'file-error'});
  f.output = f.jobs.map(j => JSON.stringify(rowFor(f.plan, j))).join('\n') + '\n'; f.error = '';
  f.client = {inspect: async () => f.batch, file: async id => chunks(id === 'file-output' ? f.output : f.error)};
  const ticket = await admitShard({directory: dir, plan: f.plan, manifest: f.manifest, executionID: 'new_batch', batchAccepted: true, representativeReviewed: true});
  await claimStart(dir, ticket);
  return {dir, ticket};
}

test('32 cases, exact input and versioned retrieval policy are enforced in construction and validation', async () => {
  const f = await fixture(32);
  assert.deepEqual(f.manifest.retrievalPolicy, BATCH_RETRIEVAL); assert.equal(f.manifest.maxRawBytes, MAX_PAYLOAD);
  await validateManifest(f.plan, f.manifest, hash(f.manifest));
  assert.throws(() => shard(f.plan, f.plan.jobs.filter(j => j.body).slice(0, 33).map(j => j.id), {}, 'batch'), /invalid_shard/);
  for (const m of [{...f.manifest, retrievalPolicy: {...BATCH_RETRIEVAL, maxCases: 33}}, {...f.manifest, jobs: [...f.manifest.jobs, f.plan.jobs[1]]}])
    await assert.rejects(validateManifest(f.plan, m, hash(m)), /invalid_batch_retrieval_policy/);
});
test('more than 1MiB file and 4MB aggregate hypothetical results recover by separate selected scans', async () => {
  const f = await fixture(12, {response: {padding: 'x'.repeat(150_000)}, batch: {error_file_id: 'file-error'}});
  assert.ok(Buffer.byteLength(f.output) > MAX_PAYLOAD);
  let logs = 0, firstScan;
  for (let i = 0; i < f.jobs.length; i++) {
    const r = await read(f, i); logs += Buffer.byteLength(r.events.map(JSON.stringify).join('\n'));
    assert.equal(r.result.valid, true); assert.equal(r.result.filePayloadHash, hash(f.output));
    assert.equal(r.events.filter(e => e.event === 'language_expansion_complete').length, 1);
    assert.ok(r.events.findIndex(e => e.event === 'language_expansion_file_scan') < r.events.findIndex(e => e.event === 'language_expansion_chunk'));
    const scan = r.events.find(e => e.event === 'language_expansion_scan');
    if (firstScan) assert.deepEqual(scan, firstScan); else firstScan = scan;
    assert.ok(Buffer.byteLength(r.events.map(JSON.stringify).join('\n')) < 2_600_000);
  }
  assert.ok(logs > 4_000_000);
});
for (const ending of ['\n', '\r\n', '']) test('exact file bytes and Unicode survive byte splits with ending ' + JSON.stringify(ending), async () => {
  const f = await fixture(1); f.output = JSON.stringify(rowFor(f.plan, f.jobs[0], {padding: 'é 🧑🏽‍🎓 e\u0301'})) + ending;
  f.client.file = async () => chunks(f.output, 1);
  const r = await read(f); const file = r.events.find(e => e.event === 'language_expansion_file_scan');
  assert.equal(file.payloadHash, hash(f.output)); assert.equal(file.finalNewline, ending.endsWith('\n'));
  assert.equal(r.result.rawLine.endsWith('\r'), ending === '\r\n');
});
for (const kind of ['blank', 'truncated', 'BOM', 'invalidUTF8', 'foreign', 'duplicate', 'envelope', 'hugeLine', 'oversizeChunk']) test('scanner rejects ' + kind + ' and closes the source', async () => {
  const f = await fixture(1), one = JSON.stringify(rowFor(f.plan, f.jobs[0])); let closed = false;
  const values = {blank: '\n', truncated: one.slice(0, -1), BOM: '\ufeff' + one, invalidUTF8: Buffer.from([0xff,10]),
    foreign: JSON.stringify({custom_id: 'foreign', response: {status_code: 200}}), duplicate: one + '\n' + one,
    envelope: JSON.stringify({custom_id: f.jobs[0].id}), hugeLine: 'x'.repeat(MAX_PAYLOAD + 1), oversizeChunk: one};
  f.client.file = async () => kind === 'oversizeChunk' ? (async function* () { try { yield Buffer.alloc(65_537); } finally { closed = true; } })() : chunks(values[kind], 4096, () => { closed = true; });
  await assert.rejects(read(f)); assert.equal(closed, true);
});
test('duplicate across files and missing rows cannot emit complete scan proof', async () => {
  const f = await fixture(2, {batch: {error_file_id: 'file-error'}});
  f.error = JSON.stringify(rowFor(f.plan, f.jobs[0])) + '\n'; f.client.file = async id => chunks(id === 'file-output' ? f.output : f.error);
  const events = []; await assert.rejects(read(f, 0, {emit: e => events.push(e)}), /duplicate/);
  assert.equal(recoverPayload(events, baseEvent(f.manifest, f.jobs[0])).valid, true);
  assert.equal(events.some(e => e.event === 'language_expansion_scan'), false);
  f.error = ''; f.output = JSON.stringify(rowFor(f.plan, f.jobs[0])) + '\n';
  await assert.rejects(read(f), /missing_batch_cases/);
});
test('actual 64MiB file and combined overflow cancel before accepting excess bytes', async () => {
  // Raw bound probes deliberately bypass admission; 66 known rows are rejected
  // by the public 32-case policy. The admitted envelope cannot reach 64MiB with
  // 32 <=1MiB lines, but the byte limiter is independently exercised here.
  const jobs = Array.from({length: 66}, (_, i) => ({id: 'bound' + i, definitionHash: hash('d'+i), bodyHash: hash('b'+i)}));
  const manifest = {jobs}; const size = MAX_PAYLOAD - 1;
  const text = j => { const p = JSON.stringify({custom_id: j.id, response: {status_code: 200}, padding: ''}); return p.slice(0,-2) + 'x'.repeat(size - Buffer.byteLength(p)) + p.slice(-2) + '\n'; };
  let closed = false;
  const stream = list => (async function* () { try { for (const j of list) yield* chunks(text(j)); } finally { closed = true; } })();
  await assert.rejects(scanFile({manifest, stream: stream(jobs), role: 'output', fileID: 'file-bound', seen: new Set(), budget: {bytes: 0}}), /retrieval_operation_limit/);
  assert.equal(closed, true);
  const seen = new Set(), budget = {bytes: 0};
  await scanFile({manifest, stream: stream(jobs.slice(0,33)), role: 'output', fileID: 'file-one', seen, budget});
  await assert.rejects(scanFile({manifest, stream: stream(jobs.slice(33)), role: 'error', fileID: 'file-two', seen, budget}), /retrieval_operation_limit/);
});
test('inherited full-result overflow remains STOP after file pin without scan or cap change', async () => {
  const f = await fixture(1, {response: {padding: 'x'.repeat(600_000)}}), events = [];
  await assert.rejects(read(f, 0, {emit: e => events.push(e)}), /payload_limit/);
  assert.ok(events.some(e => e.event === 'language_expansion_file_scan'));
  assert.equal(events.some(e => ['language_expansion_complete','language_expansion_scan'].includes(e.event)), false);
  assert.equal(MAX_PAYLOAD, 1_048_576);
});
test('second-file interruption preserves selected result and partial pin; changed unrelated row refuses recovery', async () => {
  const f = await fixture(2, {batch: {error_file_id: 'file-error'}}), events = [];
  f.client.file = async id => { if (id === 'file-error') throw Error('interrupted'); return chunks(f.output); };
  await assert.rejects(read(f, 0, {emit: e => events.push(e)}), /interrupted/);
  const result = recoverPayload(events, baseEvent(f.manifest, f.jobs[0])); assert.equal(result.valid, true);
  const pins = events.filter(e => e.event === 'language_expansion_file_scan');
  const expectedIdentity = events.find(e => e.event === 'language_expansion_control');
  f.output = f.output.replace(f.jobs[1].id, f.jobs[1].id).replace('"error":null', '"error": null');
  let reads = 0; f.client.file = async id => { reads++; return chunks(id === 'file-output' ? f.output : ''); };
  await assert.rejects(read(f, 1, {expectedIdentity, expectedFiles: pins}), /batch_file_changed/); assert.equal(reads, 1);
});
for (const change of ['batchID', 'inputFileID', 'outputFileID', 'errorFileID', 'status', 'requestCounts', 'inputHash']) test('terminal pin rejects changed ' + change + ' before file GET', async () => {
  const f = await fixture(1), r = await read(f), identity = terminalIdentity(f.manifest, r.events[0]);
  const modified = {...identity, [change]: change === 'requestCounts' ? {total:1,completed:0,failed:1} : change === 'status' ? 'expired' : change === 'inputHash' ? hash('bad') : change.startsWith('batch') ? 'batch_other' : 'file-other'};
  let reads = 0; f.client.file = async () => { reads++; assert.fail('GET forbidden'); };
  await assert.rejects(read(f, 0, {expectedIdentity: modified})); assert.equal(reads,0);
});
test('retained exact result suppresses payload emission, altered semantics/accounting/source/row fail', async () => {
  const f = await fixture(1), r = await read(f), events = [];
  await retrieveBatch({plan:f.plan,manifest:f.manifest,approvedHash:hash(f.manifest),batchID:f.batch.id,inputFileID:'file-input',selectedCaseID:f.jobs[0].id,
    client:f.client,emit:e=>events.push(e),retainedResults:{[f.jobs[0].id]:r.result}});
  assert.equal(events.some(e=>e.event==='language_expansion_chunk'),false);
  for (const edit of [{...r.result,actualMicros:0,accountedMicros:0},{...r.result,content:{}},{...r.result,sourceBindings:[]},{...r.result,rawLine:r.result.rawLine+' '}])
    await assert.rejects(read(f,0,{retainedResults:{[f.jobs[0].id]:edit}}),/retained_batch_result_changed/);
});
for (const mode of ['fallbackOversize', 'earlyReturn', 'parserFailure', 'readFailure', 'BYOB']) test('fetch adapter bounds chunks and cancels/releases actual reader: '+mode, async () => {
  let cancelled=0,released=0,reads=0,observedSize;
  const reader={read:async view=>{reads++;observedSize=view?.byteLength;if(mode==='readFailure')throw Error('read failed');
    return reads===1?{done:false,value:new Uint8Array(mode==='fallbackOversize'?65_537:64)}:{done:true};},cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}};
  const body={getReader:options=>{if(options && mode!=='BYOB')throw new TypeError('not byte stream');return reader;}};
  if(mode==='fallbackOversize'||mode==='readFailure')await assert.rejects(async()=>{for await(const c of boundedFetchStream(body)) void c;});
  else if(mode==='parserFailure')await assert.rejects(async()=>{for await(const c of boundedFetchStream(body)) throw Error('parser stopped');});
  else if(mode==='earlyReturn') { for await(const c of boundedFetchStream(body)){assert.equal(c.length,64);break;} }
  else {for await(const c of boundedFetchStream(body))assert(c.byteLength<=65_536);assert.equal(observedSize,65_536);}
  assert.equal(released,1);assert.equal(cancelled,mode==='BYOB'?0:1);
});
test('real native fetch body is bounded and early cancellation closes its HTTP stream', async t => {
  let disconnected; const closed = new Promise(r=>{disconnected=r;});
  const server=createServer((req,res)=>{res.writeHead(200);const timer=setInterval(()=>res.write(Buffer.alloc(16384)),2);res.on('close',()=>{clearInterval(timer);disconnected();});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.close());
  const response=await fetch('http://127.0.0.1:'+server.address().port);
  for await(const value of boundedFetchStream(response.body)){assert(value.byteLength<=65_536);break;}
  await closed;server.closeAllConnections();await new Promise(r=>server.close(r));
});
test('openAI injected adapter preserves GET deadline and cannot upload/create during reads', async () => {
  const f=await fixture(1); const routes=[];
  const client=openAIClient({apiKey:'synthetic-only',fetchFn:async(url,options)=>{routes.push([url,options]);
    return new Response(url.endsWith('/content')?f.output:JSON.stringify(f.batch),{status:200});}});
  await read(f,0,{client}); assert.equal(routes.length,2);
  assert(routes.every(([url,o])=>o.method==='GET' && o.signal instanceof AbortSignal));
});

test('real journal keeps separate shard barrier, replays partial payloads, rejects corruption, and CLI finalizes locally', async t => {
  const f=await fixture(2), {dir,ticket}=await admitted(t,f);
  const a=await read(f,0), b=await read(f,1);
  const chunkIndex=a.events.findIndex(e=>e.event==='language_expansion_chunk');
  await importEvents(dir,a.events.slice(0,chunkIndex+1));
  assert.equal((await snapshot(dir)).states[f.jobs[0].id].state,'unknown');
  await assert.rejects(importEvents(dir,[a.events[chunkIndex]]),/duplicate_chunk/);
  await assert.rejects(importReadReplay(dir,a.events.slice(0,a.events.findIndex(e=>e.event==='language_expansion_complete')),hash(f.manifest),f.jobs[0].id));
  const fresh=await importReadReplay(dir,a.events,hash(f.manifest),f.jobs[0].id); assert(fresh.freshPayloadRecords>0);
  await importEvents(dir,b.events);
  const state=await snapshot(dir); assert.equal(state.states[f.jobs[0].id].state,'settled');assert.equal(state.states[f.jobs[1].id].state,'settled');
  assert.equal(state.shardStates[hash(f.manifest)].state,'unresolved');
  const next=f.plan.jobs.find(j=>j.body&&!state.states[j.id]);
  await assert.rejects(admitShard({directory:dir,plan:f.plan,manifest:shard(f.plan,[next.id]),executionID:'blocked'}),/prior_shard_unresolved/);
  const scan=a.events.find(e=>e.event==='language_expansion_scan'), file=a.events.find(e=>e.event==='language_expansion_file_scan');
  for(const event of [{...scan,rowCoverageHash:hash('bad')},{...file,payloadHash:hash('bad')},{...scan,files:scan.files.slice(0,1)}])
    await assert.rejects(importEvents(dir,[event]),/changed|incomplete/);
  await assert.rejects(importEvents(dir,[{...file,event:'language_expansion_file',version:undefined,identityHash:undefined,coverageHash:undefined}]),/legacy|invalid/);
  const cli=fileURLToPath(new URL('../../scripts/evaluate-language-expansion.mjs',import.meta.url));
  const staged=path.join(dir,'repeat.jsonl'); await fs.writeFile(staged,a.events.map(JSON.stringify).join('\n')+'\n');
  const repeat=spawnSync(process.execPath,[cli,'stage-repeat','--journal',dir,'--events',staged,'--approved-shard-hash',hash(f.manifest),'--case-id',f.jobs[0].id],{encoding:'utf8'});
  assert.equal(repeat.status,0,repeat.stderr);assert.equal(JSON.parse(repeat.stdout).result.freshPayloadRecords,0);
  await fs.writeFile(staged,a.events.map(JSON.stringify).join('\n')+'\n{"bad":'); const tip=(await fs.readFile(path.join(dir,'journal.jsonl'))).toString();
  assert.equal(spawnSync(process.execPath,[cli,'stage-repeat','--journal',dir,'--events',staged,'--approved-shard-hash',hash(f.manifest),'--case-id',f.jobs[0].id],{encoding:'utf8'}).status,1);
  assert.equal((await fs.readFile(path.join(dir,'journal.jsonl'))).toString(),tip);
  const run=spawnSync(process.execPath,[cli,'finalize','--journal',dir,'--approved-shard-hash',hash(f.manifest)],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const done=await snapshot(dir);assert.equal(done.shardStates[hash(f.manifest)].state,'reconciled');
  assert.equal(done.priorMicros,137);assert.equal(done.unknownHeldMicros,251);
  await finalizeBatch(dir,hash(f.manifest)); // Repeat actually recomputes; no duplicate record needed.
  await admitShard({directory:dir,plan:f.plan,manifest:shard(f.plan,[next.id]),executionID:'after_local_finalize'});
  await assert.rejects(claimStart(dir,ticket),/already_started/);
});

test('real journal re-derives parser/accounting and keeps unknown/overrun gates after file reconciliation', async t => {
  const f=await fixture(1), {dir}=await admitted(t,f);const seed=await directory(t);
  await fs.cp(dir,seed,{recursive:true});
  for(const mode of ['unknownUsage','overrun','forgedContent','forgedCost','forgedSource','missingScan','missingEmptyFile','oversizeResult']) {
    const owned=await directory(t);await fs.cp(seed,owned,{recursive:true});
    if (mode==='oversizeResult') {
      f.output=JSON.stringify(rowFor(f.plan,f.jobs[0],{padding:'x'.repeat(600_000)}))+'\n';const records=[];
      await assert.rejects(read(f,0,{emit:e=>records.push(e)}),/payload_limit/);await importEvents(owned,records);
      const state=await snapshot(owned);assert.equal(state.states[f.jobs[0].id].state,'unknown');assert.equal(state.shardStates[hash(f.manifest)].state,'unresolved');
      assert.equal(state.results[f.jobs[0].id],undefined);continue;
    }
    const extra=mode==='unknownUsage'?{usage:null}:mode==='overrun'?{usage:{input_tokens:1000000,output_tokens:1000000}}:{};
    f.output=JSON.stringify(rowFor(f.plan,f.jobs[0],extra))+'\n'; const r=await read(f);
    let events=r.events;
    if(mode.startsWith('forged')) {
      const output={...r.result,...(mode==='forgedContent'?{content:{lines:[]}}:mode==='forgedCost'?{actualMicros:0,accountedMicros:0}:{sourceBindings:[]})};
      events=events.filter(e=>!['language_expansion_chunk','language_expansion_complete'].includes(e.event));
      events.splice(2,0,...payloadEvents(baseEvent(f.manifest,f.jobs[0]),output));
    }
    if(mode==='missingScan')events=events.filter(e=>e.event!=='language_expansion_scan');
    if(mode==='missingEmptyFile')events=events.filter(e=>!(e.event==='language_expansion_file_scan'&&e.role==='error')&&e.event!=='language_expansion_scan');
    if(mode==='forgedSource'){await assert.rejects(importEvents(owned,events),/invalid_result_accounting/);continue;}
    await importEvents(owned,events);
    if(mode.startsWith('forged'))await assert.rejects(finalizeBatch(owned,hash(f.manifest)),/retained_batch_result_changed/);
    else if(mode.startsWith('missing'))await assert.rejects(finalizeBatch(owned,hash(f.manifest)),/scan_required|batch_file_changed/);
    else {
      await finalizeBatch(owned,hash(f.manifest));const state=await snapshot(owned);
      assert.equal(state.shardStates[hash(f.manifest)].state,'reconciled');
      assert.equal(state.states[f.jobs[0].id].state,mode==='overrun'?'cost_overrun':'unknown_cost');
      if(mode==='unknownUsage')assert.equal(state.results[f.jobs[0].id].accountedMicros,f.jobs[0].reservedMicros);
      const next=f.plan.jobs.find(j=>j.body&&!state.states[j.id]);
      await assert.rejects(admitShard({directory:owned,plan:f.plan,manifest:shard(f.plan,[next.id]),executionID:'still_blocked'}),/prior_shard_unresolved/);
    }
  }
});

test('CLI selected-case execution and both build adapters are read-only and keep intentional failures', async t => {
  const f=await fixture(1), {dir,ticket}=await admitted(t,f), prior=await read(f);
  // Partial file pins from the prior read are explicit input to each build.
  const pins=prior.events.filter(e=>e.event==='language_expansion_file_scan'), identity=prior.events[0];
  const values={plan:f.plan,manifest:f.manifest,ticket,pins,identity};for(const [name,value]of Object.entries(values))await fs.writeFile(path.join(dir,name+'.json'),JSON.stringify(value));
  const conf={planPath:path.join(dir,'plan.json'),planHash:hash(f.plan),manifestPath:path.join(dir,'manifest.json'),manifestHash:hash(f.manifest),shardID:hash(f.manifest),
    ticketPath:path.join(dir,'ticket.json'),operation:'retrieve',allocationMicros:f.jobs[0].reservedMicros,batchID:f.batch.id,inputFileID:'file-input',selectedCaseID:f.jobs[0].id,
    expectedFilesPath:path.join(dir,'pins.json'),expectedIdentityPath:path.join(dir,'identity.json'),batchAccepted:true,representativeReviewed:true};
  const build=[];await assert.rejects(runLanguageExpansionBuild(conf,{env:{VERCEL:'1',VERCEL_ENV:'production'},client:f.client,emit:e=>build.push(e)}),/intentional_build_failure/);
  assert.equal(build.at(-1).state,'evaluation_only_complete');
  const missing=[];await assert.rejects(runLanguageExpansionBuild({...conf,selectedCaseID:undefined},{env:{VERCEL:'1',VERCEL_ENV:'production'},client:{inspect:()=>assert.fail('GET before selector validation')},emit:e=>missing.push(e)}),/selected_batch_case/);
  assert.equal(missing.at(-1).state,'evaluation_only_interrupted');
  const legacy=[];const env={VERCEL:'1',VERCEL_ENV:'production',VERCEL_DEPLOYMENT_ID:ticket.executionID,LYRA_LANGUAGE_EXPANSION_ON_BUILD:'1',LYRA_LANGUAGE_EXPANSION_PLAN_HASH:hash(f.plan),LYRA_LANGUAGE_EXPANSION_SHARD_HASH:hash(f.manifest)};
  await assert.rejects(evaluateLanguageExpansionInBuild(env,{loadBundle:async()=>({plan:f.plan,manifest:f.manifest,ticket,operation:'retrieve',allocationMicros:f.jobs[0].reservedMicros,
    batchID:f.batch.id,inputFileID:'file-input',selectedCaseID:f.jobs[0].id,expectedIdentity:identity,expectedFiles:pins,batchAccepted:true,representativeReviewed:true}),client:f.client,emit:e=>legacy.push(e)}),/intentional_build_failure/);
  assert.equal(legacy.at(-1).state,'evaluation_only_complete');
  await importEvents(dir,build); // actual terminal still does not reconcile
  assert.equal((await snapshot(dir)).shardStates[hash(f.manifest)].state,'unresolved');
  const inspect=prior.events[0]; // known Batch is already registered by build import
  const preload=path.join(dir,'offline-fetch.mjs');await fs.writeFile(preload,`globalThis.fetch=async(url,o)=>{if(o.method!=='GET')throw Error('generation forbidden');return new Response(url.includes('/file-error/')?'':url.endsWith('/content')?${JSON.stringify(f.output)}:${JSON.stringify(JSON.stringify(f.batch))});};`);
  const cli=fileURLToPath(new URL('../../scripts/evaluate-language-expansion.mjs',import.meta.url));
  const run=spawnSync(process.execPath,['--import',preload,cli,'execute','--journal',dir,'--plan',conf.planPath,'--approved-plan-hash',conf.planHash,'--manifest',conf.manifestPath,'--approved-shard-hash',conf.manifestHash,
    '--ticket',conf.ticketPath,'--operation','retrieve','--case-id',f.jobs[0].id,'--expected-files',conf.expectedFilesPath,'--expected-identity',conf.expectedIdentityPath,'--live','yes','--allocation-micros',String(conf.allocationMicros)],
    {encoding:'utf8',env:{...process.env,OPENAI_API_KEY:'synthetic-only'}});
  assert.equal(run.status,0,run.stderr);assert.equal((await snapshot(dir)).results[f.jobs[0].id].valid,true);
});

test('Batch credential echo is sanitized and configuration change stops after charged prefix evidence', async()=>{
  for(const mode of ['secret','model']) {
    const secret='synthetic-credential-echo-value',f=await fixture(1,{response:mode==='secret'?{echo:secret}:{model:'unexpected-model'}}),events=[];
    await assert.rejects(read(f,0,{secret,emit:e=>events.push(e)}),/stop_reconcile/);
    const result=recoverPayload(events,baseEvent(f.manifest,f.jobs[0]));
    assert.equal(JSON.stringify(events).includes(secret),false);
    assert.equal(result.error,mode==='secret'?'provider_echoed_credentials':'provider_configuration_changed');
    assert(events.some(e=>e.event==='language_expansion_file_scan'));assert.equal(events.some(e=>e.event==='language_expansion_scan'),false);
  }
});
