# Targeted browser collection

`browser-gap-fill.yml` runs the five existing browser scrapers for AP (`ap1`), CNN (`cnn1`), Guardian (`guardian1`), USA Today (`usat1`) and Yahoo (`yahoo1`). It uses the same Supabase start/save/finish RPCs as the full backup and records `github_browser_gap_fill`. The trigger check was extended by migration `20260919204444_allow_github_browser_gap_fill.sql`.

Schedule: `*/7 * * * *`, UTC, plus workflow_dispatch. This is minute 0,7,14,21,28,35,42,49,56 each hour, not a strict seven-minute elapsed timer. GitHub scheduling can be delayed. See https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule.

After obtaining the shared crawler lease, the script checks `v_crawler_health` and skips any source with a successful observation at most 420 seconds old. Missing/stale sources are collected. An entirely fresh invocation is recorded as `skipped`. The lease is retried three times at ten-second intervals if busy. `cancel-in-progress: false` avoids interrupting a database-backed crawl.

Successful outputs update crawler_current and append snapshots/history atomically through newsboard_save_source. Failures preserve prior state. The workflow has read-only GitHub permissions and no cache/data generation or Git commit/push step. Diagnostics expire after three days. The seven-source Supabase Cron and full manual `scrape.yml` backup are unchanged.

Manual trigger:

```sh
gh workflow run browser-gap-fill.yml --repo mattwilhalme/newsboard --ref main
```

Verify:

```sql
select * from public.crawler_runs where trigger='github_browser_gap_fill' order by started_at desc limit 10;
select * from public.v_crawler_health where source_id in ('ap1','cnn1','guardian1','usat1','yahoo1');
```

The frontend continues to use Supabase RPCs; no Pages data commit is required for updated stories.

## Live verification

Published to main in commit `0033d4d7`. The deployed workflow was read back and contains the requested cron, workflow_dispatch, read-only permissions, and no data commits. Full manual `scrape.yml` and the frontend were unchanged.

Manual test: https://github.com/mattwilhalme/newsboard/actions/runs/35468397528 completed successfully. Supabase run `ab5bfe42-a608-4e55-bc8d-dfcb4427a579` recorded `github_browser_gap_fill`, exactly five attempted, five succeeded, zero failed, and 48,999 ms collection duration. The five source ids are exactly the requested set. Current state and snapshots were updated for all five.

The production frontend smoke test returned HTTP 200 for all three Supabase RPCs, rendered ten ABC Top 10 rows, reported no JavaScript errors, and made zero generated-JSON data requests. The new schedule is enabled; the live collection test used manual dispatch. Actual scheduled start times remain controlled by GitHub.
