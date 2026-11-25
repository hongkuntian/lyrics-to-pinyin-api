# Spotify starter recording curation

The [manifest](recordings.json) covers the 46 recordings in [the approved pool](../../api/data/starter-songs.json) at backend commit `0a448b87734856f266044060ae2d420b8414b6cb`. It contains 37 verified counterparts and nine held leads as of 24 November 2026.

| Pool | Verified | Held | First example reviewed |
| --- | ---: | ---: | --- |
| Mandarin | 5 | 3 | 小幸運 · Hebe Tien |
| Cantonese | 8 | 0 | 千千闋歌 · Priscilla Chan |
| Japanese | 7 | 0 | 水平線 · back number |
| Korean | 6 | 2 | Love poem · IU |
| Spanish | 6 | 1 | Rosas · La Oreja de Van Gogh |
| French | 5 | 3 | S'il suffisait d'aimer · Céline Dion |

## Reading an entry

`entries` follows the backend pool order. Each stable `starterId` occurs once. Only a `verified` entry has a `spotify` field. A `held` entry places the investigated lead under `candidate`. Its review identifies the unresolved edition, discrepancy or listening requirement. The label and artist spellings are transcribed from the public catalogs, including unexpected additional credits.

`apple` has one public album/track link per distinct approved Apple ID. Canada supplies the primary catalog observation. 小幸運 and Superfly’s 愛をこめて花束を also have distinct Taiwan and Japan IDs respectively. Those pages were checked separately. Other storefronts reusing a catalog ID remain in the approved pool. Each Spotify decision covers exactly the track ID in that entry. Additional URLs can identify rejected alternatives.

`releaseEvidence` preserves the dated observations behind the decision. The Apple lookup links to the public release listing and track lengths. The Spotify track and release links identify the release, artists, sequence and durations checked on the public catalog pages. The Spotify album's public embed also exposes its track list. Counts reflect the song entries returned by each catalog. Dates and credits describe the particular digital release as displayed. Where the albums have adjacent tracks in common, the receipt records one neighbor for comparison. The four verified stand-alone one-track releases use release attribution and duration instead. For 水平線 the artist also identifies the distributor's page for both services. [Release announcement](https://backnumber.info/news/detail/104360) · [Distributor listing](https://backnumber.lnk.to/suiheisen)

The review compared the named release, performing credits, version designation, track position, millisecond duration and surrounding release context. No audio listening pass was performed. An unresolved mix, edit or remaster remains held. Recheck both official listings when a release changes. A subsequent listening review should identify the two versions heard and record the outcome in the affected entry.

`marketCheck` records one question about the public page. A `listed` result means its published country-allowance metadata included CA on the check date. `unconfirmed` means the page supplied no positive CA evidence. Neither result establishes a listener's territory, account entitlement, playback, App Remote identity after relinking, or a lyric publication grant. These records contain no observed App Remote aliases.

## Validation and delivery

Run `node --test tests/unit/starter-spotify-curation.test.js` and the full hermetic gate `npm test`. The curation test compares the entries with the live pool file and checks the evidence, track IDs, release slots, durations and the distinction between held and verified records. It performs no catalog requests.

The manifest is repository curation input, outside the deployed API, shared runtime and dashboard. The approved milestone keeps public track links off pending the product-wide release decision. The [source inventory and grant search](release-gate.md) documents the affected surfaces.
