import {LibraryError,digest} from './store.js';
import {strictJSON} from './translation.js';
import {REVIEW_POLICY} from './review-assessment.js';

export const batchFilename=id=>`lyra-review-${id}.jsonl`;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const stableJSON=value=>JSON.stringify(canonical(value));
export const batchInput=items=>items.map(i=>stableJSON({custom_id:i.operation_id,method:'POST',url:'/v1/responses',body:i.request_body})).join('\n')+'\n';
const identifier=value=> {
  if(typeof value!=='string'||!/^[-a-zA-Z0-9_]{1,200}$/.test(value))throw new LibraryError('invalid_provider_id',502);
  return value;
};
export function batchMatches(remote,local) {
  return remote?.endpoint==='/v1/responses'&&remote.input_file_id===local.input_file_id&&
    remote.metadata?.lyra_batch_id===local.id&&remote.metadata?.request_hash===local.request_hash&&remote.metadata?.policy_version===(local.policy_version??REVIEW_POLICY);
}
export function parseBatchFiles(texts,items) {
  const expected=new Set(items.map(i=>i.operation_id)),found=new Map();
  for(const text of texts)for(const line of text.split('\n').filter(l=>l.trim())) {
    const row=strictJSON(line);
    if(!expected.has(row?.custom_id)||found.has(row.custom_id))throw new LibraryError('batch_result_identity_conflict',502);
    found.set(row.custom_id,row);
  }
  return found;
}
export class BatchProvider {
  constructor({apiKey,fetchFn=fetch,deadline=Date.now()+220_000}={}) {this.apiKey=apiKey;this.fetch=fetchFn;this.deadline=deadline;}
  async request(path,{method='GET',body,raw=false}={}) {
    if(!this.apiKey)throw new LibraryError('review_not_configured',503);
    const remaining=this.deadline-Date.now();if(remaining<1000)throw new LibraryError('worker_time_limit',503);
    let response;
    try {response=await this.fetch(`https://api.openai.com/v1${path}`,{method,
      headers:{Authorization:`Bearer ${this.apiKey}`,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},
      body:body instanceof FormData?body:body?JSON.stringify(body):undefined,
      signal:AbortSignal.timeout(Math.min(20_000,remaining))});}
    catch {throw new LibraryError('provider_unavailable',502);}
    if(!response.ok){await response.body?.cancel();throw new LibraryError('provider_rejected',502);}
    // Bound downloads as they arrive, not after an unbounded response.text allocation.
    const reader=response.body.getReader(),chunks=[];let length=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
      if(length>3_000_000)throw new LibraryError('provider_response_too_large',502);chunks.push(value);}}
    finally {await reader.cancel().catch(()=>{});}
    const text=Buffer.concat(chunks).toString('utf8');
    if(raw)return text;
    return strictJSON(text);
  }
  async upload(local,items) {
    const text=batchInput(items);
    if(digest(text)!==local.request_hash)throw new LibraryError('batch_request_changed');
    const form=new FormData();form.set('purpose','batch');
    form.set('file',new Blob([text],{type:'application/jsonl'}),batchFilename(local.id));
    // Input and output files expire after 30 days; durable results live in Postgres.
    form.set('expires_after[anchor]','created_at');form.set('expires_after[seconds]','2592000');
    const f=await this.request('/files',{method:'POST',body:form});return identifier(f.id);
  }
  async locate(path,predicate) {
    let after=null;const matches=[];
    for(let page=0;page<5;page++) {
      const result=await this.request(`${path}${path.includes('?')?'&':'?'}limit=100${after?`&after=${encodeURIComponent(after)}`:''}`);
      if(!Array.isArray(result.data))throw new LibraryError('invalid_provider_response',502);
      matches.push(...result.data.filter(predicate));
      if(!result.has_more)return matches;
      after=identifier(result.last_id??result.data.at(-1)?.id);
    }
    throw new LibraryError('provider_reconciliation_page_limit',503);
  }
  async findUpload(local,items) {
    const files=await this.locate('/files?purpose=batch&order=desc',f=>f.filename===batchFilename(local.id));
    if(files.length>1)throw new LibraryError('batch_identity_conflict',502);
    if(!files.length)return null;
    const id=identifier(files[0].id);
    const contents=await this.file(id);
    if(digest(contents)!==local.request_hash||contents!==batchInput(items))throw new LibraryError('batch_request_changed');
    return id;
  }
  submit(local) {
    return this.request('/batches',{method:'POST',body:{input_file_id:local.input_file_id,endpoint:'/v1/responses',completion_window:'24h',
      metadata:{lyra_batch_id:local.id,request_hash:local.request_hash,policy_version:local.policy_version??REVIEW_POLICY},
      output_expires_after:{anchor:'created_at',seconds:2592000}}});
  }
  async findBatch(local) {
    const matches=await this.locate('/batches',b=>b.metadata?.lyra_batch_id===local.id);
    if(matches.length>1)throw new LibraryError('batch_identity_conflict',502);
    return matches[0]??null;
  }
  get(id) {return this.request(`/batches/${identifier(id)}`);}
  file(id) {return this.request(`/files/${identifier(id)}/content`,{raw:true});}
}
