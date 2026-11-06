import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {lookupReviewedRecording} from '../../api/utils/reviewed-recordings.js';
import {parseLRC} from '../../api/utils/lrc.js';
import {timingFingerprint} from '../../api/utils/timing-corrections.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const require=createRequire(import.meta.url);
const entry=require('../../api/data/reviewed-recordings.json').recordings.find(entry=>entry.id==='apple-6763663750-netease-2643800682');
const lyric='[00:00.00]制作统筹: Test Producer\n[00:01.00]母带: Test Engineer\n[00:15.50]Aria:Fixture sunrise\n[01:20.50]Bram:Fixture daylight\n[02:25.50]Aria:Fixture evening\n[04:10.25]Bram:Fixture moonlight';

test('the original Isha catalog request v2 admits reviewed source before cleanup on MISS and HIT',async()=>{
  assert.ok(entry);
  const review={...entry,source:{...entry.source,lyricsFingerprintVersion:'parsed-lrc-v1',lyricsFingerprint:timingFingerprint({lines:parseLRC(lyric)})}};
  let reads=0;
  const fetchFn=async url=>{
    reads++;
    const target=new URL(url);let body;
    if(target.hostname==='itunes.apple.com') {
      const anchor=entry.catalogAnchors.find(anchor=>anchor.storefront===target.searchParams.get('country')).signature;
      body={results:[{kind:'song',trackId:Number(anchor.catalog_id),trackName:anchor.title,artistName:anchor.artist,
        collectionName:anchor.album,trackTimeMillis:anchor.duration*1000}]};
    } else if(target.pathname==='/song/detail') {
      body={code:200,songs:[{id:Number(entry.source.id),name:entry.source.title,dt:entry.source.duration*1000,
        al:{id:Number(entry.source.album_id),name:entry.source.album},ar:entry.source.artists.map(artist=>({id:Number(artist.id),name:artist.name}))}]};
    } else {
      assert.equal(target.pathname,'/lyric');body={code:200,lrc:{lyric}};
    }
    return {ok:true,json:async()=>body};
  };
  const handler=createMusicRomanizeService({redis:null,logger:{info(){},error(){}},
    lookupReviewedRecordingFn:(request,context)=>lookupReviewedRecording(request,{...context,fetchFn},{reviews:[review]}),
    lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,resolveCatalogAliasesFn:async()=>[],
    getAvailableAPIsFn:()=>[{name:'Fixture',searchSong:async()=>null}],
    getProcessorFn:()=>({romanize:async text=>({romanized:text})})});
  let first;
  for(const cache of ['MISS','MEMORY']) {
    const response=createMockRes();
    await handler(createMockReq({body:{...entry.acceptedRequests[0],language:'en',lyric_sources_version:2}}),response);
    assert.equal(response.statusCode,200);
    assert.equal(response.headers['X-Lyrics-Cache'],cache);
    assert.equal(response.body.metadata.reviewed_recording.sourceID,entry.source.id);
    assert.equal(response.body.quality.synced,true);
    assert.deepEqual(response.body.lines.map(line=>line.original),['Fixture sunrise','Fixture daylight','Fixture evening','Fixture moonlight']);
    assert.deepEqual(response.body.lines.map(line=>line.timestamp),[15.5,80.5,145.5,250.25]);
    assert.deepEqual(response.body.metadata.lyric_structure.sourceRows.map(row=>row.text),[
      'Aria:Fixture sunrise','Bram:Fixture daylight','Aria:Fixture evening','Bram:Fixture moonlight']);
    assert.deepEqual(response.body.song_details.credits.map(credit=>credit.original),[
      '制作统筹: Test Producer','母带: Test Engineer']);
    if(first)assert.deepEqual(response.body,first);else first=response.body;
  }
  assert.equal(reads,entry.catalogAnchors.length+2);
});
