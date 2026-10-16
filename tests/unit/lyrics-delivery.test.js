import test from 'node:test';
import assert from 'node:assert/strict';
import {streamResponse} from '../helpers/stream-http.js';
import {withLyricsDelivery} from '../../api/utils/lyrics-delivery.js';

const req=()=>({method:'POST',body:{options:{delivery:'progressive-v1'}}});
test('shared acquisition replays readable text and retains the second reader after cancellation',async()=>{
 let release,entered,calls=0,signal;
 const ready=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);
 const handler=withLyricsDelivery(async(req,res)=>{calls++;signal=req.lyricDelivery.signal;req.lyricDelivery.publish({song:{id:'same'},lines:[]});entered();await barrier;res.status(200).json({song:{id:'same'},lines:[]});});
 const a=streamResponse(),b=streamResponse(),first=handler(req(),a);await ready;
 const second=handler(req(),b);await new Promise(r=>setImmediate(r));
 assert.equal(b.chunks.length,1);a.emit('close');assert.equal(signal.aborted,false);release();await Promise.all([first,second]);
 const frames=b.chunks.map(JSON.parse);assert.deepEqual(frames.map(f=>f.event),['readable','complete']);assert.equal(calls,1);
 assert.equal(frames[0].acquisitionID,frames[1].acquisitionID);assert.ok(frames[1].sequence>frames[0].sequence);
});
test('last reader cancellation aborts the owner and a new reader starts new bounded work',async()=>{
 let signal,entered;const ready=new Promise(r=>entered=r);
 const handler=withLyricsDelivery(async(req,res)=>{signal=req.lyricDelivery.signal;entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));res.status(504).json({code:'provider_timeout'});});
 const res=streamResponse(),work=handler(req(),res);await ready;res.emit('close');await work;assert.equal(signal.aborted,true);
});
test('late failure is terminal refresh failure while early failure keeps ordinary JSON errors',async()=>{
 for(const readable of [false,true]) {
  const handler=withLyricsDelivery(async(req,res)=>{if(readable)req.lyricDelivery.publish({song:{id:'same'},lines:[]});res.status(422).json({code:'source_incomplete'});});
  const res=streamResponse();await handler(req(),res);
  if(readable)assert.equal(JSON.parse(res.chunks.at(-1)).event,'refresh_failed');else assert.equal(res.statusCode,422);
 }
});
test('deadline aborts acquisition and waits for owned cleanup before returning',async()=>{
 let cleaned=false;
 const handler=withLyricsDelivery(async(req,res)=>{req.lyricDelivery.publish({song:{id:'same'},lines:[]});await new Promise(r=>req.lyricDelivery.signal.addEventListener('abort',r,{once:true}));await new Promise(r=>setTimeout(r,5));cleaned=true;res.status(504).json({code:'provider_timeout'});},{timeoutMs:5});
 const res=streamResponse();await handler(req(),res);assert.equal(cleaned,true);assert.equal(JSON.parse(res.chunks.at(-1)).event,'refresh_failed');
});
test('a subscriber exceeding the byte limit releases and aborts its owner immediately',async()=>{
 let signal;
 const handler=withLyricsDelivery(async(req,res)=>{signal=req.lyricDelivery.signal;req.lyricDelivery.publish({song:{id:'same'},lines:[{original:'x'.repeat(2_000_001)}]});res.status(200).json({song:{id:'same'}});});
 const res=streamResponse();await handler(req(),res);assert.equal(signal.aborted,true);
});
test('slow cancellation cleanup has explicit platform ownership after its bounded wait',async()=>{
 let release;const pending=[],gate=new Promise(r=>release=r);
 const handler=withLyricsDelivery(async()=>{await gate;},{timeoutMs:5,cleanupTimeoutMs:5,waitUntilFn:promise=>pending.push(promise)});
 const res=streamResponse();await handler(req(),res);assert.equal(res.statusCode,504);assert.equal(pending.length,1);release();await Promise.all(pending);
});
