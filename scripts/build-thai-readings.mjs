// Build the pinned Thai reading list from a verified Wiktionary extract.
// Source: English Wiktionary via kaikki.org (Wiktextract), CC BY-SA 4.0. The
// derived list is distributed under the same licence; see THIRD_PARTY_NOTICES.md.
// Usage: node scripts/build-thai-readings.mjs /path/to/kaikki.org-dictionary-Thai.jsonl
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

export const SOURCE='https://kaikki.org/dictionary/Thai/kaikki.org-dictionary-Thai.jsonl';
export const SOURCE_SHA256='a9afaf7191a4e2d9d976a893a58fb68039bce657784ca8af7cab48d35e0a2e66';
const thaiWord=/^[ก-๎]+$/u,skipped=new Set(['character','prefix','suffix','infix','punct','symbol']);

// The first full Paiboon reading Wiktionary lists for a word: the standard
// reading precedes colloquial ones (ฉัน chǎn before chán). Bound forms that
// only occur inside compounds (náam-, kun-ná-) are not word readings.
export function derive(jsonl) {
  const entries={};
  for(const line of jsonl.split('\n')) {
    if(!line)continue;
    const entry=JSON.parse(line);
    // Letter names, affixes and bare-consonant abbreviations (ค, จ.) are not
    // words; composing unknown words from them would invent readings.
    if(!thaiWord.test(entry.word)||/^[\u0E01-\u0E2E]$/u.test(entry.word)||skipped.has(entry.pos)||Object.hasOwn(entries,entry.word))continue;
    const reading=(entry.sounds??[]).find(s=>s.raw_tags?.includes('Paiboon')&&typeof s.roman==='string'
      &&s.roman.trim()&&!/^-|-$/.test(s.roman.trim())&&!/\s/.test(s.roman.trim()))?.roman.trim();
    if(reading)entries[entry.word]=reading.normalize('NFC');
  }
  return Object.fromEntries(Object.entries(entries).sort(([a],[b])=>a<b?-1:a>b?1:0));
}

if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const raw=readFileSync(process.argv[2]);
  const digest=createHash('sha256').update(raw).digest('hex');
  if(digest!==SOURCE_SHA256)throw new Error(`unexpected_source_sha256 ${digest}`);
  const entries=derive(raw.toString('utf8'));
  const document={schema:1,source:SOURCE,sourceSHA256:SOURCE_SHA256,retrieved:'2026-11-08',
    license:'CC BY-SA 4.0',attribution:'Wiktionary contributors, extracted by kaikki.org (Wiktextract)',
    derivation:'First full Paiboon romanization per Thai-script headword; bound forms, letter names, affixes and bare-consonant abbreviations excluded.',
    count:Object.keys(entries).length,entries};
  writeFileSync(new URL('../api/data/thai-readings.json',import.meta.url),JSON.stringify(document)+'\n');
  console.log(document.count);
}
