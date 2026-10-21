# Measured timing discovery across catalog names

Readable lyrics and complete measured word timing are separate acquisition
goals. A line-synced success previously stopped Apple catalog-localization
searches and Spotify's verified native-artist continuation. A freshly validated
provider-ID hint also returned before ordinary discovery. These paths could
keep returning LRC even when another admitted spelling or sheet had YRC/QRC/KRC.

`needsTimingDiscovery` now supplies the common stopping rule. Complete measured
vocal coverage, instrumentals, listening-reviewed timing and reviewed
replacements stop optional discovery. Otherwise a capable provider or verified
catalog spelling can improve a readable baseline. Explicit provider selection
retains its first opportunity. Optional failure preserves the readable source.
Progressive readers can receive that baseline while acquisition continues.
Cancellation prevents late publication and cache writes. Provider deadlines,
request deadlines, query limits and two-provider fanout remain unchanged.

Fresh line-only or sparse ID hints are readable fallbacks, rather than evidence
that discovery is finished. Complete source-bound hints still avoid search.
Line-only and sparse measured positives with upgrade support expire after five
minutes in response memory, canonical and Redis caches; complete measured
responses retain the normal one-day lifetime. Acquisition and verified-context
policies invalidate results created under the former stopping rules.

Artist spelling recovery remains bound to provider identities. NetEase's
verified artist-ID profile may supply an unaccented spelling of its Latin alias
(`René Liu` / `Rene Liu`). This does not fold song titles, other scripts, unknown
artists or contributor lists. Recording duration, version, ISRC conflict and
complete-credit checks continue to apply.

Edition evidence also travels through acquisition. A positive Spotify explicit
flag qualifies a provider's explicit release marker without qualifying clean,
live, remix, remaster or other editions. Apple acquisition derives explicitness
from server-fetched catalog ratings, including iTunes `trackExplicitness`, and
passes the consensus to source discovery. Conflicting known territory ratings
grant no explicit authority. Client flags cannot grant Apple edition authority.
NetEase and Kugou retain known source explicitness for Apple conflict rejection.

## Reproducible coverage checks

The live harness calls the actual acquisition service and formatter with live
providers, fresh service instances, explicit response-cache refresh and the
ordinary production deadlines. It verifies source-bound cue coverage and
Spotify response binding, and retains metadata and counts rather than lyrics
or download capabilities. It does not authenticate to the deployed app API.

```sh
node scripts/benchmark-catalog-word-timing.mjs \
  --corpus docs/research/measured-discovery-corpus.json --out original.json
node scripts/benchmark-catalog-word-timing.mjs \
  --corpus docs/research/country-chart-word-timing-corpus.json \
  --concurrency 2 --out country-charts.json
node scripts/benchmark-catalog-word-timing.mjs \
  --corpus docs/research/source-positive-word-timing-corpus.json \
  --out source-positive.json
```

`--baseline-root <checkout>` compares the same frozen requests with another
source tree; mode order alternates. `--runs 2` repeats every request without
best-of-retry scoring. The optional case concurrency is bounded at two.

The original corpus contains 16 Apple and 12 Spotify requests, including the
reported recordings. The larger country corpus freezes the first ten chart
placements in GB, FR, DE, BR, MX, IN, JP, KR, TW and HK from Apple's
[Music Marketing Tools feeds](https://rss.marketingtools.apple.com/), using
`/api/v2/<country>/music/most-played/50/songs.json`. It retains 100 placements
covering 88 distinct Apple IDs. Spotify catalog lookups resolve 94 counterparts;
six unresolved pairings stay visible. Verified Apple catalog localizations and
four provider artist-profile bindings qualify additional catalog-name matches.
These are metadata relationships, not acoustic equivalence proof.

The availability-qualified corpus freezes 109 requests: every chart pair with a
measured source found during screening, including failed counterparts, plus all
source-positive original cases. Availability evidence is never passed as a
source-ID hint to acquisition. Failed eligible requests remain in the coverage
denominator. Timing-negative and unresolved chart cases remain in the larger
screening corpus; a failed lookup does not prove upstream timing is absent.

The availability-qualified cohort includes nine chart locales, and the original
regressions add other storefronts. This is an availability-conditioned sample,
not a random estimate of global catalog coverage. Network caches, source
availability and host scheduling remain uncontrolled. Public metadata and cue
coverage do not prove acoustic synchronization, stock Dynamic Lyrics parity,
deployed authenticated acquisition or phone display behavior.

Hermetic coverage exercises verified localizations after line timing, fresh
hint continuation and failure, complete-hint reuse, progressive publication,
cancellation, sparse cache expiry, protected timing, provider-profile accent
handling, explicit/clean separation, and the benchmark's failed-case accounting.
Deadline fixtures advance a virtual clock after each acquisition stage starts;
they assert the original shared deadline without depending on host wall time.

The manual **Measured timing coverage** GitHub workflow runs the frozen
availability-qualified cohort on an independent Node 24 runner and retains the
metadata-only report. Its default acceptance threshold is 99%; callers may
require 100% and select up to three repetitions. Every attempt counts. The
workflow has no schedule or app-account credentials, and stays separate from
hermetic CI. The CLI accepts the same gate with
`--minimum-available-rate 0.99`; failed gates retain their report and exit nonzero.

## Dictionary script variants

The exact Spotify report `4xZIMRwaaBx7CZMmM6KLuh` supplies “沒那麽簡單”
on 簡單不簡單, duration 310133 ms. The old character converter left `麽`
unchanged while sources used `么/麼`, rejecting otherwise matching metadata.
The native display converter could already show the ordinary simplified title,
which hid the metadata difference from the visible reader.

Recording comparisons and provider discovery queries now share generic OpenCC
traditional-to-simplified conversion after the historical normalization. It
covers dictionary variants such as `麽`, `羣`, `牀`, `祕` and `峯`; regional
vocabulary conversion, transliteration and fuzzy titles are not enabled. Extra
Chinese variant recovery does not apply to names containing Japanese kana or
Korean Hangul. Artist credits, editions, ISRC conflicts and duration still qualify
every source independently. Raw request hashes, source words, cue positions,
timing revisions and published negative lyric fingerprint recipes stay intact.
The acquisition policy version changes so old readable responses and ID hints
do not suppress this discovery path.

The exact reported Spotify recording and public Apple counterpart `540287928`
are retained in both regression and availability-qualified corpora. Their
availability evidence routes no provider ID into ordinary acquisition. The
separate shorter 248910 ms Spotify release is not substituted.
