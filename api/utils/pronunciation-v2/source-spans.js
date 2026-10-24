// Exact original EGC and UTF8 coordinates. Normalization is a disposable lookup view.
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
export const egcs=text=>Array.from(segmenter.segment(text),part=>part.segment);
export function sourceSpans(text,maxBytes=65536){
  if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes||!text.isWellFormed())throw new TypeError('Invalid/bounded original source');
  const chars=egcs(text),utf8=[0];for(const char of chars)utf8.push(utf8.at(-1)+Buffer.byteLength(char));
  return {chars,span(lower,upper){
    if(!Number.isSafeInteger(lower)||!Number.isSafeInteger(upper)||lower<0||upper<=lower||upper>chars.length)throw new RangeError('Invalid original EGC range');
    return {lower,upper,source:chars.slice(lower,upper).join(''),utf8Lower:utf8[lower],utf8Upper:utf8[upper]};
  }};
}
export function exactSourceSelection(text,selection,maxEGC=80){
  const view=sourceSpans(text),span=view.span(selection?.lower,selection?.upper);
  if(span.upper-span.lower>maxEGC||span.source!==selection.source)throw new TypeError('Exact original selection required');
  return span;
}
