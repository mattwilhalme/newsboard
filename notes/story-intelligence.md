# Story identity and propagation

## Phase A: inspected architecture and implementation plan

The raw evidence remains authoritative and unchanged. `crawler_runs` describes collection invocations; `crawler_source_runs` records outcomes; `crawler_current` preserves the latest successful publisher output; `crawler_snapshots` appends ordered items. Only ABC currently supplies ten ranked items. Other publishers supply one homepage lead, not a full Top 10. `top10_runs` links ABC snapshots to `crawler_run_id`; `top10_items` stores ranks/titles/URLs/fingerprints; `top10_events` is a legacy per-publisher change stream. Fingerprints may include the headline and therefore are not stable story IDs. `sources` supplies publisher names. No reliable publication dates were found in the sampled outputs.

The dashboard reads `newsboard_snapshot`, `newsboard_timeline`, and `newsboard_top10` RPCs. Existing client-side clustering is transient display logic and will not be reused as authoritative identity. The UI already has drawers and `headlineDiffHtml`; story history will reuse those patterns after backend validation.

Plan: add derived stories, one membership per story/publisher, meaningful events, and a private assignment/processed-batch ledger. A standalone Edge worker polls successful raw evidence on a separate schedule. It never runs in the crawler write transaction, changes a collector, or installs a raw-table trigger. Indexed recent candidate retrieval feeds a shared deterministic JavaScript matcher. Atomic derived-only commits record assignments and rebuild chronology for affected stories so bounded out-of-order backfills remain safe and idempotent. Raw rank coverage is recorded explicitly as `top10` or `hero`.

Use a 48-hour candidate window and a 2-hour current/recent coverage window. The first historical test is September 20, 2026, 15:00–15:30 UTC. No whole-database backfill is authorized or planned. Validate normalization, matching, ambiguity rejection, event transitions, retry idempotence, security, and raw-write independence before adding UI.

## Final schema and execution

Migrations applied:

- `20260920154744_story_identity_and_propagation.sql`: derived tables, indexes, candidate/batch/event functions, public read RPCs and RLS.
- `20260920155731_story_intelligence_schedule.sql`: independent worker invocation and bounded live cursor.
- `20260920160011_story_event_reconciliation.sql`: deterministic event IDs and change-only event reconciliation (preserves unchanged event rows).

| Table | Purpose / key fields |
| --- | --- |
| `stories` | UUID identity, canonical label, first detection/source, last seen, active coverage, indexed search terms, timestamps |
| `story_members` | Unique `(story_id, source_id)`; first/latest headline, latest URL/fingerprint, first/last seen, first/peak/current rank, first No. 1 time, active coverage/scope, initial match explanation |
| `story_observations` | Deterministic UUID per story/source/batch/event; event type, observation timestamp, headline/URL/rank, optional actual publication time, Top 10 run FK, old/new values and match metadata |
| `story_processed_batches` | Idempotency ledger; original snapshot/Top 10 run FKs, source, observation timestamp, coverage scope |
| `story_assignments` | Private item-to-story decisions with raw batch/rank key, terms and top three candidate explanations; supports chronological reconstruction |
| `story_processing_runs` | Window, mode, status, counts, errors and invocation timing |
| `story_worker_state` | Derived-worker lease and live polling cursor |

`story_raw_batches` is a security-invoker view combining successful crawler snapshots and nonduplicated legacy Top 10 runs. All story tables have RLS. Anonymous/authenticated users can read public story/member/event data and call the badge/history RPCs. Assignment ledgers, worker state, and all mutating RPCs are service-role only. No security-definer functions are added. The Edge endpoint checks the existing private crawl-token hash; no service key or Vault token is exposed in the frontend.

`story-intelligence` runs independently at `1-59/5 * * * *`. The original `newsboard-crawl` remains `*/5 * * * *`. Each invocation handles at most 60 batches and roughly 45 seconds of work, with a three-minute renewable lease. Completed live windows advance a cursor with a 15-minute overlap. Observations arriving more than 15 minutes late can be recovered using the explicit backfill utility. A partial run leaves unfinished batches retryable. Separate invocation/transactions mean an intelligence failure cannot roll back or reject a raw crawler observation. There are no triggers on crawler tables and no changes to collector strategies, Top 10 extraction, backup workflows or existing crawl RPCs.

