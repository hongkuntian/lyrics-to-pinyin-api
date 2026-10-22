// Finite research descriptors. These do not change production defaults/eligibility.
import {hash,fail} from './common.mjs';
export const FAMILIES=Object.freeze({
 'r1-luna':Object.freeze({model:'gpt-6-luna',inputRate:0.125,outputRate:0.5}),
 'r1-sol':Object.freeze({model:'gpt-6.1-sol',inputRate:2.5,outputRate:10})
});
export const NAMES=Object.freeze(Array.from({length:60},(_,i)=>'confirmation'+String(i+1).padStart(2,'0')));
export function exactOptions(value,keys) {
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!keys.includes(k))) fail('finite_research_options_required');
}
export function familyOption(options={}) {
 exactOptions(options,['modelFamily']);const name=Object.hasOwn(options,'modelFamily')?options.modelFamily:'r1-luna';
 if(!Object.hasOwn(FAMILIES,name)) fail('unreviewed_model_family');
 return {name,...FAMILIES[name]};
}
export const capFor=kind=>kind==='translation'?32768:['original','translated'].includes(kind)?4096:fail('invalid_model_kind');
export function maximum(family,kind) {const f=familyOption({modelFamily:family});return Math.ceil(24000*f.inputRate+capFor(kind)*f.outputRate);}
export function makeSlotProfile(modelFamily='r1-sol') {
 const f=familyOption({modelFamily});
 return {version:'named-model-caps-r1',slots:NAMES.map((name,i)=>{
  const active=i>=13&&i<26,kind=active&&![13,16,18,19,22].includes(i)?'original':'translation';
  const family=active?f.name:'r1-luna',d=FAMILIES[family];
  // All Luna names retain the legacy translation maximum, even Study slots.
  const cap=family==='r1-luna'?32768:capFor(kind);
  return {name,modelFamily:family,model:d.model,inputUpper:24000,maxOutputTokens:cap,inputRate:d.inputRate,outputRate:d.outputRate,
   reservedMicros:Math.ceil(24000*d.inputRate+cap*d.outputRate)};
 })};
}
export function checkProfile(profile,names=NAMES) {
 if(hash(names)!==hash(NAMES)||![makeSlotProfile('r1-luna'),makeSlotProfile('r1-sol')].some(p=>hash(p)===hash(profile))) fail('frozen_slot_profile_invalid');
}
export function checkSlot(job,profile) {
 checkProfile(profile);const s=profile.slots.find(x=>x.name===job.confirmationName);
 if(!s||s.model!==job.body?.model||s.modelFamily!==job.modelFamily||job.body.max_output_tokens!==capFor(job.kind)||
  job.body.max_output_tokens>s.maxOutputTokens||Buffer.byteLength(job.bodyJSON)+4096>s.inputUpper||job.reservedMicros>s.reservedMicros) fail('named_slot_configuration_exceeded');
}
// Legacy absent profiles retain the exact original arithmetic. First opt-in must
// happen via a code transition; every later plan on that code repeats its profile.
export function assertProfiles(plans,state={}) {
 let profile=null;const codes=new Map();
 for(const p of plans) {
  const code=hash(p.codeHashes),value=hash(p.slotProfile??null);
  if(codes.has(code)&&codes.get(code)!==value) fail('same_code_slot_profile_changed');
  codes.set(code,value);
  if(!p.slotProfile) continue;
  checkProfile(p.slotProfile,p.confirmationNames);
  if(profile&&hash(profile)!==hash(p.slotProfile)) fail('frozen_slot_profile_changed');
  profile=p.slotProfile;
 }
 if(!profile)return null;
 // An absent legacy profile is exactly the old Luna allocation, never a zero hold.
 const prior=makeSlotProfile('r1-luna');
 for(const m of state.manifests??[])for(const j of m.jobs.filter(j=>j.confirmationName)) {
  const owner=plans.find(p=>hash(p)===m.planHash),old=(owner?.slotProfile??prior).slots.find(s=>s.name===j.confirmationName);
  const next=profile.slots.find(s=>s.name===j.confirmationName);
  if(!old||hash(old)!==hash(next))fail('admitted_slot_is_immutable');
 }
 return profile;
}
