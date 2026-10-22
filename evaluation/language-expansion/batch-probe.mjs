// Zero-provider adapter proof. Synthetic fixtures, no retained private results.
import fs from 'node:fs/promises';
import path from 'node:path';
import {hash,MAX_PAYLOAD} from '../../scripts/language-expansion/common.mjs';
import {preparePlan,shard,batchInput} from '../../scripts/language-expansion/plan.mjs';
import {baseEvent} from '../../scripts/language-expansion/journal.mjs';
import {responseResult} from '../../scripts/language-expansion/transport.mjs';
import {terminalIdentity} from '../../scripts/language-expansion/reconciliation.mjs';
import {corpus,routeOptions,fakeResponse,batchObject,ticketFor} from '../../tests/fixtures/language-expansion.mjs';
export async function makeProbe(directory,{plan:givenPlan,manifest:givenManifest,ticket:givenTicket,start:givenStart}={}) {
  const plan=givenPlan??await preparePlan({corpus,approvedCorpusHash:hash(corpus),...routeOptions,confirmationNames:Array.from({length:60},(_,i)=>'confirmation'+String(i+1).padStart(2,'0'))});
  const manifest=givenManifest??shard(plan,plan.jobs.filter(j=>j.kind==='translation'&&!plan.seedIDs.includes(j.id)).slice(0,3).map(j=>j.id),{},'batch');
  const ticket=givenTicket??ticketFor(manifest);
  const value={schema:ticket.schema,event:'language_expansion_start',shardHash:ticket.shardHash,executionID:ticket.executionID};
  const entry={seq:manifest.jobs.length,previousHash:hash('synthetic-probe-only'),value};entry.hash=hash(entry);
  const start=givenStart??{schema:ticket.schema,ticketHash:hash(ticket),entry};
  const batch=batchObject(manifest,{error_file_id:'file-error'});
  const rows=manifest.jobs.map((j,i)=>({custom_id:j.id,error:null,response:{status_code:200,body:fakeResponse(plan,j,{padding:i===0?'':'x'.repeat(300_000)})}}));
  const selected=manifest.jobs[0],resultFor=rawLine=>({...responseResult(plan,selected,rows[0].response.body,'batch'),fileID:'file-output',role:'output',lineIndex:0,rawLine,filePayloadHash:'0'.repeat(64)});
  let raw=JSON.stringify(rows[0]),delta=MAX_PAYLOAD-Buffer.byteLength(JSON.stringify(resultFor(raw)));
  rows[0].response.body.padding='x'.repeat(Math.floor(delta/2));raw=JSON.stringify(rows[0])+(delta%2?' ':'');
  const output=raw+'\n'+rows.slice(1).map(JSON.stringify).join('\n')+'\n';
  const result={...resultFor(raw),filePayloadHash:hash(output)};
  if(Buffer.byteLength(JSON.stringify(result))!==MAX_PAYLOAD||Buffer.byteLength(output)<=MAX_PAYLOAD)throw Error('invalid_full_probe_fixture');
  await fs.mkdir(directory,{recursive:true});
  const save=async(name,data)=>{const p=path.join(directory,name);await fs.writeFile(p,JSON.stringify(data)+'\n',{flag:'wx'});return p;};
  const identity=terminalIdentity(manifest,{batchID:batch.id,inputFileID:batch.input_file_id,outputFileID:batch.output_file_id,errorFileID:batch.error_file_id,status:batch.status,requestCounts:batch.request_counts});
  const admission={version:1,planHash:hash(plan),manifestHash:hash(manifest),ticketHash:hash(ticket),startReceiptHash:hash(start),allocationMicros:manifest.jobs.reduce((n,j)=>n+j.reservedMicros,0),cases:manifest.jobs.map(j=>({...baseEvent(manifest,j),event:'language_expansion_admitted',executionID:ticket.executionID}))};
  const build={operation:'retrieve',planPath:await save('plan.json',plan),planHash:hash(plan),manifestPath:await save('manifest.json',manifest),manifestHash:hash(manifest),shardID:hash(manifest),ticketPath:await save('ticket.json',ticket),startReceiptPath:await save('start.json',start),admissionPath:await save('admission.json',admission),allocationMicros:admission.allocationMicros,representativeReviewed:true,batchAccepted:true,batchID:batch.id,inputFileID:batch.input_file_id,selectedCaseID:selected.id,expectedIdentityPath:await save('identity.json',identity)};
  const calls=[];
  const fetchFn=async(url,options={})=>{
    const u=new URL(url);if(u.origin!=='https://api.openai.com')throw Error('fake_route_required');
    const route=u.pathname.slice(4),method=options.method??'GET';calls.push({route,method});
    let body;
    if(route==='files'&&method==='POST')return Response.json({id:'file-input'});
    if(route==='batches'&&method==='POST')return Response.json(batch);
    if(route==='batches'&&method==='GET')return Response.json({data:[batch],has_more:false});
    if(route==='batches/'+batch.id&&method==='GET')return Response.json(batch);
    if(route==='files/file-output/content')body=Buffer.from(output);
    else if(route==='files/file-error/content')body=Buffer.alloc(0);
    else if(route==='files/file-input/content')body=Buffer.from(batchInput(manifest));
    else throw Error('forbidden_fake_route');
    let at=0;return new Response(new ReadableStream({pull(c){if(at===body.length){c.close();return;}const end=Math.min(at+65_536,body.length);c.enqueue(body.subarray(at,end));at=end;}}));
  };
  return {plan,manifest,ticket,start,batch,identity,admission,build,result,rows,output,fetchFn,calls};
}
export async function runBatchProbe({env,emit}){
  // This entire branch uses an injected in-memory fetch. It never constructs the
  // actual provider credential or invokes ambient fetch, even on remote Vercel.
  const directory=path.resolve('evaluation/language-expansion/bundles/zero-provider-probe');
  const f=await makeProbe(directory);
  const {runEvaluation}=await import('./run-operation.mjs');
  return runEvaluation({version:1,kind:'batch',build:f.build},{env:{...env,OPENAI_API_KEY:'FAKE_EVALUATION_ONLY'},fetchFn:f.fetchFn,emit});
}
