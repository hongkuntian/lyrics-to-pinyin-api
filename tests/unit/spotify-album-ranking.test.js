import test from 'node:test';
import assert from 'node:assert/strict';
import {findRecording,recordingScore,explainRecordingMatch} from '../../api/utils/recording-match.js';

const request={recordingProvider:'spotify',title:'Duet',artist:'First & Second',
  creditedArtistNames:['First','Second'],creditedArtistsComplete:true,duration:261.88,
  album:"Men's Talk About Love新歌+1992~2005精選"};
const source={id:1,title:request.title,artist:request.artist,creditedArtistNames:request.creditedArtistNames,
  duration:request.duration,album:"Men's Talk About Love"};
const other={...source,id:2,album:'Another Album'};

test('a bounded new-songs year-range compilation descriptor ranks the complete base album above unrelated albums',()=>{
  for(const [long,base] of [[request.album,source.album],['Collection 新歌＋1990–2010精选辑','Collection']]) {
    const target={...request,album:long},candidate={...source,album:base};
    assert.equal(findRecording([other,candidate],target).id,source.id);
    assert.equal(findRecording([other,{...candidate,album:long}],{...target,album:base}).id,source.id);
    assert.ok(recordingScore({...candidate,album:long},target)>recordingScore(candidate,target));
    assert.ok(explainRecordingMatch(candidate,target).rules.includes('compilation_album_caption'));
  }
});

test('compilation ranking preserves unknown suffixes, date ranges, alternate albums and timeline ambiguity',()=>{
  for(const album of ["Men's Talk About Love Deluxe", "Men's Talk About Love新歌+精选",
    "Men's Talk About Love新歌+2005~1992精選", "Men's Talk About Love新歌+1992~2005精選 (Anniversary)",
    'Other新歌+1992~2005精選']) {
    assert.throws(()=>findRecording([source,other],{...request,album}),{reason:'duplicate_candidates'});
  }
  assert.throws(()=>findRecording([{...source,album:"Men's Talk About Love新歌+1990~2010精選"},other],request),{reason:'duplicate_candidates'});
  const duplicate={...source,id:3,lyricsData:{lines:[{text:'Different sheet',timestamp:12}]}};
  assert.throws(()=>findRecording([source,duplicate],request),{reason:'duplicate_candidates'});
  assert.throws(()=>findRecording([source,other],{...request,recordingProvider:undefined}),{reason:'duplicate_candidates'});
});

test('compilation ranking cannot admit a wrong performer, duration, title, version or ISRC',()=>{
  for(const change of [{creditedArtistNames:['First']},{duration:270},{title:'Other'},
    {title:'Duet (Live)'},{album:"Men's Talk About Love (Live)"},{isrc:'USAAA2600002'}]) {
    assert.ok(recordingScore({...source,...change},{...request,isrc:'USAAA2600001'})<0);
  }
});
