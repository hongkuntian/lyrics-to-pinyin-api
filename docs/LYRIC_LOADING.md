# Lyric acquisition measurements

The loading harness uses real provider requests and exact Apple recording metadata, then saves the verified result through the production song-library handler into an ephemeral local PGlite database. It never calls paid translation or Study generation and never writes the production song library. Full response captures stay outside Git; the maintained corpus contains metadata only.

```sh
node scripts/measure-lyric-loading.mjs \
  --corpus scripts/fixtures/lyric-loading-recordings.json \
  --output /absolute/evidence/lyric-loading \
  --repeat 3
```

An optional `--env-file` reads only the Apple catalog credential and catalog-policy variables enumerated in the script. It does not load database, Redis, access-token or model credentials. Use `--id` for a single recording. To compare an archived checkout, copy this harness into that archive and pass its actual `--source-revision`; the source and harness fingerprints identify the executed content independently of the Git label.

The corpus covers Mandarin, Cantonese, Japanese, Korean, Russian, English, French and Spanish, including three Chinese recordings with different discovery/recording risks. Every case retains its catalog ID, album, artist, storefront and duration. Provider and library stages record response status, source ID, language, timing/partial/instrumental flags, complete source hash and recording-match proof. HTTP 200 or a timing flag alone does not establish audible alignment.

## October 7, 2026 comparison

Three trials per recording on the same host, baseline `724c6d9` versus the changes accompanying this document:

| Local stage | Before median | After median | Before p90 | After p90 |
| --- | ---: | ---: | ---: | ---: |
| Fresh provider acquisition | 553 ms | 568 ms | 834 ms | 1,439 ms |
| First library save after verified provider acquisition | 554 ms | 11 ms | 629 ms | 15 ms |
| Library revisit | 1.6 ms | 1.5 ms | 3.9 ms | 1.9 ms |

The first-save stage previously forced another provider lookup. It now reuses verified current-policy cache content; explicit reloads and existing stale documents still refresh. This stage measures the avoided duplicate work, not the total uncached end-to-end request. Provider latency still depends on upstream availability. Handler caches reset between recordings/trials; process-level catalog and tokenizer caches may be warm. These measurements exclude app authentication, HTTP transport, production PostgreSQL and visible presentation, which need separate app measurements.

The baseline returned the separate English version for all three Japanese `1679278167` trials, despite matching duration. The corrected lookup returned Japanese source for all three. A reviewed exact-recording constraint rejects English and romanized substitutes for that Japanese single while retaining the separate English single `1688334537`. The Japanese provider median increased from 559 ms to 2,684 ms while seeking the correct source; this is intentional. All 30 corrected acquisitions returned a language matching the corpus expectation and timed rows; this is source/metadata evidence, not a listening review of each timestamp.

Refresh requests now share the ordinary response-cache identity while retaining their own acquisition work. Memory caches and Redis commit by acquisition start so an older slow response cannot overwrite a later successful refresh. The Redis comparison is atomic and was exercised with one temporary 30-second key, writing a newer result followed by an older result and reading back the newer one. Acquisition timestamps use host wall clocks; severe clock skew between server instances remains a limitation of their ordering. Durable song-library lookup leases continue to fence document publication.

`Server-Timing` on song-library replies separates document read/bind, source lookup, document save and total handler work. These headers contain durations only. The per-request library cache header distinguishes an existing document from an acquisition.

Relevant hermetic regressions cover first acquisition versus explicit/stale refresh, duplicate requests, refresh ordering, known wrong-version cache invalidation, and Redis command timeout/auth propagation. Run `npm test` before delivery.
