import OpenCC from 'opencc-js';

const converters=new Map();
// Display-only script preference. Never change the canonical source/binding,
// recording metadata, model context or performed cue identity.
export function displayText(text,language){
 if(typeof text!=='string')return '';
 const tag=typeof language==='string'?language.toLowerCase().replaceAll('_','-'):'';
 if(!/^(zh|yue)-(hans|hant)(-|$)/.test(tag)||/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff\uffa0-\uffdc\u{1b000}-\u{1b16f}]/u.test(text))return text;
 const script=tag.split('-')[1];
 if(!converters.has(script))converters.set(script,OpenCC.Converter(script==='hans'?{from:'t',to:'cn'}:{from:'cn',to:'t'}));
 return converters.get(script)(text);
}
