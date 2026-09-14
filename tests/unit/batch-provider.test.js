import test from 'node:test';
import assert from 'node:assert/strict';
import {BatchProvider,batchInput,batchFilename} from '../../api/utils/song-library/batch-provider.js';
import {digest} from '../../api/utils/song-library/store.js';
const local={id:'local-1',input_file_id:'file-test',request_hash:'hash'};
test('provider uses only fixed OpenAI paths, unique metadata, 24h completion and no automatic POST retries',async()=> {
  const calls=[];
  const provider=new BatchProvider({apiKey:'test',fetchFn:async(url,opts)=>{calls.push({url,opts});throw new Error('timeout');}});
  await assert.rejects(provider.submit(local),{code:'provider_unavailable'});assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.openai.com/v1/batches');
  const body=JSON.parse(calls[0].opts.body);assert.equal(body.completion_window,'24h');
  assert.equal(body.metadata.lyra_batch_id,local.id);assert.equal(body.metadata.request_hash,'hash');
  await assert.rejects(async()=>provider.file('https://untrusted.example/'),{code:'invalid_provider_id'});
  assert.equal(calls.length,1);
});
test('upload stores an expiring JSONL file and hashes survive JSONB key order',async()=> {
  const items=[{operation_id:'op-1',request_body:{z:1,a:2}}],text=batchInput(items),l={...local,request_hash:digest(text)};
  let form;
  const p=new BatchProvider({apiKey:'test',fetchFn:async(url,opts)=>{assert.equal(url,'https://api.openai.com/v1/files');form=opts.body;return Response.json({id:'file-test'});}});
  assert.equal(await p.upload(l,items),'file-test');assert.equal(form.get('purpose'),'batch');
  assert.equal(form.get('file').name,batchFilename(local.id));assert.equal(await form.get('file').text(),text);
  assert.equal(form.get('expires_after[seconds]'),'2592000');
});
test('recovered uploads must match both unique filename and exact stored request bytes',async()=> {
  const items=[{operation_id:'op-1',request_body:{model:'gpt-5.6-luna'}}],text=batchInput(items),l={...local,request_hash:digest(text)};
  const p=new BatchProvider({apiKey:'test',fetchFn:async url=>url.includes('/content')?new Response('wrong input'):
    Response.json({data:[{id:'file-test',filename:batchFilename(local.id)}],has_more:false})});
  await assert.rejects(p.findUpload(l,items),{code:'batch_request_changed'});
});
test('provider download limits and bounded reconciliation prevent unbounded work',async()=> {
  const oversized=new BatchProvider({apiKey:'test',fetchFn:async()=>new Response('x'.repeat(3_000_001))});
  await assert.rejects(oversized.file('file-test'),{code:'provider_response_too_large'});
  let pages=0;const p=new BatchProvider({apiKey:'test',fetchFn:async()=>{pages++;return Response.json({data:[{id:`b-${pages}`}],has_more:true});}});
  await assert.rejects(p.findBatch(local),{code:'provider_reconciliation_page_limit'});assert.equal(pages,5);
});
