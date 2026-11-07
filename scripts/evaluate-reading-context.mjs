// Offline diagnostic. A curated corpus is not population or recording accuracy.
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import * as candidate from '../api/utils/pronunciation-aids.js';

const [corpusPath,baselinePath,outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: node scripts/evaluate-reading-context.mjs CORPUS BASELINE_SOURCE OUTPUT');
const corpus = JSON.parse(await readFile(corpusPath,'utf8'));
const language = corpus.language ?? 'ja', profile = language === 'ko' ? 'ko-revised' : 'ja-kana';
const sourceURL = new URL('../api/utils/pronunciation-aids.js',import.meta.url);
const require = createRequire(sourceURL);
const baselineSource = (await readFile(baselinePath,'utf8')).replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g,
  (_,quote,path) => `from ${quote}${new URL(path,sourceURL).href}${quote}`)
  .replace(/import\((['"])([^'"]+)\1\)/g,(_,quote,id)=>
    `import(${quote}${id.startsWith('.')?new URL(id,sourceURL).href:pathToFileURL(require.resolve(id)).href}${quote})`);
const baseline = await import('data:text/javascript;base64,' + Buffer.from(baselineSource).toString('base64'));
const graphemes = text => Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text),s=>s.segment);
function selectedReading(text,segments,target) {
  const chars=graphemes(text),needle=graphemes(target.source);
  let occurrence=0,lower=-1;
  for(let i=0;i<=chars.length-needle.length;i++) {
    if(chars.slice(i,i+needle.length).join('')!==target.source)continue;
    if(occurrence++===(target.occurrence??0)){lower=i;break;}
  }
  if(lower<0)throw new Error('Missing target: '+target.source+' in '+text);
  const upper=lower+needle.length,selected=segments.filter(s=>s.upper>lower&&s.lower<upper);
  if(!selected.length||selected[0].lower!==lower||selected.at(-1).upper!==upper)return {status:'unaligned',reading:null};
  if(selected.some(s=>s.status==='unresolved'))return {status:'unresolved',reading:null};
  return {status:'resolved',reading:selected.map(s=>s.reading??s.source).join('')};
}
const rows=[];
for(const [index,row] of corpus.cases.entries()) {
  const old=await baseline.analyzeReading(row.text,language),current=await candidate.analyzeReading(row.text,language);
  if(row.kana || row.romanizations) {
    const expected=row.romanizations??[row.kana];
    const before=baseline.renderReading(old,profile).text,after=candidate.renderReading(current,profile).text;
    rows.push({id:row.id??index,text:row.text,expected,before,after,beforeCorrect:expected.includes(before),afterCorrect:expected.includes(after)});
  } else for(const target of row.targets) {
    const before=selectedReading(row.text,old.segments,target),after=selectedReading(row.text,current.segments,target);
    const correct=value=>target.readings.includes(value.reading)||(target.allowUnresolved&&value.status==='unresolved');
    rows.push({id:row.id??index,text:row.text,target:target.source,expected:target.readings,before,after,
      beforeCorrect:!!correct(before),afterCorrect:!!correct(after)});
  }
}
const comparable=rows.filter(r=>r.before?.status!=='unaligned'&&r.after?.status!=='unaligned');
const report={basis:corpus.basis,corpus:resolve(corpusPath),targets:rows.length,comparableTargets:comparable.length,
  beforeCorrect:comparable.filter(r=>r.beforeCorrect).length,afterCorrect:comparable.filter(r=>r.afterCorrect).length,
  fixed:rows.filter(r=>!r.beforeCorrect&&r.afterCorrect).length,regressions:rows.filter(r=>r.beforeCorrect&&!r.afterCorrect).length,
  unaligned:rows.filter(r=>r.before?.status==='unaligned'||r.after?.status==='unaligned').length,rows};
await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,rows:undefined}));
