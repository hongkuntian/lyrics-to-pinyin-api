// Conventional text readings, never evidence of a recording's sung reading.
// Work on complete analyzer tokens within one uninterrupted Japanese run.
const emptyContainers = new Set(['箱','瓶','グラス','財布','缶','袋']);
const desertedPlaces = new Set(['道','街','町','駅','公園','部屋','廊下','路地','海岸']);
const food = new Set(['料理','カレー','スープ','味','食べ物','唐辛子','キムチ']);
const personEndings = /^(?:で|の|が|は|を|に|も|と|だけ|きり|ずつ|ぼっち|とも|一人)/u;
const endsNoun = (tokens,index) => !tokens[index+1] || ['助詞','助動詞'].includes(tokens[index+1].pos);

export function contextualJapaneseTokens(input) {
  const tokens = input.map(token => ({...token}));
  const result = [];
  for (let index = 0; index < tokens.length; index++) {
    let token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (['一','二'].includes(token.surface_form) && token.pos_detail_1 === '数'
        && next?.surface_form === '人' && next.pos_detail_1 === '接尾'
        && previous?.pos_detail_1 !== '数' && !previous?.surface_form?.includes('第')) {
      const following = tokens.slice(index + 2, index + 5).map(t => t.surface_form).join('');
      if (!following || personEndings.test(following)) {
        const reading = token.surface_form === '一' ? 'ヒトリ' : 'フタリ';
        token = {...token, surface_form:token.surface_form + '人', reading, pronunciation:reading,
          pos_detail_1:'一般'};
        index++;
      }
    }
    let reading;
    if (token.surface_form === '人気者' && token.pos === '名詞') reading = 'ニンキモノ';
    if (token.surface_form === '人気' && next?.surface_form === '者' && next.pos_detail_1 === '接尾') {
      token = {...token,surface_form:'人気者'}; reading = 'ニンキモノ'; index++;
    }
    if (token.surface_form === '人気' && token.pos === '名詞'
        && next?.surface_form === 'の' && tokens[index+2]?.surface_form === 'ない'
        && desertedPlaces.has(tokens[index+3]?.surface_form) && endsNoun(tokens,index+3)) reading = 'ヒトケ';
    if (token.surface_form === '空' && token.pos === '名詞'
        && next?.surface_form === 'の' && emptyContainers.has(tokens[index+2]?.surface_form)
        && endsNoun(tokens,index+2)) reading = 'カラ';
    if (token.basic_form === '辛い' && token.pos === '形容詞') {
      const ending = token.surface_form.slice(1);
      const contextIndex = index + (['た','て'].includes(next?.surface_form) ? 2 : 1);
      const context = tokens[contextIndex];
      if ((food.has(context?.surface_form) && endsNoun(tokens,contextIndex))
          || (next?.surface_form === 'て' && ['美味しい','おいしい','旨い','うまい'].includes(context?.basic_form))) {
        // Preserve the analyzer's inflection; replace only the lexical stem.
        const endings = {い:'イ',く:'ク',かっ:'カッ',けれ:'ケレ'};
        if (Object.hasOwn(endings,ending)) reading = 'カラ' + endings[ending];
      }
    }
    result.push(reading ? {...token,reading,pronunciation:reading} : token);
  }
  return result;
}
