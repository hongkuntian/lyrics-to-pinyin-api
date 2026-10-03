import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB} from '../helpers/library-db.js';
import {pushBody,pushTime} from '../helpers/live-lyrics.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {createLiveLyricsHandler} from '../../api/live-lyrics.js';
import {validatePush,LiveLyricsPushRelay} from '../../api/utils/live-lyrics/relay.js';
import {LibraryError} from '../../api/utils/song-library/store.js';

test('relay serializes accepted updates, ignores older sequences, and retains no lyrics or raw tokens',async()=>{
  const {db}=await libraryDB();let time=pushTime;const sent=[];
  try {
    const relay=new LiveLyricsPushRelay(db,{send:async input=>sent.push(input),now:()=>time});
    const first=await relay.update('reader-a',validatePush(pushBody(),time));
    assert.deepEqual(first,{state:'accepted',sequence:1,timestamp:time/1000});
    assert.equal(sent[0].priority,10);assert.equal(sent[0].payload.aps['stale-date'],time/1000+8);
    time+=1000;
    await relay.update('reader-a',validatePush(pushBody(1,time),time));assert.equal(sent.length,1);
    const next=pushBody(2,time);next.reason='heartbeat';await relay.update('reader-a',validatePush(next,time));
    assert.equal(sent[1].priority,5);assert.equal(sent[1].payload.aps.timestamp,time/1000);
    const row=(await db.query('SELECT * FROM live_lyrics_push_receipts')).rows[0];
    assert.equal(row.sequence,2);assert.equal(JSON.stringify(row).includes(pushBody().token),false);
    assert.equal(JSON.stringify(row).includes(pushBody().state.original),false);
    await assert.rejects(()=>relay.update('reader-b',validatePush(pushBody(3,time+1000),time+1000)),{code:'push_session_conflict'});
  }finally{await db.close();}
});
test('same-second changes coalesce without future APNs timestamps; failed delivery does not advance the receipt',async()=>{
  const {db}=await libraryDB();let time=pushTime,fail=false,calls=0;
  try {
    const relay=new LiveLyricsPushRelay(db,{send:async()=>{calls++;if(fail)throw new LibraryError('push_unavailable',503);},now:()=>time});
    await relay.update('reader-a',validatePush(pushBody(1,time),time));
    await assert.rejects(()=>relay.update('reader-a',validatePush(pushBody(2,time),time)),{code:'push_rate_limited'});assert.equal(calls,1);
    time+=1000;fail=true;
    await assert.rejects(()=>relay.update('reader-a',validatePush(pushBody(3,time),time)),{code:'push_unavailable'});
    assert.equal((await db.query('SELECT sequence FROM live_lyrics_push_receipts')).rows[0].sequence,1);
    assert.equal((await db.query('SELECT count FROM live_lyrics_push_rate_windows')).rows[0].count,3);
    fail=false;await relay.update('reader-a',validatePush(pushBody(4,time),time));
    assert.equal((await db.query('SELECT sequence FROM live_lyrics_push_receipts')).rows[0].sequence,4);
    time+=9000;await assert.rejects(()=>relay.update('reader-a',validatePush(pushBody(5,time-9000),time-9000)),{code:'push_observation_expired'});
  }finally{await db.close();}
});
test('push quota is independent of browsing and bounds failed attempts',async()=>{
  const {db,store}=await libraryDB();
  try {
    await db.query("INSERT INTO live_lyrics_push_rate_windows VALUES('reader-a',date_trunc('minute',now()),120)");
    const relay=new LiveLyricsPushRelay(db,{send:async()=>{throw Error('unexpected');},now:()=>pushTime});
    await assert.rejects(()=>relay.update('reader-a',validatePush(pushBody(),pushTime)),{code:'push_rate_limited'});
    await store.rateLimit('reader-a');
  }finally{await db.close();}
});
test('endpoint requires authenticated app sessions and returns actionable retry timing',async()=>{
  let calls=0;
  const authStore={authenticate:async()=>({id:'reader-a'})};
  const relay={update:async()=>{calls++;throw new LibraryError('push_rate_limited',429);}};
  const handler=createLiveLyricsHandler({authStore,relay,now:()=>pushTime});
  for(const authorization of [undefined,'Bearer token-a']) {
    const res=createMockRes();await handler(createMockReq({body:pushBody(),headers:{authorization}}),res);assert.equal(res.statusCode,401);
  }
  assert.equal(calls,0);
  const res=createMockRes();await handler(createMockReq({body:pushBody(),headers:{authorization:'Bearer lyra_s_fixture'}}),res);
  assert.equal(res.statusCode,429);assert.equal(res.headers['Retry-After'],'1');assert.equal(res.headers['Cache-Control'],'private, no-store');
});
