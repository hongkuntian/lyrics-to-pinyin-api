import {LibraryError} from './store.js';

// Targets describe output text, never UI locale, storefront, or pronunciation.
export const TARGETS=Object.freeze({
  en:{name:'English',unclear:'[unclear source]'},
  fr:{name:'French',unclear:'[source incertaine]'},
  es:{name:'Spanish',unclear:'[original poco claro]'},
  'zh-Hans':{name:'Simplified Chinese',unclear:'[原文不明]'},
  'zh-Hant':{name:'Traditional Chinese',unclear:'[原文不明]'}
});
const aliases={'en-US':'en','en-GB':'en','en-CA':'en','en-AU':'en',
  'fr-FR':'fr','fr-CA':'fr','es-ES':'es','es-MX':'es',
  'zh-CN':'zh-Hans','zh-SG':'zh-Hans','zh-TW':'zh-Hant','zh-HK':'zh-Hant'};
export function canonicalTarget(value='en') {
  if(typeof value!=='string'||value.length>40)throw new LibraryError('unsupported_target',400);
  let tag;try {tag=Intl.getCanonicalLocales(value)[0];}catch {throw new LibraryError('unsupported_target',400);}
  tag=aliases[tag]??tag;
  if(!Object.hasOwn(TARGETS,tag))throw new LibraryError('unsupported_target',400);
  return tag;
}
const sourceTag=value=>{try{return Intl.getCanonicalLocales(value)[0]??'und';}catch{return 'und';}};
function directions(value) {
  if(value===undefined)return ['*:en'];
  if(!Array.isArray(value))throw new LibraryError('invalid_language_policy',503);
  return value.map(pair=>{
    if(typeof pair!=='string')throw new LibraryError('invalid_language_policy',503);
    const [source,target,...extra]=pair.split(':');
    if(!source||extra.length||!target||!(source==='*'||sourceTag(source)===source)||canonicalTarget(target)!==target)
      throw new LibraryError('invalid_language_policy',503);
    return pair;
  });
}
export function languagePolicy({translation,explanation}={}) {
  const policy={translation:directions(translation),explanation:directions(explanation)};
  return Object.freeze({translation:Object.freeze(policy.translation),explanation:Object.freeze(policy.explanation)});
}
export function environmentLanguagePolicy(env=process.env) {
  try {return languagePolicy({translation:env.LYRA_TRANSLATION_DIRECTIONS===undefined?undefined:JSON.parse(env.LYRA_TRANSLATION_DIRECTIONS),
    explanation:env.LYRA_EXPLANATION_DIRECTIONS===undefined?undefined:JSON.parse(env.LYRA_EXPLANATION_DIRECTIONS)});}
  catch {throw new LibraryError('invalid_language_policy',503);}
}
export function requireDirection(policy,kind,source,target) {
  if(!policy[kind]?.some(pair=>pair===`*:${target}`||pair===`${sourceTag(source)}:${target}`))
    throw new LibraryError('unsupported_direction',422);
}
export function capabilities(policy) {
  return {version:1,targets:Object.entries(TARGETS).map(([tag,{name}])=>({tag,name})),
    translationDirections:policy.translation,explanationDirections:policy.explanation,
    study:{contractVersions:[1,2],layers:['original','translation'],offsetUnit:'grapheme',maxRanges:1,maxGraphemes:80},
    automaticCorrectionTargets:['en']};
}
