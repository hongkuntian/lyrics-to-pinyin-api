import {createRequire} from 'node:module';
import chinese from 'chinese-conv';
const require=createRequire(import.meta.url);
const policy=require('../data/lyric-notice-policy.json');
if(policy.version!==1)throw new Error('unsupported_lyric_notice_policy');
const rules=policy.rules.map(rule=>({...rule,regex:new RegExp(rule.pattern,'u')}));

// Comparison only: never change the retained source words. Square wrappers
// are optional syntax around a complete row, not a general deletion rule.
export function classifyLyricNotice(text) {
  if(typeof text!=='string'||text.length>4000||/[\r\n\v\f\u0085\u2028\u2029]/u.test(text))return null;
  let key=chinese.sify(text.normalize('NFKC')).toLowerCase().replace(/\s+/gu,'');
  if((key.startsWith('[')&&key.endsWith(']'))||(key.startsWith('【')&&key.endsWith('】')))key=key.slice(1,-1);
  if(/[\[\]【】]/u.test(key))return null;
  return rules.find(rule=>rule.regex.test(key))?.kind??null;
}
