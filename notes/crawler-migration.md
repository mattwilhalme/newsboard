# Newsboard crawler migration

> This September 19 migration report is historical. Current routing and mobile validation are documented in [mobile editorial crawling](mobile-editorial-crawling.md): six HTTP sources, five mobile browser sources, and unchanged CNN browser collection.

Update: the five browser-dependent sources now also have a [scheduled targeted workflow](browser-gap-fill.md). The report below records the earlier Supabase cutover.

## Existing architecture (audited before changes)

`.github/workflows/scrape.yml` schedules `7,37 * * * *` and supports workflow_dispatch. It installs Node 24 and dependencies, uses runner Chrome, executes `server.js --refresh`, checks at least one source succeeded, copies cache.json into docs, then runs scripts/run-scrape.js with USE_CACHE_JSON=true and ENABLE_TOP10=0. It commits and pushes nine changing JSON files plus the public Supabase configuration to GitHub Pages.

`server.js` contains the publisher browser implementations and HTTP variants. The active HERO_SCRAPERS registry already prefers HTTP for eleven publishers; CNN uses Playwright. Browser CP logic often uses geometry, prominence, live banners, or publisher-specific ordering, which generic HTTP selectors cannot be assumed to reproduce. ABC Top 10 uses JSON-LD first, then ordered anchors, normalizes/deduplicates URLs, removes related live entries, and requires ten items. Top 10 collection is disabled in the scheduled workflow.

`refreshSources` writes hero_runs for attempts and headline_events for successes using server-only credentials, while also maintaining local cache/archive. The JSON builder maintains history, timeline, current/unified and Top 10 snapshots/events; it may reinsert prior Top 10 data from files. Database errors are often logged without failing the workflow. Existing SQL defines Top 10 tables, recently applied with server-only permissions. Existing public views use security_invoker; current hero includes failed attempts. Latest successful state is not a dedicated database entity.

`docs/index.html` explicitly returns early from loadFromSupabase on GitHub Pages. Cards/history/timeline and ABC Deep Dive thus rely on committed files there. On other hosts, current/history reads use a proxy or Supabase views, but timeline and Deep Dive still use JSON. The moment explorer additionally uses server APIs. `wrangler.jsonc` deploys static docs assets, not the Express crawler.

The current registry has ABC, CBS, USA Today, NBC, CNN, Guardian, AP, LA Times, NPR, BBC, Fox and Yahoo. Older database sources include additional legacy ids. No data files or working browser implementations should be deleted during migration.

## Implemented architecture

One Supabase Cron job, `newsboard-crawl`, runs `*/5 * * * *` in UTC. It calls `newsboard_private.invoke_crawl('supabase_cron')`, which records a dispatch and uses pg_net to POST to the `newsboard-crawl` Edge Function. A 256-bit invocation token lives in Vault; the function checks its SHA-256 digest using server-only credentials. Public/anon credentials cannot invoke crawls or write crawler data. Platform JWT checking is deliberately disabled because this endpoint implements its own private-token authentication; a wrong token was verified to return HTTP 401.

The orchestrator uses two concurrent HTTP collectors, 20-second request timeouts, strict non-2xx/empty-result rejection, per-publisher transactions, and an exclusive ten-minute run lease. It persists source outcomes independently. A failed source never changes its last successful data or timestamp. Interrupted runs remain visible and are marked failed when their lease expires on the next invocation. Browser-required publishers are explicitly recorded as unsuccessful attempts with their reason; they do not erase prior state. This intentionally makes overall runs `partial` while all seven enabled HTTP publishers succeed.

The manual workflow runs `scripts/crawl/github-backup.mjs`, which calls the existing browser implementations and the same persistence RPC. It retains Playwright and browser diagnostics but has only `contents: read`; no data commit/push step exists. Existing server.js/run-scrape.js are preserved for local/debug use. A compatibility trigger keeps successful legacy hero writes visible during parallel operation.

## Publisher validation

