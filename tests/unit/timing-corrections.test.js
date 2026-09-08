import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTimingCorrection,timingFingerprint} from '../../api/utils/timing-corrections.js';
const request={catalog_id:'123',artist:'Test Singer',title:'Example',album:'Album',duration:100};
const lyrics={lines:[{text:'Opening phrase',timestamp:12},{text:'Second phrase',timestamp:20}]};
const replacement={lines:[{text:'Opening phrase',timestamp:9},{text:'Second phrase',timestamp:16}]};
const candidate={song:{...request,id:1},lyrics,api:{name:'LRCAPI'},target:request};
const rule={id:'fixture',...request,artists:[request.artist],rejected:[timingFingerprint(lyrics)],replacementID:2,replacementFingerprint:timingFingerprint(replacement)};
const raw={id:2,trackName:request.title,artistName:request.artist,albumName:request.album,duration:100,syncedLyrics:'[00:09]Opening phrase\n[00:16]Second phrase'};
test('recording-bound correction replaces the complete timeline with verified provenance',async()=>{
 const result=await applyTimingCorrection(candidate,request,{}, {rules:[rule],fetchJSONFn:async()=>raw});
 assert.deepEqual(result.lyrics.lines,replacement.lines);assert.equal(result.song.id,2);assert.equal(result.timingCorrection.status,'replacement');
});
test('different recording, changed upstream content and unrelated lyrics never trigger correction',async()=>{
 for(const change of [{catalog_id:'124'},{artist:'Another singer'},{title:'Example (Live)'},{album:'Other'},{duration:104}]) {
  const result=await applyTimingCorrection(candidate,{...request,...change},{},{rules:[rule],fetchJSONFn:()=>assert.fail('must not fetch')});assert.equal(result,candidate);
 }
 const changed={...candidate,lyrics:replacement};assert.equal(await applyTimingCorrection(changed,request,{}, {rules:[rule],fetchJSONFn:()=>assert.fail('must not fetch')}),changed);
});
test('failed, changed or wrong-recording replacement preserves words without known-bad timestamps',async()=>{
 for(const fetchJSONFn of [async()=>{throw Error('offline');},async()=>({...raw,artistName:'Cover Singer'}),async()=>({...raw,syncedLyrics:'[00:09]Changed words'})]) {
  const result=await applyTimingCorrection(candidate,request,{}, {rules:[rule],fetchJSONFn});
  assert.deepEqual(result.lyrics.lines.map(line=>line.text),lyrics.lines.map(line=>line.text));assert.ok(result.lyrics.lines.every(line=>line.timestamp===null));
  assert.equal(result.timingCorrection.status,'untimed_fallback');
 }
});

test('correction deadline returns readable fallback before the outer provider expires',async()=>{
 const result=await applyTimingCorrection(candidate,request,{deadline:Date.now()+120},{rules:[rule],fetchJSONFn:()=>new Promise(()=>{})});
 assert.equal(result.timingCorrection.status,'untimed_fallback');assert.ok(result.lyrics.lines.every(line=>line.timestamp===null));
});
test('identical normalized rows retain source spelling and character ranges',async()=>{
 const original={...candidate,lyrics:{lines:[{text:'Opening phrase!',timestamp:12},{text:'Second phrase',timestamp:20}]}};
 const bound={...rule,rejected:[timingFingerprint(original.lyrics)]};
 const result=await applyTimingCorrection(original,request,{}, {rules:[bound],fetchJSONFn:async()=>raw});
 assert.equal(result.lyrics.lines[0].text,'Opening phrase!');assert.equal(result.lyrics.lines[0].timestamp,9);
});
test('a reviewed catalog localization validates the replacement against its canonical artist',async()=>{
 const localized={...request,artist:'测试歌手'};
 const bound={...rule,artists:[request.artist,localized.artist],canonicalArtist:request.artist};
 const result=await applyTimingCorrection(candidate,localized,{}, {rules:[bound],fetchJSONFn:async()=>raw});
 assert.equal(result.timingCorrection.status,'replacement');assert.equal(result.target,localized);
});
