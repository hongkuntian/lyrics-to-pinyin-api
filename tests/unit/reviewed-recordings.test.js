import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {lookupReviewedRecording} from '../../api/utils/reviewed-recordings.js';
import {withDeadline} from '../../api/utils/fetch-json.js';
const require=createRequire(import.meta.url);
const {recordings}=require('../../api/data/reviewed-recordings.json');
const clone=value=>JSON.parse(JSON.stringify(value));
// Entirely synthetic text proves fetched lines/timing flow through unchanged.
const rawLyrics='[00:00.00]词曲: Test Author\n[00:15.50]Fixture sunrise\n[00:30.25]Fixture moonlight';
function fixture(entry,mutate=()=>{},signal) {
  const calls=[];
  const fetchFn=async (url,init)=>{
    calls.push(url);if(signal) assert.equal(init.signal,signal);
    const u=new URL(url);let body;
    if(u.hostname==='itunes.apple.com') {
      assert.equal(u.searchParams.get('id'),entry.acceptedRequests[0].catalog_id);
      const anchor=entry.catalogAnchors.find(a=>a.storefront===u.searchParams.get('country')).signature;
      body={results:[{kind:'song',trackId:Number(anchor.catalog_id),trackName:anchor.title,
        artistName:anchor.artist,collectionName:anchor.album,trackTimeMillis:anchor.duration*1000}]};
    } else if(u.pathname==='/song/detail') {
      assert.equal(u.searchParams.get('ids'),entry.source.id);
      body={code:200,songs:[{id:Number(entry.source.id),name:entry.source.title,dt:entry.source.duration*1000,
        al:{id:Number(entry.source.album_id),name:entry.source.album},ar:entry.source.artists.map(a=>({id:Number(a.id),name:a.name}))}]};
    } else {
      assert.equal(u.pathname,'/lyric');assert.equal(u.searchParams.get('id'),entry.source.id);
      body={code:200,lrc:{lyric:rawLyrics}};
    }
    mutate(body,u);return {ok:true,json:async()=>body};
  };
  return {calls,fetchFn,signal};
}
for(const entry of recordings) {
  test(`${entry.id}: every reviewed full request validates live anchors and source`,async()=>{
    for(const request of entry.acceptedRequests) {
      const context=fixture(entry);const result=await lookupReviewedRecording(request,context);
      assert.ok(result);assert.equal(result.target,request);assert.equal(result.song.id,Number(entry.source.id));
      assert.equal(result.api.name,'NeteaseAPI');assert.equal(result.reviewedIdentity.id,entry.id);
      assert.match(result.reviewedIdentity.metadataSha256,/^[a-f0-9]{64}$/);
      assert.deepEqual(result.lyrics.lines,[{text:'Fixture sunrise',timestamp:15.5},{text:'Fixture moonlight',timestamp:30.25}]);
      assert.equal(context.calls.filter(url=>url.includes('/lyric?')).length,1);
    }
  });
  const base=entry.acceptedRequests[0];
  test(`${entry.id}: contradictory lyric artist and title headers fail closed`,async()=>{
    for(const header of ['[ar:Wrong Singer]', '[ti:Another Song]']) {
      const context=fixture(entry,(body,u)=>{if(u.pathname==='/lyric') body.lrc.lyric=header+'\n'+rawLyrics;});
      assert.equal(await lookupReviewedRecording(base,context),null);
    }
    const context=fixture(entry,(body,u)=>{if(u.pathname==='/lyric') body.lrc.lyric=`[ar:${entry.source.artists.map(a=>a.name).join(' & ')}]\n[ti:${entry.source.title}]\n${rawLyrics}`;});
    assert.ok(await lookupReviewedRecording(base,context));
  });
  const requestChanges=[{catalog_id:'999'},{catalog_id:undefined},{title:base.title+' (Live)'},
    {title:base.title+' (Remastered)'},{title:base.title+' (Instrumental)'},{artist:base.artist+' & Unlisted Guest'},
    {artist:base.artist.split(',')[0]},{artist:'Wrong Singer'},{album:'Different Release'},
    {album:base.album+' (Remix)'},{duration:base.duration+0.501},{duration:NaN},{duration:String(base.duration)}];
  for(const change of requestChanges) test(`${entry.id}: reject request ${JSON.stringify(change)}`,async()=>{
    const context=fixture(entry);assert.equal(await lookupReviewedRecording({...base,...change},context),null);
    assert.equal(context.calls.length,0);
  });
  test(`${entry.id}: complete contributor order and storefront do not change identity`,async()=>{
    const artist=base.artist.split(/\s*(?:,|&)\s*/).reverse().join(' & ');
    assert.ok(await lookupReviewedRecording({...base,artist,storefront:'invalid'},fixture(entry)));
  });
  const sourceChanges=[s=>s.id++,s=>s.name+=' (Live)',s=>s.name+=' (Instrumental)',s=>s.al.id++,
    s=>s.al.name='Another Album',s=>s.dt+=501,s=>s.dt=String(s.dt),s=>s.ar[0].name='Wrong Singer',
    s=>s.ar[0].id++,s=>s.ar.push({id:999,name:'Extra Guest'}),s=>s.ar.pop(),s=>delete s.al,s=>delete s.ar];
  for(const [index,change] of sourceChanges.entries()) test(`${entry.id}: reject upstream source mutation ${index}`,async()=>{
    const context=fixture(entry,(body,u)=>{if(u.pathname==='/song/detail') change(body.songs[0]);});
    assert.equal(await lookupReviewedRecording(base,context),null);
    assert.ok(!context.calls.some(url=>url.includes('/lyric?')));
  });
  test(`${entry.id}: reject all changed catalog anchors before requesting lyrics`,async()=>{
    for(const change of [s=>s.trackId++,s=>s.artistName+=' & Guest',s=>s.collectionName='Another Album',
      s=>s.trackName+=' (Live)',s=>s.trackTimeMillis+=501,s=>s.kind='music-video']) {
      const context=fixture(entry,(body,u)=>{if(u.hostname==='itunes.apple.com')change(body.results[0]);});
      assert.equal(await lookupReviewedRecording(base,context),null);
      assert.ok(!context.calls.some(url=>url.includes('/song/detail')));
    }
  });
  test(`${entry.id}: reject unavailable, multiple, or wrong-ID detail results`,async()=>{
    for(const change of [body=>body.code=404,body=>body.songs=[],body=>body.songs.push(clone(body.songs[0]))]) {
      const context=fixture(entry,(body,u)=>{if(u.pathname==='/song/detail')change(body);});
      assert.equal(await lookupReviewedRecording(base,context),null);
    }
  });
  test(`${entry.id}: absent or non-vocal source lyrics cannot become success`,async()=>{
    for(const lyric of ['', '[00:00.00]词曲: Test Author','[00:00.00]纯音乐，请欣赏']) {
      const context=fixture(entry,(body,u)=>{if(u.pathname==='/lyric')body.lrc.lyric=lyric;});
      assert.equal(await lookupReviewedRecording(base,context),null);
    }
  });
}
test('artist names must stay paired with their reviewed provider entity IDs',async()=>{
  const entry=recordings.find(x=>x.source.artists.length>1);
  const context=fixture(entry,(body,u)=>{if(u.pathname==='/song/detail') {
    const [a,b]=body.songs[0].ar;[a.id,b.id]=[b.id,a.id];
  }});
  assert.equal(await lookupReviewedRecording(entry.acceptedRequests[0],context),null);
});
test('duration tolerance never compounds through a reviewed anchor',async()=>{
  const entry=recordings[0],request={...entry.acceptedRequests[0],duration:entry.source.duration-0.4};
  for(const endpoint of ['itunes.apple.com','/song/detail']) {
    const context=fixture(entry,(body,u)=>{
      if(endpoint==='itunes.apple.com' && u.hostname===endpoint)body.results[0].trackTimeMillis+=400;
      if(endpoint==='/song/detail' && u.pathname===endpoint)body.songs[0].dt+=400;
    });
    assert.equal(await lookupReviewedRecording(request,context),null);
  }
});
test('upstream failures fail closed and cannot trigger unreviewed discovery',async()=>{
  const entry=recordings[0];let calls=0;
  assert.equal(await lookupReviewedRecording(entry.acceptedRequests[0],{fetchFn:async()=>{calls++;throw new Error('Unavailable');}}),null);
  assert.equal(calls,entry.catalogAnchors.length);
});
test('abort signal reaches catalog, detail, and lyric requests',async()=>{
  const controller=new AbortController(),entry=recordings[0];
  assert.ok(await lookupReviewedRecording(entry.acceptedRequests[0],fixture(entry,()=>{},controller.signal)));
  controller.abort();let calls=0;
  await assert.rejects(lookupReviewedRecording(entry.acceptedRequests[0],{signal:controller.signal,fetchFn:async()=>{calls++;}}),{name:'AbortError'});
  assert.equal(calls,0);
});
test('abort after metadata fetch never proceeds to lyric retrieval',async()=>{
  const controller=new AbortController(),entry=recordings[0];
  const context=fixture(entry,(_,u)=>{if(u.pathname==='/song/detail')controller.abort();},controller.signal);
  await assert.rejects(lookupReviewedRecording(entry.acceptedRequests[0],context),{name:'AbortError'});
  assert.ok(!context.calls.some(url=>url.includes('/lyric?')));
});
test('caller deadline cancels a pending upstream fetch',async()=>{
  const entry=recordings[0];let aborted=0;
  await assert.rejects(withDeadline(signal=>lookupReviewedRecording(entry.acceptedRequests[0],{signal,
    fetchFn:async(_,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>{
      aborted++;const error=new Error('cancelled');error.name='AbortError';reject(error);
    },{once:true}))}),15),{code:'provider_timeout'});
  assert.equal(aborted,entry.catalogAnchors.length);
});
