# Source content and recording recovery

Selection policy `lyrics-selection-2026-09-29-source-content-3` admits only verified recording names and versions. MusicKit's same-ID localized metadata supplies app discovery retries, including the authenticated song library. A small reviewed native-signature registry bridges the observed missing public English catalog responses. Full contributor sets, catalog IDs, albums and duration remain bound; this does not grant artist-wide or title-only equivalence.

The lyric API emits performed words, performance cues and their timestamps. `song_details.credits` contains recording-bound production metadata; `provider_translation` contains aligned, explicitly provider-supplied translations. Neither contributes to the source text or generated translation input. Recognition covers role-labelled credits and repeated Chinese^English pairs; ambiguous punctuation, performed speech and bilingual sung phrases remain intact.

The durable store persists extras in `lyric_document_extras`, separately from lyric documents. Migration 014 supplies source freshness and retirement fields. The production build's existing explicit `LYRA_LIBRARY_MIGRATE_ON_BUILD=1` switch applies schema changes and the idempotent `migrateSourceContent` transformation. It creates clean immutable revisions, moves request heads, preserves old IDs as retirement records for foreign keys, and removes old lyric payloads. It fails before retirement when an affected generation is queued/running. No model/provider calls occur. Restore the switch to `0` after a successful deployment and migration receipt.

Untimed/partial sources become stale after five minutes; timed sources after one day. Explicit refresh bypasses transient provider caches. A lookup lease and compare-and-swap move all aliases of the previous head together. Failure retains usable offline content; explicit refresh reports failure. A timed source cannot silently regress to untimed. Dependent translations/Study content use the new source hash; personal learning and pronunciation choices are independent.

`tests/fixtures/song-source-corpus.json` retains the reported recording signatures and controlled English variants. Run `node scripts/probe-song-sources.js` for a metadata-only live probe; `LYRA_PROBE_BASE` selects a deployment. Optional `LYRA_LIBRARY_TOKEN` adds authenticated source checks, never generation. Keep token values out of command history/output.

## Version-sensitive candidates awaiting listening evidence

The 305.650-second Zhao Chuan recording has a candidate with an added Live label (NetEase 3425563499). The 221.412-second Fei Yu-Ching remaster has a candidate without its remaster label (LRCLIB 36228377). Both remain unapproved for alternate-version timestamps until start/chorus/ending checks against the actual Apple recordings pass. No duration-derived offset or general relaxation is implemented. The corpus records listening checkpoints; metadata/timestamps alone do not prove synchronization.

Evon Low's official-description fallback remains explicitly partial and untimed. The spoken title “你偷偷的伤口” was not identified in the supplied catalog export; exact identity is still required.
