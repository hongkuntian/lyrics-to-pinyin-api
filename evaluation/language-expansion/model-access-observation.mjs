// Evaluation-only, one fixed read-only model metadata GET. No generation or retry.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const model='gpt-6.1-sol';
export const probeID='language-model-metadata-20261022-r1';
const errorCodes=new Set(['model_not_found','insufficient_quota','invalid_api_key','permission_denied','access_denied','rate_limit_exceeded','unsupported_model','account_deactivated','billing_hard_limit_reached']);
const errorTypes=new Set(['invalid_request_error','permission_error','authentication_error','rate_limit_error','server_error']);
export async function observeModel({apiKey,fetchFn}) {
  if(typeof apiKey!=='string'||!apiKey||typeof fetchFn!=='function')return {outcome:'configuration_unavailable',metadataRequests:0,generationRequests:0};
  try {
    const response=await fetchFn('https://api.openai.com/v1/models/'+model,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(30000)});
    if(!Number.isInteger(response.status)||response.status<100||response.status>599)throw Error('invalid_status');
    const requestID=response.headers.get('x-request-id');
    const result={outcome:'http_observed',metadataRequests:1,generationRequests:0,status:response.status,providerRequestID:typeof requestID==='string'&&/^req_[A-Za-z0-9_-]{1,120}$/.test(requestID)&&!requestID.includes(apiKey)?requestID:null};
    const reader=response.body?.getReader();let size=0;const chunks=[];
    if(!reader)return {...result,outcome:'empty_body'};
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();return {...result,outcome:'body_bound'};}chunks.push(Buffer.from(value));}}
    finally {reader.releaseLock();}
    const raw=Buffer.concat(chunks);result.responseSHA256=createHash('sha256').update(raw).digest('hex');
    let data;try{data=JSON.parse(raw.toString('utf8'));}catch{return {...result,outcome:'invalid_json'};}
    if(response.status===200&&data?.object==='model'&&data.id===model)return {...result,modelID:model,metadataAvailable:true};
    return {...result,metadataAvailable:false,errorCode:errorCodes.has(data?.error?.code)?data.error.code:null,errorType:errorTypes.has(data?.error?.type)?data.error.type:null};
  } catch {return {outcome:'request_outcome_unknown',metadataRequests:1,generationRequests:0};}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const gitSHA=process.env.VERCEL_GIT_COMMIT_SHA;
  if(typeof gitSHA!=='string'||!/^([a-f0-9]{40})$/.test(gitSHA)||process.env.VERCEL_ENV!=='production') {
    process.stdout.write(JSON.stringify({event:'language_model_metadata_failure',probeID})+'\n');
  } else {
    const observation=await observeModel({apiKey:process.env.OPENAI_API_KEY,fetchFn:globalThis.fetch});
    process.stdout.write(JSON.stringify({event:'language_model_metadata_observation',probeID,version:1,gitSHA,target:'production',requestedModel:model,observation})+'\n');
  }
  process.exitCode=1; // Always before packaging; never a serving deployment.
}
