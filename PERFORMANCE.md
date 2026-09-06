# Lyrics latency and cache behavior

Requests retain the existing 2.2.0 response contract and recording validation. The default provider order now hedges the next lookup after 350 ms, with at most two providers active. Verified timed lyrics win; untimed lyrics leave a 350 ms opportunity for timing. Explicit source requests keep their sequential preference. Losing requests are aborted, and the overall lookup budget remains bounded.

Responses use a bounded, 24-hour in-process cache (128 entries, 256 KB per entry), a shared Redis cache and same-key inflight sharing. Keys retain full recording metadata, requested language/source, catalog/storefront and stable pronunciation options. Verified catalog aliases are cached against the exact original request. Errors are not cached.

Redis reads/writes have 300 ms budgets, no automatic SDK retries and a 60-second circuit breaker after failures/timeouts. Cache writes use Vercel `waitUntil` and do not delay responses. The new `LYRA_CACHE_KV_REST_API_URL` / `LYRA_CACHE_KV_REST_API_TOKEN` variables take precedence over legacy `LYRICS_KV_*` configuration. Never commit their values.

On 6 September 2026, both legacy resources were reported as uninstalled and their endpoints failed DNS. A replacement `lyra-lyrics-cache` was connected to production and preview in `iad1`, using the free plan with automatic upgrades disabled. Live local-handler verification against that shared cache returned a 748 ms provider miss followed by a 115 ms Redis hit from a fresh handler with zero provider calls. This is a small local measurement, not a production percentile.

Response headers:

- `X-Request-ID`: joins request/provider/cache-write logs.
- `X-Lyrics-Cache`: `MISS`, `MEMORY`, `REDIS`, or `COALESCED`.
- `Server-Timing`: cache read, provider search/lyrics, alias resolution, romanization, shared wait and total durations as applicable. Canceled provider spans may finish after the response; logs and headers reflect only completed stages.

`npm test` passes 59 hermetic tests. New coverage checks real reuse, coalescing, losing-request cancellation, slow primary fallback, mismatch rejection, timed preference, explicit sources, hanging cache, detached writes, cache expiry/eviction and parent deadlines.
