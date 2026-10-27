// This is a reserved NetEase container row, not arbitrary JSON or a lyric
// line which merely contains JSON. Unknown shapes remain performed text (LRC)
// or refuse the complete edition (YRC). Callers own the sheet-wide count cap.
export function isNeteaseMetadataRow(row) {
 if(typeof row!=='string'||row.length>16384||!/^\s*\{/u.test(row))return false;
 try {
  const value=JSON.parse(row),bounded=text=>typeof text==='string'&&text.length<=4096&&!/\p{Surrogate}/u.test(text);
  return value&&typeof value==='object'&&!Array.isArray(value)
   &&Object.keys(value).every(key=>['t','c'].includes(key))
   &&Number.isSafeInteger(value.t)&&Math.abs(value.t)<=7200000
   &&Array.isArray(value.c)&&value.c.length>0&&value.c.length<=128
   &&value.c.every(part=>part&&typeof part==='object'&&!Array.isArray(part)
    &&Object.keys(part).every(key=>['tx','li','or'].includes(key))
    &&bounded(part.tx)&&part.tx.length<=2000
    &&['li','or'].every(key=>!(key in part)||bounded(part[key])));
 }catch{return false;}
}
