import test from 'node:test';
import assert from 'node:assert/strict';
import {observePlayback} from '../../api/utils/spotify/observation.js';
import {createSpotifyProvider} from '../../api/utils/spotify/provider.js';
import {renderState} from '../../api/utils/spotify/render.js';
import {playback,documentFor,recipe} from '../helpers/spotify.js';
import {displayText} from '../../api/utils/spotify/display.js';
import {sourceCapsule,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {recording} from '../helpers/spotify.js';

const time=1_800_000_000_000;
const sample=(position,start,{playing=true,rtt=100}={})=>({status:200,body:playback(position,playing),requestStartedAt:start,responseReceivedAt:start+rtt});
test('confirmation lease starts before request; progress interpolation starts after receipt',()=>{
 const observation=observePlayback(sample(19500,time,{rtt:900}),null,1),document=documentFor();
 assert.equal(observation.confirmedAt,time);
 const consumer={generation:1,sequence:0,recipe};
 const state=renderState({observation,document,consumer,now:time+900});
 assert.equal(state.original,'Fixture original','do not add RTT to returned progress');
 assert.equal(renderState({observation,document,consumer,now:time+8000}).phase,'unavailable');
 assert.equal(observePlayback({status:204,requestStartedAt:time,responseReceivedAt:time+900},null,1).confirmedAt,time);
});
test('three stagnant playing observations stop freshness; advancing and paused clocks recover honestly',()=>{
 let prior=observePlayback(sample(10000,time),null,1);
 for(let n=1;n<=3;n++){
  prior=observePlayback(sample(10000,time+n*2000),prior,n+1);
  assert.equal(prior.stalledSamples,n);
  assert.equal(prior.confirmedAt,n===3?null:time+n*2000);
 }
 assert.equal(prior.reason,'playbackStalled');
 let recovered=observePlayback(sample(12000,time+8000),prior,5);
 assert.equal(recovered.confirmedAt,time+8000);assert.equal(recovered.stalledSamples,0);
 for(let n=5;n<10;n++)recovered=observePlayback(sample(12000,time+n*2000,{playing:false}),recovered,n+1);
 assert.equal(recovered.confirmedAt,time+18000);assert.equal(recovered.stalledSamples,0);
});
test('response-body latency is included before accepting an observation',async()=>{
 let clock=time;
 const provider=createSpotifyProvider({now:()=>clock,fetchFn:async()=>({status:200,ok:true,json:async()=>{clock+=2500;return playback();}})});
 const sample=await provider.playback('fixture-token');
 assert.equal(sample.responseReceivedAt-sample.requestStartedAt,2500);
 assert.equal(observePlayback(sample,null,1).confirmedAt,null);
});
test('validated reading aid obeys pronunciation visibility just like source readings',()=>{
 const document=documentFor(),observation=observePlayback(sample(10000,time,{playing:false}),null,1);
 const consumer={generation:1,sequence:0,recipe:{...recipe,reading:'validatedDeviceAid',showPronunciation:false},
  validatedAid:{sourceHash:document.sourceHash,textRevision:document.textRevision,readingRevision:document.readingRevision,lines:[{pronunciation:'Device reading'}]}};
 assert.equal(renderState({observation,document,consumer,now:time}).pronunciation,'');
 consumer.recipe.showPronunciation=true;
 assert.equal(renderState({observation,document,consumer,now:time}).pronunciation,'Device reading');
});
test('explicit Chinese display script transforms phrases without rewriting source identity or mixed Japanese/Korean text',()=>{
 assert.equal(displayText('头发，发现','zh-Hant'),'頭髮，發現');
 assert.equal(displayText('頭髮，發現','yue-Hans'),'头发，发现');
 for(const language of ['zh','en','ja','ko'])assert.equal(displayText('头发，发现',language),'头发，发现');
 for(const text of ['头发 の 歌','头发 한'])assert.equal(displayText(text,'zh-Hant'),text);
 const source=documentFor(),response=structuredClone(source.response),selection=source.selectionRevision;
 response.lines[0].original='头发，发现';response.lines[1].original='音乐';
 response.recordingBinding=spotifyBinding(recording,sourceCapsule(response),selection,response);
 const doc=publicDocument(makeDocument(recording,response,selection),recording),before=JSON.stringify(doc);
 const observation=observePlayback(sample(10000,time,{playing:false}),null,1),consumer={generation:1,sequence:0,recipe:{...recipe,language:'zh-Hant'}};
 const rendered=renderState({observation,document:doc,consumer,now:time});
 assert.equal(rendered.original,'頭髮，發現');assert.equal(rendered.nextOriginal,'音樂');
 assert.equal(rendered.sourceHash,doc.sourceHash);assert.equal(JSON.stringify(doc),before);
});
