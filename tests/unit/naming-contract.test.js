import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../..',import.meta.url));
const policy=JSON.parse(await readFile(new URL('../../docs/NAMING_HISTORY.json',import.meta.url),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
async function files(directory){
 const result=[];
 for(const entry of await readdir(path.join(root,directory),{withFileTypes:true})){
  const name=path.posix.join(directory,entry.name);
  if(entry.isDirectory()){
   if(!['node_modules','.git','.next','artifacts'].includes(entry.name))result.push(...await files(name));
  }else if(entry.isFile())result.push(name);
 }
 return result;
}

test('current source uses only canonical naming and historical exceptions remain byte-exact',async()=>{
 const exceptions=new Map(policy.exceptions.map(entry=>[entry.path,entry]));
 assert.equal(exceptions.size,policy.exceptions.length);
 for(const [name,entry] of exceptions){
  assert.ok(entry.reason.length>15,name);
  if(entry.sha256)assert.equal(hash(await readFile(path.join(root,name))),entry.sha256,name+' historical bytes changed');
 }
 const roots=['api','dashboard/src','dashboard/tests','db','docs','evaluation','experiments','scripts','tests'];
 const selected=(await Promise.all(roots.map(files))).flat();
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(entry.isFile()&&/\.(?:md|json|ya?ml|js|mjs|ts)$/i.test(entry.name))selected.push(entry.name);
 }
 const unexpected=[];
 for(const name of selected){
  const bytes=await readFile(path.join(root,name));if(bytes.includes(0))continue;
  if(/lyra/iu.test(bytes.toString('utf8'))&&!exceptions.has(name))unexpected.push(name);
 }
 assert.deepEqual(unexpected,[],'Old-brand references require removal or an explicit reviewed historical exception');
});
