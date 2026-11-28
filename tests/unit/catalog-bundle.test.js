import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('both deployed lyric entrypoints explicitly package reviewed catalog evidence',async()=>{
  const config=JSON.parse(await readFile(new URL('../../scripts/vercel-functions.json',import.meta.url)));
  const asset='api/data/reviewed-catalog-aliases.json';
  for(const entry of ['api/music-romanize.js','api/song-library.js'])
    for(const file of [asset,'api/data/lyric-performers.json'])
      assert.ok(config.entries.find(b=>b.entry===entry)?.includeFiles.includes(file),entry+': '+file);
  const registry=JSON.parse(await readFile(new URL('../../'+asset,import.meta.url)));
  assert.ok(registry.recordings.length>0);
});

test('the prepared content entrypoints explicitly package the starter-song pool',async()=>{
  const config=JSON.parse(await readFile(new URL('../../scripts/vercel-functions.json',import.meta.url)));
  const asset='api/data/starter-songs.json';
  assert.ok(config.entries.find(b=>b.entry==='api/song-library.js')?.includeFiles.includes(asset));
  assert.deepEqual(config.entries.filter(b=>b.includeFiles?.includes(asset)).map(b=>b.entry),['api/song-library.js','api/shared-prepared-content.js']);
  assert.equal(Object.keys(JSON.parse(await readFile(new URL('../../'+asset,import.meta.url))).languages).length,6);
});
