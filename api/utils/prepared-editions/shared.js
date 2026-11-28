import {LibraryError} from '../song-library/store.js';
import {storeEnvironment} from '../membership/policy.js';
import {preparedRequest} from './service.js';

export const sharedPreparedToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const unavailable=()=>new LibraryError('prepared_content_unavailable',503);
const statusFor={prepared_unavailable:404,artifact_unavailable:404,publication_changed:409,variant_unavailable:403};
const responseLimit=2_000_000;

export function sharedPreparedReader(env=process.env,fetchFn=fetch){
 if(storeEnvironment(env)!=='Sandbox'||!env.LYRICA_SHARED_PREPARED_URL)return null;
 let url;
 try{url=new URL(env.LYRICA_SHARED_PREPARED_URL);}catch{throw unavailable();}
 const token=env.LYRICA_SHARED_PREPARED_TOKEN;
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||
    url.pathname!=='/api/shared-prepared-content'||!sharedPreparedToken(token))throw unavailable();
 return async input=>{
  let response, result;
  try{
   response=await fetchFn(url.href,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(5000)});
   const chunks=[];let bytes=0;
   for await(const chunk of response.body){
    bytes+=chunk.byteLength;
    if(bytes>responseLimit)throw unavailable();
    chunks.push(chunk);
   }
   result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw unavailable();}
  if(!result||Array.isArray(result)||result.version!==1)throw unavailable();
  if(!response.ok){
   if(Object.hasOwn(statusFor,result.code)&&statusFor[result.code]===response.status)throw new LibraryError(result.code,response.status);
   throw unavailable();
  }
  const {version,...content}=result;
  if(input.action==='prepared_starters'?!Array.isArray(content.preparedStarters):
     !['ready',...(input.action==='prepared_lookup'?['unprepared']:[])].includes(content.state))throw unavailable();
  return content;
 };
}

export async function readPreparedContent(input,{store,read,territory=null}){
 if(!read)return preparedRequest(input,{store,territory});
 // Let the normal validator reject malformed inputs before contacting the publisher.
 let localEdition=false;
 const localStore={
  all:()=>store.all(),
  lookup:variant=>store.lookup(variant),
  edition:async (...args)=>{const row=await store.edition(...args);localEdition=Boolean(row);return row;}
 };
 let result;
 try{result=await preparedRequest(input,{store:localStore,territory});}
 catch(error){
  if(!localEdition&&error instanceof LibraryError&&error.code==='prepared_unavailable'&&
     ['prepared_grant','prepared_artifact'].includes(input.action))return read(input);
  throw error;
 }
 if(result.state==='unprepared'||result.preparedStarters?.every(group=>!group.songs.length))return read(input);
 return result;
}