## Deterministic matcher

`supabase/functions/story-intelligence/matcher.js` is shared by the Edge worker, CLI and tests. No external LLM/API or NLP dependency is used.

Normalization handles Unicode, case, punctuation/whitespace, leading live/update labels and trailing publisher names. Significant terms exclude grammatical/formatting boilerplate and use a small explicit inflection/synonym map (e.g. quake → earthquake, hits/strikes → strike). Negation and event terms remain. Capitalization provides a lightweight entity signal; common sentence-opening nouns are not treated as proper names. Canonical URLs preserve identity-bearing query parameters while dropping tracking.

Base score:

| Signal | Weight |
| --- | ---: |
| Significant headline-token Dice similarity | 0.40 |
| Significant-term containment | 0.35 |
| Entity containment | 0.12 |
| Article URL-slug Dice similarity | 0.08 |
| Temporal proximity (linear decay across 48 hours) | 0.05 |

A **0.15 corroborated-phrase bonus**, capped at score 1, requires at least four shared headline terms, a shared two-term phrase, and at least three shared URL-slug terms. This addresses rewrites with concrete event wording without allowing a shared person alone to merge stories. Scores are confidence heuristics, not calibrated probabilities.

Automatic association requires **score ≥ 0.75**, at least three shared significant terms, at least 0.45 headline similarity, and shared evidence beyond entities alone. Explicit conflicting actions (e.g. rate cuts versus hikes) are rejected. Publisher-local URL continuity can score 0.98, but still requires at least two shared terms, ≥0.5 containment, and no conflicting action—an unrelated rolling live-blog headline cannot match solely on URL. Candidates within **0.08** of the best score cause a separate story rather than a forced merge.

Candidate retrieval uses a **48-hour** observation window, indexed shared term arrays or publisher-local URL continuity, up to **100 stories** and **24 distinct representative headlines per story**. Representatives come from multiple member observations, not just the canonical label. Search terms, source/URL lookups, timestamps and event FKs are indexed. Canonical labels use the earliest observed headline; ties are ordered by source ID, never invented publication times.

The membership count is distinct publishers still present in their latest successfully processed coverage and seen within **two hours**. `active` means present in the latest observed coverage; the recency cutoff additionally protects the displayed count when a source stops updating. A hero disappearing produces `LEFT_HOMEPAGE_LEAD`, not a fabricated `EXITED_TOP10`. Only genuine full Top 10 coverage produces Top 10 entry/exit events. Actual item `published_at`/`publishedAt` is preserved if present and valid; all sampled records had null publication timestamps.

## Small backfill and match quality

Explicit test window: **2026-09-20 15:00–15:30 UTC**, not the full archive.

- 49 raw batches processed in about 4.1 seconds.
- 23 stories, 24 publisher memberships, **1 multi-publisher story**, 58 meaningful events.
- Identical replay processed 0 batches; all four counts stayed unchanged.
- A subsequent live catch-up processed 36 additional batches in about 2.5 seconds, without creating duplicate stories.

Strong real match:

- CBS: `Trump says proposed arch will also be a "top grade Military Complex"` — first detected **15:00:05.236 UTC**.
- USA Today: `Trump says triumphal arch will also serve as 'military complex' with snipers` — picked up **15:09:21.506 UTC**, score **0.7977**. The shared military-complex phrase plus corroborating URL slugs distinguishes this event from other Trump coverage.

Intentional conservative misses/rejections:

- ABC's arch/sniper/drone headline remains separate from the CBS/USA Today story: corroborating overlap does not meet this initial threshold. This is a known false negative, not a claim these are different real-world events.
- BBC's Moscow drone attack and ABC's ballistic-missile Moscow strike overlap topically but remain separate without stronger evidence of the exact event.
- Trump/China tariffs versus border security, Warriors/Lakers game versus a trade, and Fed rate cuts versus Powell's inflation outlook are rejected.
- Synthetic equally plausible competing stories remain separate with `decision: ambiguous` and both scores preserved.

