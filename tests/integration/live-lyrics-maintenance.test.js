import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB} from '../helpers/library-db.js';
import {pushBody,pushTime} from '../helpers/live-lyrics.js';
import {validatePush,LiveLyricsPushRelay} from '../../api/utils/live-lyrics/relay.js';
import {cleanupExpiredPushState} from '../../api/utils/live-lyrics/maintenance.js';

test('cleanup removes a bounded batch of expired state and preserves current quota and receipts',async()=>{
  const {db}=await libraryDB();
  try {
    await db.query(`INSERT INTO live_lyrics_push_rate_windows
      SELECT 'reader-a',now()-interval '2 days'-i*interval '1 minute',1 FROM generate_series(1,1001) i`);
    await db.query(`INSERT INTO live_lyrics_push_rate_windows VALUES('reader-a',date_trunc('minute',now()),120)`);
    await db.query(`INSERT INTO live_lyrics_push_receipts(activity_id,user_id,token_digest,expires_at)
      SELECT 'expired-'||i,'reader-a','digest',now()-interval '1 hour' FROM generate_series(1,1001) i`);
    await db.query(`INSERT INTO live_lyrics_push_receipts(activity_id,user_id,token_digest,expires_at)
      VALUES('current','reader-a','digest',now()+interval '30 minutes')`);
    assert.deepEqual(await cleanupExpiredPushState(db,{now:()=>pushTime}),{state:'completed',receipts:1000,rateWindows:1000});
    assert.equal((await db.query('SELECT count(*)::int AS count FROM live_lyrics_push_receipts')).rows[0].count,2);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM live_lyrics_push_rate_windows')).rows[0].count,2);
    assert.equal((await db.query("SELECT count FROM live_lyrics_push_rate_windows WHERE window_start=date_trunc('minute',now())")).rows[0].count,120);
    assert.deepEqual(await cleanupExpiredPushState(db,{now:()=>pushTime+59_999}),{state:'skipped'});
    assert.deepEqual(await cleanupExpiredPushState(db,{now:()=>pushTime+60_000}),{state:'completed',receipts:1,rateWindows:1});
  }finally{await db.close();}
});

test('cleanup is shared by relay instances using the same pool and does not run inside a delivery transaction',async()=>{
  const {db}=await libraryDB();let time=pushTime,depth=0,cleanups=0;
  const tracked={query:(...args)=>db.query(...args),transaction:fn=>db.transaction(async tx=>{
    depth++;
    try{return await fn({query:(sql,...args)=>{
      if(sql.includes('WITH expired_receipts')){assert.equal(depth,1);cleanups++;}
      return tx.query(sql,...args);
    }});}finally{depth--;}
  })};
  try {
    for(let sequence=1;sequence<=3;sequence++) {
      const relay=new LiveLyricsPushRelay(tracked,{send:async()=>assert.equal(depth,1),now:()=>time});
      await relay.update('reader-a',validatePush(pushBody(sequence,time),time));time+=1000;
    }
    assert.equal(cleanups,1);
    time=pushTime+60_000;
    await new LiveLyricsPushRelay(tracked,{send:async()=>{},now:()=>time}).update('reader-a',validatePush(pushBody(4,time),time));
    assert.equal(cleanups,2);
  }finally{await db.close();}
});

test('maintenance failure rolls back only cleanup, allowing a fresh push and preserving its quota',async()=>{
  const {db}=await libraryDB();let time=pushTime,cleanups=0;
  const warnings=[],tracked={query:(...args)=>db.query(...args),transaction:fn=>db.transaction(tx=>fn({query:(sql,...args)=>{
    if(sql.includes('WITH expired_receipts')){cleanups++;throw Object.assign(new Error('private database detail'),{code:'57014'});}
    return tx.query(sql,...args);
  }}))};
  try {
    const relay=new LiveLyricsPushRelay(tracked,{send:async()=>{},now:()=>time,logger:{warn:value=>warnings.push(value)}});
    assert.equal((await relay.update('reader-a',validatePush(pushBody(1,time),time))).state,'accepted');
    time+=1000;
    assert.equal((await relay.update('reader-a',validatePush(pushBody(2,time),time))).state,'accepted');
    assert.equal(cleanups,1);assert.deepEqual(warnings,[{event:'live_lyrics_cleanup_failed'}]);
    assert.equal((await db.query('SELECT count FROM live_lyrics_push_rate_windows')).rows[0].count,2);
    assert.equal((await db.query('SELECT sequence FROM live_lyrics_push_receipts')).rows[0].sequence,2);
  }finally{await db.close();}
});

test('an expired activity receipt can restart at sequence one even between cleanup attempts',async()=>{
  const {db}=await libraryDB();
  try {
    await cleanupExpiredPushState(db,{now:()=>pushTime});
    await db.query(`INSERT INTO live_lyrics_push_receipts(activity_id,user_id,token_digest,sequence,push_timestamp,expires_at)
      VALUES($1,'reader-b','old-digest',100,$2,now()-interval '1 minute')`,[pushBody().activityID,pushTime/1000]);
    let sent=0;
    const relay=new LiveLyricsPushRelay(db,{send:async()=>sent++,now:()=>pushTime+1000});
    assert.deepEqual(await relay.update('reader-a',validatePush(pushBody(1,pushTime+1000),pushTime+1000)),
      {state:'accepted',sequence:1,timestamp:pushTime/1000+1});
    assert.equal(sent,1);
    assert.equal((await db.query('SELECT user_id FROM live_lyrics_push_receipts')).rows[0].user_id,'reader-a');
  }finally{await db.close();}
});
