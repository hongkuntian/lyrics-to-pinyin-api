import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const prompt=require('./prompt.json'),lexicon=require('./lexicon.json');
import {LibraryError} from './store.js';
export const MODEL='gpt-5.6-luna';
export const RECIPE='song-clause-4-vocal-text-1';
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export function requestBody(doc) {
  const ids=doc.structure.occurrences.map(o=>o.sourceID),text=doc.structure.occurrences.map(o=>o.sourceText).join('\n');
  const terms=lexicon.terms.filter(t=>[t.term,...t.variants].some(v=>text.includes(v)));
  const sourceIDs=new Set(terms.flatMap(t=>t.meanings.flatMap(m=>m.sources)));
  const data={title:doc.response.song.title.original,artist:doc.response.song.artist.original,
    sourceLanguageLabel:doc.response.song.language,sourceDocument:{version:doc.structure.version,
      speakers:doc.structure.speakers,occurrences:doc.structure.occurrences},verifiedBackground:[],
    lexicalContext:{terms,sources:lexicon.sources.filter(s=>sourceIDs.has(s.id))}};
  return {model:MODEL,reasoning:{effort:'high'},service_tier:'default',max_output_tokens:16384,store:false,
    instructions:prompt.instructions,input:[{role:'user',content:JSON.stringify(data)}],text:{format:{
      type:'json_schema',name:'song_fidelity',strict:true,schema:object({
        translations:object(Object.fromEntries(ids.map(id=>[id,{type:'string'}]))),
        sourceNotes:{type:'array',items:object({sourceID:{type:'string',enum:ids},sourceQuote:{type:'string'},
          kind:{type:'string',enum:['uncertain_source','ambiguous_reading']},explanation:{type:'string'}})}
      })}}};
}
// Rates verified 2026-09-13. Integer microdollars keep admission comparisons exact.
// Charge input at the more conservative cache-write price even when uncached/cached is cheaper.
export function reservationMicros(body) {
  const inputTokenUpperBound=Buffer.byteLength(JSON.stringify(body),'utf8')+4096;
  if(inputTokenUpperBound>100_000) throw new LibraryError('source_too_large',422);
  return Math.ceil(inputTokenUpperBound*0.25+body.max_output_tokens*1.2);
}
export function usageMicros(usage) {
  if(!usage||!['input_tokens','output_tokens'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0&&usage[k]<=10_000_000)) return null;
  return Math.ceil(usage.input_tokens*0.25+usage.output_tokens*1.2);
}
function strictJSON(text) {
  if(typeof text!=='string'||Buffer.byteLength(text)>500_000) throw new LibraryError('invalid_json',502);
  let parsed;try { parsed=JSON.parse(text); } catch { throw new LibraryError('invalid_json',502); }
  // JSON.parse accepts duplicate fields. Scan valid JSON to reject them, including escaped keys.
  let i=0;const ws=()=>{while(/\s/.test(text[i]??'')&&i<text.length)i++;};
  const string=()=>{const start=i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')break;}return JSON.parse(text.slice(start,i));};
  function value(depth=0) {
    if(depth>20) throw new LibraryError('invalid_json',502);ws();
    if(text[i]==='"'){string();return;}
    if(text[i]==='{') {i++;ws();const keys=new Set();if(text[i]==='}'){i++;return;}
      while(i<text.length){ws();const key=string();if(keys.has(key))throw new LibraryError('duplicate_json_fields',502);keys.add(key);ws();i++;value(depth+1);ws();if(text[i++]==='}')return;}
    } else if(text[i]==='[') {i++;ws();if(text[i]===']'){i++;return;}while(i<text.length){value(depth+1);ws();if(text[i++]===']')return;}}
    else {while(i<text.length&&!/[\s,}\]]/.test(text[i]))i++;}
  }
  value();return parsed;
}
export function parseTranslation(text,doc) {
  const value=strictJSON(text),occurrences=doc.structure.occurrences;
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='sourceNotes,translations') throw new LibraryError('invalid_response_fields',502);
  const translations=value.translations;
  if(!translations||Array.isArray(translations)||typeof translations!=='object'||Object.keys(translations).length!==occurrences.length||
    occurrences.some(o=>!Object.hasOwn(translations,o.sourceID)||typeof translations[o.sourceID]!=='string'||!translations[o.sourceID].trim()||
      /[\n\r\v\f\u0085\u2028\u2029]/.test(translations[o.sourceID])||translations[o.sourceID].length>4000)) throw new LibraryError('invalid_translation_coverage',502);
  const names=doc.structure.speakers.flatMap(s=>[s.id,s.displayName,s.sourceLabel,...(s.sourceLabel==='合'?['All']:[])]);
  const lines=occurrences.map(o=> {
    const body=translations[o.sourceID];
    if(names.some(name=>body.startsWith(name+':')||body.startsWith(name+'：'))) throw new LibraryError('unexpected_generated_speaker_prefix',502);
    return {sourceID:o.sourceID,lyricText:body,speakerID:o.speakerID,startsTurn:o.startsTurn,
      text:body};
  });
  const sourceNotes=[],rejectedNotes=[];
  const notes=Array.isArray(value.sourceNotes)?value.sourceNotes:[value.sourceNotes];
  for(const note of notes) {
    const source=occurrences.find(o=>o.sourceID===note?.sourceID);
    if(!note||Array.isArray(note)||Object.keys(note).sort().join(',')!=='explanation,kind,sourceID,sourceQuote'||!source||note.sourceQuote!==source.sourceText||
      !['uncertain_source','ambiguous_reading'].includes(note.kind)||typeof note.explanation!=='string'||!note.explanation.trim()||note.explanation.length>2000) {
      rejectedNotes.push({reason:'source_note_evidence_mismatch',note});continue;
    }
    sourceNotes.push(note);
  }
  return {lines,sourceNotes,rejectedNotes};
}
export async function generate(doc,{apiKey,fetchFn=fetch}={}) {
  if(!apiKey) throw new LibraryError('generation_not_configured',503);
  const body=requestBody(doc);let response=null,actualMicros=null;
  try {
    const result=await fetchFn('https://api.openai.com/v1/responses',{method:'POST',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(270_000)});
    const text=await result.text();if(Buffer.byteLength(text)>2_000_000) throw new LibraryError('provider_response_too_large',502);
    try {response=JSON.parse(text);}catch{throw new LibraryError('invalid_provider_response',502);}
    if(!result.ok) throw new LibraryError('provider_rejected',502);
    if(response.model!==MODEL||response.service_tier!=='default') throw new LibraryError('provider_configuration_changed',502);
    actualMicros=usageMicros(response.usage);
    if(response.status!=='completed') throw new LibraryError('provider_incomplete',502);
    const parts=(response.output??[]).filter(o=>o.type==='message').flatMap(o=>o.content??[]);
    if(parts.some(p=>p.type==='refusal')) throw new LibraryError('provider_refused',422);
    const outputs=parts.filter(p=>p.type==='output_text');
    if(outputs.length!==1) throw new LibraryError('invalid_provider_response',502);
    return {content:parseTranslation(outputs[0].text,doc),actualMicros,response};
  } catch(error) {
    const failure=error instanceof LibraryError?error:new LibraryError('provider_unavailable',502);
    failure.actualMicros=actualMicros;failure.providerResponse=response;throw failure;
  }
}
