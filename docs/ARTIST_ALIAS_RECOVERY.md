# Bounded artist alias recovery

The independent Spotify lyric path can recover an artist-name representation
after ordinary provider aliases fail. It keeps the original Spotify item,
request hash, complete artist array, independent source labels and timing.
This is metadata corroboration, not Spotify catalog or acoustic verification.

`api/utils/artist-alias-recovery.js` is the shared comparison/evidence policy.
NetEase supplies its artist-ID profiles; the existing verified-credit
continuation can then use recovered localized credits when another provider
independently discovers and validates its own song. Other providers do not
inherit NetEase's words, source IDs or timestamps.

## Admission

Automatic recovery recognizes explicit `Surname, Given` formatting and a
hyphenated given name in the opposite order, including joined spelling such as
`Tayu Lo` / `Lo Ta-Yu`. Latin accent equivalence remains supported. It does not
sort arbitrary name tokens, change letters, infer transliterations, edit short
Chinese titles, drop guests, or ignore recording editions.

New recovery requires the same normalized title and nonempty album, duration
within 0.5 seconds, compatible versions and nonconflicting ISRC/explicit flags.
Every complete requested contributor must have one unambiguous assignment.
Positive provider artist IDs and canonical profile names bind the observed
aliases. At most three contributors participate. An unresolved plausible artist
beyond the profile budget prevents a recovered winner. Explicit provider aliases
rank before derived name-order matches; conflicting best timelines still refuse.
The previously reviewed Fei alias retains its existing recording checks.

Search keeps the existing two-query bound. For a Spotify request containing a
Chinese title of at least three Han characters and Latin artist names, the
second NetEase query can use the title alone when the first page contains no
plausible title/version/duration anchor. Returned recordings still pass all
ordinary checks. Exact hits, short titles and Apple query planning are unchanged.
Provider/outer deadlines, concurrency limits and lyric timing selection stay
unchanged.

## Evidence and persistence

Recovered sources retain their actual structured names in `creditedArtistNames`.
Internal `artistAliasEvidence` records policy, source/request signatures, artist
IDs, observed names, requested names and applied rules. `recordingScore` checks
that evidence; merely removing it does not make the original credits match.
The service retains it in memory/Redis candidate metadata and durable request
evidence. Fresh source-ID reads rebuild it from freshly checked provider
metadata. Save and public reopen validate structured candidate evidence too.
Canonical comparison supports PostgreSQL JSONB object-key reordering while
preserving array order. No public DTO, request hash or document hash changes.
Legacy source-only documents retain their existing compatibility path.

The `spotify_lyrics_recovery` event reports request ID, independent provider,
source ID, query strategy, policy and applied rules without lyric bodies or
credentials. Existing lookup logs retain provider failure reasons.

## Reproducible evaluation

`tests/helpers/artist-alias-recovery.js` maintains the controlled challenge
cohort. Invented name representations, transport faults and adversarial changes
are labelled separately from captured metadata. Its duet control uses the
reported Spotify/NetEase metadata; all lyric text is invented.

Run the same production-service harness against an immutable baseline checkout
and the candidate, each installed with the committed lockfile:

```sh
node scripts/benchmark-artist-alias-recovery.mjs \
  --baseline-root /absolute/path/to/baseline \
  --runs 3 --delay-ms 20 --out /absolute/path/to/report.json
```

This extends the existing catalog timing benchmark. It measures recovered
positives, wrong acceptances, rejected negatives, unchanged exact controls,
provider calls, the two-search ceiling and control p50/p95 latency. Positive
acceptance requires the expected source ID and complete bound measured timing.
Injected transport delays measure controlled scheduling, not live network or
phone latency. Do not interpret constructed negative results as population
precision or aggregate fast errors as faster successful acquisition.

Use `scripts/benchmark-catalog-word-timing.mjs --baseline-root ... --corpus ...`
for a separately labelled live-provider cohort. Retain all failures, exact item
metadata, source identity and timing coverage. A small live sample establishes
only observed compatibility/availability; deployment authentication, physical
rendering and acoustic alignment require separate evidence. Broader title typo
or transliteration acceptance needs another measured policy change.

`--case-ids id-a,id-b` selects a named subset of the maintained live corpus;
unknown and duplicate IDs refuse instead of silently reducing the denominator.
The reported duet and the Eason Chan/Faye Wong duet are retained alongside
existing solo and English controls in that corpus.
