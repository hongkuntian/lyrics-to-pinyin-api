import {createRequire} from 'node:module';
import chinese from 'chinese-conv';
const require=createRequire(import.meta.url);
const policy=require('../data/lyric-credit-policy.json');
if(policy.version!==1)throw new Error('unsupported_lyric_credit_policy');
export const creditLabelKey=text=>chinese.sify(text.normalize('NFKC')).toLowerCase().replace(/\s+/gu,'');
export const ambiguousProductionRoles=new Set(policy.ambiguousRoles.map(creditLabelKey));
const roleLabels=new Set(policy.roleGroups.flatMap(({chinese:zh,english:en})=>[
  ...zh,...en,...zh.flatMap(chinese=>en.flatMap(english=>[
    chinese+english,english+chinese,chinese+'('+english+')',english+'('+chinese+')']))
]).map(creditLabelKey));
const patterns=Object.values(policy.patterns).map(pattern=>new RegExp(pattern,'u'));
const compoundSeparator=new RegExp(policy.compoundSeparator,'u');
const creditBlockContributor=new RegExp(policy.creditBlockContributor,'u');
export const isCreditBlockContributor=body=>creditBlockContributor.test(creditLabelKey(body));
export function isProductionRole(key) {
  const atom=part=>!ambiguousProductionRoles.has(part)
    && (roleLabels.has(part)||patterns.some(pattern=>part.match(pattern)?.[0]===part));
  if(atom(key))return true;
  const parts=key.split(compoundSeparator);
  return parts.length>1&&parts.every(part=>part&&atom(part));
}
