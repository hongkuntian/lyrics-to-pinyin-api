# Initial provider comparison

Observed 2026-09-13T08:07:14.361Z through 2026-09-13T08:08:01.614Z.

This is a six-recording, single-pass probe of individual adapters. It is not a test of the full production selector, catalog localization or caches. No new provider is promoted.

| Recording | LRCLIB | NetEase | KuGou | lyrics.ovh |
|---|---|---|---|---|
| jacky-mandarin | recording mismatch | 42/42 timed; reference text match | No accepted lyric result | http 404 |
| jacky-cantonese | 0/34 timed; text needs review | 47/47 timed; text needs review | recording mismatch | http 404 |
| evon-cover | recording mismatch | recording mismatch | No accepted lyric result | http 404 |
| beyond-cantonese | 30/30 timed; text needs review | 40/40 timed; text needs review | recording mismatch | http 404 |
| jay-ashin-duet | 36/36 timed; text needs review | recording mismatch | recording mismatch | http 404 |
| daft-punk-isrc-control | 100/100 timed; text needs review | 46/46 timed; text needs review | 84/84 timed; text needs review | 0/102 timed; text needs review |

## Findings

- NetEase returned all 42 reviewed Mandarin lines for Apple recording `1440912488`; normalized text matched the accepted reference and no timestamp exceeded the recording duration. This reproduces the existing repair, rather than demonstrating a new provider improvement.
- The patched LRCLIB adapter rejected the Mandarin lookup. That is safer than serving the known Cantonese transcription, but means another source is still needed.
- lyrics.ovh returned 404 for all five Chinese fixtures and untimed text for the English control. It does not add useful Chinese coverage in this small sample.
- No tested adapter accepted the Evon Low cover under the supplied complete metadata. This is a useful unresolved coverage case for the authenticated candidates.
- Both LRCLIB and NetEase returned candidates for the Cantonese recording whose text differed from the comparison reference; LRCLIB returned plain text only. The automatic result correctly left both for review. The subsequent review below identified a second mislabeled LRCLIB entry.
- MusicBrainz returned 404 for the sourced Cantonese ISRC and 503 for the English control; four fixtures had no sourced ISRC and were skipped. The earlier discovery search also returned 503. These observations establish no reliable MusicBrainz bridge for the problem recording.

## Remaining candidate access

Musicae and Musixmatch need authenticated requests. No keys were available for the initial baseline. The user is setting up free-tier access. Spotify/LyricFever requires a separate authenticated unofficial route and was not exercised. The linked Musicae Apify actor currently documents analysis output rather than lyrics; the direct RapidAPI lyrics endpoint is the intended probe.

## Post-run text review

LRCLIB entry `18172401` claims the Cantonese album `這個冬天不太冷` and a
319.253-second duration, but its 406 normalized characters match the reviewed
Mandarin transcription except for two `了` / `瞭` substitutions. This is a second
mislabeled lyric record, in the opposite direction from the original incident.
Its text fingerprint is
`5fae9d9ad2e399d6aaa7cd3a02437174f3914b81da7f09e8043966da4f0532cd`.
The fixture and initial machine verdict are retained unchanged; this is a
post-run source comparison, not a blind accuracy score or native audio test.

NetEase entry `190128` is much closer to the Cantonese reference (93.5% sequence
similarity), with inserted text and several character changes. It still needs
complete lyric/timing review. Similarity alone is not treated as acceptance.

This finding reinforces why matching recording metadata, even precise duration,
does not establish that the attached lyric text belongs to that recording. No
additional production rejection or selection change was made by the experiment.

Sources: [LRCLIB 18172401](https://lrclib.net/api/get/18172401),
[Mandarin reference](https://music.163.com/song?id=189873),
[NetEase Cantonese recording](https://music.163.com/song?id=190128).

## Verification

- Eight deterministic experiment tests passed, covering reference classification, timing differences, key redaction, identifier-only requests, quota handling and schema failures.
- The backend `npm test` unit, integration and contract gates passed.
- Live provider misses and outages are recorded above; they are not hermetic test failures.

Raw observations are retained locally in `tmp/provider-experiment/baseline.json`. Only public fixture metadata and analysis are committed; lyric bodies and API credentials are excluded.
