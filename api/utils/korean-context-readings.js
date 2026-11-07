// Standard-pronunciation exception: verb/adjective ㄺ becomes ㄹ before ㄱ.
// This is a pronunciation-only intermediate; canonical Hangul remains untouched.
// A finite stem/ending set avoids applying the verb rule to nouns such as 닭고기.
const stems = new Set(['읽','맑','밝','늙','묽','긁','굵']);
const endings = /^(?:고|게|기|거나|거든|겠|구나|군)/u;
export function koreanPronunciationInput(text) {
  const source = text.normalize('NFC');
  if (!stems.has(source[0]) || !endings.test(source.slice(1))) return source;
  // ㄺ and ㄹ have adjacent jongseong indices in a precomposed Hangul syllable.
  return String.fromCharCode(source.charCodeAt(0)-1) + source.slice(1);
}
