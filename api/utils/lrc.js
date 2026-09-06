// LRC fractions are decimal seconds, not always milliseconds.
export function parseLRC(raw = '') {
  const lines = [];
  for (const row of raw.split(/\r?\n/)) {
    if (/^\s*\[(?:ar|al|ti|by|offset|length|re|ve):/i.test(row)) continue;
    const matches = [...row.matchAll(/\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = row.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;
    if (!matches.length) {
      if (!/^\s*\[\d/.test(row)) lines.push({text, timestamp:null});
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
