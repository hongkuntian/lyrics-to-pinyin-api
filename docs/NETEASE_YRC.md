# NetEase YRC acquisition

The existing independent recording matcher selects the NetEase ID. Acquisition
fetches `/lyric/new` once and selects the complete YRC text/timestamp edition,
with optional measured token cues. Missing or undecodable YRC uses the same
payload's LRC. Only an unavailable or invalid new endpoint response falls back
to the legacy `/lyric` endpoint. Both requests share the caller's cancellation
and existing provider deadline; source selection priority is unchanged.

YRC line and token starts are absolute milliseconds. Zero-duration token text
remains visible without an invented interval. The reserved token integer has
no role semantics. Unknown rows reject the complete YRC edition; invalid cues
in an otherwise decoded row remove only its optional timing. Final text must
match exactly and cue ranges must follow UTF-16 and grapheme boundaries. Trim,
performer-prefix removal, untimed correction and excessive response size can
remove optional cues without losing readable lyrics.

`metadata.lyric_timing` binds the measured source to the current Spotify raw
22-character ID or Apple catalog ID. Requests without an Apple catalog ID get
readable lyrics without the word extension. Source revisions hash integer
millisecond source rows and accepted cues under `netease-yrc-1`, excluding
request IDs, hints, provider fetch timestamps, romanization and model data.

Spotify v2 hash formulas are unchanged. For Apple, the legacy branch without
word cues keeps its existing JSON digest bytes. Only the new word branch hashes
**canonical JSON** (recursive sorted object keys, original array/string order):

- `sourceHash = H({language, lines, structure, lyricTiming: {source, revision}})`
- `timingRevision = H({policy: 'apple-vocal-timing-1', recording,
  textRevision, timestamps, vocalTiming, lyricTiming: {source, revision}})`

Here `recording` retains the existing canonical ID or recording key. Existing
recording-key and document-ID formulas remain unchanged. Canonical encoding
lets public projection verify hashes after PostgreSQL JSONB reorders keys.
Apple request lookup evidence is private to each server-side document object.
A verified canonical alias can project only the timing `recordingID`; exact
current request lookup evidence and catalog membership are both required.
Cloning or serializing a document cannot grant projection evidence.

Only internal acquisition keys gain the `netease-yrc-1` capability. Global
selection revision and saved document/job identities stay pinned. Existing
caches and accepted saved songs are not promised an automatic upgrade; new
acquisitions and the existing explicit Reload/refresh can select YRC.

Automatic acquisition publishes a complete line-timed fallback as soon as it
is readable, then keeps an eligible NetEase lookup alive for a measured-timing
upgrade within the existing provider/shared deadline (at most six seconds).
Only source-bound validated YRC can improve line timing. Missing, malformed,
cancelled or late word data leaves the readable fallback in place. The lookup
window starts once and is not reset by another line-timed result; at most two
providers run concurrently. Explicit source choices, listening-reviewed timing
and reviewed replacement corrections retain their priority.

The internal `measured-vocal-selection-1` acquisition-cache marker separates the
new selection behavior from earlier line-only cached acquisitions. It does not
change YRC parsing revisions, source hashes, the global selection revision or
saved document/job identities. Existing accepted line-only songs need Reload.

Hermetic coverage is in `tests/unit/netease-yrc.test.js` and
`tests/integration/netease-yrc.test.js`, with synthetic source text only. Coverage
includes public Apple/Spotify DTOs, legacy hashes, word/source revision changes,
JSONB reopen, verified alias projection, saved jobs, leased Spotify refresh,
captured model-request privacy, final-text validation and optional-size fallback.


## Repeated lookup and native upgrade admission

The verified-context cache now supports the selected NetEase source ID as well
as LRCLIB. This is the existing six-hour, exact-request/policy-bound context,
not a title-only mapping or a new persistent table. Only final accepted candidates
write a hint. Hints contain independent metadata and the target signature, never
provider lyric downloads. Ordinary hint reads do not extend their expiry.

A NetEase ID routes `/song/detail` followed by current lyric acquisition. The
adapter requires one exact returned ID, validates recording/version/duration and
complete source credits, and resolves translated artist names through matching-ID
provider profiles before fetching words. Metadata drift, missing/duplicate IDs,
no lyrics and failed validation return to ordinary discovery within the original
provider deadline. The NetEase hint gets at most 2500ms (LRCLIB retains 800ms),
clamped by that deadline; it does not start a new six-second lookup window.

Explicit refresh still bypasses content caches and re-resolves Apple catalog
proof. A prior NetEase hint may route fresh source validation only if its target
matches the newly accepted target. LRCLIB's prior refresh behavior is unchanged.
A usable NetEase hint suppresses redundant speculative search, not catalog checks.
The single selected-source hint can be replaced by a later accepted line fallback;
no guarantee is made that a failed NetEase route remains remembered indefinitely.

Optional `metadata.word_timing_upgrade_supported` reports registry capability
for the current lookup. It is false for instrumentals, partial/corrected curated
sources, or an explicitly requested provider without measured-timing capability.
An absent field on older cached documents means unknown, not unsupported. The
field is outside immutable source/timing hash recipes and changes no source
selection revision, saved document, job, or translation identity.

`node scripts/benchmark-netease-reuse.mjs --live` performs three sequential
NetEase-only acquisitions of the public 256-second Apple recording, clearing
content caches while preserving an in-memory shared context across fresh service
instances. It records request timings and cue counts without retaining lyric
bodies. It is opt-in, network-dependent, and outside `npm test`; it measures this
server host and does not establish physical-phone or production percentile latency.
