# Progressive lyric delivery v1

Clients may opt into `progressive-v1` using `options.delivery` on music-romanize or top-level `delivery` on Song Library's lyrics action. Omitted delivery retains final-only JSON. Delivery is a transport preference and is removed before content-cache identity is calculated. Other library actions do not accept it.

An authenticated POST remains open with `application/x-ndjson`, private/no-store. Each JSON line contains `version:1`, `event`, `acquisitionID`, an increasing positive `sequence`, and the owner's fixed `deadlineAtMS`. A joining reader can begin after sequence 1.

`readable` carries a fully normalized, recording-bound raw `response` without a library reference. `complete` terminates with a final raw `response`, or with the durably saved public `document` for Song Library. `refresh_failed` terminates with a stable error `code` after readable content; the client preserves that content. Before a readable event, errors retain their ordinary HTTP status and JSON body. Optional diagnostics are `requestID`, `cache` and `serverTiming`; no credentials or raw authentication headers are included.

The existing provider order, catalog gate, hedge concurrency, final untimed grace and strict recording/source checks remain unchanged. Readable snapshots expose progress while that same bounded acquisition continues. Partial and instrumental responses may be readable but never create provisional library documents. Existing clean-source guards still fence new paid content generation. Expired-but-admissible server documents may be readable during refresh; sources requiring known timing, version or credit corrections are withheld.

Same-request readers share an owner, latest immutable snapshot and final promise. One reader leaving does not cancel others; the last reader aborts the owner. Source work shares a 16-second deadline. Normal cancellation cleanup is awaited; cleanup taking more than two seconds is explicitly registered with platform waitUntil. This is cleanup after cancellation, not continuation of a quality upgrade after response teardown.

Inner acquisition promises are scoped to the outer acquisition ID. Distinct raw/library or alias owners cannot silently join a promise without sharing its subscriber accounting. Exact-request legacy/progressive coalescing and verified canonical memory reuse remain available. Cross-owner canonical in-flight sharing is deliberately withheld until it can preserve subscriber fanout and cancellation ownership.

Both public lyric functions explicitly enable response streaming in their source static config, and Build Output preserves the builder's `supportsResponseStreaming` flag. The packaging verifier checks emitted function configuration. Local streaming tests do not establish deployed first-byte latency; deployment verification must inspect actual early response bytes.

Run `node scripts/benchmark-lyric-delivery.mjs` to compare final-only and progressive publication with the same injected 40 ms plain provider and 1000 ms timing provider. It makes no network/model calls and does not represent physical-device latency.
