# Pronunciation dictionary derivative notice

Publication status: **unpublished; inactive**. No derivative commit URL, download
URL or public archive-row permalink is claimed. Root must publish the exact
shards, index/schema, source lock and notices in an immutable data-artifact commit,
then pin actual browsable/download/notice URLs and hashes in the engine release.
These packaged server files are never downloaded at import or per tap.

The Thai, Hindi and Vietnamese dictionary derivatives (including their index,
qualification row values and dictionary-derived fixture readings) are licensed
under **Creative Commons Attribution-ShareAlike 4.0 International**. The complete
legal code is [CC-BY-SA-4.0.html](CC-BY-SA-4.0.html). This copy is retained from the
official Creative Commons source; SHA256 is
`d48546c6161cd2698445d184a859363a2436a6a3bcda655564730e3861e74a9e`.
Wrapper/compiler/test code is separately MIT; dependency notices do not relabel data.

Thai: Wiktionary contributors; extraction by Tatu Ylonen and Kaikki contributors.
Source: https://kaikki.org/dictionary/Thai/kaikki.org-dictionary-Thai.jsonl
Snapshot: 2026-10-03 extraction of enwiktionary 2026-09-02; expanded SHA256
`54f99aa88a65d3be58b3a169526af04fb07f2643685f47343dccd2b33ba0c259`.
Retain all exact headword IPA variants, source sound/record hashes, line/byte/sound
column locators, POS and sound qualifiers. Do not infer a contextual sense from
an IPA. No normalization strips tones, vowel length, aspiration, glottal stops,
unreleased-stop marks, internal or terminal dots. Exact original headword lookup
is used. Root's two model-assisted screens intersect at 48 exact entry/raw-variant
sets; this is a dictionary-reading proposal, not boundary, human or acoustic proof.

Hindi: Google Research and Dakshina contributors, Dakshina v1.0, CC-BY-SA-4.0.
Pinned source/format attribution:
https://github.com/google-research-datasets/dakshina/tree/99f211490f5ba5bcda8d48675371f5f8be5f7809
Archive: https://storage.googleapis.com/gresearch/dakshina/dakshina_dataset_v1.0.tar
Only the three Hindi lexicon members are inputs. source-lock.json retains exact
member paths, byte-range starts, lengths and input hashes. Tuples retain exact
row, column, byte offset/length, native/roman values and attestation count. Alias
lookup NFC/case folds a disposable view; original Latin source remains exact.
All splits are combined as candidate evidence, not held-out quality evaluation.
Counts are attestations, not probabilities. Candidates are incomplete and every
derived Devanagari speaking value requires separate explicit confirmation.

Vietnamese: Vietnamese Wiktionary contributors via Kaikki's Vietnamese-edition
raw extraction, CC-BY-SA-4.0.
Source: https://kaikki.org/dictionary/downloads/vi/vi-extract.jsonl.gz
Retained on 2026-10-22, Last-Modified 2026-10-03; upstream dump date unspecified.
Compressed input SHA256:
`566a1b6b941d5ec792ce5f79f1830250076a5d9d517c1f3d1aa04dd4dc02482d`.
Keep allowed Latin headwords/POS up to 80 EGC, NFC lookup and Vietnamese lowercase,
with every original spelling/POS/row/hash/byte locator. The 35,682 exact headwords
map to 35,465 case-folded keys; all spelling alternatives remain. No gloss,
translation, lyric, usage example or audio is copied. Every contained/crossing
compound candidate stays available; no automatic longest-match or denominator.

The deterministic compiler removes examples, definitions, etymology prose,
categories, audio links and unrelated fields; retains only needed headwords,
readings and locators; deduplicates exact stable IDs; hash-shards canonical JSONL;
compacts repeated provenance into the pinned dataset manifest and tuple schema.
Runtime expands only a requested entry. Original authored diagnostic sentences
are kept solely in dedicated test fixtures, outside published data.

Japanese existing dependency notices are in licenses/: kuromoji Apache-2.0,
mecab-IPADIC NAIST/ICOT, kuroshiro MIT and analyzer MIT. The existing koroman
package declares MIT by Donghe Youn but omits LICENSE. The full primary MIT license
is retained as licenses/koroman-MIT.txt, pinned to npm 1.0.16 gitHead
`e529729b923f8a9d9acc62b2c9c0887b00e9bd88` with a source/hash receipt. Only bounded
metadata/license files were downloaded; no package or model was installed or
vendored. See wrapper NOTICE.

A live Wiktionary page is navigation/attribution, not a permalink for the frozen
raw row. Only the snapshot hash plus exact row/byte/column locator identifies that
input. There are no fake archive URLs or self-referential commit URLs.
