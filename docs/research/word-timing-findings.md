# Measured lyric source coverage

## Finding

The English coverage gap is chiefly missing source formats, rather than an
English-language switch in NetEase. The previous adapter already requested
NetEase YRC for English. Live Viva la Vida and Shape of You source IDs returned
line lyrics without YRC, while other English recordings returned YRC. Kugou was
downloaded as `fmt=lrc`, losing the available KRC word markers. QQ QRC was absent.

Static inspection of a Dynamic Lyrics 2.0.5/build 179 executable found Kugou
`fmt=krc`, QQ `lyric_download.fcg` with `lrctype=4`, their decoder/parser paths,
and an Apple syllable-TTML path. The examined IPA is a modified third-party
package, not a verified current App Store binary. It was inspected as data and
never installed or executed. This establishes implemented source paths; it does
not establish which source the user's stock app chose, its actual latency, or
whether every displayed word highlight is measured. No extracted account token,
private Apple service or competitor backend credential is used by this change.

The user reported Spotify playback and no visible source label. Their exact
Spotify item ID was not captured. The frozen Apple catalog benchmark therefore
must not be presented as a reproduction of their exact recording or stock app.

## Implementation

- Kugou downloads KRC first, falls back once to LRC, and validates every equally
  ranked best metadata candidate before accepting an edition. Conflicting words,
  row times or measured cues reject the tie. Failure cancels pending peer work.
- QQ searches public suggestions, then batches fresh structured song details and
  QRC reads for all bounded suggestions. Numeric ID and MID, complete credits,
  version labels, duration and best-candidate consensus remain admission gates.
  Complete edition annotations and suffixes remain material, including unknown
  qualifiers. Allowed award/Explicit caption suffixes revalidate their remaining
  base. Identical complete album text can survive punctuation differences without
  equating different years or venues. A rejected suggestion can be excluded by a
  freshly ID/MID-verified duration outside the existing bound; that proof remains
  authoritative during legacy fallback.
  Fresh ID revalidation avoids rediscovery when verified source context exists.
- Provider display translations may be accepted only when freshly bound to the
  same QQ entity. A translation cannot erase a version or a printed guest.
  Source-owned sheet labels remain distinct from catalog metadata. A narrowly
  recognized Explicit sheet label additionally requires an explicitly classified
  request and private fresh-admission evidence; serialized fields cannot grant it.
- The existing two-provider hedge can show readable lyrics first and continue
  looking for better measured coverage within its existing deadline. Complete
  readable editions outrank partial editions. Among usable measured candidates,
  meaningful grapheme coverage controls selection; a single cue cannot end the
  search. Existing reviewed/replacement timing rules retain precedence.
- `metadata.word_timing_upgrade_version: 2` distinguishes old negative capability
  cache entries. Native policy allows one bounded retry after that migration and
  adopts only strictly greater coverage on the current recording/source epoch.
  Sparse successes have a shorter lifetime than complete coverage.
- Normal library acquisition requests `options.lyric_sources_version: 2`, matching
  the expanded provider set used by native raw timing requests. The winning source
  supplies the saved text, line times and measured cues together. Raw version 1 or
  omitted-option calls retain their former provider set and separate cache keys.
  Existing saved copies can use Reload Lyrics without a bulk migration.
- Refresh retains valid measured coverage on a strict quality downgrade, using
  the same meaningful-grapheme coverage, provenance and duration-precision rules
  as acquisition. Equal-quality editions can replace the current source; rejected
  old sources still yield. Whole immutable documents are saved through the existing
  lookup lease and exact-request mapping. Old translations, corrections and admitted
  jobs remain bound to their original document, never copied onto changed wording.
  Optional timing attachments still require exact accepted text and better coverage.

Backend ownership centralizes source consensus, provenance, cache reuse and
identity rules. The existing progressive response path and native overlay avoid
making initial readable lyrics wait for the richest timing. This gives broader
coverage without duplicating provider matching and reconciliation on the phone.

## Timing fidelity and bounds

KRC markers precede their text and use offsets relative to the row; QRC markers
follow their text and use absolute song milliseconds. Both produce exact UTF-16
text ranges. Zero-duration text remains readable without a fabricated cue.
Malformed optional timing drops the affected row's cues, not its words. Source
format, source ID, parser capability and the complete source edition participate
in revision identity. Public DTOs bind provenance to the requested catalog ID.

QQ's structured `interval` has whole-second precision. Only validated QQ QRC
provenance may carry `durationResolution: 1`, admitting source timestamps strictly
below the next whole second while preserving the reported duration. Other
sources and unqualified documents retain the exact bound; nothing is rescaled.

Some QRC rows end exactly one millisecond before the last supplied positive word
cue. The parser derives the containing row envelope from that supplied cue only
for this one-millisecond discrepancy. That envelope adjustment leaves word times
unchanged, and the original container endpoint remains in the source revision.
This recovers the measured initial Idol row without distributing guessed times.

Adjacent QQ words can also overlap by exactly one integer millisecond. The QRC
parser joins only that boundary at the next supplied word start when starts
strictly increase, changing the preceding end by one millisecond. Raw intervals
remain in the source revision, and the parser/selection capability invalidates
older parsed caches. Shared and native interval validation remain unchanged;
larger overlaps, reversed times, broken text ranges and duration violations still
lose optional cues. An anonymized multirow fixture reproduces Mojito's 89-to-404
cue recovery with complete meaningful-grapheme coverage and unchanged words.

