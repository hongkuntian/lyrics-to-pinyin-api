import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSharedPreparedHandler} from '../../api/shared-prepared-content.js';
import {sharedPreparedReader,readPreparedContent} from '../../api/utils/prepared-editions/shared.js';
const url='https://published.example/api/shared-prepared-content', token='a'.repeat(64);
const qa={LYRICA_STORE_ENVIRONMENT:'Sandbox',LYRICA_SHARED_PREPARED_URL:url,LYRICA_SHARED_PREPARED_TOKEN:token};
const prod={LYRICA_STORE_ENVIRONMENT:'Production',LYRICA_SHARED_PREPARED_TOKEN:token};
const request={action:'prepared_starters',languages:['cmn']};
const empty={preparedStarters:[{language:'cmn',songs:[]}]};

function capture(){
 return {headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;}};
}
test('published-content route is off in Sandbox and never reads for an invalid service token',async()=>{
 let reads=0;
 const store={all:async()=>{reads++;return [];}};
 for(const [env,credential,status] of [[qa,token,404],[{},token,404],[prod,'wrong',401],[prod,token,200]]){
  const res=capture();
  await createSharedPreparedHandler({env,store})({method:'POST',headers:{authorization:'Bearer '+credential},body:request},res);
  assert.equal(res.code,status);
 }
 assert.equal(reads,1);
 const res=capture();
 await createSharedPreparedHandler({env:prod,store})({method:'POST',headers:{authorization:'Bearer '+token},body:{action:'delete'}},res);
 assert.equal(res.code,400);
 assert.equal(reads,1);
});
test('Sandbox reader uses its configured origin without following redirects and preserves withdrawal',async()=>{
 let calls=0;
 const reader=sharedPreparedReader(qa,async(input,options)=>{
  calls++;assert.equal(input,url);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);
  assert.deepEqual(JSON.parse(options.body),request);
  return Response.json({version:1,code:'prepared_unavailable'},{status:404});
 });
 assert.equal(sharedPreparedReader(prod),null);
 await assert.rejects(reader(request),{code:'prepared_unavailable',status:404});
 assert.equal(calls,1);
});
test('local snapshot stays authoritative and missing content uses the configured reader',async()=>{
 let local=false, remote=0;
 const store={all:async()=>[], edition:async()=>local?{state:'withdrawn',bundle:{rights:{expiresAt:'2099-01-01',worldwide:true}}}:null};
 const read=async()=>{remote++;return empty;};
 assert.deepEqual(await readPreparedContent(request,{store,read}),empty);
 const artifact={action:'prepared_grant',editionID:'a'.repeat(64),generation:'1',use:'read'};
 assert.deepEqual(await readPreparedContent(artifact,{store,read}),empty);
 local=true;
 await assert.rejects(readPreparedContent(artifact,{store,read}),{code:'prepared_unavailable'});
 assert.equal(remote,2);
});
