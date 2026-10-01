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

test('reviewed title and album localizations stay bound to the exact catalog and fingerprint',async()=>{
 const localized={...request,title:'Example in another script',album:'Localized album',artist:'Localized singer'};
 const bound={...rule,titles:[request.title,localized.title],albums:[request.album,localized.album],
  artists:[request.artist,localized.artist],canonicalTitle:request.title,canonicalArtist:request.artist};
 const options={rules:[bound],fetchJSONFn:async()=>raw};
 assert.equal((await applyTimingCorrection(candidate,localized,{},options)).timingCorrection.status,'replacement');
 for(const change of [{catalog_id:'124'},{title:'Example (Live)'},{album:'Other'},{artist:'Cover singer'},{duration:101}]) {
  assert.equal(await applyTimingCorrection(candidate,{...localized,...change},{},{rules:[bound],fetchJSONFn:()=>assert.fail('must not fetch')}),candidate);
 }
 const changed=await applyTimingCorrection({...candidate,lyrics:replacement},localized,{},options);
 assert.equal(changed.timingCorrection,undefined);
});

test('cache repair detects note placeholders and exact rejected timing without invalidating other recordings',async()=>{
 const {lyricSourceNeedsRefresh,timingCorrections}=await import('../../api/utils/timing-corrections.js');
 const cached={lines:lyrics.lines.map(l=>({original:l.text,timestamp:l.timestamp}))};
 assert.equal(lyricSourceNeedsRefresh(cached,request,{rules:[rule]}),true);
 assert.equal(lyricSourceNeedsRefresh(cached,{...request,catalog_id:'124'},{rules:[rule]}),false);
 assert.equal(lyricSourceNeedsRefresh({lines:replacement.lines.map(l=>({original:l.text,timestamp:l.timestamp}))},request,{rules:[rule]}),false);
 assert.equal(lyricSourceNeedsRefresh({lines:[{original:'♪',timestamp:37.19}]},request),true);
 assert.equal(lyricSourceNeedsRefresh({lines:[{original:'Sing ♪ with me',timestamp:37.19}]},request),false);
 const reviewed=timingCorrections.find(r=>r.catalog_id==='1560789314');
 assert.deepEqual(reviewed.titles,['獨角戲','Du Jiao Xi']);
 assert.deepEqual(reviewed.albums,['茹此精彩十三首','So Bravo 13 Songs']);
 assert.equal(reviewed.replacementID,11773385);
 assert.equal(reviewed.duration,277.093);
});

test('reviewed replacement rejects metadata drift and clears every fallback timeline representation',async()=>{
 const {cleanLyrics}=await import('../../api/utils/lyric-quality.js');
 const source={...candidate,lyrics:cleanLyrics(lyrics)};
 const bound={...rule,replacementSignature:{title:request.title,artist:request.artist,album:request.album,duration:100}};
 for(const change of [{albumName:'Another album'},{duration:101},{trackName:'Example (Live)'},{artistName:'Cover singer'}]) {
  const result=await applyTimingCorrection(source,request,{}, {rules:[bound],fetchJSONFn:async()=>({...raw,...change})});
  assert.equal(result.timingCorrection.status,'untimed_fallback');
  assert.ok(result.lyrics.lines.every(l=>l.timestamp===null));
  assert.ok(result.lyrics.lyricStructure.sourceRows.every(l=>l.timestamp===null));
 }
});
