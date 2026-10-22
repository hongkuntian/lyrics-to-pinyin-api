// LRC fractions are decimal seconds, not always milliseconds.
const headerRows=/^(?:\[(?:ar|al|ti|by|offset|length|re|ve):[^\[\]\r\n]*\]\s*)+$/iu;
export function parseLRC(raw = '') {
  const lines = [];
  for (const row of raw.split(/\r?\n/)) {
    let remaining=row.trimStart(),matches=[];
    for(let match;(match=remaining.match(/^\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/u));){
      matches.push(match);remaining=remaining.slice(match[0].length).trimStart();
    }
    const text=remaining.trim();
    // Recognized headers may concatenate or follow timestamps, but must
    // consume the whole remaining row. A mixed sung tail preserves them all.
    if (!text || headerRows.test(text)) continue;
    if (!matches.length) {
      // Retain the established malformed numeric-timestamp rejection.
      if (!/^\s*\[\d+:/u.test(row)) lines.push({text, timestamp:null});
      continue;
    }
    for (const match of matches) {
      const seconds = Number(match[2]);
      const timestamp = Number(match[1])*60 + seconds + Number(`0.${match[3] || '0'}`);
      if (seconds < 60 && Number.isFinite(timestamp)) lines.push({text,timestamp});
    }
  }
  return lines.sort((a,b)=>(a.timestamp ?? Infinity)-(b.timestamp ?? Infinity));
}