Every assignment stores matcher version, decision, threshold, score components, shared terms/phrases, winning representative and top three candidates. Use `node scripts/story/diagnose.mjs` with server-side Supabase credentials, or inspect `story_assignments.metadata` for later decisions. Public FIRST labels mean earliest **NewsBoard detection within available processed history**, not first publication worldwide. History currently begins at the bounded test window, not the start of all raw data.

## Validation

- 17 matcher tests passed: required earthquake/storm positives, topic/action negatives, normalization, identity-bearing URL parameters, ambiguous ties, multiple representatives, temporal cutoff, rolling URL protection and real corroborated URLs.
- 7 existing collector/Top 10/runner checks passed (24 Node tests total).
- Transactional SQL integration assertions passed and rolled back: rank 6 → 1, headline and URL changes, publisher pickup, earlier backfill correcting FIRST, deduplicated replay, unchanged event-row retention, Top 10 exit, null publication dates, and raw snapshot survival after forced derived-processing failure. Tests create isolated temporary publisher fixtures inside the rolled-back transaction.
- Anonymous write/private-ledger access denied; public history read allowed. Supabase security advisors reported no new warnings/errors; only the three pre-existing intentional policy notices. Performance advisors reported informational unused indexes (including newly added indexes on small tables), not missing FK indexes or errors.
- Real UI tests passed for two badges, drawer timeline, desktop/mobile layouts, Escape/Close behavior, and a simulated history API failure while raw headline cards remain usable.
- The existing Supabase UI smoke test also passed: all 10 ABC items rendered, all four dashboard RPCs returned HTTP 200, no JavaScript errors, and no generated-JSON fallback reads.
- Live catch-up processed 36 additional batches successfully. The scheduled intelligence job then ran at 16:01 UTC and processed another six batches successfully; the original raw crawler also ran at 16:00 UTC. Both cron jobs remain active with separate schedules.
- Raw Supabase cron continued recording six HTTP successes per cycle at 15:50 and 15:55 UTC. Its overall `partial` status reflects the existing browser-required notices, not this intelligence work. Browser scraper code and workflows are unchanged in this task.

## UI

The existing overview stays publisher-based. Matched current headlines get one compact `FIRST · 2 pubs` or `2 pubs` button. The ABC Top 10 row renderer supports the same indicator when its current item has a multi-publisher match. Historical rows are not given a fabricated historical publisher count. Clicking opens the existing-style Story History drawer with canonical headline, first detected publisher/time, recent publisher count, current No. 1 count, and chronological events. Headline edits reuse `headlineDiffHtml`. Tooltip and drawer copy explain FIRST and observation coverage. Intelligence reads time out gracefully and do not replace raw headlines.

Desktop screenshot: `/tmp/newsboard-story-history.png`; mobile: `/tmp/newsboard-story-history-mobile.png`; overview badges: `/tmp/newsboard-story-badges.png`.

## Tools and files

Created: this report; three migrations above; `supabase/tests/story_intelligence.sql`; `supabase/functions/story-intelligence/{index.ts,deno.json,matcher.js,processor.js}`; `scripts/story/{process.mjs,diagnose.mjs,matcher.test.mjs,smoke-ui.mjs}`. Modified: `docs/index.html` only for the additive indicators/drawer.

Bounded CLI examples (service credentials must remain server-side):

```sh
node scripts/story/process.mjs --hours 6
node scripts/story/process.mjs --hours 24 --max-batches 300
node scripts/story/process.mjs --start 2026-09-20T15:00:00Z --end 2026-09-20T15:30:00Z
```

Default bound is 60 batches, maximum explicit window 24 hours. Repeat the same window to continue safely; the ledger skips completed batches. No entire-database backfill was run. SQL administrators can invoke `newsboard_private.invoke_story_intelligence(start,end)` and inspect `story_processing_runs`/`net._http_response`. Run SQL integration tests only as a complete transaction so their fixtures roll back.

## Tuning recommendations

Keep the current threshold initially. Review labeled true/false pairs, especially same-person different-event coverage, before lowering it. ABC's arch miss is a useful recall example; a small curated evaluation set should guide any future URL/phrase-weight change. Add explicit entity extraction only if error review warrants it. Consider manual story reconciliation and paging for timelines beyond 1,000 events in a later phase. Measure candidate saturation and event reconstruction cost as retention grows. Distinguish source polling latency from editorial pickup speed; this feature records detections, not publication times.
