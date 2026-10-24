import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory='api/utils/pronunciation-v2/';
const common=[directory+'written-profiles.js',directory+'bound-written-annotation.js',
  'scripts/compile-written-pronunciation-data.mjs'];
const recipes=[
  {profileID:'ru-written',engineVersion:'lyrica-ru-written-1',files:[...common,directory+'russian-written.js']},
  {profileID:'hi-deva-written',engineVersion:'sanscript-1.3.3-lyrica-deva-written-1',files:[...common,
    directory+'hindi-written.js',directory+'vendor/sanscript-1.3.3/sanscript.cjs',
    directory+'vendor/sanscript-1.3.3/LICENSE',directory+'vendor/sanscript-1.3.3/provenance.json']}
];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const profiles=[];
for(const recipe of recipes){
  const inputs=[];
  for(const file of recipe.files.sort()){
    const bytes=await readFile(path.join(root,file));inputs.push({path:file,sha256:sha(bytes),bytes:bytes.length});
  }
  profiles.push({profileID:recipe.profileID,engineVersion:recipe.engineVersion,inputs,
    dataRevision:sha(JSON.stringify(['written-pronunciation-data-1',recipe.profileID,recipe.engineVersion,inputs]))});
}
const encoded=JSON.stringify({version:'written-pronunciation-data-1',profiles},null,2)+'\n';
const output=path.join(root,directory+'written-data-manifest.json');
if(process.argv.length===3&&process.argv[2]==='--check'){
  if((await readFile(output,'utf8'))!==encoded)throw new Error('Written pronunciation manifest is stale');
  console.log('Written pronunciation manifest exact: '+sha(encoded));
}else{
  if(process.argv.length!==2)throw new Error('Usage: node scripts/compile-written-pronunciation-data.mjs [--check]');
  await writeFile(output,encoded);console.log('Compiled written pronunciation manifest: '+sha(encoded));
}
