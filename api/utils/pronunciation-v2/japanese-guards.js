// Optional A+: lexical-only enumeration on existing chosen KNOWN token surfaces.
// No lattice, whole-selection lookup, semantic classifier, ranking, or speech multiplicity gate.
import {egcs,hira} from './japanese-rules.js';
export const limits=Object.freeze({maxGroupEGC:512,maxTokens:32,maxEntriesPerToken:256,maxCompositions:4096,maxLexicalAlternatives:256,maxEvidenceBytes:262144});
const kana=s=>typeof s==='string'&&/^[\p{Script=Hiragana}ー]+$/u.test(s);
export function exactEntries(t,surface){
 const id=t.viterbi_builder.trie.lookup(surface);if(id<0)return [];
 const ids=t.token_info_dictionary.target_map[id];if(!Array.isArray(ids))throw Error('missing-exact-target-map');
 if(ids.length>limits.maxEntriesPerToken)throw Error('exact-entry-cap');
 return ids.map(id=>{const fields=t.token_info_dictionary.getFeatures(id).split(',');if(fields[0]!==surface)throw Error('nonexact-dictionary-surface');return t.formatter.formatEntry(Number(id),1,'KNOWN',fields);}).sort((a,b)=>a.word_id-b.word_id);
}
const lexEvidence=t=>({surface:t.surface_form,wordID:t.word_id,reading:t.reading,pos:t.pos,detail:t.pos_detail_1,conjugatedForm:t.conjugated_form});
export function enumerateLexical(t,g,bounds=limits){
 const unknown=reason=>({state:'unknown',reason,alternatives:[],compositionCount:0,manualConfirmation:true});
 bounds={...limits,...bounds};
 if(Object.entries(limits).some(([key,maximum])=>!Number.isSafeInteger(bounds[key])||bounds[key]<1||bounds[key]>maximum))return unknown('invalid-resource-bounds');
 if(!g.rawTokens.length||g.rawTokens.some(t=>t.verbose?.word_type!=='KNOWN'))return {state:'not-applicable',reason:'chosen-token-not-KNOWN',alternatives:[],compositionCount:0};
 if(egcs(g.source).length>bounds.maxGroupEGC||g.rawTokens.length>bounds.maxTokens)return unknown('group-or-token-cap');
 if(g.rawTokens.map(t=>t.surface_form).join('')!==g.source.normalize('NFC'))return unknown('nonreconstructing-chosen-tokens');
 const choices=[];let count=1,maxPathEvidenceBytes=0;
 for(const token of g.rawTokens){
  // The exact target map's size is checked BEFORE fetching features / Cartesian expansion.
  const id=t.viterbi_builder.trie.lookup(token.surface_form),ids=id<0?[]:t.token_info_dictionary.target_map[id];
  if(!Array.isArray(ids)||!ids.length)return unknown('missing-exact-entry');
  if(ids.length>bounds.maxEntriesPerToken)return unknown('exact-entry-cap');
  const entries=exactEntries(t,token.surface_form);
  if(entries.some(e=>!kana(hira(e.reading))))return unknown('entry-missing-lexical-reading');
  const map=new Map();for(const e of entries){const reading=hira(e.reading);if(!map.has(reading))map.set(reading,[]);map.get(reading).push(lexEvidence(e));}
  const values=[...map.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0);
  if(count>Math.floor(bounds.maxCompositions/values.length))return unknown('composition-cap');
  count*=values.length;maxPathEvidenceBytes+=Math.max(...values.map(([,ev])=>Buffer.byteLength(JSON.stringify(ev))))+1;choices.push(values);
 }
 // Conservative bound on duplicated per-path attribution, before allocating/composing paths.
 if(count*(maxPathEvidenceBytes+2)>(bounds.maxEvidenceBytes??limits.maxEvidenceBytes))return unknown('composition-evidence-byte-cap');
 const rows=new Map();
 function visit(i,reading,evidence){
  if(i===choices.length){
   if(!rows.has(reading))rows.set(reading,[]);rows.get(reading).push(evidence);return;
  }
  for(const [r,ev] of choices[i])visit(i+1,reading+r,[...evidence,ev]);
 }
 // Distinct-reading combinations are bounded before this traversal; no partial output is admitted.
 visit(0,'',[]);
 if(rows.size>bounds.maxLexicalAlternatives)return unknown('lexical-alternative-cap');
 return {state:rows.size>1?'multiple':'singleton',reason:rows.size>1?'all-POS-exact-token-lexical-multiplicity':'singleton-still-context-uncertain',compositionCount:count,alternatives:[...rows].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([reading,evidence])=>({reading,readingScript:'Hira',basis:'unreviewed-candidate',kind:choices.length>1?'dictionary-composition':'dictionary-entry',label:choices.length>1?'Dictionary composition; not a certified word or context choice':'Exact-surface dictionary reading; not a context choice',evidence}))};
}
