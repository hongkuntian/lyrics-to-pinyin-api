# Pronunciation aids

Japanese and Korean have text-derived beta reading profiles. These are separate from translation language and explanation language. They do not identify how a particular singer pronounces a lyric.

| Profile | Source | Notation | Script | Engine |
| --- | --- | --- | --- | --- |
| ja-hepburn | Japanese | Hepburn romaji | Latin | Kuromoji 0.1.2 / Kuroshiro 1.2.0, Lyra rules 1 |
| ja-kana | Japanese | Hiragana reading | Hiragana | Same Japanese analysis |
| ko-revised | Korean | Revised Romanization | Latin | Koroman 1.0.16, Lyra rules 1 |

Japanese analysis preserves multi-character readings and particle pronunciation, combines auxiliary endings, and handles volitional long vowels separately from ordinary vowel sequences. Kana retains lexical spelling, including particles は/へ/を. Korean uses pronunciation rules for liaison and assimilation; its native reading field retains Hangul orthography. Revised Romanization is not a phonetic transcript and does not encode every spoken distinction. Neither engine sees audio. Ambiguous kanji, names, artistic readings and stylized spellings remain limitations. Unknown readings remain original text with an explicit unresolved status. Mixed Latin text, punctuation and graphemes remain intact.

## Request and storage

Authenticated `POST /api/song-library` accepts:

```json
{"action":"pronunciation","documentID":"<document id>","sourceHash":"<source hash>","profileID":"ja-hepburn"}
```

It returns `{version:1,state:"ready",pronunciation:...}`. The capabilities action advertises `pronunciation.contractVersion` and available profiles. `contracts/pronunciation-aid.schema.json` defines the artifact. Segment offsets count extended grapheme clusters within `lyricText`, excluding a speaker prefix. Segments cover the exact original text; readings must never be used to reconstruct source offsets.

Migration `013-pronunciation-aids.sql` stores annotations separately from immutable lyric documents and translations. Identity includes document, source hash, profile version and engine version. Reading revision identifies the source analysis independently of romaji/kana rendering. Repeated requests reuse the stored artifact; concurrent insertion retains the first canonical artifact. This deterministic path makes no model calls and reserves no paid generation budget. Existing authentication and rate limiting apply.

The legacy romanize endpoints now use the same engines. Music response version 2.4.0 and engine-keyed standalone caches prevent reuse of the old placeholder conversions. Legacy responses keep their whole-line alignment shape; only the separate artifact provides safe grapheme alignment. Existing durable library documents are not rewritten, so saved translation and learning identities remain valid.

## Rollout and rollback

Apply the additive migration before promotion. A production build with the one-shot build environment `LYRA_LIBRARY_MIGRATE_ON_BUILD=1` applies and verifies migrations using the existing private database connection. Subsequent builds verify schema readiness. Do not put credentials in a request or repository.

The default enabled set is all three beta profiles. `LYRA_PRONUNCIATION_PROFILES` can contain a JSON array of profile IDs, including `[]` to stop new annotation requests. Disabled profiles are omitted from capabilities and return 422 even when cached on the server. Already downloaded app annotations remain usable offline. This switch controls the new artifact path; rolling back the deployment restores the previous legacy processors. Keep the additive table on rollback.

The iOS client validates exact text, profile/engine version and ranges, caches each profile independently and rejects stale responses after a song or preference change. Japanese offers Romaji/Kana/Off; Korean offers romanization on/off. A non-library 2.4.0 response can supply a whole-line romanization fallback; older placeholder responses and unavailable kana are not presented as valid readings.

## Adding another notation

Add a versioned profile and a reviewed generator/renderer, then register its permitted source direction. Profiles distinguish `romanization`, `native-reading` and `phonetic-approximation`, with source language, output script, notation and optional reader language. An approximation must declare its intended reader language and limitations. UI locale never implies a pronunciation mapping, and two existing profiles never imply a third direction. Mandarin-friendly Cantonese hints or katakana approximations require separate evaluation and explicit client support before enablement.

No singer-specific correction publication, Japanese/Korean speech synthesis, vocabulary learning admission or character teaching is enabled by this change. Those require their own capability and quality acceptance.

## Verification

Hermetic tests exercise particles, multi-kanji words, kana, long vowels, gemination, Korean liaison/assimilation, mixed scripts, emoji, decomposed Hangul, unknown characters, source identity, profile cache separation, disabled profiles and the additive API contract. Native tests cover stale responses, offline reuse, legacy rejection and unchanged source identity. Account-free UI fixtures use original short lines; they are not evidence of a commercial-song or bilingual human accuracy evaluation.

A broader local 60-line exploratory review motivated the inflection fixes, but is not an independent accuracy score. Beta status remains until a representative J-pop/K-pop corpus and native-reader review justify a stronger claim.

Sources: [Kuroshiro](https://github.com/hexenq/kuroshiro), [Koroman](https://github.com/gerosyab/koroman), [official Korean romanization rules](https://www.korean.go.kr/front_eng/roman/roman_01.do). Redistribution notices are retained in `THIRD_PARTY_NOTICES.md` and the function bundles.
