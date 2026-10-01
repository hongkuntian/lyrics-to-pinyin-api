import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {lookupReviewedRecording} from '../../api/utils/reviewed-recordings.js';
import {timingFingerprint} from '../../api/utils/timing-corrections.js';

const require=createRequire(import.meta.url);
const {recordings}=require('../../api/data/reviewed-recordings.json');
const entry=recordings.find(r=>r.id==='apple-6785801848-lrclib-37647540');
const lines=[{text:'Fixture sunrise',timestamp:17.51},{text:'Fixture moonlight',timestamp:187.72}];
const lyric='[00:17.51]Fixture sunrise\n[03:07.72]Fixture moonlight';
function fixture(mutate=()=>{}) {
  assert.ok(entry);
  const review={...entry,source:{...entry.source,lyricsFingerprint:timingFingerprint({lines})}};
  const calls=[];
  const fetchFn=async(url,init)=>{
    calls.push(url);assert.ok(init.signal);
    const u=new URL(url);let body;
    if(u.hostname==='itunes.apple.com') {
      const anchor=entry.catalogAnchors.find(a=>a.storefront===u.searchParams.get('country')).signature;
      body={results:[{kind:'song',trackId:Number(anchor.catalog_id),trackName:anchor.title,
        artistName:anchor.artist,collectionName:anchor.album,trackTimeMillis:anchor.duration*1000}]};
    } else {
      assert.equal(u.hostname,'lrclib.net');assert.equal(u.pathname,`/api/get/${entry.source.id}`);
      body={id:Number(entry.source.id),trackName:entry.source.title,artistName:entry.source.artist,
        albumName:entry.source.album,duration:entry.source.duration,syncedLyrics:lyric,plainLyrics:'Unreviewed plain field'};
    }
    mutate(body,u);return {ok:true,json:async()=>body};
  };
  return {review,calls,fetchFn};
}
const lookup=(request,f)=>lookupReviewedRecording(request,f,{reviews:[f.review]});

test('the reported Mandarin release uses the pinned Chinese-title source, including rounded app duration',async()=>{
  for(const request of entry?.acceptedRequests??[]) {
    for(const duration of [request.duration,210]) {
      const f=fixture(),result=await lookup({...request,duration},f);
      assert.ok(result);assert.equal(result.song.id,37647540);assert.equal(result.api.name,'LRCAPI');
      assert.equal(result.reviewedIdentity.source,'lrclib');assert.deepEqual(result.lyrics.lines,lines);
      assert.equal(f.calls.filter(url=>url.includes('lrclib.net')).length,1);
    }
  }
  assert.ok(entry);
});
test('Cantonese, guest, album, duration and catalog changes cannot use the Mandarin mapping',async()=>{
  const base=entry?.acceptedRequests[0];assert.ok(base);
  for(const change of [{title:base.title+' (粵語版)'},{catalog_id:'999'},{catalog_id:undefined},
    {artist:base.artist+' & Guest'},{album:base.album+' (Live)'},{duration:211}]) {
    const f=fixture();assert.equal(await lookup({...base,...change},f),null);assert.equal(f.calls.length,0);
  }
});
test('reviewed LRCLIB metadata, words and timestamps must remain unchanged',async()=>{
  for(const mutate of [r=>r.id++,r=>r.trackName+=' (粵語版)',r=>r.artistName='Another Singer',
    r=>r.albumName='Another Album',r=>r.duration+=1,r=>r.duration=String(r.duration),
    r=>r.syncedLyrics=lyric.replace('sunrise','Changed words'),r=>r.syncedLyrics=lyric.replace('17.51','18.51'),
    r=>r.syncedLyrics='',r=>r.syncedLyrics=null,r=>r.instrumental=true,
    r=>r.syncedLyrics='[ar:Another Singer]\n'+lyric,r=>r.syncedLyrics='[ti:Another Song]\n'+lyric]) {
    const f=fixture((body,u)=>{if(u.hostname==='lrclib.net')mutate(body);});
    assert.equal(await lookup(entry.acceptedRequests[0],f),null);
  }
  const f=fixture((body,u)=>{if(u.hostname==='lrclib.net')body.syncedLyrics=`[ar:${entry.source.artist}]\n[ti:${entry.source.title}]\n${lyric}`;});
  assert.ok(await lookup(entry.acceptedRequests[0],f));
});
test('LRCLIB metadata exceptions require a full timeline fingerprint and fresh catalog evidence',async()=>{
  for(const mutate of [r=>r.trackId++,r=>r.trackName+=' (粵語版)',r=>r.artistName+=' & Guest',
    r=>r.collectionName='Another Album',r=>r.trackTimeMillis+=1000]) {
    const f=fixture((body,u)=>{if(u.hostname==='itunes.apple.com')mutate(body.results[0]);});
    assert.equal(await lookup(entry.acceptedRequests[0],f),null);
  }
  const f=fixture();delete f.review.source.lyricsFingerprint;
  assert.equal(await lookup(entry.acceptedRequests[0],f),null);
});