| Publisher | Edge status | Live comparison |
|---|---|---|
| ABC | HTTP enabled, CP + Top 10 | CP exact; all 10 headlines, normalized URLs, ranks and fingerprints match |
| CBS | HTTP enabled, CP | Headline, normalized URL and CP slot match |
| NBC | HTTP enabled, CP | Headline, normalized URL and CP slot match |
| LA Times | HTTP enabled, CP | Headline, normalized URL and CP slot match |
| NPR | HTTP enabled, CP | Headline, normalized URL and CP slot match |
| BBC | HTTP enabled, CP | Headline, normalized URL and CP slot match |
| Fox | HTTP enabled, CP | Headline, normalized URL and CP slot match |
| USA Today | Browser/manual backup | HTTP picked a different story than browser CP |
| Guardian | Browser/manual backup | HTTP picked a different story than browser CP |
| AP | Browser/manual backup | HTTP returned 403; browser succeeded |
| CNN | Browser/manual backup | Existing rendered-layout CP; no validated HTTP implementation |
| Yahoo | Browser/manual backup | Same headline but yahoo.com versus news.yahoo.com URL; equivalence not assumed |

Comparisons are point-in-time evidence, not a guarantee against future publisher layout changes. See `collector-comparison.json` and `abc-top10-comparison.json`. Generic HTTP selectors were copied from the existing code without rewriting browser extraction. No rendered geometry is fabricated. Only ABC supplies ranked Top 10 today; other migrated publishers supply the CP rank/slot they previously tracked. The snapshot model supports multiple ranked items for future collectors. No Intelligence work was added.

## Database objects

- Existing: `sources`, `hero_runs`, `headline_events`, `top10_runs`, `top10_items`, `top10_events`.
- New: `crawler_settings` (server-only token digest), `crawler_publishers` (method configuration), `crawler_runs`, `crawler_source_runs`, `crawler_current`, `crawler_snapshots`, `crawler_dispatches`.
- Writes: `newsboard_start_run`, `newsboard_save_source` / internal base function, `newsboard_finish_run`. All are security-invoker and restricted to service_role. Top 10 snapshots/items/events commit atomically with CP and source health.
- Reads: `newsboard_snapshot`, `newsboard_timeline`, `newsboard_top10`, `v_crawler_health`. Public read policies expose structured newsroom data, never the service-role key or invocation token. Existing raw headline_events remain inaccessible to browser clients.
- Frontend history covers seven days plus the current story, timeline is capped at 5,000 observations and at most seven days, and Top 10 at 2,016 snapshots (seven days at five-minute intervals). Full database history is retained. There is no automatic deletion or HTML archival in the Edge path.
- `newsboard_legacy_hero` trigger synchronizes successful legacy hero writes; failed legacy writes are ignored.

Applied migrations are in `supabase/migrations`, with filenames matching remote history:

1. `20260919190028_repair_newsboard_sources_and_top10.sql` — prior review's repair.
2. `20260919192030_newsboard_crawl_pipeline.sql` — runs, source health, current/snapshots, credentials and transactional writes.
3. `20260919192828_newsboard_reads_and_top10.sql` — atomic Top 10 persistence and browser RPCs.
4. `20260919193004_newsboard_five_minute_cron.sql` — single five-minute Cron and dispatch tracking.
5. `20260919194156_newsboard_legacy_sync.sql` — parallel-operation compatibility.
6. `20260919194657_newsboard_crawl_hardening.sql` — replay guard and time-bounded history.

These are incremental migrations for the existing Newsboard database, not a complete blank-project baseline. Collector activation is operational configuration in `crawler_publishers`; new installations default to browser/unvalidated until comparisons pass.

## Frontend and generated files

The design is preserved. Pages no longer skips Supabase. Cards/current state, history/metrics, timeline, ABC Deep Dive and Top 10 now use the read RPCs. The UI shows the age of the latest successful observation and a small failure indicator. A visible page refreshes every five minutes. Existing moment-explorer fallback uses the Supabase timeline through the same adapter; its full Express-only API remains available locally.

