import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {nodeFileTrace}=createRequire(import.meta.url)('@vercel/nft');

test('both deployed lyric entrypoints trace the independent Spotify review registry',async()=>{
 for(const entry of ['api/music-romanize.js','api/song-library.js']) {
  const {fileList}=await nodeFileTrace([entry],{base:process.cwd()});
  assert.ok(fileList.has('api/utils/spotify-reviewed-source.js'),entry);
  assert.ok(fileList.has('api/utils/artist-discovery.js'),entry+' must retain automatic artist discovery');
  assert.ok(fileList.has('api/data/spotify-reviewed-sources.json'),entry+' must retain the reviewed source data');
 }
});
