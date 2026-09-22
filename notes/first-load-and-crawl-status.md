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

Deployed verification, September 22, 2026:

- Fix commit `f88907df`; Pages deployment [35778753311](https://github.com/mattwilhalme/newsboard/actions/runs/35778753311) succeeded.
- Seven Node/Chrome tests passed, including initial transient failure/retry, offline snapshot labeling, clean-browser outage, automatic recovery, all status labels, and existing browser-runner checks.
- Rollback-only SQL tests passed against the deployed database for delegation, running, browser success, both failures, a new pending retry after failure, interrupted runs and both timeout paths.
- Live [browser gap-fill run 35778635313](https://github.com/mattwilhalme/newsboard/actions/runs/35778635313) completed with all six browser publishers successful. Public combined health reported success for all twelve configured publishers.
- `verify-live-load.mjs` confirmed all twelve displayed publisher headlines matched the first live snapshot, no Refresh click, zero page errors, zero static fallback/CDN requests, no service worker/controller and empty Cache Storage. A browser-only simulated HTTP 503 on the snapshot RPC displayed `Stale data — live data unavailable. Last successful snapshot: 2026-09-22T20:12:18.700Z`, then recovered automatically after restoring the connection.
- Screenshots: `/tmp/newsboard-live-first-load.png` and `/tmp/newsboard-live-stale-snapshot.png`.
- The existing GitHub schedule had run at 11:42, 15:44 and 19:15 UTC despite its seven-minute cron expression. This upstream scheduling delay is separate from page loading; older publisher observations now disclose their stale state instead of claiming freshness.
