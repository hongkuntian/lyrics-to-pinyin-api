import {createHash} from 'node:crypto';
import {packagedLexicons} from './lexicon-runtime.js';
import {scan,normalized,joinable} from './vietnamese-scan.js';
import {sourceSpans,exactSourceSelection} from './source-spans.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
export const vietnameseCandidateEngineVersion='vi-dictionary-candidates-1';
export async function analyzeVietnameseCandidates(text,{lexicons=packagedLexicons}={}){
  const view=sourceSpans(text,16384);if(view.chars.length>2048)throw new RangeError('Vietnamese source EGC cap');
  const {atoms,pieces,boundaries}=scan(text),out={language:'vi',source:text,sourceTextSHA256:sha(text),engineVersion:vietnameseCandidateEngineVersion,offsetUnit:'grapheme',pieces,candidates:[],crossOverlaps:[],unresolved:[],publicationStatus:'unpublished',inventory:{status:'incomplete',denominator:null,reason:'no-contextual-segmentation-qualification'}};
  const refuse=reason=>({...out,reason,candidates:[],crossOverlaps:[],unresolved:atoms.map(a=>({...a,reason}))});
  let manifest;try{manifest=await lexicons.manifest('vietnamese');}catch{return refuse('data-unavailable-or-corrupt');}
  if(!Number.isInteger(manifest.maxAtoms)||manifest.maxAtoms<1||manifest.maxAtoms>80)throw new Error('Invalid Vietnamese atom bound');
  const queries=[];
  for(let i=0;i<atoms.length;i++)for(let j=i;j<Math.min(i+manifest.maxAtoms,atoms.length);j++){
    if(!atoms[j].latin||(j>i&&!joinable(text.slice(atoms[j-1].utf16Upper,atoms[j].utf16Lower))))break;
    if(atoms[j].upper-atoms[i].lower>80)break;
    const span=view.span(atoms[i].lower,atoms[j].upper),key=atoms.slice(i,j+1).map(a=>normalized(a.text)).join(' ');
    if(Buffer.byteLength(key)>512)continue;queries.push({span,key,syllableAtoms:j-i+1});if(queries.length>4096)return refuse('candidate-work-cap');
  }
  // Bound each batch; no eager parsed lexicon or whole-dictionary trie is retained.
  const keys=[...new Set(queries.map(q=>q.key))],values=new Map();
  try{for(let i=0;i<keys.length;i+=32){const batch=keys.slice(i,i+32),rows=await lexicons.lookupMany('vietnamese',batch);for(let n=0;n<batch.length;n++)if(rows[n].length)values.set(batch[n],rows[n]);}}catch{return refuse('data-unavailable-or-corrupt');}
  for(const q of queries){const entries=values.get(q.key);if(!entries)continue;const {span}=q;
    out.candidates.push({...span,id:sha(JSON.stringify(['vi-lexical-span-1',out.sourceTextSHA256,span.lower,span.upper,span.source,entries.map(e=>e.id).sort()])),surface:span.source,canonicalSurface:span.source.normalize('NFC'),syllableAtoms:q.syllableAtoms,basis:'dictionary-attested-candidate',requiresConfirmation:true,contextualBoundaryQualified:false,entries,overlaps:[]});
    if(out.candidates.length>2048)return refuse('candidate-output-cap');
  }
  let active=[];for(const c of out.candidates){active=active.filter(x=>x.upper>c.lower);for(const a of active){a.overlaps.push(c.id);c.overlaps.push(a.id);if(a.syllableAtoms>1&&c.syllableAtoms>1)out.crossOverlaps.push([a.id,c.id]);}active.push(c);}
  out.unresolved=atoms.filter(a=>!out.candidates.some(c=>c.lower<=a.lower&&c.upper>=a.upper)).map(a=>({...a,reason:a.latin?'not-in-snapshot':'non-latin-or-number'}));
  return out;
}
// Range editor syntax proof only. No payload-derived source/context or confirmation authority.
export function vietnameseManualRange(text,selection){
  const span=exactSourceSelection(text,selection);if(!/\p{L}/u.test(span.source))throw new TypeError('Lexical source letters required');
  return {...span,canonicalSurface:span.source.normalize('NFC'),requiresConfirmation:true,wholeSongDenominatorEligible:false,authority:'none'};
}
