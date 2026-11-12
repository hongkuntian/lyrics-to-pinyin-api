export const sensitiveCredit=/\b(feat|ft|featuring|with|live|remaster(?:ed)?|instrumental|karaoke|acapella|cover|remix|demo|version|acoustic|reprise|edit|mix)\b|合唱|翻唱|原唱|客串|现场|現場|演唱会|演唱會|伴奏|重制|重製/iu;
const titleAnnotation=/\s*(?:\([^()[\]\r\n]*\)|\[[^()[\]\r\n]*\])/gu;
const titleDescription=/^(?:from\s+.+|(?:love\s+)?theme\s+(?:song\s+)?from\s+.+|.*(?:主题曲|主題曲|插曲|片尾曲|片頭曲|片头曲|主题歌|主題歌).*|抖音[热熱]歌)$/iu;
const themeDescriptionSuffix=/\s+[-–—]\s+(?:電視劇|电视剧|電影|电影|動畫|动画)[「《][^「」《》\n]+[」》](?:主題曲|主题曲|片尾曲|片頭曲|片头曲|插曲|主題歌|主题歌)\s*$/u;
const japaneseThemeDescription=/\s*\(([^()\r\n]*[\p{Script=Hiragana}\p{Script=Katakana}][^()\r\n]*)\)$/u;
const guestCredit=/\s*\((?:feat\.?|ft\.?|featuring|with)\s+([^()]+)\)/gi;
const liveLabel=/\(\s*live\s*版?\s*\)/gi;

function annotationParts(title) {
 const malformedAnnotations=/[()[\]]/u.test(title.replace(titleAnnotation,'')),descriptions=[];
 const base=malformedAnnotations?title:title.replace(titleAnnotation,annotation=>{
  if(!titleDescription.test(annotation.trim().slice(1,-1))||sensitiveCredit.test(annotation))return annotation;
  descriptions.push(annotation.trim());return '';
 });
 return {base:base.trim(),descriptions,malformedAnnotations};
}
export const stripTitleDescription=value=>annotationParts(value.normalize('NFKC')).base;
export const stripThemeDescriptionSuffix=value=>value.normalize('NFKC').replace(themeDescriptionSuffix,
 description=>sensitiveCredit.test(description)?description:'').trim();
function normalizeJapaneseThemeTitle(value) {
 const title=value.normalize('NFKC'),match=title.match(japaneseThemeDescription);
 return match&&!sensitiveCredit.test(match[1])&&match[1].endsWith('全話OP')
  ?title.slice(0,match.index)+` (${match[1].slice(0,-4)})`:title;
}
export function japaneseThemeSearchTitle(value) {
 const title=value.normalize('NFKC'),match=title.match(japaneseThemeDescription);
 return match&&!sensitiveCredit.test(match[1])?title.slice(0,match.index).trim():null;
}
export function parseRecordingTitle(raw='',{themeSuffix=false}={}) {
 const normalized=raw.normalize('NFKC'),suffix=themeSuffix?stripThemeDescriptionSuffix(normalized):normalized;
 const {base,descriptions,malformedAnnotations}=annotationParts(suffix),guests=[],rules=[];
 if(normalized!==raw)rules.push('unicode_compatibility');
 if(suffix.trim()!==normalized.trim())rules.push('theme_description_suffix');
 if(descriptions.length)rules.push('soundtrack_description');
 const searchTitle=base.replace(guestCredit,(annotation,credit)=>{guests.push(credit);return '';}).trim();
 if(guests.length)rules.push('guest_credit');
 const live=searchTitle.replace(liveLabel,'(Live)'),title=normalizeJapaneseThemeTitle(live).trim();
 if(live!==searchTitle)rules.push('live_label');
 if(title!==live)rules.push('japanese_theme_description');
 return {raw,normalized,title,searchTitle,guests,descriptions,rules,malformedAnnotations};
}
