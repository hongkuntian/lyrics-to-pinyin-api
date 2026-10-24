# Lyrica pronunciation data artifact

This is an **unpublished data-only candidate**, prepared from backend source
`9e6cab8c14d4e6238b37f402fe83e5baf6cb5d1d`. Publication, runtime admission and
linguistic qualification are separate decisions. No profile is enabled by this
tree. A future publication receipt must identify the actual accessible Git commit,
browsable index, compiled download and notice URLs outside this tree; no live
publication URL is asserted here.

The exact packaged files keep their original `unpublished` / `active:false`
**BUILD metadata**, including the historical notice wording. Those fields describe
the retained build and remain unchanged even if Root later publishes this tree.
The separate verified publication record must not be silently inserted into these
covered files or existing closed runtime/native contracts. The retained engine
revision is `b6d045a2b1ea62ab8124b19c3d845ebd4fb669f6acbc9fa08f41ab5cd5a58965`.

## Data and attribution index

| Data | Source and creators | Frozen candidate inventory | Exact data |
| --- | --- | --- | --- |
| Thai | Wiktionary contributors; Tatu Ylonen and Kaikki contributors. 2026-10-03 extraction of enwiktionary 2026-09-02. [Source](https://kaikki.org/dictionary/Thai/kaikki.org-dictionary-Thai.jsonl) | 17,486 keys; 22,340 entries; all raw IPA alternatives retained | [Manifest](language-data/pronunciation/thai/manifest.json), [64 shards](language-data/pronunciation/thai/shards) |
| Hindi aliases | Google Research and Dakshina contributors. Dakshina v1.0, only the Hindi lexicon dev/train/test members. [Pinned source documentation](https://github.com/google-research-datasets/dakshina/tree/99f211490f5ba5bcda8d48675371f5f8be5f7809) | 49,090 alias keys; 53,064 entries; every native alternative/count/locator retained | [Manifest](language-data/pronunciation/hindi/manifest.json), [64 shards](language-data/pronunciation/hindi/shards) |
| Vietnamese headwords | Vietnamese Wiktionary and Kaikki contributors. Extraction retained 2026-10-22; Last-Modified 2026-10-03; upstream dump date unspecified. [Source](https://kaikki.org/dictionary/downloads/vi/vi-extract.jsonl.gz) | 35,465 folded keys; 35,682 original headwords; 38,633 entries | [Manifest](language-data/pronunciation/vietnamese/manifest.json), [64 shards](language-data/pronunciation/vietnamese/shards) |

[Packaged index](language-data/pronunciation/index.json) ·
[Tuple schema and locator semantics](language-data/pronunciation/SCHEMA.md) ·
[Exact source/snapshot/member/hash lock](language-data/pronunciation/source-lock.json) ·
[Every other file's byte/hash/Git-blob inventory](CONTENTS.json) ·
[Compiler and reproducibility provenance](PROVENANCE.json).

These dictionary derivatives are **CC-BY-SA-4.0**, including their derivative
index and finite qualification values. Retain the supplied attribution,
modification descriptions and notices when reusing data. Read the full
[original CC legal code](language-data/pronunciation/CC-BY-SA-4.0.html),
[corrected readable companion](notices/CC-BY-SA-4.0-readable.txt), and
[verbatim derivative notice](language-data/pronunciation/NOTICE.md).
The companion preserves the reviewed section/clause labels and visible legal
text; the original HTML is also included byte-for-byte. No legal clearance is
asserted. Wrapper MIT and dependency terms do not relabel these data.

Dakshina's upstream documentation requests citation of Brian Roark, Lawrence
Wolf-Sonkin, Christo Kirov, Sabrina J. Mielke, Cibu Johny, Işin Demirşahin and Keith
Hall (2020), [Processing South Asian Languages Written in the Latin Script: the
Dakshina Dataset](https://www.aclweb.org/anthology/2020.lrec-1.294). This preserves
the requested attribution; it is not a new license opinion.

Modifications: extract only exact headwords/readings/POS/qualifiers and source
locators; preserve alternatives; combine the three Hindi members as attested
candidate evidence; NFC/case-fold lookup views while retaining original values;
deduplicate stable IDs; hash-shard canonical JSONL; compact common provenance into
manifests. No definitions, usage examples, lyrics, audio, raw dumps, packages or
runtime source code are included. Source links are attribution/navigation; only
the pinned snapshot/member hashes and row/byte/column locators identify frozen
input rows. Current live sources may differ.

## Finite qualification and limits

[Thai's exact 48 forms / 72 entry references](language-data/pronunciation/thai-qualification.json)
are model-assisted dictionary-reading intersection **proposals**. Publication of
all shards grants no broader qualification. Explicit source-range choice remains
necessary; no automatic boundary, semantic-gloss, fluent, human or acoustic
certification is implied. The complete 175-case adjudication input and rationales
remain retained privately; only their exact input hash and finite output appear
here. Full deterministic regeneration of this qualification file needs that pinned
input. No corpus was regraded for publication preparation.

Hindi alternatives require contextual choice and separate explicit Devanagari
confirmation before derived speech. Combining train/dev/test does not produce a
held-out benchmark. Vietnamese remains an incomplete lexical candidate helper,
with no pronunciation profile, automatic segmentation or whole-song denominator.
No Japanese/Korean/written profile is activated or newly qualified here.

## Full notice index

- [kuromoji 0.1.2 Apache-2.0](language-data/pronunciation/licenses/kuromoji-Apache-2.0.txt)
- [mecab-IPADIC 2.7.0-20070801 NAIST/ICOT notice](language-data/pronunciation/licenses/kuromoji-IPADIC-NOTICE.md) — separate from Apache/MIT
- [kuroshiro 1.2.0 MIT](language-data/pronunciation/licenses/kuroshiro-MIT.txt)
- [kuroshiro-analyzer-kuromoji 1.1.0 MIT](language-data/pronunciation/licenses/kuroshiro-analyzer-MIT.txt)
- [Koroman 1.0.16 exact source MIT notice](language-data/pronunciation/licenses/koroman-MIT.txt) and [source receipt](language-data/pronunciation/licenses/koroman-license-source.json)
- [Lyrica wrapper/compiler MIT](notices/lyrica-wrapper-MIT.txt) and [verbatim wrapper notice](notices/lyrica-wrapper-NOTICE.txt)
- [Sanscript 1.3.3 MIT](notices/sanscript-MIT.txt) and [verbatim source receipt](notices/sanscript-source.json)

**Koroman upstream condition:** the installed package omitted LICENSE. The exact
gitHead-pinned primary notice is 1,150 bytes, SHA256
`8e140c804d0226d197db528f1653ede195ab254935b4fa18bc81f1ea455614ca`,
with a complete MIT grant/copyright ©2025 Donghe Youn and literal conflict
markers. Root's bounded engineering disposition preserves those exact bytes and
the source receipt, with this disclosure outside the verbatim notice. No marker
was removed. No author correction, upstream resolution or legal clearance is
claimed. Korean profile admission remains separate and inactive.

The copied wrapper notice's historical `LICENSE` means the wrapper MIT linked
above, and its `licenses/` references mean the pronunciation license directory.
The Sanscript receipt names the original `sanscript.cjs` source, intentionally
absent from this data-only tree; its `LICENSE` is the linked Sanscript MIT.
[Dependency file pins](language-data/pronunciation/dependency-pins.json) and
[engine input pins](language-data/pronunciation/engine-manifest.json) are metadata
only. Their referenced backend/dependency source files are intentionally absent.

## Reproducibility and download

[PROVENANCE.json](PROVENANCE.json) pins both exact compiler source paths, Git blob
IDs, byte counts, SHA256 values and backend source commit. The lexical compiler
uses Node 24 built-ins, exact pre-staged source-lock inputs and a separately owned
output root. It produces 197 lexical output files. This candidate reuses the
existing deterministic-recompile receipt and matches its output hashes; no full
recompile or package install was performed.

The backend source commit and compiler references are **currently unpublished**
according to unauthenticated public GitHub metadata. Those references identify
exact source; they are not claimed as accessible public links. Root must settle
their public reproducibility availability separately. Raw sources, the private
adjudication input and dependency packages are not mirrored here.

After actual publication, use the verified commit SHA, rather than a movable tag,
in GitHub's archive URL. The archive will contain only this data tree; validate
the extracted file set, byte counts and SHA256 values against the exact handoff
manifest. GitHub-generated compression bytes can change without changing file
contents. Individual raw-file URLs also need actual HTTP/content/hash checks.
No download URL exists for this candidate yet. Runtime lookup continues to use
packaged server shards, with no GitHub download at import or per tap.
