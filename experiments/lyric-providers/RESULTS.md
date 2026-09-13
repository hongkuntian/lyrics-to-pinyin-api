# Lyric provider comparison

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

## Authenticated Musicae comparison

The 2026-09-13 authenticated follow-up made four successful RapidAPI requests:
two ISRC lyric queries, one recording metadata query and one direct Spotify-ID
lyric query. The final response reported six requests remaining in a ten-request
allowance. Four fixtures without sourced ISRCs were skipped in the initial
authenticated pass; those skips are not evidence of absent provider coverage.

**Musicae reproduced the original wrong-version lyric result.** The identifier
route did not repair this recording, even when queried directly by Spotify ID.

| Query on `dj-track-audio-analysis-api.p.rapidapi.com` | Observed result |
|---|---|
| `/v2/tracks/HKA619900534/lyrics` | Spotify ID `0lcU3CPpyG6AnLRzZowdzr`; 34 timed Cantonese lines |
| `/v2/tracks/HKA619900534` | Same Spotify ID; album `真愛 新曲 + 真正精選`; duration 278.506 seconds; echoed ISRC `HKA619900534` |
| `/v2/tracks/0lcU3CPpyG6AnLRzZowdzr/lyrics` | Same 34 timed Cantonese lines, rejected against the reviewed Mandarin reference |
| `/v2/tracks/GBDUW0000053/lyrics` | Daft Punk, “One More Time”; 100 timed lines |

The Jacky Cheung metadata matches the original Mandarin fixture's album and
duration (within one millisecond), but the lyric text and complete parsed
line/timestamp sequence exactly match the original bad LRCLIB entry `13004903`
and its duplicate `25371400`. Both public LRCLIB entries were fetched again for
this comparison. All timestamps fit inside the Mandarin duration, so an
out-of-range check would not catch the mismatch.

| Comparison | Normalized text SHA-256 | Cleaned line/timestamp SHA-256 |
|---|---|---|
| Jacky Cheung: both Musicae queries and LRCLIB `13004903` / `25371400` | `29f92a0adaaa3d79294adb14941f217c52ae95452bff9a6cf17643e009568af8` | `610e8b60fe78236d23c5f66b8175e2a5503be1a3d1820fa66d0bccdbb27db693` |
| Daft Punk: Musicae and baseline LRCLIB `250327` | `a763606f6921c22dfdcbeef0196fcf8e7da7085e0ebda00eb19322aacf48f2f6` | `5bf34ac624282a116a4a043c1903aa35cebfdf2bb15105f82f9082ff2d4153bf` |

The English control also has an identical parsed text/timing payload across
Musicae and LRCLIB. This is evidence of overlapping transcription data, not
proof that Musicae calls LRCLIB internally. Neither response establishes the
upstream lyric source or the internal matching algorithm. These observations
do not establish correctness across either provider's wider catalog.

There is also an identifier conflict: the direct Deezer lookup associated
`HKA619900534` with a 319-second recording on `三年兩語`, while Musicae returned
the 278.506-second recording above. The initial frozen `jacky-cantonese` fixture
therefore reports `reference_text_match` for the ISRC lyric response, but the
subsequent metadata check prevents treating that as an identity success. The
fixture and initial result are preserved as recorded. The separate Spotify-ID
follow-up was assessed against `jacky-mandarin` and returned
`known_wrong_version`. Neither catalog's ISRC mapping has been verified against
MusicKit's ISRC for the original Apple recording.

Decision: do not promote Musicae as a fix or count its agreement with LRCLIB as
independent corroboration in this sample. Retain the reviewed bad-transcription
rejection and existing NetEase fallback. An identifier can narrow a recording
lookup while the attached lyric document is still wrong. A future general
selection change needs to validate lyric/version disagreements as well as
recording metadata; this experiment implements no such production change.

Sources: [Musicae endpoint documentation](https://api.musicae.io/docs/dj),
[LRCLIB 13004903](https://lrclib.net/api/get/13004903),
[LRCLIB 25371400](https://lrclib.net/api/get/25371400),
[LRCLIB English control](https://lrclib.net/api/get/250327),
[Deezer ISRC lookup](https://api.deezer.com/track/isrc:HKA619900534).

## Remaining candidate access

Musixmatch is deferred at the user's request while they consider a subscription
closer to launch; no authenticated Musixmatch request has been made. Its actual
account access and pricing have not been verified. Spotify/LyricFever requires a
separate authenticated unofficial route and was not exercised. The linked
Musicae Apify actor documents analysis output rather than lyrics; the experiment
used the direct RapidAPI lyrics endpoint.

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

Raw observations are retained locally under `tmp/provider-experiment/` in
`baseline.json`, `musicae-authenticated.json`, `musicae-metadata.json` and
`musicae-identity-followup.json`. Only public fixture metadata and analysis are
committed; lyric bodies and API credentials are excluded.
