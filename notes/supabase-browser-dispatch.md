# Supabase browser dispatch scheduler

## Deployment state

Implemented September 22, 2026. The private Edge Function, tracking migration and credential are deployed. Controlled dispatch [35782230968](https://github.com/mattwilhalme/newsboard/actions/runs/35782230968) completed successfully for all six browser publishers. Supabase scheduling is enabled and the GitHub cron trigger is removed; the full manual backup is unchanged. See the cutover verification below for actual scheduled-cycle results.

## Timing evidence and policy

The twelve most recent browser runs took 34.620–60.911 seconds in `crawler_runs`. The latest controlled manual workflow took 62 seconds wall-clock: GitHub started at 20:11:21 UTC, crawler lease started at 20:11:36.955, observations were saved at 20:11:49.463–20:12:18.700, and the crawl completed at 20:12:19.113. Scheduled GitHub starts that day occurred at 01:10, 06:13, 11:42, 15:44, and 19:15 UTC despite a seven-minute schedule.

The replacement checks every minute. It becomes due when the oldest configured browser publisher's last successful observation is 420 seconds old (the existing freshness threshold). Missing observations are due immediately. Recent actual observations, any unexpired crawler lease, or an active dispatch suppress new requests. Queue/start deadline: ten minutes, generously above observed startup time. Crawl deadline: the existing ten-minute shared lease. GitHub's twelve-minute job limit is unchanged. This aims to remove the multi-hour GitHub cron-trigger delay, but runner queues, startup, and extraction still add latency. A seven-minute observation interval is not guaranteed; measured cutover results are recorded below.

## Implementation

- `supabase/migrations/20260922202342_browser_dispatch_scheduler.sql`: private RLS-protected settings/attempt tables, atomic claim/send/start/result/complete RPCs, private operational status RPC, Vault-backed invocation authentication, and a staged inactive one-minute Cron job.
- `supabase/functions/newsboard-browser-dispatch/{index.ts,dispatcher.js,deno.json}`: authenticate Cron requests, claim work, POST only `mattwilhalme/newsboard` / `browser-gap-fill.yml` / `main`, record allowlisted response metadata. Uses pinned Supabase SDK; GitHub API version `2026-03-10` supports a 200 response with run ID; legacy 204 acceptance is also supported.
- `.github/workflows/browser-gap-fill.yml`: optional `dispatch_id` input and runner-start timestamp. Existing concurrency and manual dispatch remain; the GitHub schedule is removed after successful cutover verification.
- `scripts/crawl/github-browser-gap-fill.mjs`: correlate scheduled attempts to the existing shared crawler lease and persist completion. Manual invocations still use the original start RPC.
- `scripts/crawl/browser-dispatch.test.mjs`, `scripts/crawl/github-browser-gap-fill.test.mjs`, `supabase/tests/browser_dispatch_scheduler.sql`: dispatch/authentication, worker correlation, and database lifecycle coverage.

Claims use the same advisory transaction lock as `newsboard_start_run`, plus a unique partial index allowing only one active dispatch. Send is single-use. A late/duplicate/expired GitHub worker cannot acquire a crawl through its old attempt. A worker that races a general crawler defers with a two-minute cooldown. No general crawler, story intelligence, publisher extraction, public UI, or manual backup code changes.

GitHub 200/204 means **accepted**, never success. A worker callback links the actual `crawler_runs` ID. Completion is derived from that persisted row; each tick reconciles if the completion callback was interrupted. Transport uncertainty holds the ten-minute lease. Rejections/expired attempts/failed or partial crawls use exponential retry cooldown (2–30 minutes; GitHub Retry-After honored up to one hour). A missing credential records a diagnostic and suppresses retries for 30 minutes. A successful crawl resets failure backoff. Raw provider response bodies and credentials are never stored or logged.

## Credential setup and controlled cutover

1. In GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens, create a token owned by `mattwilhalme`, limited to **Only select repositories: `newsboard`**, with **Repository permissions → Actions: Read and write**. No Contents write or Workflows permission is needed for dispatch. Set an expiry and plan rotation. GitHub automatically includes Metadata read. A repository-limited GitHub App installation credential with Actions write is also supported, provided its short-lived tokens are refreshed operationally.
2. In [Supabase Edge Function secrets](https://supabase.com/dashboard/project/aknclkofrjliaecsjbnp/functions/secrets), save the token as **`NEWSBOARD_GITHUB_DISPATCH_TOKEN`**. Do not paste it into chat, SQL, Git, workflow files, or the public dashboard. Saving an Edge secret does not require redeployment. The separate Cron invocation token has already been generated in Vault as `newsboard_browser_dispatch_token`; it must not be copied to GitHub.
3. Confirm `main` contains this workflow's `dispatch_id` input. Keep the existing GitHub cron enabled. In the private SQL editor, enable only the decision flag and invoke one controlled tick (the new cron job stays inactive):

```sql
update public.browser_scheduler_settings set enabled=true, retry_after=null where id;
select newsboard_private.invoke_browser_dispatch();
select public.newsboard_browser_scheduler_status();
```

If the decision is `fresh` or `crawler_active`, wait until due/idle and invoke again. Do not forge observation times or bypass a lease. An accepted attempt's `github_run_id` or GitHub Actions run list provides the workflow link. While accepted/running, invoke another tick and confirm `dispatch_active` without another attempt. After completion, confirm `success`, all six source successes, new current/snapshot rows linked to the crawler run, and dashboard status. Use:

```sql
select a.id,a.status,a.due_at,a.dispatched_at,a.github_status,a.github_run_id,
 a.github_runner_started_at,r.started_at as crawler_started_at,r.completed_at,
 r.publishers_succeeded,r.publishers_failed,
 extract(epoch from(a.dispatched_at-a.due_at)) as due_to_dispatch_seconds,
 extract(epoch from(a.github_runner_started_at-a.dispatched_at)) as dispatch_to_runner_seconds,
 min(c.observed_at) as first_observation,max(c.observed_at) as last_observation
from public.browser_dispatch_attempts a
left join public.crawler_runs r on r.id=a.crawler_run_id
left join public.crawler_current c on c.run_id=r.id
group by a.id,r.id order by a.claimed_at desc limit 5;
```

Run `node scripts/crawl/verify-live-load.mjs` to verify API headline rendering, status, and recovery on the public site. Its simulated outage is browser-local.

4. **Only after a complete successful controlled crawl**, activate the replacement Cron:

```sql
select cron.alter_job(jobid,active:=true)
from cron.job where jobname='newsboard-browser-dispatch';
```

Verify at least one scheduled tick is recorded and suppresses a duplicate while fresh/active. Then remove only these two lines from `.github/workflows/browser-gap-fill.yml`, commit, and push `main`:

```yaml
  schedule:
    - cron: "*/7 * * * *"
```

Retain `workflow_dispatch`, inputs, and concurrency. Measure a complete scheduled observation cycle before claiming improved freshness. Until these steps pass, the migration is staged, not a completed cutover.

## Operations and rollback

Run `select public.newsboard_browser_scheduler_status();` as the SQL administrator/service role. It returns last due check, due time, decision/backoff, recent dispatch/response/run timestamps/errors, last completed browser crawl, and per-publisher observation ages. Anon/authenticated roles cannot read these diagnostics or invoke scheduler RPCs. The public UI continues to show the existing simple freshness and combined crawl status.

For rollback, first disable the replacement:

```sql
update public.browser_scheduler_settings set enabled=false where id;
select cron.alter_job(jobid,active:=false)
from cron.job where jobname='newsboard-browser-dispatch';
```

Restore the two `schedule` lines shown above if removed, then commit/push `main`. Leave an already accepted GitHub run to finish under the existing concurrency and lease protections. Keep tables/migrations for audit and leave the manual backup available. No data rollback or publisher changes are necessary. After cutover the replacement is active and the prior schedule must be restored explicitly for rollback.

## Verification performed

- 21 Node tests passed, including overlapping ticks, fresh/due/active suppression, acceptance, rejected API statuses, missing credentials, transport uncertainty, authentication, worker correlation and the existing collector/lease tests.
- Rollback-only SQL scenarios passed: recent observations, due claim, duplicate suppression, accepted-not-success, never-started expiration, late/duplicate worker rejection, missing credential cooldown, API backoff, running/result race, failed crawl recovery, active manual backup, and access controls.
- Two genuinely concurrent production database claim requests returned one `dispatch` and one `dispatch_active`; exactly one attempt was created. This probe sent no GitHub request and was closed by its exact UUID with `database_concurrency_probe_no_github_request`.
- Deployed Edge endpoint rejected an unauthenticated request with HTTP 401. Authenticated Vault → pg_net → Edge invocation (request 1513) returned `missing_credential` and recorded attempt `fa5aff4a-6901-434b-bbeb-68922a5b2bbd` at 20:30:15 UTC, due at 20:18:49.463 UTC, with no GitHub dispatch/run fields. This verifies the real invocation/authentication path, **not** GitHub dispatch or crawl success.
- A second authenticated invocation (request 1515) returned `backoff` and created no additional attempt. Both the settings flag and Cron job were then confirmed disabled; the other two existing Cron jobs remained active.
- The staged-state checks above preceded credential provisioning. End-to-end results follow below.

References checked: [Supabase scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions), [Edge secrets](https://supabase.com/docs/guides/functions/secrets), [GitHub workflow dispatch and token permissions](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).


## Controlled cutover verification

- An initial credential attempt returned GitHub HTTP 403 and was safely rejected; no workflow ran and the replacement stayed disabled until permissions were corrected.
- With the corrected credential, authenticated Edge invocation 1521 dispatched attempt `a73525b2-45d8-480e-82da-42ab86312c3f`, GitHub run `35782230968`, and Supabase crawl `75fa8d11-a019-4390-ba88-0cca2b29a73f`.
- Dispatch: 20:44:20.884 UTC; GitHub runner start: 20:44:27; crawler start: 20:44:38.415; observations: 20:44:49.288–20:45:12.668; completed: 20:45:13.445. All six publishers succeeded and have matching current/snapshot rows. The due time of 20:18:49.463 predates credential setup; that manual test's overdue duration is not scheduler latency.
- Duplicate authenticated invocation 1522 returned `dispatch_active`. Live combined health showed already completed sources as success while remaining sources were running, then all six succeeded.
- The existing 21 JavaScript tests passed again before cutover. No extraction, general-crawler, story-intelligence, or manual-backup changes were needed.

- The recurring Cron job was activated at approximately 21:06 UTC, after the user resumed the task. Its first tick began at 21:07:00.179, and the Edge Function dispatched at 21:07:01.415. The due time (20:51:49.288) predates activation by about 14 minutes; the 15m12s due-to-dispatch duration includes this intentional inactive period and does not measure steady-state scheduling lag.
- Scheduled attempt `209c3331-eaac-4456-973b-878841295cd5` started GitHub run [35784619919](https://github.com/mattwilhalme/newsboard/actions/runs/35784619919). Runner start: 21:07:07; crawler start: 21:07:20.846. The 21:08:01 tick returned `dispatch_active`, with no additional dispatch.
- The first automatic crawl completed successfully at 21:08:41.217: six publishers succeeded, zero failed, and six matching snapshots were persisted. Observations span 21:08:06.306–21:08:40.406. This was 5.585 seconds from dispatch to runner start and 99.802 seconds from dispatch to completed crawl (80.371 seconds of collection). The slower AP collection demonstrates why dispatch acceptance is not a guarantee of immediate freshness.
- The new trigger demonstrably reached GitHub about one second after an actual Cron tick, versus the prior multi-hour GitHub trigger gaps. This verifies the intended dispatch path and fresh observations; it does not establish a long-term seven-minute observation guarantee. Startup, extraction, retries and GitHub queues can still delay observations.
- At 21:09:00.649 UTC, the next automatic tick returned `fresh` with next due time 21:15:06.306 and created no new dispatch. All three Supabase Cron jobs remain active with their intended schedules; general crawling and story intelligence were not modified.
- The deployed dashboard smoke check passed after the automatic crawl: all twelve configured publishers' headlines matched the initial live RPC, all six browser statuses were `success`, no page errors or static fallback requests occurred, and a simulated outage recovered automatically with a timestamped stale snapshot.