Meaningful coverage counts graphemes containing letters or numbers, not silent
punctuation or spaces. Complete coverage means all such text in the returned
source edition has valid measured cues. It does not prove that the edition
contains every sung word, matches the audio, or describes the intended clean,
explicit, live or remastered recording. The optional 160 KB response cap remains;
large word extensions may be dropped to preserve readable lyrics.

## Reproduction and acceptance limits

The hermetic gate is `npm test`. Synthetic KRC/QRC fixtures pass through real
parsers, production acquisition/formatting and durable public projections; no
copyrighted provider lyric body is committed. The public QRC interoperability
codec's MIT provenance is retained in `api/utils/vendor/NOTICE.qq-qrc.md`.

`scripts/benchmark-word-timing.mjs` is opt-in live research. For example:

```sh
node scripts/benchmark-word-timing.mjs \
  --baseline-root /absolute/path/to/original-backend \
  --output /absolute/path/outside/repository/comparison.json \
  --ids en-viva-album,en-shape --runs 3 --concurrency 1 --max-time-ms 30000
```

Omit `--ids` to run the frozen 17-case corpus: twelve coverage cases and five
recording-version controls. Artifacts retain metadata, counts, hashes and latency,
not lyric bodies, download keys or request credentials. Source fingerprints are
checked before and after the run. The baseline uses its original registry,
selection and hedge. Direct fixed-ID source replays bypass discovery and tie
consensus and are labelled separately from the production adapter path.

These measurements exclude deployed authentication, network geography, Redis,
database, native visible latency and stock Dynamic Lyrics runtime. Source
metadata admission is not acoustic or catalog equivalence. In particular, the
drivers license Apple cleaned case initially matched a QQ sheet whose content
hash equals a separately labelled Explicit sheet. The final QQ admission path
compares album rendition labels as well as titles, rejects that recovery and
returns readable LRCLIB lyrics instead. A true explicit request classification
can qualify Explicit labels while Clean, Live and other distinctions remain
strict. The remaining absence of matching measured timing is an honest gap.


## Chinese catalog admission regressions (2026-10-27)

The exact Spotify 天天想你 recording (`7mubQiRZ1Q94ZN3zCrNbzn`,
252866 ms, same-name album) has complete NetEase YRC timing at source `188177`.
Discovery rejected its artist credit: Spotify uses Zhang Yu Sheng while the
fresh NetEase artist `6459` profile uses 张雨生 with Tom Chang. The existing
reviewed artist-alias registry now covers this identity, conditional on that
fresh provider ID, canonical name and profile alias. Recording title, album,
duration, complete contributors and version checks still apply. This is an
artist identity entry, not a song-title exception or phonetic matching rule.

A frozen expansion across ten additional Chinese catalog artists found the
same gap for A-Mei Chang: NetEase artist `10559` uses 张惠妹 with aMEI. The
reviewed entry admits the exact BAD BOY 聽海 source `327584` (318626 ms) for
Spotify `5WD10VSuBAm2YxnaiqQ3eA` (318333 ms) under the existing duration policy.
Changed profiles, IDs, Live editions and incompatible durations remain refused.
The NetEase acquisition cache capability advances; accepted source hash recipes
and immutable stored documents do not change.

The maintained discovery corpus grows from 30 to 42 cases. The ten additional
artist recordings were selected before timing measurement, and every result is
retained. With the two exact user reports included, the 12-case local production
service replay changes from 9 to 12 complete measured results; all nine prior
complete results remain complete. Mojito retains 404 cues covering 432 meaningful
graphemes, 天天想你 has 315/315, and 聽海 has 337/337. These three source-positive
cases also join the existing availability cohort (110 to 113), so later manual
coverage runs retain these regressions. The expanded cohort is a convenience
sample, not a catalog-wide coverage estimate or a stock Dynamic Lyrics test.
Live public-provider metadata and measured coverage do not establish acoustic
alignment, authenticated deployed acquisition or physical-device playback.

## Observed source-path results (2026-10-18)

After the version-admission correction, the fixed 17-case corpus returned
complete measured coverage for 16 cases, versus 6 on the original backend.
Coverage cases improved from 4/12 to 11/12; the five version controls improved
from 2/5 to 5/5. drivers license remains readable without an admitted measured
source. No original complete-measured positive was lost. These are source
metadata checks, not independent audio-alignment or stock-app acceptance.

The final paired source-adapter runs returned complete measured timing three
times each for Viva la Vida and Shape of You. Median lookup time was 758 ms
(range 725–2118 ms) and 77 ms (74–207 ms), respectively. Fresh known-ID QQ
revalidation medians were 364 and 408 ms. These small samples are observations,
not p95 guarantees or a controlled stock-app comparison. Readable-first and
measured-completion timings are different metrics.

The local production service with the real Japanese processor preserved all
769 supplied Idol cues (773/773 meaningful graphemes); Shape of You preserved
655 cues (2224/2224), and Despacito 510 (2052/2052). Acquisition DTOs were
106132, 108349 and 96412 bytes respectively. Public library projections also
retained every cue. This checks the formatter/size path in addition to adapters;
it is not an authenticated deployed HTTP or phone measurement.

Static source identity for the inspected executable:
`181f6033d12413811dfafcca146a413040bf32cf25807fa39452653219b09d33`
(SHA256, arm64 slice, 13795328 bytes, Mach-O UUID
`c95b646bf9c83f66b0cce1e22a75b499`, cryptid 0). Representative virtual addresses:
Kugou download `0x1002e68a4`, KRC decode `0x1002d076c`, row parser
`0x1002d0f5c`; QQ legacy download `0x1002f8efc`; Apple syllable path
`0x1002f01b4` and TTML delegate `0x1002d7a2c`. Addresses refer only to this
slice, not another app release.
