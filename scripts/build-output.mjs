// Explicit Build Output API v3. Helpers are traced runtime files, never routes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(import.meta.url),u=require('@vercel/build-utils'),{build}=require('@vercel/node');
const execute=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const manifest=JSON.parse(await fs.readFile(new URL('./vercel-functions.json',import.meta.url),'utf8'));
// Runtime bundles need dependency/module identity, never package lifecycle hooks.
// The outer explicit static carrier owns the one and only packaging invocation.
export function isolatedBuilderPackage(packageJSON){return {...packageJSON,scripts:{}};}
export function runtimeConfiguration(lambda){
 return {runtime:lambda.runtime,handler:lambda.handler,launcherType:lambda.launcherType,shouldAddHelpers:lambda.shouldAddHelpers,shouldAddSourcemapSupport:lambda.shouldAddSourcemapSupport,supportsResponseStreaming:lambda.supportsResponseStreaming,maxDuration:lambda.maxDuration,regions:lambda.regions,experimentalTriggers:lambda.experimentalTriggers};
}
export const notFoundPath='/_lyrica-not-found.json';
export function deploymentRoutes(routes){return [...routes,{src:'/.*',dest:notFoundPath,status:404}];}
export async function packageFunctions({workPath=root,output=path.join(workPath,'.vercel/output'),preflight=true}={}){
 if(process.versions.node.split('.')[0]!=='24')throw new Error('node24_required');
 if(preflight)await execute(process.execPath,[path.join(workPath,'scripts/vercel-library-build.js')],{cwd:workPath});
 await fs.mkdir(path.join(workPath,'.vercel'),{recursive:true});
 const stage=await fs.mkdtemp(path.join(workPath,'.vercel','build-stage-'));
 try{
 await fs.cp(path.join(workPath,'node_modules'),path.join(stage,'node_modules'),{recursive:true});
 await fs.rm(output,{recursive:true,force:true});await fs.mkdir(path.join(output,'functions'),{recursive:true});
 const sourceRefs=await u.glob('**',{cwd:workPath,ignore:['.git/**','.vercel/**','node_modules/**','artifacts/**']});
 const input={};
 // Materialize bytes before any builder download; never self-copy FileFsRef.
 for(const [name,file] of Object.entries(sourceRefs))input[name]=new u.FileBlob({data:await fs.readFile(file.fsPath)});
 // The builder must not rediscover/run this package's build hooks once per entry.
 const packageJSON=JSON.parse(await fs.readFile(path.join(workPath,'package.json'),'utf8'));
 input['package.json']=new u.FileBlob({data:JSON.stringify(isolatedBuilderPackage(packageJSON))});
 const selected={functions:Object.fromEntries(manifest.entries.map(({entry,...config})=>[entry,config]))},inventory=[];
 for(const {entry,includeFiles,...options} of manifest.entries){
  const built=await build({files:input,entrypoint:entry,workPath:stage,config:{nodeVersion:'24.x',projectSettings:{installCommand:'',buildCommand:''},includeFiles},meta:{},considerBuildCommand:true});
  const opts=await u.getLambdaOptionsFromFunction({sourceFile:entry,config:selected});
  const lambda=new u.NodejsLambda({files:built.output.files,handler:built.output.handler,runtime:built.output.runtime,launcherType:built.output.launcherType,shouldAddHelpers:built.output.shouldAddHelpers,shouldAddSourcemapSupport:built.output.shouldAddSourcemapSupport,supportsResponseStreaming:built.output.supportsResponseStreaming,...opts});
  if(lambda.runtime!=='nodejs24.x')throw new Error('nondev_node24_output_required');
  const name=entry.replace(/\.js$/,''),dir=path.join(output,'functions',name+'.func');await fs.mkdir(dir,{recursive:true});
  for(const [relative,file] of Object.entries(lambda.files)){
   const dest=path.join(dir,relative);await fs.mkdir(path.dirname(dest),{recursive:true});await pipeline(file.toStream(),createWriteStream(dest));
  }
  // Preserve the builder's actual launcher and helper behavior and the processed
  // trigger shape required by Lambda deserialization (including consumer).
  const vc=runtimeConfiguration(lambda);
  if(['api/music-romanize.js','api/song-library.js'].includes(entry)&&vc.supportsResponseStreaming!==true)throw new Error('lyric_response_streaming_required');
  await fs.writeFile(path.join(dir,'.vc-config.json'),JSON.stringify(vc,null,2)+'\n');
  const required=[...new Set((await Promise.all((includeFiles??[]).map(pattern=>u.glob(pattern,stage)))).flatMap(files=>Object.keys(files)))];
  for(const included of required)await fs.access(path.join(dir,included));
  for(const trigger of vc.experimentalTriggers??[])if(!trigger.consumer)throw new Error('processed_consumer_required');
  if(entry.includes('_spotify-')&&!(vc.experimentalTriggers?.length))throw new Error('private_trigger_required');
  inventory.push({entry,output:name+'.func',...vc,files:Object.keys(lambda.files).length,includes:required});
 }
 // A status-only fallback may still execute a public function at the incoming
 // path. Resolve unknown URLs to inert static bytes instead.
 await fs.mkdir(path.join(output,'static'),{recursive:true});
 await fs.writeFile(path.join(output,'static',notFoundPath),JSON.stringify({version:1,code:'not_found'})+'\n');
 const config={version:3,routes:deploymentRoutes(manifest.routes),crons:manifest.crons};
 await fs.writeFile(path.join(output,'config.json'),JSON.stringify(config,null,2)+'\n');
 const receipt={node:process.version,builder:require('@vercel/node/package.json').version,mode:'non-development meta:{}',preflightRuns:preflight?1:0,functionCount:inventory.length,publicRoutes:manifest.routes,privateConsumers:inventory.filter(x=>x.experimentalTriggers),terminal404:true,crons:config.crons,functions:inventory,deployed:false};
 await fs.writeFile(path.join(output,'packaging-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 return receipt;
 }finally{await fs.rm(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const receipt=await packageFunctions();console.log(JSON.stringify({functionCount:receipt.functionCount,publicRoutes:receipt.publicRoutes.length,privateConsumers:receipt.privateConsumers.length,node:receipt.node,builder:receipt.builder}));}catch(error){console.error('Explicit function packaging failed:',error.message);process.exitCode=1;}}
