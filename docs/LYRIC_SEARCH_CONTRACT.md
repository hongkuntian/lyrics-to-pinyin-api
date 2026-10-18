# Lyric search and reader recovery

`POST /api/music-romanize` accepts two additional authenticated actions. Existing recording-bound requests and response contracts stay intact. Search responses are independent source capsules, never verified recording bindings or Song Library documents. Both actions use the existing app session and rate limit, perform no generation, and return version 1 JSON.

Search request: `{ "action": "search_lyrics", "query": "父亲 筷子兄弟", "hints": { "title": "父亲", "artist": "筷子兄弟", "artists": ["筷子兄弟"], "album": "父亲", "duration": 280.289 } }`.

Hints are optional. When supplied, title and artist are required; album, complete artists, duration in seconds, catalogID and spotifyItemID are optional. Exact item hints only maintain reviewed negative language/content exclusions; they do not grant recording equivalence. Queries are 1–500 characters. Unknown fields fail with 400.

Search response: `{ "version": 1, "candidates": [...], "unavailable": ["netease"] }`. Up to 20 candidates are ranked by normalized title/artist similarity, duration proximity, album and availability of readable words. Duration affects rank without discarding words. `namesMatch` requires full normalized title/contributor agreement; `durationMatches` records the separate three-second criterion. Neither establishes verified timing. Provider failures preserve other results; all-provider failure returns 502.

Candidate fields: `provider` (lrclib or netease), `itemID` (opaque decimal string), `title`, `artist`, optional `artists`, `album`, `duration`, `lines`, plus search-only `namesMatch`, `durationMatches`, `score`. Lines contain `text` and an optional source `timestamp` in seconds. LRCLIB searches already include words; NetEase candidates normally require preview. Up to 250 lines, 4,000 characters each, 180 KB per transcription and 500 KB of embedded search data are retained. Credit normalization and reviewed source exclusions still apply.

Preview request: `{ "action": "preview_lyrics", "provider": "netease", "itemID": "123", "hints": {...} }`. Response: `{ "version": 1, "candidate": {...} }`. Only allowlisted providers and decimal IDs route to fixed provider origins; client URLs and capabilities are never accepted. Source metadata and words are fetched independently of caller labels. Empty, wrong-ID or unusable sources return 404; transport failure returns 502.

A client can show matching-name candidates as explicitly unverified, untimed suggestions after ordinary recording lookup fails. Manual selection/import pins an exact local recording and immutable source revision. Alternative words never change playback ID, fabricate a backend document, or unlock model generation. Timing remains a separate explicit decision. Automatic verified acquisition keeps all existing identity checks.