No generated JSON file is required on the normal successful production path. Browser smoke tests observed HTTP 200 for all three RPCs, ten rendered Top 10 rows, no JavaScript errors, and **zero generated-data JSON requests**.

Preserved as migration/outage fallbacks: `docs/cache.json`, `docs/data/history.json`, `docs/data/timeline.json`, `docs/data/top10_abc_latest.json`, `docs/data/top10_abc_history.json`. These files retain their original timestamps; they are not refreshed by Cron. `docs/data/unified.json`, `docs/data/current.json`, `docs/data/top10_abc_events_24h.json`, `docs/data/top10_abc_events_history.json` remain archived/debug outputs and are no longer required for the frontend's normal path. `cache.json` remains local/debug state. `docs/supabase.json` is static public connection configuration and is still required; it contains no service-role credential.

Legacy Top 10 JSON archives were retained, not bulk imported or deleted. The active frontend windows are at most seven days, so historical pre-migration archives do not supply the current window. A separate idempotent archival import can be done if historical access beyond the active UI window is desired.

## Validation and operations

- Local HTTP/browser comparisons cover all 12 publishers; seven CP matches and ABC 10/10 ranks/fingerprints.
- Real Edge invocation returned HTTP 200 and seven source successes; initial boot failure was corrected before scheduling by fixing the import map and duplicate binding.
- Scheduled runs at 19:35 and 19:40 UTC on 2026-09-19 independently wrote all seven HTTP publishers. Further scheduled runs continued during validation. No GitHub job or Git commit triggered those writes.
- `supabase/tests/crawler_safety.sql` passed against the live database inside a rolled-back transaction: overlap rejection, successful persistence, failure preservation, empty-result rejection, and no public write/secret access.
- `node --test scripts/crawl/collectors.test.mjs` passes blocked-page, empty-page, truncated-Top-10 and normalization checks.
- `node scripts/crawl/smoke-ui.mjs` validates real anonymous reads, rendered CPs/Top 10, failure indicators and absence of JSON fallback requests. It requires local Chrome and network access.
- Security advisors have no WARN/ERROR findings. Informational no-policy notices for server-only tables are intentional.

### Manually invoke the Edge Function

In the project's SQL editor (no secret needs to be copied):

```sql
select newsboard_private.invoke_crawl('manual_edge_function');
```

Or POST to `https://aknclkofrjliaecsjbnp.supabase.co/functions/v1/newsboard-crawl` with `Content-Type: application/json`, `x-newsboard-token` set securely from the `newsboard_crawl_token` Vault secret, and body `{"trigger":"manual_edge_function"}`. Never use the public anon key as crawl authorization.

### Manually invoke the GitHub backup

Use GitHub Actions → **Newsboard manual browser backup** → Run workflow, or:

```sh
gh workflow run scrape.yml --repo mattwilhalme/newsboard --ref main
```

Existing GitHub secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are used. The workflow never writes repository data. It updates browser-required publishers through the same database pipeline and records `github_backup` as the trigger. If another crawl holds the lease, retry after it finishes.

### Check health

```sql
select jobname, schedule, active from cron.job where jobname='newsboard-crawl';
select started_at, completed_at, trigger, status, publishers_succeeded,
       publishers_failed, duration_ms, error_summary
from public.crawler_runs order by started_at desc limit 20;
select * from public.v_crawler_health order by source_id;
select d.dispatched_at,d.trigger,r.status_code,r.timed_out,r.error_msg
from public.crawler_dispatches d
left join net._http_response r on r.id=d.request_id
order by d.dispatched_at desc limit 20;
```

