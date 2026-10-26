# Playlist timing regression evaluation

Use exact Spotify recordings and every occurrence from every page of the
discovered collections. The connector's playlist search is bounded; completing
those collections does not prove a complete account inventory. Keep personal
exports and reports outside this public repository. Do not retain lyric bodies,
credentials or transient playback URIs.

`scripts/playlist-timing-eval.mjs` validates a normalized private snapshot
(`collections[].{pages,items}`). Pages must be consecutive, READY, unfiltered,
have consistent totals and end with `hasNext:false`. Items retain exact track
URI, title, full credited artist array, album and duration. Conflicting duplicate
metadata rejects import. Deduplication uses the exact Spotify item ID; unknown
ISRC, explicit classification or market is omitted, never guessed. An export
containing unsupported/unresolved items must be resolved before this all-item
import can pass.

```sh
node scripts/playlist-timing-eval.mjs \
  --snapshot /private/playlist-snapshot.json \
  --corpus-out /private/playlist-corpus.json
node scripts/benchmark-catalog-word-timing.mjs \
  --corpus /private/playlist-corpus.json --runs 1 --concurrency 2 \
  --out /private/candidate.json
node scripts/playlist-timing-eval.mjs \
  --snapshot /private/playlist-snapshot.json \
  --baseline /private/baseline.json --candidate /private/candidate.json \
  --out /private/comparison.json --positive-out /private/positive-corpus.json
```

Run the same acquisition command on a retained baseline checkout first. Record
both source revisions, source hashes for uncommitted candidates, lockfile hash
and corpus hash with the private reports. The comparison requires every case
and repetition exactly once. HTTP failures remain in the denominator. It reports
all-track readable, line timing, any measured cues and complete measured coverage separately from
hit rate over the common known-available subset. Availability is the union of
frozen prior evidence and complete bound results in either run. Unknown
availability is not evidence of absence. Per-case losses stay visible even when
the aggregate improves. Sequential live results are sensitive to upstream
availability and latency; use deterministic delayed-provider fixtures to prove
the behavior change itself.

Freeze the source-positive private cohort before a subsequent acceptance run:

```sh
node scripts/benchmark-catalog-word-timing.mjs \
  --corpus /private/positive-corpus.json --runs 3 --concurrency 2 \
  --minimum-available-rate 0.99 --out /private/acceptance.json
```

Every eligible attempt counts, including failed repetitions. Source IDs are
availability evidence only and never injected into acquisition. Complete means
all meaningful graphemes in the returned source edition have validated measured
cues bound to the requested recording. It does not prove acoustic alignment,
complete sung text, authenticated deployment or phone playback. Completion
latency is distinct from first-readable streaming latency.

Hermetic `npm test` covers the plain-first cancellation regression, preservation
of the existing line-to-word window, wrong-edition refusal, cancellation,
page completeness and evaluation denominators. The reported recording
`2PXhHrVL1HkKk4fto9D8zE` (第一次, Michael Wong, 十光年精選輯,
263333 ms) is a metadata-only public regression case. NetEase `85482` supplied
43 rows and 411 measured cues in a fresh 2026-10-26 service observation. Its
test words are invented; no provider lyrics are committed.

The existing **Measured timing coverage** workflow now runs daily at 10:37 UTC
and can still be dispatched manually. It checks the public frozen source-positive
cohort at 99%, retains the complete report on failure, and serializes overlapping
runs. Personal playlist exports never enter that workflow. Network-dependent
coverage failures signal investigation; they do not silently reclassify or remove
eligible recordings. Normal `npm test` remains independent of live providers.
