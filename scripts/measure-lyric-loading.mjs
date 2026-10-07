// Opt-in real-provider benchmark. Never calls translation, explanation, or paid generation.
// Library writes are confined to an ephemeral local PGlite database.
import {parseArgs} from 'node:util';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const {values}=parseArgs({options:{corpus:{type:'string'},output:{type:'string'},'env-file':{type:'string'},id:{type:'string'},repeat:{type:'string',default:'1'},'source-revision':{type:'string'}}});
if(!values.corpus||!values.output)throw new Error('Use --corpus <metadata.json> --output <external-directory> [--env-file <local configuration>]');
if(values['env-file']) {
  const {parse}=await import('dotenv');
  const env=parse(await readFile(values['env-file']));
  // Catalog credentials may improve identity verification. Production database,
  // Redis, paid model credentials and access tokens are deliberately not loaded.
  for(const key of ['APPLE_MUSIC_TEAM_ID','APPLE_MUSIC_KEY_ID','APPLE_MUSIC_PRIVATE_KEY','LYRA_CATALOG_RESOLUTION_ENABLED','LYRA_CATALOG_EQUIVALENTS_ENABLED'])
    if(env[key])process.env[key]=env[key];
}
const [{createMusicRomanizeService,SELECTION_REVISION},{createSongLibraryService,lyricLoader},{libraryDB},{createMockReq,createMockRes}]=await Promise.all([
  import('../api/music-romanize.js'),import('../api/song-library.js'),import('../tests/helpers/library-db.js'),import('../tests/helpers/mock-http.js')]);
const output=resolve(values.output);await mkdir(output,{recursive:true});
const corpus=JSON.parse(await readFile(values.corpus));
const cases=corpus.recordings.filter(r=>!values.id||r.catalog_id===values.id);
const repeats=Number(values.repeat);if(!Number.isInteger(repeats)||repeats<1||repeats>5)throw new Error('repeat must be 1...5');
const revision=values['source-revision']??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[0-9a-f]{7,40}$/.test(revision))throw new Error('source-revision must identify the archived source commit');
const logger={info(){},error(){}};
const results=[];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fingerprint(directory) {
  const files=[];
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=join(directory,entry.name);
    if(entry.isDirectory())files.push([entry.name,await fingerprint(path)]);
    else files.push([entry.name,createHash('sha256').update(await readFile(path)).digest('hex')]);
  }
  return hash(files);
}
const sourceFingerprint=await fingerprint('api');
async function invoke(handler,body,extra={}) {
  const res=createMockRes(),start=performance.now();
  await handler({...createMockReq({body}),...extra},res);
  return {res,elapsedMs:performance.now()-start};
}
async function capture(recording,stage,iteration,handler,body,extra={}) {
  const {res,elapsedMs}=await invoke(handler,body,extra),response=res.body.document?.response??res.body;
  const file=`${recording.catalog_id}-${iteration}-${stage}.json`;
  await writeFile(join(output,file),JSON.stringify(res.body,null,2));
  const row={catalogID:recording.catalog_id,language:recording.expectedLanguage,stage,iteration,status:res.statusCode,
    elapsedMs,cache:res.headers['X-Lyrics-Cache']??null,serverTiming:res.headers['Server-Timing']??null,
    code:res.body.code??null,state:res.body.state??null,source:response.metadata?.source??null,sourceID:response.song?.id??null,
    actualLanguage:response.song?.language??null,quality:response.quality??null,rows:response.lines?.length??0,
    timedRows:response.lines?.filter(l=>Number.isFinite(l.timestamp)).length??0,
    sourceHash:response.lines?hash(response.lines.map(l=>[l.original,l.timestamp])):null,
    recordingMatch:response.metadata?.recording_match??null,artifact:file};
  results.push(row);console.log(JSON.stringify(row));
  await writeFile(join(output,'measurements.json'),JSON.stringify({revision,sourceFingerprint,harnessFingerprint:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),capturedAt:new Date().toISOString(),mode:'local-real-providers-ephemeral-library',
    limitations:['HTTP transport, app attestation and production database latency excluded; measured separately on device.','Cold resets handler caches; process-level catalog and tokenizer caches may be warm after the first song.'],corpus,results},null,2));
  return res;
}
for(let iteration=0;iteration<repeats;iteration++) {
  const {db,store}=await libraryDB();
  try {
    for(const item of cases) {
      const {expectedLanguage,pronunciationContext,...recording}=item;
      const pending=[];
      const music=createMusicRomanizeService({redis:null,logger,waitUntilFn:p=>pending.push(p)});
      const body={...recording,options:{tone_style:'marks',separator:' ',case:'lower'}};
      await capture(item,'provider-cold',iteration,music,body);
      await capture(item,'provider-revisit',iteration,music,body);
      const library=createSongLibraryService({store,logger,loadLyrics:lyricLoader(music),selectionRevision:SELECTION_REVISION,waitUntilFn:p=>pending.push(p),
        generateFn:()=>{throw new Error('Paid generation forbidden in loading benchmark');},explainFn:()=>{throw new Error('Paid generation forbidden in loading benchmark');}});
      const extra={lyricaUser:{id:'reader-a'}};
      const first=await capture(item,'library-first',iteration,library,{action:'lyrics',recording},extra);
      await capture(item,'library-revisit',iteration,library,{action:'lyrics',recording},extra);
      const doc=first.body.document;
      if(doc) {
        for(const profile of doc.response.song.language==='ja'?['ja-hepburn','ja-kana']:doc.response.song.language==='ko'?['ko-revised']:[]) {
          await capture(item,profile,iteration,library,{action:'pronunciation',documentID:doc.id,sourceHash:doc.sourceHash,profileID:profile},extra);
        }
      }
      await Promise.allSettled(pending);
    }
  } finally {await db.close();}
}