No new dispatch for over ten minutes indicates a scheduler problem. Dispatch without a crawler run indicates invocation/auth/boot trouble; inspect pg_net response and Edge logs. A stale `running` run indicates interruption. `persistence:` source errors distinguish write failures from extraction failures. For HTTP-enabled publishers, expect a success less than ten minutes old. The five browser-only sources require manual refresh; their repeated browser-required notices are expected until migrated. pg_net response history is short-lived, while crawler/dispatch records persist.

### Deployment and rollback

Frontend hosting remains GitHub Pages from `main:/docs`; no new paid hosting or crawl provider was introduced. Deploy function revisions with:

```sh
supabase functions deploy newsboard-crawl --project-ref aknclkofrjliaecsjbnp --use-api --no-verify-jwt --import-map supabase/functions/newsboard-crawl/deno.json
```

To stop the new scheduler without deleting data: `select cron.unschedule('newsboard-crawl');`. The manual workflow remains available. Do not restore automatic Git data commits as a persistence mechanism.

## Files changed

Added: `supabase/functions/newsboard-crawl/{index.ts,collectors.js,deno.json}`, the five pipeline migrations, `supabase/tests/crawler_safety.sql`, `scripts/crawl/{compare.mjs,compare-top10.mjs,collectors.test.mjs,github-backup.mjs,smoke-ui.mjs}`, and this report plus comparison evidence. `supabase/.gitignore` excludes CLI temporary state.

Modified: `.github/workflows/scrape.yml`, `docs/index.html`, `server.js` (comparison exports only), `supabase/README.md`. Prior review changes to `package.json`, `package-lock.json`, and `sql/20260218_top10_deep_dive.sql` are included: pinned client version and secured Top 10 setup.

## Next migration step

Validate publisher-specific HTTP CP rules for USA Today/Guardian, investigate Yahoo host canonicalization and CNN's raw homepage, and solve AP's HTTP restriction without pretending a blocked response is a valid crawl. Until then those five require the preserved manual browser backup. Five-minute collection increases database growth substantially compared with the former half-hour schedule; monitor storage before assuming the earlier Free-tier capacity estimate still applies.


## Final cutover result

**Yes: Supabase now triggers and stores Newsboard crawls every five minutes without GitHub Actions or Git commits, for the seven validated HTTP publishers.** USA Today, Guardian, AP, CNN and Yahoo still depend on the manual Playwright backup; they are not automatically refreshed by the Edge crawler.

- Published application/workflow commit: `a59e502b66e6181ff0534c220108203aed40883b`.
- Live application: https://mattwilhalme.github.io/newsboard/
- GitHub Pages confirmed that commit built successfully. A smoke test of the actual Pages URL returned HTTP 200 from all three read RPCs, rendered 10 ABC rows, reported no JavaScript errors, and requested no generated JSON.
- Deployed Edge Function: `newsboard-crawl`, version 3. One active Cron job, `*/5 * * * *`.
- Scheduled writes verified at 19:35, 19:40, 19:45 and 19:50 UTC on 2026-09-19: seven successes per invocation, roughly 2–3 seconds each. The five browser-required outcomes are explicitly reported as failures/requirements, making the whole run `partial`.
- The **remote** `.github/workflows/scrape.yml` was read back and confirmed to have `workflow_dispatch` only, no `schedule`, and read-only repository permissions.
- Manual dispatch test: https://github.com/mattwilhalme/newsboard/actions/runs/35465630782 — all 12 publishers succeeded; ABC stored 10 items. The database recorded `github_backup`, `success`, 12 succeeded, zero failed, and 59,720 ms duration. The workflow has no commit/push operation.
- No setup steps remain for the active seven-publisher pipeline. Run the manual backup when fresh results are needed for the other five. Their previous successful observations remain visible and correctly aged between manual runs.
- No Intelligence feature, clustering work, UI redesign, external paid browser service, data deletion, or historical-snapshot overwrite was introduced.

To retrieve a publisher's most recent failure even after a later successful retry:

```sql
select distinct on(source_id) source_id,completed_at,error,collection_method
from public.crawler_source_runs where not success
order by source_id,completed_at desc;
```
