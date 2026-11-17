import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {manifest,deploymentRoutes} from '../../scripts/build-output.mjs';

// Spotify is native-only (App Remote in the app). The backend serves Spotify
// recording lyrics and the app-fed Live Lyrics relay, and nothing else: no
// Spotify gateway, Web API requests, server-held grants or scheduled polling.
const root=new URL('../../',import.meta.url);
async function sources(directory){
 const files=[];
 for(const entry of await readdir(new URL(directory,root),{withFileTypes:true})){
  const path=directory+'/'+entry.name;
  if(entry.isDirectory())files.push(...await sources(path));
  else if(/\.(?:js|mjs|cjs|json)$/.test(entry.name))files.push(path);
 }
 return files;
}

test('packaging routes no Spotify gateway and subscribes no private consumers',()=>{
 assert.equal(manifest.entries.length,8);assert.equal(manifest.routes.length,9);
 assert.deepEqual(manifest.crons,[{path:'/api/review-reports',schedule:'0 8 * * *'}]);
 assert.equal(manifest.entries.flatMap(x=>x.experimentalTriggers??[]).length,0);
 assert.equal(manifest.entries.find(x=>x.entry==='api/song-library.js').maxDuration,300);
 assert.equal(manifest.entries.find(x=>x.entry==='api/live-lyrics.js').maxDuration,15);
 assert.deepEqual(manifest.routes.find(x=>x.src==='/api/live-lyrics'),{src:'/api/live-lyrics',dest:'/api/live-lyrics'});
 const spotify=deploymentRoutes(manifest.routes).find(route=>new RegExp('^(?:'+route.src+')$').test('/api/spotify'));
 assert.deepEqual(spotify,{src:'/.*',dest:'/_lyrica-not-found.json',status:404});
});

test('runtime and packaging sources hold no Spotify Web API, grant vault or queue polling path',async()=>{
 const forbidden=[
  [/api\.spotify\.com|\/v1\/me\/player/,'Spotify Web API request'],
  [/accounts\.spotify\.com/,'server-side Spotify token exchange or refresh'],
  [/spotify_(?:connections|outbox|snapshot_capabilities|provider_circuits)/,'retired Spotify observer table'],
  [/LYRICA_SPOTIFY_/,'retired Spotify broker configuration'],
  [/@vercel\/queue|queue\/v2beta|spotify-background-(?:tick|acquire)/,'scheduled queue consumer'],
  [/(?:import|from)\s*\(?['"][^'"]*\/spotify\/[^'"]*['"]|lyrica_w_/,'retired Spotify broker module or widget capability']
 ];
 const files=[...await sources('api'),...await sources('scripts'),'package.json','vercel.json'];
 assert.ok(files.length>100);
 for(const file of files){
  const text=await readFile(new URL(file,root),'utf8');
  for(const [pattern,label] of forbidden)assert.doesNotMatch(text,pattern,`${file}: ${label}`);
 }
 const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
 assert.equal(Object.hasOwn(pkg.dependencies,'@vercel/queue'),false);
});
