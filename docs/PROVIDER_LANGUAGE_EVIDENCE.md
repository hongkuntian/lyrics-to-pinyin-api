# Source-bound provider language evidence

Automatic Apple and Spotify lyric acquisition can return optional
`metadata.language_details.provider_evidence`. It records a selected provider's
declaration alongside the existing text estimate. It does not replace `primary`,
change pronunciation, choose a translation target, confirm a language, admit a
pronunciation profile, or establish recording equivalence.

The 26 October 2026 read-only audit inspected two songs for each of ten expansion
languages and two controls through four providers. QQ detail responses contained
useful language categories; Kugou search contained specific, broad, empty and
incorrect labels. QQ classified the Malay control as Indonesian, and Kugou
classified an Italian source as English. Provider-only fallback, including from
an unresolved text estimate, would therefore manufacture certainty. The retained
audit is research evidence, not audio-language gold or a population benchmark.

## Acquisition and source binding

QQ captures language from the already-fetched detail/QRC batch or fresh numeric
source lookup. `/data/track_info/language` is preserved as an uninterpreted enum;
`/data/info/lan/content/N` is interpreted only under the exact `歌曲语种` heading.
These are distinct namespaces. A category ID of zero is not absence. The lyric
response's default nested `track.language`, reading tags, translations and artist
labels supply no source-language declaration.

Kugou captures `/candidates/N/language` from its existing search response. Its
instrumental filter remains intact. Duplicate records for one ID retain optional
language disagreements without changing the existing recording/timeline checks.
Separate tied sources do not vote or transfer declarations to the winner.

No language-only request, album lookup, translation/phonetic download, retry,
provider reordering, or longer deadline is introduced. QQ legacy fallback without
detail and providers without observed declarations remain eligible. NetEase and
LRCLIB receive no speculative enum/YAML mapping or extra discovery request.

Observation records live outside provider-song JSON identity comparisons. They
are attached to the decoded primary/original-associated sheet only after the
adapter's existing ID/header checks. Analysis independently checks the selected
provider and exact ID, body role, format, field and observation namespaces. The
body hash binds the final exact ordered text array analysed, not an Apple/Spotify
identity or a claim that every word is sung. An original-associated slot may still
contain a transliteration; no missing native script is invented.

## Interpretation

Specific exact labels map lexically to language candidates: Japanese, Korean,
German, Russian, Thai, Indonesian, Spanish, Portuguese, Italian, Vietnamese and
English. `印度语`, `其他` and `小语种` remain broad. Missing, empty, unknown,
uninterpreted numeric and malformed fields remain distinguishable. Strings are
not fuzzily normalized into a recognized label. Numeric namespaces are never
cross-mapped or interpreted from their apparent agreement.

| Evidence condition | Decision | Effect on existing text analysis |
|---|---|---|
| No eligible observations | `absent` | None |
| Invalid binding, wrong body role, malformed/over-limit collection | `unusable` | None |
| Only broad/unknown/empty/enum-only data, or an unknown/broad companion | `unspecific` | None |
| Different specific declarations | `declaration_conflict` | None |
| One specific declaration; text is `und` | `declared_only` | None |
| One specific declaration equals the text estimate | `agreement` | None; no certainty upgrade |
| One specific declaration differs | `disagreement` | None; preserve both estimates |

All legacy v1 fields remain intact, including per-line languages, script
presence, mixed status, confidence and pronunciation basis. `mixed:false` is not
monolingual proof. Russian/Bulgarian, Indonesian/Malay and Latin
Hindustani/Hausa/Korean-romanization ambiguities are not globally remapped.
Explicit processing language/system overrides keep their existing precedence.
Chinese catalog-category and wording policy is unchanged.

The sidecar is immediately usable as declared-language evidence and a conflict
signal. A future context/confirmation consumer must bind its semantic revision
into that consumer's independently versioned authority; this feature does not
silently alter existing source/text/reading/timing revision recipes or migrate
saved documents. Selected-source learning capsules retain their existing
contract. Historical responses may omit the optional sidecar.

## Bounds and hashes

The formal standalone schema is
[`provider-language-evidence.schema.json`](../contracts/provider-language-evidence.schema.json),
embedded byte-for-byte as an optional property in the existing music response
schema. Collections contain at most eight observations; raw scalar strings have
at most 256 Unicode code points. A malformed or oversized optional collection is
unusable rather than a truncated, apparently complete declaration. The emitted
sidecar is capped at 4 KiB. At the existing 160,000-byte response boundary,
language diagnostics are omitted before valid measured word cues are removed.

`body.text_sha256` hashes UTF-8 compact JSON of the exact ordered text array.
`semantic_sha256` hashes the evidence version, selected source, body descriptor,
ordered interpreted observations without `observed_at`, unchanged base v1
analysis and any unusable reason. Object keys are recursively sorted, array order
is preserved, and observation order uses lexicographic canonical
`[operation, namespace, field, raw]`. No text normalization is applied. A changed
source, body, declaration, namespace, role or detector result changes semantic
identity; observation time alone does not. This is not a raw-response-byte hash.

Actual observation time is retained on cache reuse. The evidence version enters
response, context and shared-acquisition cache policy, so an old response is not
relabelled with newly installed evidence semantics. Cache hits never fetch language
metadata. Existing immutable library documents are not rewritten.

## Metadata and measured timing

The bounded NetEase reserved `{t,c:[{tx,...}]}` metadata format is recognized at
every sheet position. Unknown shapes and timestamped JSON lyrics remain intact
in LRC; unknown YRC rows still refuse the entire edition. The same sheet-wide
32-container bound applies. Removing these containers prevents credits from
contaminating text analysis or causing a valid measured sheet to fall back to
LRC. Already-accepted words and cues retain their existing YRC revision recipe;
the acquisition cache capability changes for the newly accepted parser behavior.

An incomplete source-ID hint can start request-owned readable formatting while
ordinary discovery continues inside its original provider deadline. Formatting
no longer occupies that discovery opportunity. Existing best-candidate,
cancellation, publication and cleanup fences still apply. No timing selection
threshold changes, interpolation, grafting of cues, retries or longer windows are
introduced. Complete measured coverage keeps its current priority over sparse
coverage; listening-reviewed timing remains protected.

Hermetic regressions cover actual adapter request ledgers, unchanged text/cues,
cache replay, explicit overrides, source/namespace/role refusals, finite language
decisions, response-size priority, late structured metadata and held hint
formatting on Apple and Spotify paths. Controlled timings measure local
scheduling/CPU under injected conditions; they do not establish live provider,
network-tail, audio-alignment or native-display performance.
