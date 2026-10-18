import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {manifest,deploymentRoutes,notFoundPath} from './build-output.mjs';
const execute=promisify(execFile),root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),out=path.join(root,'.vercel/output');
const config=JSON.parse(await fs.readFile(path.join(out,'config.json'))),receipt=JSON.parse(await fs.readFile(path.join(out,'packaging-receipt.json')));
assert.equal(config.version,3);assert.equal(receipt.functionCount,12);assert.equal(receipt.preflightRuns,1);assert.equal(receipt.mode,'non-development meta:{}');assert.equal(receipt.builder,'24.0.2');
assert.deepEqual(config.routes,deploymentRoutes(manifest.routes));assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'static',notFoundPath))),{version:1,code:'not_found'});assert.deepEqual(config.crons,manifest.crons);
assert.equal(manifest.routes.length,11);assert.equal(receipt.privateConsumers.length,3);assert.equal(receipt.privateConsumers.flatMap(x=>x.experimentalTriggers).length,3);
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
 }
// Exercise every canonical route from the actual emitted bytes, including both
// selectors in each shared HTTP entry point. Never create an account or write data.
async function invoke(route,{method='OPTIONS',query={},body=null,expected}={}){
 const url=new URL(route.dest,'https://packaging.invalid'),dir=path.join(out,'functions',url.pathname+'.func');
 const vc=JSON.parse(await fs.readFile(path.join(dir,'.vc-config.json')));
 const request={method,headers:{},body,query:{...Object.fromEntries(url.searchParams),...query}};
 const program=`import handler from ${JSON.stringify(pathToFileURL(path.join(dir,vc.handler)).href)};let status=200,payload=null;const res={setHeader(){},status(n){status=n;return this},json(v){payload=v;return this},end(v){payload=v;return this},send(v){payload=v;return this}};await handler(${JSON.stringify(request)},res);console.log(JSON.stringify({status,payload}));`;
 const {stdout}=await execute(process.execPath,['--input-type=module','-e',program],{cwd:dir,env:{...process.env,LYRA_STORE_BUNDLE_ID:'invalid.example.emitted-proof',LYRA_STORE_APP_APPLE_ID:'1'}});
 const result=JSON.parse(stdout.trim().split('\n').at(-1));
 if(expected!==undefined)assert.equal(result.status,expected);else assert([200,204,400,401,405].includes(result.status));
 runtime.push({route:route.src,method,status:result.status});return result;
}
for(const route of manifest.routes)await invoke(route);
const sessions=manifest.routes.find(x=>x.src==='/api/sessions');
const invitation=await invoke(sessions,{method:'GET',query:{join:'a'.repeat(32)},expected:200});
assert.match(invitation.payload,/lyrica:\/\/sessions\/join\?invite=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
const invalid=await invoke(sessions,{method:'GET',query:{join:'invalid',format:'json'},expected:404});assert.equal(invalid.payload.code,'session_not_found');
await invoke(sessions,{method:'POST',body:{version:1,action:'list'},expected:401});
await invoke(manifest.routes.find(x=>x.src==='/api/store-notifications'),{method:'POST',body:{signedPayload:'not-a-jws'},expected:403});

const blocked=['/api/_spotify-tick','/api/_spotify-acquire','/api/_listening-tick','/api/provider-gateway','/api/billing-gateway','/api/sessions.js','/api/utils/spotify/service.js','/api/data/lyric-performers.json','/api/song-library.js'];
for(const url of blocked){const matched=config.routes.find(route=>new RegExp('^(?:'+route.src+')$').test(url));assert.equal(matched.status,404);assert.equal(matched.dest,notFoundPath);}
const proof={node:process.version,functionCount:12,publicRoutes:11,privateConsumers:3,sourceBytesMatch:true,includes,nonMutatingRuntimeImports:runtime,blocked,terminal404:true,deployed:false,queueRegistration:false,platformWaitUntil:false};
await fs.writeFile(path.join(out,'verification-receipt.json'),JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify({functions:12,publicRoutes:11,privateConsumers:3,actualIncludeChecks:includes.length,runtimeImports:runtime.length,terminal404:true,deployed:false}));
