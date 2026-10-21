import chinese from 'chinese-conv';
import OpenCC from 'opencc-js';

const simplified=OpenCC.Converter({from:'t',to:'cn'});
const otherCJK=/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff\uffa0-\uffdc\u{1b000}-\u{1b16f}]/u;
// Keep historical script equivalence and complete dictionary variants such as
// 麽/麼/么. Generic t2s does not enable regional vocabulary/phrase conversion.
// Extra Chinese variants do not authorize changing Japanese/Korean names.
// This is a comparison/query spelling, never a rewrite of request/source bytes.
export function simplifyRecordingScript(value='',{preserveOtherCJK=false}={}) {
 // QQ discovery historically sends Japanese/Korean catalogue strings verbatim.
 if(preserveOtherCJK&&otherCJK.test(value))return value;
 const legacy=chinese.sify(value).normalize('NFKC');
 return /\p{Script=Han}/u.test(legacy)&&!otherCJK.test(value)?simplified(legacy):legacy;
}
