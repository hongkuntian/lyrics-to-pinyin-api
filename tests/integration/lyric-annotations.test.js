import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeHandler} from '../../api/music-romanize.js';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {parseTranslation,requestBody} from '../../api/utils/song-library/translation.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {libraryDB} from '../helpers/library-db.js';
import {createSongLibraryHandler} from '../../api/song-library.js';
const recording={catalog_id:'1835909383',artist:'TOP登陆少年组合',title:'流星雨',album:'流星雨',duration:271.291};
const data={source:'netease',lines:[{text:'编曲Arrangement：Example',timestamp:0},
  {text:'合：',timestamp:5},{text:'一起唱这首歌',timestamp:6},
  {text:'张极Jeremy：',timestamp:10},{text:'我说：别走',timestamp:11},
  {text:'张泽禹Zack/左航LEFT：再唱一遍',timestamp:20},{text:'一起唱这首歌',timestamp:23}]};
async function response({reviewed=false,cache}={}) {
  const song={...recording,id:2734065329};
  const api={name:'NeteaseAPI',searchSong:async()=>song,getLyrics:async()=>data};
  const candidate={song,lyrics:cleanLyrics(data),api,target:recording};
  const handler=createMusicRomanizeHandler({redis:cache?{}:null,getCachedFn:async()=>cache,
    setCachedFn:async()=>{},waitUntilFn:()=>{},getAvailableAPIsFn:()=>[api],
    lookupReviewedRecordingFn:async()=>reviewed?candidate:null,lookupOfficialTranscriptionFn:async()=>null,
    resolveCatalogAliasesFn:async()=>[],logger:{error(){}}});
  const res=createMockRes();await handler(createMockReq({body:recording}),res);
  assert.equal(res.statusCode,200);return res.body;
}
test('normal and reviewed paths normalize before pinyin and preserve source turn metadata',async()=>{
  for(const reviewed of [false,true]) {
    const result=await response({reviewed});
    assert.deepEqual(result.lines.map(l=>[l.original,l.timestamp]),[
      ['一起唱这首歌',6],['我说：别走',11],['再唱一遍',20],['一起唱这首歌',23]]);
    assert.ok(result.lines.every(l=>!l.romanized.includes('Jeremy')&&!l.romanized.includes('Arrangement')));
    const doc=makeDocument(recording,result,result.metadata.selection_revision);
    assert.deepEqual(doc.structure.occurrences.map(o=>o.sourceIndex),[2,4,5,6]);
    assert.equal(doc.structure.sourceRows.length,7);
    const translated=parseTranslation(JSON.stringify({translations:{L0001:'Sing this song together.',L0002:'I say: stay.',L0003:'Sing it again.',L0004:'Sing this song together.'},sourceNotes:[]}),doc);
    assert.equal(translated.lines[2].text,'Sing it again.');assert.equal(translated.lines[2].startsTurn,true);
    assert.equal(translated.lines[2].speakerID,doc.structure.occurrences[2].speakerID);
    const input=JSON.parse(requestBody(doc).input[0].content);
    assert.equal(input.sourceDocument.sourceRows,undefined);
    assert.equal(input.sourceDocument.occurrences.length,4);
  }
});
test('saved annotations cannot attach to shifted, edited or malformed lyric rows',async()=>{
  const result=await response();
  for(const mutate of [
    r=>r.lines.reverse(),
    r=>r.metadata.lyric_structure.occurrences[0].sourceIndex=0,
    r=>r.metadata.lyric_structure.occurrences[0].speakerID='unknown',
    r=>r.metadata.lyric_structure.occurrences[2].sourcePrefix='wrong'
  ]) {
    const changed=structuredClone(result);mutate(changed);
    assert.throws(()=>makeDocument(recording,changed,'test'),{code:'invalid_source_structure'});
  }
});
test('old server cache is replaced and the clean document has a distinct source identity',async()=>{
  const fresh=await response(),old=structuredClone(fresh);
  old.metadata.selection_revision='lyrics-selection-2026-09-13-reviewed-text';
  delete old.metadata.lyric_structure;
  old.lines=[{original:'张极Jeremy：',romanized:'zhāng jí Jeremy',timestamp:10},...fresh.lines];
  const oldDoc=makeDocument(recording,old,old.metadata.selection_revision);
  const current=await response({cache:old}),doc=makeDocument(recording,current,current.metadata.selection_revision);
  assert.notEqual(doc.id,oldDoc.id);assert.notEqual(doc.sourceHash,oldDoc.sourceHash);
  assert.deepEqual(current.lines,fresh.lines);
});

test('lyrics, cached translation and job status remain compatible with API v1 clients',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());
  const source=await response(),pending=[];
  const handler=createSongLibraryHandler({store,apiKey:'fixture',selectionRevision:source.metadata.selection_revision,
    loadLyrics:async()=>source,waitUntilFn:task=>pending.push(task),generateFn:async doc=>({actualMicros:1000,response:{},
      content:parseTranslation(JSON.stringify({translations:{L0001:'Sing together.',L0002:'I say: stay.',L0003:'Sing it again.',L0004:'Sing together once more.'},sourceNotes:[]}),doc)})});
  async function call(body) {
    const res=createMockRes();await handler({method:'POST',headers:{authorization:'Bearer token-a'},body},res);return res;
  }
  const loaded=await call({action:'lyrics',recording});assert.equal(loaded.statusCode,200);
  const wire=loaded.body.document,canonical=await store.document(wire.id);
  assert.equal(wire.structure.version,'source-speakers-1');
  assert.equal(canonical.structure.version,'lyric-annotations-1');
  assert.deepEqual(wire.response.metadata.lyric_structure,canonical.structure);
  for(const [i,o] of wire.structure.occurrences.entries()) {
    assert.equal(o.sourceText,wire.response.lines[i].original);
    assert.equal(o.sourcePrefix+o.lyricText,o.sourceText);assert.equal(o.startsTurn,false);
  }
  const started=await call({action:'translate',documentID:wire.id,sourceHash:wire.sourceHash});
  assert.equal(started.statusCode,202);await Promise.all(pending);
  const cached=await call({action:'translate',documentID:wire.id,sourceHash:wire.sourceHash});
  const status=await call({action:'status',jobID:started.body.job.id});
  assert.equal(cached.statusCode,200);assert.equal(status.statusCode,200);
  assert.deepEqual(cached.body.translation,status.body.translation);
  assert.ok(cached.body.translation.lines.every(l=>l.text===l.lyricText && !l.startsTurn));
  assert.ok((await store.translation(wire.id,'en')).lines.some(l=>l.startsTurn));
  assert.deepEqual((await store.document(wire.id)).structure,canonical.structure);
});
