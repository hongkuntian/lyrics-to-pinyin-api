import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {manifest} from './build-output.mjs';
const execute=promisify(execFile),root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),out=path.join(root,'.vercel/output');
const config=JSON.parse(await fs.readFile(path.join(out,'config.json'))),receipt=JSON.parse(await fs.readFile(path.join(out,'packaging-receipt.json')));
assert.equal(config.version,3);assert.equal(receipt.functionCount,12);assert.equal(receipt.preflightRuns,1);assert.equal(receipt.mode,'non-development meta:{}');assert.equal(receipt.builder,'24.0.2');
assert.deepEqual(config.routes,[...manifest.routes,{src:'/.*',status:404}]);assert.deepEqual(config.crons,manifest.crons);
assert.equal(manifest.routes.length,10);assert.equal(receipt.privateConsumers.length,2);
const functions=await fs.readdir(path.join(out,'functions/api'));assert.deepEqual(functions.sort(),manifest.entries.map(x=>path.basename(x.entry,'.js')+'.func').sort());
const includes=[],runtime=[];
for(const entry of manifest.entries){
 const dir=path.join(out,'functions',entry.entry.replace(/\.js$/,'')+'.func'),vc=JSON.parse(await fs.readFile(path.join(dir,'.vc-config.json')));
 assert.equal(vc.runtime,'nodejs24.x');assert.equal(vc.launcherType,'Nodejs');assert.equal(vc.shouldAddHelpers,true);assert((await fs.stat(path.join(dir,vc.handler))).size>0);
 if(['api/music-romanize.js','api/song-library.js'].includes(entry.entry))assert.equal(vc.supportsResponseStreaming,true);
 if(entry.maxDuration)assert.equal(vc.maxDuration,entry.maxDuration);
 for(const trigger of vc.experimentalTriggers??[]){assert(trigger.consumer);assert.equal(trigger.retryAfterSeconds,2);assert.equal(trigger.maxDeliveries,128);}
 const inventory=receipt.functions.find(x=>x.entry===entry.entry);
 for(const file of inventory.includes){const actual=await fs.readFile(path.join(dir,file)),expected=await fs.readFile(path.join(root,file));assert(actual.length>0);assert.deepEqual(actual,expected);includes.push({entry:entry.entry,file,bytes:actual.length,sha256:createHash('sha256').update(actual).digest('hex')});}
 if(!entry.experimentalTriggers){
  // Account-free import + non-mutating method rejection from the emitted bytes.
  const program=`import handler from ${JSON.stringify(pathToFileURL(path.join(dir,vc.handler)).href)};let status=200;const res={setHeader(){},status(n){status=n;return this},json(){return this},end(){return this},send(){return this}};await handler({method:'OPTIONS',headers:{},body:null},res);console.log(JSON.stringify({status}));`;
  const {stdout}=await execute(process.execPath,['--input-type=module','-e',program],{cwd:dir});const result=JSON.parse(stdout.trim().split('\n').at(-1));assert([200,204,400,401,405].includes(result.status));runtime.push({entry:entry.entry,...result});
 }
}
const blocked=['/api/_spotify-tick','/api/_spotify-acquire','/api/utils/spotify/service.js','/api/data/lyric-performers.json','/api/song-library.js'];
for(const url of blocked){const matched=config.routes.find(route=>new RegExp('^(?:'+route.src+')$').test(url));assert.equal(matched.status,404);}
const proof={node:process.version,functionCount:12,publicRoutes:10,privateConsumers:2,sourceBytesMatch:true,includes,nonMutatingRuntimeImports:runtime,blocked,terminal404:true,deployed:false,queueRegistration:false,platformWaitUntil:false};
await fs.writeFile(path.join(out,'verification-receipt.json'),JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify({functions:12,publicRoutes:10,privateConsumers:2,actualIncludeChecks:includes.length,runtimeImports:runtime.length,terminal404:true,deployed:false}));
