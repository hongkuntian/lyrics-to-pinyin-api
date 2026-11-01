import {scriptsOf} from './lyric-language.js';

export function lyricScriptFit(candidate) {
 const title=candidate?.target?.title??candidate?.song?.title;
 const expected=scriptsOf(typeof title==='string'?title:title?.original??'').filter(script=>script!=='Latn');
 if(!expected.length)return 0;
 const lines=candidate?.lyrics?.lines??candidate?.lines??[];
 const words=lines.map(line=>line.text??line.original??'').join('\n');
 const observed=scriptsOf(words);
 const compatible=(expectedScript,observedScript)=>expectedScript===observedScript
  ||['Hani','Jpan'].includes(expectedScript)&&['Hani','Jpan'].includes(observedScript);
 if(observed.some(script=>expected.some(expectedScript=>compatible(expectedScript,script))))return 1;
 return observed.length===1&&observed[0]==='Latn'?-1:0;
}

export const isLatinScriptFallback=candidate=>lyricScriptFit(candidate)===-1;
