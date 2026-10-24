#!/usr/bin/env node
// Offline reproducible compiler. Inputs must be exact pinned files; never downloads.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {fileURLToPath} from 'node:url';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const hash=x=>sha(canonical(x));
const maxFile=64*1024*1024;
async function pinned(file,pin){const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>maxFile||st.size!==pin.bytes)throw Error('Source file size/type/pin mismatch: '+file);const b=await fs.readFile(file);if(sha(b)!==pin.sha256)throw Error('Source SHA mismatch: '+file);return b;}
async function* rawLines(file,gzip,expandedCap){
  const input=createReadStream(file),stream=gzip?input.pipe(createGunzip()):input;let pending=Buffer.alloc(0),offset=0,line=0;
  try{for await(const chunk of stream){pending=Buffer.concat([pending,chunk]);if(pending.length>8*1024*1024)throw Error('Raw row cap');let end;
    while((end=pending.indexOf(10))>=0){const raw=pending.subarray(0,end+1);if(offset+raw.length>expandedCap)throw Error('Expanded input cap');yield {raw,line:++line,offset};offset+=raw.length;pending=pending.subarray(end+1);}}
    if(pending.length){if(offset+pending.length>expandedCap)throw Error('Expanded input cap');yield {raw:pending,line:++line,offset};}
  }finally{stream.destroy();input.destroy();}
}
const add=(map,key,entry)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(entry);};
const entryID=(datasetID,locator,key,value)=>sha(JSON.stringify(['entry-1',datasetID,locator,key,value]));
function compactEntry(dataset,e,source){
  if(dataset==='thai')return [e.id,e.value,e.recordSHA256,e.soundSHA256,e.line,e.byteOffset,e.byteLength,e.soundIndex,e.pos,e.qualifiers];
  if(dataset==='hindi')return [e.id,e.value,source.members.findIndex(m=>m.member===e.member),e.line,e.byteOffset,e.byteLength,e.recordSHA256,e.attestedAlias,e.attestationCount];
  return [e.id,e.value,e.pos,e.line,e.byteOffset,e.byteLength,e.recordSHA256];
}
async function writeDataset(output,id,entries,source,options={}){
  const count=64,descriptors=[];await fs.mkdir(path.join(output,id,'shards'),{recursive:true});
  let keyCount=0,entryCount=0,maxEntryBytes=0;
  for(let n=0;n<count;n++){
    const rows=[];for(const key of [...entries.keys()].sort())if(parseInt(sha(key).slice(0,2),16)%count===n){
      const unique=[...new Map(entries.get(key).map(e=>[e.id,e])).values()].sort((a,b)=>a.id<b.id?-1:1),line=canonical([key,unique.map(e=>compactEntry(id,e,source))])+'\n';
      maxEntryBytes=Math.max(maxEntryBytes,Buffer.byteLength(line));if(Buffer.byteLength(line)>131072)throw Error('Selected entry cap');rows.push(line);keyCount++;entryCount+=unique.length;
    }
    const bytes=Buffer.from(rows.join(''));if(bytes.length>8388608)throw Error('Shard cap');const rel=id+'/shards/'+n.toString(16).padStart(2,'0')+'.jsonl';await fs.writeFile(path.join(output,rel),bytes);descriptors.push({bucket:n,path:rel,bytes:bytes.length,sha256:sha(bytes)});
  }
  const manifest={schema:'lyrica-lexicon-jsonl-1',datasetID:id,publicationStatus:'unpublished',active:false,license:'CC-BY-SA-4.0',licensePath:'CC-BY-SA-4.0.html',noticePath:'NOTICE.md',source,shardCount:count,shardAlgorithm:'sha256-utf8-first-byte-modulo-64',encoding:'canonical-json-lines-[lookup,tuples]-1',entryEncoding:id+'-provenance-tuple-1',keyCount,entryCount,maxEntryBytes,completeAlternativesWithinSnapshot:true,candidateSetExhaustive:false,shards:descriptors,...options};
  await fs.writeFile(path.join(output,id,'manifest.json'),canonical(manifest)+'\n');return manifest;
}
export async function compileLanguageLexicons({inputRoot,outputRoot=path.join(base,'language-data/pronunciation')}){
  if(process.versions.node.split('.')[0]!=='24')throw Error('Node24 required');
  const lock=JSON.parse(await fs.readFile(path.join(base,'language-data/pronunciation/source-lock.json')));
  await fs.mkdir(outputRoot,{recursive:true});
  const thaiFile=path.join(inputRoot,lock.thai.path);await pinned(thaiFile,lock.thai);
  const reviewFile=path.join(inputRoot,lock.thai.review.path);const review=JSON.parse(await pinned(reviewFile,lock.thai.review));
  const thai=new Map(),thDigest=createHash('sha256');
  for await(const {raw,line,offset} of rawLines(thaiFile,true,64*1024*1024)){
    thDigest.update(raw);const d=JSON.parse(raw);if(d.lang_code!=='th'||typeof d.word!=='string')continue;
    for(const [soundIndex,sound] of (d.sounds??[]).entries())if(typeof sound.ipa==='string'&&sound.ipa){
      const recordSHA256=sha(raw),soundSHA256=hash(sound),locator=`input:${lock.thai.rawSHA256}:record:${recordSHA256}:sound:${soundSHA256}`,datasetID='kaikki-th-'+lock.thai.rawSHA256.slice(0,16);
      const qualifiers=Object.fromEntries(Object.entries(sound).filter(([k])=>['tags','raw_tags','qualifier'].includes(k)));
      add(thai,d.word,{id:entryID(datasetID,locator,d.word,sound.ipa),datasetID,lookup:d.word,value:sound.ipa,rawIPA:sound.ipa,sourceEntryLocator:locator,sourceURL:'https://en.wiktionary.org/wiki/'+encodeURIComponent(d.word)+'#Thai',snapshot:lock.thai.snapshot,inputSHA256:lock.thai.rawSHA256,recordSHA256,line,byteOffset:offset,byteLength:raw.length,column:`sounds[${soundIndex}].ipa`,soundIndex,soundSHA256,pos:d.pos??null,qualifiers,reviewStatus:'unreviewed-candidate'});
    }
  }
  if(thDigest.digest('hex')!==lock.thai.rawSHA256)throw Error('Expanded Thai hash mismatch');
  const qualified=[];
  for(const row of review.rows.filter(r=>r.dictionaryReadingApprovedForExplicitSpan)){
    const entries=thai.get(row.source)??[],ids=entries.filter(e=>e.rawIPA===row.rawIPA).map(e=>e.id).sort();
    if(canonical(ids)!==canonical([...row.entryRefs].sort())||entries.some(e=>e.rawIPA!==row.rawIPA))throw Error('Exact48 entry/complete raw variant mismatch: '+row.source);
    qualified.push({source:row.source,rawIPA:row.rawIPA,entryRefs:ids,rawVariants:[...new Set(entries.map(e=>e.rawIPA))].sort(),basis:'model-assisted-lexicon',boundaryQualified:false,reviewStatus:'dual-model-intersection-proposal'});
  }
  if(qualified.length!==48)throw Error('Expected exact48 qualification proposals');
  qualified.sort((a,b)=>a.source<b.source?-1:1);
  const q={schema:'thai-exact48-1',publicationStatus:'unpublished',automaticUseQualified:false,sourceInputSHA256:lock.thai.rawSHA256,reviewInputSHA256:lock.thai.review.sha256,rows:qualified};
  await fs.writeFile(path.join(outputRoot,'thai-qualification.json'),canonical(q)+'\n');
  const th=await writeDataset(outputRoot,'thai',thai,lock.thai,{qualificationSHA256:hash(q)});
  const hindi=new Map();
  for(const member of lock.hindi.members){const file=path.join(inputRoot,member.path);await pinned(file,member);
    for await(const {raw,line,offset} of rawLines(file,false,maxFile)){
      const values=raw.toString('utf8').replace(/\r?\n$/,'').split('\t');if(values.length!==3||!/^\d+$/.test(values[2]))throw Error('Unexpected Dakshina row');
      const [native,alias,count]=values,key=alias.normalize('NFC').toLowerCase(),datasetID='dakshina-hi-v1.0',locator=`member:${member.member}:row:${line}:columns:native,romanization,count`;
      add(hindi,key,{id:entryID(datasetID,locator,key,native),datasetID,lookup:key,value:native,sourceEntryLocator:locator,sourceURL:lock.hindi.sourceURL,archiveURL:member.url,member:member.member,archiveRangeStart:member.rangeStart,snapshot:lock.hindi.snapshot,inputSHA256:member.sha256,recordSHA256:sha(raw),line,byteOffset:offset,byteLength:raw.length,columns:{native:1,romanization:2,count:3},attestedAlias:alias,attestationCount:Number(count),reviewStatus:'unreviewed-candidate'});
    }
  }
  const hi=await writeDataset(outputRoot,'hindi',hindi,lock.hindi);
  const viFile=path.join(inputRoot,lock.vietnamese.path);await pinned(viFile,lock.vietnamese);
  const vi=new Map(),posSet=new Set(['noun','verb','adj','adv','name','pron','det','conj','prep','intj','particle','num','classifier']);
  const spelling=/^\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:[ '\u2019-]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*$/u;
  const segmenter=new Intl.Segmenter('vi',{granularity:'grapheme'});let maxAtoms=0;
  for await(const {raw,line,offset} of rawLines(viFile,true,512*1024*1024)){
    const d=JSON.parse(raw);if(d.lang_code!=='vi'||typeof d.word!=='string'||!posSet.has(d.pos))continue;
    const word=d.word.normalize('NFC');if(!spelling.test(word)||Array.from(segmenter.segment(word)).length>80)continue;
    const key=word.toLocaleLowerCase('vi'),datasetID='kaikki-vi-'+lock.vietnamese.sha256.slice(0,16),locator=`compressed-input:${lock.vietnamese.sha256}:line:${line}:column:word`;
    maxAtoms=Math.max(maxAtoms,key.split(' ').length);
    add(vi,key,{id:entryID(datasetID,locator,key,word),datasetID,lookup:key,value:word,pos:d.pos,sourceEntryLocator:locator,sourceURL:'https://vi.wiktionary.org/wiki/'+encodeURIComponent(word.replaceAll(' ','_')),snapshot:lock.vietnamese.snapshot,inputSHA256:lock.vietnamese.sha256,recordSHA256:sha(raw.subarray(0,raw.length-(raw.at(-1)===10?1:0))),line,byteOffset:offset,byteLength:raw.length,column:'word',reviewStatus:'unreviewed-candidate'});
  }
  const vietnamese=await writeDataset(outputRoot,'vietnamese',vi,lock.vietnamese,{maxAtoms});
  const index={schema:'lyrica-pronunciation-data-1',publicationStatus:'unpublished',active:false,maxShardBytes:Math.max(...[th,hi,vietnamese].flatMap(d=>d.shards.map(s=>s.bytes))),compilerSHA256:sha(await fs.readFile(fileURLToPath(import.meta.url))),sourceLockSHA256:sha(await fs.readFile(path.join(base,'language-data/pronunciation/source-lock.json'))),datasets:[th,hi,vietnamese].map(d=>({datasetID:d.datasetID,path:d.datasetID+'/manifest.json',sha256:sha(canonical(d)+'\n'),keyCount:d.keyCount,entryCount:d.entryCount})),qualifications:{thai:{path:'thai-qualification.json',sha256:sha(canonical(q)+'\n')}}};
  await fs.writeFile(path.join(outputRoot,'index.json'),canonical(index)+'\n');return index;
}
export async function compilePronunciationEngineManifest(){
  const packages=['kuromoji','kuroshiro','kuroshiro-analyzer-kuromoji','koroman','async','lodash','doublearray','zlibjs','@babel/runtime'];
  const dependencyFiles=[];
  async function walk(dir){const result=[];for(const d of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const p=path.join(dir,d.name);if(d.isSymbolicLink())throw Error('Unexpected dependency symlink');if(d.isDirectory())result.push(...await walk(p));else if(d.isFile())result.push(p);}return result;}
  for(const name of packages)for(const file of await walk(path.join(base,'node_modules',name))){const b=await fs.readFile(file);dependencyFiles.push({path:path.relative(base,file),bytes:b.length,sha256:sha(b)});}
  const dep={schema:'lyrica-pronunciation-dependencies-1',files:dependencyFiles};
  await fs.writeFile(path.join(base,'language-data/pronunciation/dependency-pins.json'),canonical(dep)+'\n');
  const files=[];
  const names=['source-spans.js','japanese-rules.js','japanese-guards.js','japanese-v2.js','korean-v2.js','lexicon-runtime.js','candidate-engines.js','vietnamese-scan.js','vietnamese-candidates.js','engine-profiles.js','japanese-semantics.js','LICENSE','NOTICE'].map(p=>'api/utils/pronunciation-v2/'+p);
  names.push('api/utils/pronunciation-aids.js','scripts/compile-language-lexicons.mjs');
  for(const p of await walk(path.join(base,'language-data/pronunciation'))){const rel=path.relative(base,p);if(rel.endsWith('/engine-manifest.json'))continue;names.push(rel);}
  for(const rel of [...new Set(names)].sort()){const b=await fs.readFile(path.join(base,rel));files.push({path:rel,bytes:b.length,sha256:sha(b)});}
  const content={schema:'lyrica-pronunciation-engine-manifest-1',publicationStatus:'unpublished',active:false,semantics:{japanese:'ja-spoken-kana-beta-3',japanesePolicy:'A+; quote guard OFF; exact KNOWN ALL-POS lexical enumeration',korean:'original-hangul-1',thai:'original-thai-1',hindiLatin:'confirmed-native-deva-1'},files};
  const manifest={...content,dataRevision:hash(content)};await fs.writeFile(path.join(base,'language-data/pronunciation/engine-manifest.json'),canonical(manifest)+'\n');return {dataRevision:manifest.dataRevision,files:files.length,dependencyFiles:dependencyFiles.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--engine-manifest-only')){console.log(JSON.stringify(await compilePronunciationEngineManifest()));process.exit(0);}
 const i=process.argv.indexOf('--input-root'),o=process.argv.indexOf('--output-root');if(i<0)throw Error('Supply --input-root for exact retained snapshots');
 console.log(JSON.stringify(await compileLanguageLexicons({inputRoot:process.argv[i+1],...(o>=0?{outputRoot:process.argv[o+1]}:{})})));
}
