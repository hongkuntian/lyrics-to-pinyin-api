// Evidence from one exact non-OK request. Never retries or returns error text.
import {createHash} from 'node:crypto';
import {hash,fail,integer} from './common.mjs';
const CODES=new Set(['model_not_found','invalid_api_key','insufficient_quota','rate_limit_exceeded','invalid_request_error','unsupported_value','permission_denied','access_denied','context_length_exceeded','server_error']);
const TYPES=new Set(['invalid_request_error','authentication_error','permission_error','rate_limit_error','server_error','insufficient_quota','error']);
const LIMIT=16384;
export function validateObservation(o,requestBodyHash) {
 if(!o||Object.keys(o).sort().join()!=='bytes,code,complete,providerRequestID,requestBodyHash,responseHash,status,type,version'||
  o.version!=='same-request-http-r1'||o.requestBodyHash!==requestBodyHash||!/^[a-f0-9]{64}$/.test(o.requestBodyHash)||
  !Number.isInteger(o.status)||o.status<100||o.status>599||o.status>=200&&o.status<300||
  !integer(o.bytes)||o.bytes>LIMIT||typeof o.complete!=='boolean'||!/^[a-f0-9]{64}$/.test(o.responseHash)||
  o.providerRequestID!==null&&!/^[A-Za-z0-9_-]{1,120}$/.test(o.providerRequestID)||
  o.code!==null&&!CODES.has(o.code)||o.type!==null&&!TYPES.has(o.type))fail('invalid_same_request_http_observation');
}
export async function observeHTTP(response,requestBodyHash,secret) {
 const parts=[];let bytes=0,complete=true;const h=createHash('sha256'),reader=response.body?.getReader();
 try {if(reader)while(true){const {done,value}=await reader.read();if(done)break;
  const b=Buffer.from(value),take=b.subarray(0,LIMIT-bytes);parts.push(take);h.update(take);bytes+=take.length;
  if(b.length>take.length){complete=false;await reader.cancel();break;}
 }}catch {complete=false;}finally{reader?.releaseLock();}
 let parsed=null;try{if(complete)parsed=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{}
 const id=response.headers?.get('x-request-id');
 const observation={version:'same-request-http-r1',requestBodyHash,status:response.status,
  providerRequestID:typeof id==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(id)&&!id.includes(secret)?id:null,
  code:CODES.has(parsed?.error?.code)?parsed.error.code:null,type:TYPES.has(parsed?.error?.type)?parsed.error.type:null,
  bytes,complete,responseHash:h.digest('hex')};
 // Hash is of exactly bytes bytes; complete=false explicitly denotes a prefix.
 validateObservation(observation,requestBodyHash);return observation;
}
