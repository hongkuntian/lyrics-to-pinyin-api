import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('both deployed lyric entrypoints explicitly package reviewed catalog evidence',async()=>{
  const config=JSON.parse(await readFile(new URL('../../vercel.json',import.meta.url)));
  const asset='api/data/reviewed-catalog-aliases.json';
  for(const entry of ['api/music-romanize.js','api/song-library.js'])
    assert.ok(config.builds.find(b=>b.src===entry)?.config?.includeFiles.includes(asset),entry);
  const registry=JSON.parse(await readFile(new URL('../../'+asset,import.meta.url)));
  assert.ok(registry.recordings.length>0);
});
