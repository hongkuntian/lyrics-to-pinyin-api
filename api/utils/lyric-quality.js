// Provider credits are not vocal lyrics. Keep the list deliberately explicit:
// arbitrary colons, prose, or short lyric lines are not metadata by themselves.
const credit = /^(?:词|詞|曲|作词|作詞|填词|填詞|作曲|编曲|編曲|词曲|詞曲|制作人|製作人|制作|製作|监制|監製|录音|錄音|混音|母带|母帶|和声|和聲|弦乐|弦樂|吉他|贝斯|貝斯|鼓|钢琴|鋼琴|配唱制作人|配唱製作人|录音师|錄音師|混音师|混音師|母带工程师|母帶工程師|音乐总监|音樂總監|发行|發行|出品|版权|版權|发行公司|發行公司|制作公司|製作公司|录音室|錄音室|录音工程师|錄音工程師|混音工程师|混音工程師|lyrics\s+by|compos(?:er|ed\s+by)|arrang(?:er|ed\s+by)|produc(?:er|ed\s+by)|mixed\s+by|mastered\s+by|recorded\s+by)\s*[:：]/iu;
const instrumentalMarker = /^(?:纯音乐[，,。\s]*(?:请欣赏)?|純音樂[，,。\s]*(?:請欣賞)?|instrumental)[。.!\s]*$/iu;

export function cleanLyrics(data, {duration} = {}) {
  if (!data) return null;
  const lines = (data.lines || []).filter(line => typeof line.text === 'string')
    .map(line => ({...line, text: line.text.trim()}))
    .filter(line => line.text && !credit.test(line.text) && !instrumentalMarker.test(line.text))
    .map(line => ({...line, timestamp: Number.isFinite(line.timestamp) && line.timestamp >= 0
      && (!Number.isFinite(duration) || line.timestamp <= duration) ? line.timestamp : null}));
  // NetEase encodes its explicit instrumental flag as this fixed full phrase.
  // Only accept it from that provider and only when no vocal text remains.
  const markedInstrumental=data.source==='netease' && (data.lines || []).some(line=>
    /^(?:纯音乐[，,。\s]*请欣赏|純音樂[，,。\s]*請欣賞)[。.!\s]*$/u.test(line.text?.trim() || ''));
  return {...data, lines, instrumental: (data.instrumental === true || markedInstrumental) && lines.length === 0};
}

export function hasUsableLyrics(data, options) {
  const cleaned = cleanLyrics(data, options);
  return !!cleaned && (cleaned.lines.length > 0 || cleaned.instrumental);
}

export function timingStructure(data, options) {
  const cleaned = cleanLyrics(data, options);
  const times = (cleaned?.lines || []).map(line => line.timestamp).filter(Number.isFinite);
  return {vocalLines: cleaned?.lines.length || 0, timedLines: times.length,
    distinctTimes: new Set(times).size, instrumental: cleaned?.instrumental === true};
}
