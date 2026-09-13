# Recording-specific lyric provider experiment

This opt-in harness compares existing lyric adapters with identifier-based alternatives.
It does not change production selection, caches, provider order, or API contracts.
The six public recording fixtures cover a known Mandarin/Cantonese mismatch, a cover,
Cantonese coverage, full duet credits, and an English ISRC control.

## Run

```sh
npm ci
node --test experiments/lyric-providers/compare.test.mjs
node experiments/lyric-providers/run.mjs \
  --providers lrclib,netease,kugou,lyrics-ovh,musicbrainz \
  --output tmp/provider-experiment/baseline.json
```

For authenticated free-tier probes, configure `RAPIDAPI_KEY` and/or
`MUSIXMATCH_API_KEY` in an ignored local environment file, then pass its path:

```sh
node experiments/lyric-providers/run.mjs \
  --providers musicae,musixmatch-apple,musixmatch-isrc \
  --env-file .env.local \
  --output tmp/provider-experiment/identifier-providers.json
```

`--cases jacky-mandarin,jacky-cantonese` selects a subset. Each authenticated
provider route is capped at five HTTP requests per invocation. Musicae currently
has only two fixtures with sourced ISRCs, so a complete run makes at most two
Musicae requests. Repeated runs still consume account quota: this per-run limit
does not know your remaining daily or monthly allowance. There is no signup,
subscription, payment, deployment, or production request in this script.

Requests are sequential, with a 15-second per-probe deadline. MusicBrainz calls
are spaced by at least 1.1 seconds. The existing adapters retain their own bounded
retry behavior; the experimental endpoints do not retry. Rate limiting or access
denial stops further requests to that route during the run.

Reports contain selected public metadata, fingerprints, line/timestamp counts,
latency and HTTP status. They exclude lyric bodies, request query strings, keys,
cookies, response headers and upstream error text. Raw local run reports belong
under ignored `tmp/`, not in Git.

## Interpretation

- `reference_text_match`: normalized complete text matches the stated reference.
  This does not establish audio alignment, independent provenance, or accuracy of
  every timestamp. The Mandarin reference was reviewed during the original fix;
  the Cantonese reference is a comparison transcription, not an audio acceptance.
- `known_wrong_version`: matches the other language's known fingerprint.
- `different_text_needs_review`: different from the reference; may be a correction,
  alternate spelling, credit/header, missing verse, or different version.
- `unreviewed_text`: availability evidence only. Never count this as a correct match.
- `metadata_only`: a recording lookup, not lyric availability.
- `skipped`: access or recording identity is missing; it is not a provider miss.

Fingerprints normalize simplified/traditional Chinese, punctuation, case and
wrapping using the production fingerprint helper. They deliberately do not use
fuzzy text similarity to turn an uncertain result into a success. Separate
timeline fingerprints expose timing differences even when lyric text agrees.

## Identifier provenance

The native app captures MusicKit ISRC when available but does not currently send
it to the lyrics backend. These fixtures do not invent missing Apple ISRCs.
The Mandarin Apple ID `1440912488` is directly usable with Musixmatch's
`track_itunes_id` parameter. It has no ISRC fixture yet.

One discovery listing associated `HKA619900534` with the 278-second Mandarin
version. A live direct Deezer ISRC lookup instead returned track `2458130`,
319 seconds, on `三年兩語`. Consequently that code is used only as a sourced
Cantonese candidate, and is not described as verified Apple recording identity.
MusicBrainz returned 404 for that code in the initial probe. The English ISRC
is the recording used in Musicae's own documentation.

Provider support for an ISRC query does not prove that its lyric selection uses
the identifier end to end. An ISRC-to-metadata lookup followed by fuzzy lyric
search can retain the original failure mode. Before adopting an alternative,
verify returned recording metadata, Chinese coverage, full-song completeness,
timestamps, source provenance and actual access/price terms.

## Provider references

- [Musixmatch synced lyrics: ISRC and Apple IDs](https://www.postman.com/musixmatch-dev/musixmatch-apis/request/j136ay9/track-subtitle-get)
- [Musicae lyrics endpoint and advertised pricing](https://api.musicae.io/dj-track-analysis/)
- [Musicae RapidAPI listing](https://rapidapi.com/musicae-musicae-default/api/dj-track-audio-analysis-api)
- [Musicae Apify actor](https://apify.com/musicae/dj-track-audio-analyzer): current
  actor documentation describes audio analysis and does not document lyric output.
- [MusicBrainz API and rate limits](https://musicbrainz.org/doc/MusicBrainz_API)
- [lyrics.ovh API source](https://github.com/NTag/lyrics.ovh)
- [LyricFever](https://github.com/aviwad/LyricFever) demonstrates an ISRC-to-Spotify
  route, but requires user-session access through an unofficial lyric endpoint.
  This harness does not extract or reuse Spotify login cookies.

Keep the reviewed bad-transcription exclusion until a broader replacement has
passed the recording/version checks. No provider is promoted by this experiment.
