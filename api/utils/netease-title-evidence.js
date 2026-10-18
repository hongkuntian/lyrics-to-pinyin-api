import chinese from 'chinese-conv';

export const NETEASE_TITLE_CAPABILITY='netease-descriptive-title-1';
const validDescriptors=values=>Array.isArray(values)&&values.length>0&&values.length<=8
 &&values.every(value=>typeof value==='string'&&value.trim()&&value.length<=256&&!/\p{C}/u.test(value));

// Search and detail expose the same provider-owned aliases under different
// names. This evidence is internal; it is never accepted in a client request.
export function neteaseTitleEvidence(raw,field) {
 const sourceID=String(raw?.id),descriptors=raw?.[field];
 return /^[1-9]\d{0,19}$/.test(sourceID)&&validDescriptors(descriptors)
  ?{version:1,sourceID,descriptors:[...descriptors]}:null;
}
function description(value) {
 if(typeof value!=='string'||value.length>256||/\p{C}/u.test(value))return null;
 const text=chinese.sify(value).normalize('NFKC').trim();
 const match=text.match(/^(?:动画剧集《([^《》]{1,120})》|《([^《》]{1,120})》动画剧集)中文主题曲$/u);
 // Preserve the quoted work's punctuation and word order. This is not a
 // generic suffix remover, title translation, or fuzzy substring comparison.
 const work=match?(match[1]??match[2]):null;
 return work?.trim()?work:null;
}
export function neteaseDescriptiveTitleMatches(song,request,normalizeBase) {
 const evidence=song?.neteaseTitleEvidence;
 if(song?.source!=='netease'||evidence?.version!==1||evidence.sourceID!==String(song.id)
  ||!/^[1-9]\d{0,19}$/.test(evidence.sourceID)||!validDescriptors(evidence.descriptors)
  ||typeof song.title!=='string'||typeof request?.title!=='string')return false;
 const parts=request.title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
 const base=normalizeBase(song.title);
 if(!parts||!base||base!==normalizeBase(parts[1]))return false;
 const work=description(parts[2]);
 return work!==null&&evidence.descriptors.some(value=>description(value)===work);
}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const sameNetEaseTitleEvidence=(a,b)=>JSON.stringify(canonical(a??null))===JSON.stringify(canonical(b??null));
