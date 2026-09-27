# Frontend data-access boundary

`docs/js/data/supabase.js` is the static frontend's only constructor of Supabase REST/RPC requests. It is a classic browser global (`NewsboardData`) so GitHub Pages remains build-free.

It owns configuration loading, authenticated RPC construction, JSON/error handling, request timeouts, 30-second request caching, invalidation, and named methods for the current snapshot, timeline, Top 10, Story badges, and Story History. It returns RPC payloads without removing fields. Rendering, validation, retry scheduling, and the decision to retain already-rendered observations remain application-state responsibilities in `docs/index.html`.

GDELT remains an isolated on-demand request. On GitHub Pages it reuses only `NewsboardData.getConfig()` for the Edge Function URL and authorization; it is not part of core snapshot loading.

## System Health inputs

The current snapshot envelope already exposes enough information for the frontend to derive or display, when supplied for a publisher:

- last successful observation/current observation and its age (`updatedAt`, `firstSeenAt`, and the retained `item`);
- latest crawl state (`health.crawlStatus`);
- latest failure detail (`health.latestError` or the existing source error fields);
- collection method and browser/fallback context when present in the source health/raw metadata;
- partial or incomplete current attempts through existing crawl/run status fields;
- Top 10 observation time and availability through `newsboard_top10` (`latest`, `runs`, `observedAt`, and result status/error fields).

Fields are preserved, not synthesized. Before a System Health UI can make uniform guarantees across all publishers, the snapshot RPC may need explicit, consistently populated fields for:

- `last_successful_observed_at` separate from the displayed retained observation;
- `collection_method` and `fallback_used` on every publisher result;
- `latest_failure_at`, `latest_error`, and `consecutive_failures` on every publisher;
- an envelope-level latest run status/completeness field with expected, attempted, succeeded, and failed publisher counts;
- Top 10 freshness/status per publisher rather than only the existing Top 10 payload coverage.

Those additions belong in a future backend/RPC change, not this frontend architecture pass.
