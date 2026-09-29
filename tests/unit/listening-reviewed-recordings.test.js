import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupListeningReviewedRecording,listeningReviews} from '../../api/utils/listening-reviewed-recordings.js';
import {timingFingerprint} from '../../api/utils/timing-corrections.js';

const lines=[{text:'Fixture opening',timestamp:36.68},{text:'Fixture chorus',timestamp:90.94},{text:'Fixture ending',timestamp:199.45}];
const review={...listeningReviews[0],fingerprint:timingFingerprint({lines})};
const request={catalog_id:review.catalogID,title:review.title,artist:'Fei Yu-Ching',album:review.album,duration:review.duration};
function fixture(mutate=()=>{},selected=review) {
  const calls=[];
  const context={fetchFn:async url=>{
    calls.push(url);const catalog=url.includes('itunes.apple.com');
    const body=catalog?{results:[{kind:'song',trackId:Number(review.catalogID),trackName:review.title,
      artistName:review.catalogArtist,collectionName:review.album,trackTimeMillis:review.duration*1000}]}:
      {id:review.source.id,trackName:review.source.title,artistName:review.source.artist,albumName:review.source.album,duration:review.source.duration,
        syncedLyrics:'[00:36.68]Fixture opening\n[01:30.94]Fixture chorus\n[03:19.45]Fixture ending'};
    mutate(body,catalog);return {ok:true,json:async()=>body};
  }};
  return {calls,run:(input=request)=>lookupListeningReviewedRecording(input,context,{reviews:[selected]})};
}
test('listening-bound recovery aligns three observations and every source representation',async()=>{
  const f=fixture(),result=await f.run();assert.ok(result);
  assert.deepEqual(result.lyrics.lines.map(l=>l.timestamp),[28.18,82.44,190.95]);
  assert.deepEqual(result.lyrics.lyricStructure.sourceRows.map(l=>l.timestamp),[28.18,82.44,190.95]);
  assert.equal(result.timingCorrection.basis,'recording_listening_review');assert.equal(result.target,request);
  assert.equal(f.calls.length,2);
});
test('other catalog IDs, versions, performers, albums and durations never use the correction',async()=>{
  for(const change of [{catalog_id:'1'},{catalog_id:undefined},{title:'一剪梅'},{title:request.title+' (Live)'},
    {artist:'Another Singer'},{artist:'Fei Yu-Ching & Guest'},{album:'Other Album'},{duration:229.642},{duration:NaN}]) {
    const f=fixture();assert.equal(await f.run({...request,...change}),null);assert.equal(f.calls.length,0);
  }
});
test('changed live catalog evidence fails before fetching lyrics',async()=>{
  for(const mutate of [s=>s.trackId++,s=>s.trackName+=' Live',s=>s.artistName='Other',s=>s.collectionName='Other',s=>s.trackTimeMillis+=600]) {
    const f=fixture((body,catalog)=>{if(catalog)mutate(body.results[0]);});assert.equal(await f.run(),null);assert.equal(f.calls.length,1);
  }
});
test('changed provider identity, text or timing and contradictory headers fail closed',async()=>{
  for(const mutate of [s=>s.id++,s=>s.trackName+=' Live',s=>s.artistName='Other',s=>s.albumName='Other',s=>s.duration+=1,
    s=>s.syncedLyrics=s.syncedLyrics.replace('Fixture opening','Changed'),s=>s.syncedLyrics=s.syncedLyrics.replace('36.68','28.18'),
    s=>s.syncedLyrics='[ar:Other]\n'+s.syncedLyrics,s=>s.syncedLyrics='[ti:Other]\n'+s.syncedLyrics]) {
    assert.equal(await fixture((body,catalog)=>{if(!catalog)mutate(body);}).run(),null);
  }
});
test('inconsistent listening observations cannot be repaired with one global shift',async()=>{
  assert.equal(await fixture(()=>{},{...review,checkpoints:[...review.checkpoints.slice(0,2),{source:199.45,heard:180}]}).run(),null);
  assert.equal(await fixture(()=>{},{...review,offsetSeconds:-20}).run(),null);
});
test('upstream failure and cancellation cannot publish guessed timing',async()=>{
  assert.equal(await lookupListeningReviewedRecording(request,{fetchFn:async()=>{throw Error('offline');}},{reviews:[review]}),null);
  const controller=new AbortController();controller.abort();
  await assert.rejects(lookupListeningReviewedRecording(request,{signal:controller.signal},{reviews:[review]}));
});
