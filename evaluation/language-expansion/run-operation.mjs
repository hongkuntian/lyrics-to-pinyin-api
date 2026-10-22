// EVALUATION BRANCH ONLY. Never merge this configuration into normal main.
import fs from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createPacedEmitter} from './paced-emitter.mjs';
import {validateBatchConfig,STREAM_BUDGET} from './batch-config.mjs';
export async function runEvaluation(config,{env=process.env,fetchFn=globalThis.fetch,emit=createPacedEmitter({maxStreamBytes:STREAM_BUDGET}),client}={}) {
  if(env.VERCEL!=='1'||env.VERCEL_ENV!=='production'||env.VERCEL_GIT_COMMIT_REF!=='codex/language-expansion-evaluation-20261022'||!/^[a-f0-9]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA??'')||Number(process.versions.node.split('.')[0])!==24)throw Error('evaluation_environment_required');
  if(config?.version!==1)throw Error('unknown_evaluation_configuration');
  if(config.kind==='batch-probe') {
    if(Object.keys(config).sort().join()!=='kind,version')throw Error('invalid_probe_config');
    const {runBatchProbe}=await import('./batch-probe.mjs');
    return runBatchProbe({env,emit});
  }
  if(config.kind==='transport') {
    const {probeFixture}=await import('./probe.mjs');
    const {records,expected}=await probeFixture({commonPath:fileURLToPath(new URL('../../scripts/language-expansion/common.mjs',import.meta.url)),cases:1,payloadBytes:1_048_576});
    if(expected.stdoutBytes>STREAM_BUDGET)throw Error('probe_exceeds_log_budget');
    for(const r of records)await emit(r);return;
  }
  if(config.kind==='standard') {
    const manifest=JSON.parse(await fs.readFile(config.build.manifestPath,'utf8'));
    if(config.build.operation!=='standard'||manifest.transport!=='standard'||manifest.jobs?.length!==1)throw Error('one_remote_standard_case_required');
    const {payloadEvents,MAX_PAYLOAD}=await import('../../scripts/language-expansion/common.mjs');
    const {baseEvent}=await import('../../scripts/language-expansion/journal.mjs');
    const base=baseEvent(manifest,manifest.jobs[0]);
    const fullSize={text:'x'.repeat(MAX_PAYLOAD-Buffer.byteLength(JSON.stringify({text:''})))};
    const maximumBytes=payloadEvents(base,fullSize).reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e))+1,0)+Buffer.byteLength(JSON.stringify({...base,event:'language_expansion_submitting'}))+1+2*1901;
    if(maximumBytes>STREAM_BUDGET)throw Error('one_case_exceeds_log_budget');
    const {runLanguageExpansionBuild}=await import('../../scripts/language-expansion-build.mjs');
    return runLanguageExpansionBuild(config.build,{env,emit,fetchFn,client});
  }
  const {plan,manifest,identity}=await validateBatchConfig(config);
  const {recoverPayload}=await import('../../scripts/language-expansion/common.mjs');
  const {baseEvent}=await import('../../scripts/language-expansion/journal.mjs');
  const {verifyBatchResult}=await import('../../scripts/language-expansion/reconciliation.mjs');
  const {runLanguageExpansionBuild}=await import('../../scripts/language-expansion-build.mjs');
  // The adapter always receives NO retainedResultsPath. Repeated remote reads emit
  // the complete actual result. Only Root's explicit local stage-repeat deduplicates.
  let pending=[],bytes=0,flushed=false;
  const guarded=async r=>{
    if(['language_expansion_chunk','language_expansion_complete'].includes(r.event)){
      if(r.caseID!==config.build.selectedCaseID||flushed)throw Error('one_selected_result_required');
      bytes+=Buffer.byteLength(JSON.stringify(r))+1;
      if(bytes>STREAM_BUDGET-12*1901)throw Error('transport_stream_limit');
      pending.push(r);return;
    }
    if(r.event==='language_expansion_scan'){
      const job=manifest.jobs.find(j=>j.id===config.build.selectedCaseID),result=recoverPayload(pending,baseEvent(manifest,job));
      verifyBatchResult(plan,job,result,JSON.parse(result.rawLine));
      if(result.actualMicros===null||result.actualMicros>job.reservedMicros)throw Error('stop_reconcile_unknown_or_configuration');
      if(r.identityHash!==(await import('../../scripts/language-expansion/common.mjs')).hash(identity))throw Error('batch_identity_changed');
      for(const e of pending)await emit(e);pending=[];flushed=true;
    }
    await emit(r);
  };
  return runLanguageExpansionBuild(config.build,{env,emit:guarded,fetchFn,client});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  (async()=>runEvaluation(JSON.parse(await fs.readFile(new URL('./current-operation.json',import.meta.url),'utf8'))))()
    .catch(()=>process.stderr.write('evaluation_only_operation_failed; reconcile exact deployment before further work\n'))
    .finally(()=>{process.exitCode=1;});
}
