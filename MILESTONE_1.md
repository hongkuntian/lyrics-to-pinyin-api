# Milestone 1: reliable recording lookup

The music endpoint keeps the existing response contract and adds optional `album` and `duration` (seconds) request fields. Responses include nullable `song.album` and `song.duration`; music response metadata is version `2.1.0`. Existing text romanization behavior is unchanged.

Recording selection normalizes traditional/simplified Chinese, spacing and punctuation; requires matching artist/title; rejects durations more than three seconds apart; prefers matching albums; rejects conflicting live/studio album labels and equally ranked distinct recordings. Unknown artist aliases remain deliberately unmatched. Send the actual MusicKit album and duration to distinguish recordings.

Provider search and lyrics retrieval share a six-second deadline per provider. Missing lyrics, errors and mismatches fall through to the next provider. The final result distinguishes missing (404), mismatch (409), upstream unavailable (502), and timeout (504). An explicit platform preference is tried first and remains eligible for fallback. Unknown platforms return 400.

Cache identity includes requested platform, provider order, album, duration and response version. Successful results expire after 24 hours, and cache operations have an 800 ms budget. Old cached responses cannot bypass new recording matching. Provider lyrics from LRCLIB stay attached to the individual search result, avoiding concurrent-request cross-contamination.

LRC parsing preserves zero, interprets decimal fractions correctly, expands repeated timestamps, skips metadata, and preserves untimed lyric lines.

## Verification

- `npm test`: hermetic unit, integration and response-contract coverage.
- Local handler against live providers, September 5, 2026: 晴天 / 葉惠美 / 269 s (53 lines), 稻香 / 魔杰座 / 223 s (44 lines), 七里香 / 七里香 / 299.23 s (35 lines), all artist 周杰倫. All returned 200 through LRCLIB in 1.6–2.2 seconds, with matching recording metadata and response version 2.1.0.
- These are provider checks, not an Apple Music audio-sync test.
- Production publication still requires access to the existing Vercel project. The current connected account lists no projects; local CLI is signed out. Do not substitute a newly created project for `lyrics-to-pinyin-api`.

## Deployment check

After authenticating the owning account, link the existing project, publish a preview, verify success/mismatch/missing responses and metadata version, then promote the tested deployment. Repeat the three-song checks through the production URL. Do not claim the deployed service is repaired until this succeeds.
