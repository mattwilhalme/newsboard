# First load and combined crawl status

The Pages deployment publishes `main:/docs`. Supabase Cron writes HTTP observations every five minutes; the existing GitHub browser gap-fill workflow writes browser observations on its scheduled runs. Neither workflow updates Git snapshots. Wrangler is an alternative static deployment configuration, not the active GitHub Pages flow.

The initial `reload()` previously tried a CDN-loaded Supabase SDK, then silently loaded `docs/cache.json` on failure and cleared the error. That frozen migration-era file could therefore appear current. A later Refresh retried the database. A 30-second RPC memo also meant Refresh could reuse a previous response. The local root `cache.json` is ignored by Git and used by the Express/debug scraper; it is not the Pages fallback.

Removed `docs/cache.json` and its Git exception. Published historical JSON remains for archival/debug use, but the frontend no longer falls back to it for headlines, history, timeline or Top 10. Live RPC requests use native fetch, no-store, a 12-second timeout, and a fresh request on every reload. Initial snapshots retry once immediately; outage recovery retries every 15 seconds. Visibility and online events also reload automatically. Refresh remains available.

Browser storage previously held preferences and change-detection state, not the initial headline payload. It now retains only the last successful live snapshot under `nb_last_successful_snapshot_v1`. During an outage it is explicitly labeled Stale data with its observation timestamp. A clean browser without a saved snapshot shows unavailable data, not GitHub stories. Individual observations older than 20 minutes are also labeled stale even if the database read succeeds. No service worker registration or Cache Storage use exists in the repository.

For browser-configured sources, Edge failures are delegation notices. `v_crawler_attempt_status` combines those persisted notices with actual GitHub browser runs/results. Delegation is pending, a browser run is running, an individual successful browser result is success, and a failed browser result is failure. Routing notices do not override a recent success or reset an existing timeout. Queue timeout is 20 minutes; running timeout matches the database's ten-minute lease. Interrupted browser runs also fail. All raw attempt evidence is preserved. The snapshot RPC exposes the combined status; no collector selectors or schedules change.

Verification commands:

- `node --test scripts/crawl/first-load.test.mjs scripts/crawl/github-browser-gap-fill.test.mjs`
- Execute `supabase/tests/combined_crawl_status.sql` as one transaction (fixtures roll back; retry if a live crawl holds the single-run lease).
- `node scripts/crawl/verify-live-load.mjs` checks the published page, actual initial RPC headlines, service worker/cache inventory, zero static fallback requests, labeled outage snapshot, and automatic recovery without clicking Refresh.
