import test from 'node:test';
import assert from 'node:assert/strict';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {parseYRC} from '../../api/utils/netease-yrc.js';
import {chooseMeasuredLyricCandidate,hasCompleteMeasuredVocalTiming} from '../../api/utils/lyric-selection.js';

// Invented text and provider-format structures only; no captured song lyrics.
const credit=JSON.stringify({t:12000,c:[{tx:'人声 : '},{tx:'Example Performer',li:'https://example.invalid/artist',or:'artist:example'}]});
const lrc=['[00:01]Invented first line','[00:05]Invented second line'];
const yrc=['[1000,2000](1000,1000,0)Invented (2000,1000,0)first',
 '[5000,2000](5000,1000,0)Invented (6000,1000,0)second'];
const parse=raw=>new NeteaseAPI().parseLyrics(raw);

for(const position of [0,1,2])test(`NetEase structured credit at position ${position} stays out of LRC performed rows`,()=>{
 const rows=[...lrc];rows.splice(position,0,credit);
 assert.deepEqual(parse(rows.join('\n')),parse(lrc.join('\n')));
});
for(const position of [0,1,2])test(`NetEase structured credit at position ${position} preserves the same complete measured YRC edition`,()=>{
 const rows=[...yrc];rows.splice(position,0,credit);
 const baseline=parseYRC(yrc.join('\n'),{songId:'42',duration:30});
 const actual=parseYRC(rows.join('\n'),{songId:'42',duration:30});
 assert.ok(actual);assert.deepEqual(actual,baseline);
 const song={id:'42',duration:30};
 assert.equal(hasCompleteMeasuredVocalTiming({song,lyrics:actual}),true);
 const lineTimed={song,lyrics:{lines:parse(lrc.join('\n'))}};
 const measured={song,lyrics:actual};
 assert.equal(chooseMeasuredLyricCandidate(lineTimed,measured),measured);
});
test('timestamped sung JSON and unknown structured rows remain exact LRC text',()=>{
 const literal='[00:12]'+credit;
 const unknown=JSON.stringify({t:12,c:[{tx:'An invented literal'}],meaning:'performed'});
 const result=parse([...lrc,literal,unknown].join('\n'));
 assert.equal(result.at(-2).text,credit);assert.equal(result.at(-2).timestamp,12);
 assert.equal(result.at(-1).text,unknown);
});
test('unknown later YRC row refuses the edition rather than deleting possible words',()=>{
 const unknown=JSON.stringify({t:12,c:[{tx:'An invented literal'}],meaning:'performed'});
 assert.equal(parseYRC([...yrc,unknown].join('\n'),{songId:'42',duration:30}),null);
});
test('invalid or unbounded metadata structures are preserved by LRC and refuse later YRC',()=>{
 for(const row of [JSON.stringify({t:0,c:[]}),JSON.stringify({t:0,c:[{tx:'x',unknown:true}]}),
  JSON.stringify({t:0,c:[{tx:'x'.repeat(4097)}]}),JSON.stringify({t:7200001,c:[{tx:'x'}]}),'{broken']) {
  assert.equal(parse([...lrc,row].join('\n')).at(-1).text,row);
  assert.equal(parseYRC([...yrc,row].join('\n'),{songId:'42',duration:30}),null);
 }
});
test('structured metadata parsing remains bounded after performed rows',()=>{
 const rows=[...lrc,...Array(33).fill(credit)];
 const result=parse(rows.join('\n'));
 assert.deepEqual(result.slice(0,2),parse(lrc.join('\n')));
 assert.equal(result.length,3);assert.equal(result.at(-1).text,credit);
 assert.equal(parseYRC([...yrc,...Array(33).fill(credit)].join('\n'),{songId:'42',duration:30}),null);
});
