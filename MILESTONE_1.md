# Milestone 1: reliable recording lookup

The music endpoint keeps the existing response contract and adds optional `album` and `duration` (seconds) request fields. Responses include nullable `song.album` and `song.duration`; music response metadata is version `2.1.0`. Existing text romanization behavior is unchanged.

Recording selection normalizes traditional/simplified Chinese, spacing and punctuation; requires matching artist/title; rejects durations more than three seconds apart; prefers matching albums; rejects conflicting live/studio album labels and equally ranked distinct recordings. Unknown artist aliases remain deliberately unmatched. Send the actual MusicKit album and duration to distinguish recordings.

Provider search and lyrics retrieval share a six-second deadline per provider. Missing lyrics, errors and mismatches fall through to the next provider. The final result distinguishes missing (404), mismatch (409), upstream unavailable (502), and timeout (504). An explicit platform preference is tried first and remains eligible for fallback. Unknown platforms return 400.

Cache identity includes requested platform, provider order, album, duration and response version. Successful results expire after 24 hours, and cache operations have an 800 ms budget. Old cached responses cannot bypass new recording matching. Provider lyrics from LRCLIB stay attached to the individual search result, avoiding concurrent-request cross-contamination.

LRC parsing preserves zero, interprets decimal fractions correctly, expands repeated timestamps, skips metadata, and preserves untimed lyric lines.

## Verification

- `npm test`: 41 hermetic unit, integration and response-contract tests pass.
- Local handler against live providers, September 5, 2026: 晴天 / 葉惠美 / 269 s (53 lines), 稻香 / 魔杰座 / 223 s (44 lines), 七里香 / 七里香 / 299.23 s (35 lines), all artist 周杰倫. All returned 200 through LRCLIB in 1.6–2.2 seconds, with matching recording metadata and response version 2.1.0.
- These are provider checks, not an Apple Music audio-sync test.
- Preview and production verified through the existing Vercel project on September 5, 2026. Production returned all three matching songs in 2.1–2.3 seconds; wrong duration returned 409, empty input 400, and nonexistent song 404.
- The old Upstash hostname no longer resolves. Optional cache failures now open a 60-second backoff per client; requests continue through providers. Restoring persistent caching requires a working cache resource and updated Vercel environment variables.

## Deployment check

Project: `prj_88IMRZ5X5Fd1LAR8NfEC3pKYJIDy`. Primary production URL: https://lyrics-to-pinyin-api.vercel.app. Initial verified release: `dpl_92p1FpWPJsmPmihy5agctdQcJdkB`, ready in 13 seconds. The Vercel connector publishes only API source, package manifests and Vercel configuration; credentials and local dependencies are excluded. Follow-up cache backoff release is recorded below once verified.
