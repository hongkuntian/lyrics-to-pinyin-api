const graphemeSegmenter=new Intl.Segmenter('vi',{granularity:'grapheme'});
export const normalized=s=>s.normalize('NFC').toLocaleLowerCase('vi');
export const joinable=s=>/^[ \u00a0\u202f]+$/u.test(s);
const latin=/^\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:[-'’]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*$/u;
export function scan(text){
 const egcs=[...graphemeSegmenter.segment(text)],boundaries=egcs.map(x=>x.index).concat(text.length),egcAt=new Map(boundaries.map((u,i)=>[u,i]));
 const pieces=[],atoms=[];let end=0;
 for(const m of text.matchAll(/\p{L}[\p{L}\p{M}]*(?:[-'’]\p{L}[\p{L}\p{M}]*)*|\p{N}+/gu)){
  const lower=m.index,upper=lower+m[0].length;
  if(!egcAt.has(lower)||!egcAt.has(upper))continue;
  if(lower>end)pieces.push({kind:'gap',text:text.slice(end,lower),lower:egcAt.get(end),upper:egcAt.get(lower)});
  const atom={kind:'atom',text:m[0],lower:egcAt.get(lower),upper:egcAt.get(upper),utf16Lower:lower,utf16Upper:upper,latin:latin.test(m[0])};
  pieces.push(atom);atoms.push(atom);end=upper;
 }
 if(end<text.length)pieces.push({kind:'gap',text:text.slice(end),lower:egcAt.get(end),upper:egcs.length});
 return {atoms,pieces,boundaries};
}
