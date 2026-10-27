import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const code=`
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
await import(pathToFileURL(resolve(process.cwd(),process.argv[1])));
const recording=await import(pathToFileURL(resolve(process.cwd(),'api/utils/song-library/spotify-recording.js')));
const observation=await import(pathToFileURL(resolve(process.cwd(),'api/utils/spotify/observation.js')));
const {SongLibraryStore}=await import(pathToFileURL(resolve(process.cwd(),'api/utils/song-library/store.js')));
assert.equal(observation.recordingFingerprint,recording.spotifyRecordingKey);
let calls=0;new SongLibraryStore({query(){calls++;throw Error('constructor SQL');},transaction(){calls++;throw Error('constructor SQL');}});
assert.equal(calls,0);
`;
// Fresh ESM graphs: a previous import must not mask an initialization cycle.
for(const entry of ['song-library/spotify-recording.js','song-library/store.js','spotify/observation.js',
 'spotify/revocation.js','membership/accounts.js','listening-v2/privacy-writers.js'])
 test('actual lifecycle dependency graph initializes with '+entry+' first',()=>{
  const child=spawnSync(process.execPath,['--input-type=module','--eval',code,'api/utils/'+entry],
   {cwd:root,encoding:'utf8',timeout:5000,maxBuffer:65536});
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr);
 });
