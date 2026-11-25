// Trusted offline publication and untrusted listener reads share identity rules.
import {vocalCoverage,validTimingProvenance} from '../vocal-timing.js';
import {validateInspectorManifest} from './compiler.js';
import {lineSelections} from '../song-library/study-line.js';
import {selectionV2,parseExplanation} from '../song-library/study-explanation.js';
import {translationRecipe} from '../song-library/translation.js';
import {createRequire} from 'node:module';
import {digest,LibraryError} from '../song-library/store.js';
import {independentProvider,canonicalJSON} from '../song-library/spotify-recording.js';
import {TARGETS} from '../song-library/languages.js';
const require=createRequire(import.meta.url),pool=require('../../data/starter-songs.json');
export const POOL=pool.languages;
export const hashID=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const fail=(code='invalid_request',status=400)=>{throw new LibraryError(code,status);};
export const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
export function variantKey(v){
 if(!exact(v,['provider','catalogID','storefront'])||v.provider!=='apple'||!/^\d{1,30}$/.test(v.catalogID)||!/^[a-z]{2}$/.test(v.storefront))fail();
 return canonicalJSON(v);
}
export const artifact=(kind,content,selector={})=>({id:digest(canonicalJSON({kind,selector,content})),kind,selector,content});
export const editionIdentity=b=>digest(canonicalJSON({songID:b.songID,documentID:b.documentID,sourceHash:b.sourceHash,artifacts:b.artifacts.map(a=>a.id)}));
export const manifestFor=b=>b.artifacts.find(a=>a.kind==='manifest')?.content;
export function validateBundle(b){
 const bad=()=>fail('invalid_publication',422);
 if(!b||!Array.isArray(b.artifacts)||b.version!==1||!hashID(b.documentID)||!hashID(b.sourceHash)||!hashID(b.editionID)||b.editionID!==editionIdentity(b))bad();
 const song=Object.values(POOL).flat().find(s=>s.id===b.songID);
 if(!song||!b.display||typeof b.display.title!=='string'||!b.display.title.trim()||typeof b.display.artist!=='string'||!b.display.artist.trim()||!Number.isFinite(b.display.duration)||b.display.duration<=0)bad();
 if(!Array.isArray(b.variants)||!b.variants.length||new Set(b.variants.map(variantKey)).size!==b.variants.length||b.variants.some(v=>!song.recordings.some(r=>r.catalog_id===v.catalogID&&r.storefront===v.storefront)))bad();
 if(!b.variants.some(v=>variantKey(v)===variantKey(b.documentVariant)))bad();
 if(!Array.isArray(b.uses)||!b.uses.includes('read')||b.uses.some(u=>!['read','play'].includes(u)))bad();
 const e=b.recordingEvidence,r=b.rights,c=b.coverage;
 if(e?.documentID!==b.documentID||e?.sourceHash!==b.sourceHash||!Array.isArray(e?.variants)||canonicalJSON(e.variants.map(variantKey).sort())!==canonicalJSON(b.variants.map(variantKey).sort())||!e?.reference||!e.reviewer||!e.timingVerified||!e.listeningVerified||!r?.reference||!r.reviewer||r.acquisition!==true||r.derivatives!==true||r.persistentServing!==true||typeof r.worldwide!=='boolean'||!Array.isArray(r.territories)||r.territories.some(t=>!/^[A-Z]{2}$/.test(t))||!Number.isFinite(Date.parse(r.expiresAt)))bad();
 if(!c?.complete||!c.parityReference||canonicalJSON([...c.targets].sort())!==canonicalJSON(Object.keys(TARGETS).sort())||!Array.isArray(b.artifacts)||!b.artifacts.length||b.artifacts.length>20000)bad();
 if(Buffer.byteLength(JSON.stringify(b))>20_000_000)bad();
 const ids=new Set();for(const a of b.artifacts){if(!['document','translation','batch','explanation','manifest'].includes(a.kind)||!a.selector||a.id!==artifact(a.kind,a.content,a.selector).id||ids.has(a.id))bad();ids.add(a.id);}
 const docs=b.artifacts.filter(a=>a.kind==='document'),manifests=b.artifacts.filter(a=>a.kind==='manifest');
 if(docs.length!==1||manifests.length!==1||docs[0].content.id!==b.documentID||docs[0].content.sourceHash!==b.sourceHash||c.nativeManifestHash!==manifests[0].id)bad();
 const d=docs[0].content,p=d.response?.metadata?.lyric_timing;
 if(d.recordingKey!==digest({catalogID:b.documentVariant.catalogID,storefront:b.documentVariant.storefront})||p?.recordingID!==b.documentVariant.catalogID)bad();
 if(r.source?.provider!==independentProvider(d.response?.metadata?.source)||r.source?.itemID!==String(d.response?.song?.id)||!validTimingProvenance(p)||!vocalCoverage(d.response?.lines,{duration:d.response?.song?.duration,durationResolution:p.durationResolution??0,provenance:true}).complete)bad();
 const m=manifests[0].content;
 if(m.version!==1||m.documentID!==b.documentID||m.sourceHash!==b.sourceHash||!Array.isArray(m.requests)||!m.requests.length||m.requests.length>20000)bad();
 // Required coverage is derived from the exact manifest, not a boolean supplied by a publisher.
 const requests=m.requests.map(q=>canonicalJSON({kind:q.kind,selector:q.selector}));
 if(new Set(requests).size!==requests.length)bad();
 if(b.artifacts.length!==m.requests.length+2)bad();
 for(const q of m.requests)if(!b.artifacts.some(a=>a.kind===q.kind&&canonicalJSON(a.selector)===canonicalJSON(q.selector)))bad();
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
 const translations=Object.fromEntries(b.artifacts.filter(a=>a.kind==='translation').map(a=>[a.selector.target,a.content]));
 try{validateInspectorManifest(docs[0].content,translations,m);}catch{bad();}
 for(const a of b.artifacts.filter(a=>['translation','batch','explanation'].includes(a.kind))){
  if(!uuid(a.content.id)||a.content.documentID!==b.documentID||a.content.sourceHash&&a.content.sourceHash!==b.sourceHash)bad();
  const v=a.content;
  if(a.kind==='translation'){
   if(v.recipe!==translationRecipe(v.target)||v.sourceHash!==b.sourceHash||v.notesLanguage!==v.target||!Array.isArray(v.sourceNotes)||!Array.isArray(v.lines)||v.lines.length!==d.structure.occurrences.length)bad();
   for(const [i,line] of v.lines.entries()){const o=d.structure.occurrences[i];if(line.sourceID!==o.sourceID||typeof line.lyricText!=='string'||!line.lyricText.trim()||line.lyricText.length>4000||/[\r\n\v\f\u0085\u2028\u2029]/.test(line.lyricText)||typeof line.text!=='string'||line.speakerID!==o.speakerID||typeof line.startsTurn!=='boolean')bad();
    if((v.identity||v.target===d.response.song.language)&&(v.target!==d.response.song.language||v.identity!==true||line.lyricText!==o.lyricText))bad();
   }
  }
  if(a.kind==='batch'&&(a.content.recipe!==a.selector.recipe||canonicalJSON(a.content.studyText)!==canonicalJSON(a.selector.studyText)||canonicalJSON(a.content.manifest)!==canonicalJSON(a.selector.manifest)||a.content.explanationLanguage!==a.selector.explanationLanguage))bad();
  if(['batch','explanation'].includes(a.kind)){
   const t=a.selector.studyText.layer==='translation'?translations[a.selector.studyText.target]:null;
   if(v.translationID!==(t?.id??null))bad();
   try{
    if(a.kind==='batch'){
     const selections=lineSelections(d,a.selector,t);
     if(!Array.isArray(v.items)||v.items.length!==selections.length)bad();
     for(const [i,item] of v.items.entries()){const selected=selections[i];
      if(!exact(item,['id','meaning','context','uncertainty','sourceQuote','grammar'])||item.id!==selected.id||item.sourceQuote!==selected.text||item.grammar!=='')bad();
      for(const [field,max] of [['meaning',400],['context',800],['uncertainty',400]])if(typeof item[field]!=='string'||item[field].length>max||field!=='uncertainty'&&!item[field].trim())bad();
     }
    }else{
     const selected=selectionV2(d,a.selector,t);if(v.contractVersion!==2||v.sourceID!==selected.sourceID||v.lower!==selected.lower||v.upper!==selected.upper)bad();
     parseExplanation(JSON.stringify(Object.fromEntries(['meaning','context','grammar','uncertainty','sourceQuote'].map(k=>[k,v[k]]))),selected);
    }
   }catch{bad();}
  }
  if(a.kind==='explanation'&&(a.content.recipe!==a.selector.recipe||canonicalJSON(a.content.studyText)!==canonicalJSON(a.selector.studyText)||canonicalJSON(a.content.selection)!==canonicalJSON(a.selector.selection)||a.content.explanationLanguage!==a.selector.explanationLanguage))bad();
 }
 for(const target of Object.keys(TARGETS))if(!b.artifacts.some(a=>a.kind==='translation'&&a.selector.target===target&&a.content.target===target&&a.content.id===a.selector.revisionID))bad();
 if(!Array.isArray(c.requiredArtifactIDs)||canonicalJSON([...c.requiredArtifactIDs].sort())!==canonicalJSON([...ids].sort()))bad();
 return b;
}
export function publicationGrant(row,use,territory=null,now=Date.now(),variant=null){
 const b=row.bundle,r=b.rights;
 if(row.state!=='published'||Date.parse(r.expiresAt)<=now||!r.worldwide&&(!territory||!r.territories.includes(territory)))fail('prepared_unavailable',404);
 if(!b.uses.includes(use))fail('variant_unavailable',403);
 if(variant&&!b.variants.some(v=>variantKey(v)===variantKey(variant))||use==='play'&&!variant)fail('variant_unavailable',403);
 return {editionID:b.editionID,generation:String(row.generation),documentID:b.documentID,sourceHash:b.sourceHash,use,onlineRequired:true,expiresAt:new Date(Math.min(now+300_000,Date.parse(r.expiresAt))).toISOString()};
}
export const descriptors=b=>b.artifacts.map(({id,kind,selector})=>({id,kind,selector}));
export const summary=row=>({language:Object.keys(POOL).find(l=>POOL[l].some(s=>s.id===row.bundle.songID)),songID:row.bundle.songID,editionID:row.bundle.editionID,generation:String(row.generation),...row.bundle.display,
 documentVariant:row.bundle.documentVariant,variants:row.bundle.variants,uses:row.bundle.uses,documentID:row.bundle.documentID,sourceHash:row.bundle.sourceHash});
