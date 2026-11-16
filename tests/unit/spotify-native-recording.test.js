import test from 'node:test';
import assert from 'node:assert/strict';
import {spotifyRecording,spotifyRequestHash,spotifyRecordingKey,spotifySearchRequest} from '../../api/utils/song-library/spotify-recording.js';
import {recordingScore,findRecording} from '../../api/utils/recording-match.js';

const native=()=>({version:3,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{
  origin:'spotify',observation:'app_remote',artists_complete:false,title:'Synthetic Song',artists:['Artist'],album:'Synthetic Album',duration_ms:240000
}});
const source=extra=>({id:'source',title:'Synthetic Song',artist:'Artist',creditedArtistNames:['Artist'],album:'Synthetic Album',duration:240,...extra});

test('native and Web observations share recording identity but bind different evidence',()=>{
  const a=native(),b={...a,metadata:{...a.metadata,observation:'web_api',artists_complete:true}};
  assert.deepEqual(spotifyRecording(a),a);assert.deepEqual(spotifyRecording(b),b);
  assert.equal(spotifyRecordingKey(a),spotifyRecordingKey(b));assert.notEqual(spotifyRequestHash(a),spotifyRequestHash(b));
  assert.equal(spotifySearchRequest(a).creditedArtistsComplete,false);
  assert.throws(()=>spotifyRecording({...a,version:2}),{code:'invalid_recording'});
  for(const metadata of [{...a.metadata,observation:'unknown'},{...a.metadata,artists_complete:true},
    {...a.metadata,artist_ids:['1123456789ABCDEFGHIJKL']},{...a.metadata,artists:['Artist','Guest']},
    {...a.metadata,artists_complete:undefined}])assert.throws(()=>spotifyRecording({...a,metadata}),{code:'invalid_recording'});
});

test('incomplete native credits admit known contributors without inventing a complete list',()=>{
  const request=spotifySearchRequest(native());
  assert.ok(recordingScore(source(),request)>=0);
  assert.ok(recordingScore(source({artist:'Artist & Guest',creditedArtistNames:['Artist','Guest']}),request)>=0);
  assert.equal(recordingScore(source({artist:'Cover Artist',creditedArtistNames:['Cover Artist']}),request),-1);
  assert.equal(recordingScore(source({artist:'Artist & Unknown',creditedArtistNames:undefined}),request),-1);
  const full={...request,creditedArtistsComplete:true};
  assert.equal(recordingScore(source({creditedArtistNames:['Artist','Guest']}),full),-1);
});

test('native metadata keeps guest, version, duration, identity and ambiguity rejection',()=>{
  const request=spotifySearchRequest(native());
  assert.equal(recordingScore(source(),{...request,title:'Synthetic Song (feat. Guest)'}),-1);
  assert.ok(recordingScore(source({creditedArtistNames:['Artist','Guest']}),{...request,title:'Synthetic Song (feat. Guest)'})>=0);
  for(const extra of [{duration:244},{title:'Synthetic Song (Live)'},{album:'Synthetic Album (Remastered)'},
    {creditedArtistNames:[]},{isrc:'USABC2600002'}]) {
    assert.equal(recordingScore(source(extra),{...request,isrc:'USABC2600001'}),-1);
  }
  assert.throws(()=>findRecording([source({id:'one'}),source({id:'two'})],request),{reason:'duplicate_candidates'});
  const r=native();assert.notEqual(spotifyRecordingKey(r),spotifyRecordingKey({...r,item_id:'1123456789ABCDEFGHIJKL'}));
});
