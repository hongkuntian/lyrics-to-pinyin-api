// EVALUATION ONLY. Public bundles contain no journal or retained result cache.
import fs from 'node:fs/promises';
import path from 'node:path';
import {hash, readJSON, payloadEvents, MAX_PAYLOAD, SCHEMA} from '../../scripts/language-expansion/common.mjs';
import {validateManifest} from '../../scripts/language-expansion/transport.mjs';
import {baseEvent, validateStartReceipt} from '../../scripts/language-expansion/journal.mjs';
import {terminalIdentity, scanProjection} from '../../scripts/language-expansion/reconciliation.mjs';
import {validateFileReceipt, fileProjection, BATCH_RETRIEVAL} from '../../scripts/language-expansion/batch-files.mjs';
export const STREAM_BUDGET = 2_600_000;
const fail = code => {throw new Error(code);};
export const same = (a,b) => JSON.stringify(a,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v) === JSON.stringify(b,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const exact = (o,ks) => o && same(Object.keys(o).sort(),ks.sort());
// Only structural pins are knowable before retrieval. Content/coverage hashes
// remain runtime obligations, including a supplied scan with no journal scan.
export function validateRetrievalPins(manifest,identity,files=[],scan) {
  const identityHash=hash(identity);
  const validate=f=>{if(!f||typeof f!=='object')fail('invalid_partial_file_pins');validateFileReceipt(f);if(f.version!==BATCH_RETRIEVAL.version||f.identityHash!==identityHash||!identity[f.role+'FileID']||f.fileID!==identity[f.role+'FileID'])fail('invalid_partial_file_pins');};
  const bounded=(pins,complete=false)=>{
    const bytes=pins.reduce((n,f)=>n+f.bytes,0),count=pins.reduce((n,f)=>n+f.count,0);
    if(bytes>BATCH_RETRIEVAL.combinedBytes||count>manifest.jobs.length||(complete&&count!==manifest.jobs.length))fail('invalid_aggregate_file_pins');
  };
  if(!Array.isArray(files)||files.some(f=>!f||typeof f!=='object')||new Set(files.map(f=>f.role)).size!==files.length)fail('invalid_partial_file_pins');
  files.forEach(validate);bounded(files);
  if(scan!==undefined){
    if(!scan||scan.version!==BATCH_RETRIEVAL.version||scan.identityHash!==identityHash||!Array.isArray(scan.files)||scan.rowCount!==manifest.jobs.length||!/^[a-f0-9]{64}$/.test(scan.rowCoverageHash??'')||!same(scanProjection(scan),scan)||scan.files.some(f=>!f||typeof f!=='object')||new Set(scan.files.map(f=>f.role)).size!==scan.files.length||scan.files.length!==[identity.outputFileID,identity.errorFileID].filter(Boolean).length)fail('invalid_expected_scan');
    scan.files.forEach(f=>{validate({...f,version:scan.version,identityHash:scan.identityHash});if(!same(fileProjection(f),f))fail('invalid_expected_scan');});
    bounded(scan.files,true);
    for(const pin of files)if(!scan.files.some(f=>same(f,fileProjection(pin))))fail('batch_file_changed');
  }
}
export async function validateBatchConfig(config) {
  if (!exact(config,['version','kind','build']) || config.version!==1 || config.kind!=='batch') fail('typed_batch_configuration_required');
  const b=config.build, required=['operation','planPath','planHash','manifestPath','manifestHash','shardID','ticketPath','startReceiptPath','admissionPath','allocationMicros','representativeReviewed','batchAccepted'];
  const optional={submit:[],inspect:['batchID','inputFileID'],recover:['inputFileID'],retrieve:['batchID','inputFileID','selectedCaseID','expectedIdentityPath','expectedFilesPath','expectedScanPath']}[b?.operation];
  if (!optional || !required.every(k=>Object.hasOwn(b,k)) || Object.keys(b).some(k=>![...required,...optional].includes(k))) fail('typed_batch_build_required');
  if (!/^[a-f0-9]{64}$/.test(b.planHash??'') || !/^[a-f0-9]{64}$/.test(b.manifestHash??'') || b.shardID!==b.manifestHash || b.batchAccepted!==true || b.representativeReviewed!==true) fail('reviewed_batch_admission_required');
  for (const key of ['batchID','inputFileID']) if (b[key]!==undefined && !(key==='batchID'?/^batch_[A-Za-z0-9_-]{1,114}$/:/^file-[A-Za-z0-9_-]{1,115}$/).test(b[key])) fail('invalid_batch_id');
  if (['inspect','retrieve'].includes(b.operation) && (!b.batchID || !b.inputFileID)) fail('known_batch_input_required');
  // Realpath prevents symlink escape. No private results/journal path is accepted.
  for (const [k,v] of Object.entries(b).filter(([k])=>k.endsWith('Path'))) {
    if (typeof v!=='string'||/(^|\/)(?:public|static|\.vercel)(\/|$)/.test(v)) fail('private_bundle_path_required');
    const resolved=await fs.realpath(v), bundle=await fs.realpath('evaluation/language-expansion/bundles');
    if (!resolved.startsWith(bundle+path.sep) || !(await fs.stat(resolved)).isFile()) fail('reviewed_bundle_path_required');
  }
  const [plan,manifest,ticket,start,admission]=await Promise.all([b.planPath,b.manifestPath,b.ticketPath,b.startReceiptPath,b.admissionPath].map(readJSON));
  if (hash(plan)!==b.planHash||manifest.planHash!==b.planHash||manifest.transport!=='batch') fail('frozen_batch_plan_required');
  await validateManifest(plan,manifest,b.manifestHash);
  if (!exact(ticket,['schema','planHash','shardHash','executionID','transport']) || ticket.schema!==SCHEMA || ticket.planHash!==b.planHash || ticket.shardHash!==b.manifestHash || ticket.transport!=='batch' || !/^[A-Za-z0-9_-]{1,120}$/.test(ticket.executionID??'')) fail('invalid_external_ticket');
  validateStartReceipt(start,ticket);
  const cases=manifest.jobs.map(j=>({...baseEvent(manifest,j),event:'language_expansion_admitted',executionID:ticket.executionID}));
  const expected={version:1,planHash:b.planHash,manifestHash:b.manifestHash,ticketHash:hash(ticket),startReceiptHash:hash(start),allocationMicros:manifest.jobs.reduce((n,j)=>n+j.reservedMicros,0),cases};
  if (!same(admission,expected)||b.allocationMicros!==expected.allocationMicros) fail('all_root_case_admissions_required');
  let identity,files=[],scan;
  if (b.operation==='retrieve') {
    if (!manifest.jobs.some(j=>j.id===b.selectedCaseID)||!b.expectedIdentityPath) fail('one_exact_selected_case_and_identity_required');
    identity=terminalIdentity(manifest,await readJSON(b.expectedIdentityPath));
    if (identity.batchID!==b.batchID||identity.inputFileID!==b.inputFileID) fail('batch_identity_changed');
    files=b.expectedFilesPath?await readJSON(b.expectedFilesPath):[];
    scan=b.expectedScanPath?await readJSON(b.expectedScanPath):undefined;
    validateRetrievalPins(manifest,identity,files,scan);
  }
  // Admission is BEFORE client creation. Reserve worst full-case payload + all controls,
  // two file receipts, scan and terminal; install/platform keeps a separate 400K allowance.
  for (const job of b.operation==='retrieve'?manifest.jobs.filter(j=>j.id===b.selectedCaseID):manifest.jobs.slice(0,1)) {
    const full={text:'x'.repeat(MAX_PAYLOAD-Buffer.byteLength(JSON.stringify({text:''})))};
    const records=payloadEvents(baseEvent(manifest,job),full);
    const maximum=records.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e))+1,0)+(manifest.jobs.length+12)*1901;
    if(maximum>STREAM_BUDGET)fail('one_case_exceeds_log_budget');
  }
  return {plan,manifest,ticket,start,admission,identity,files,scan};
}
