# Multi-publisher Top 10

The existing HTTP and browser crawlers now return both CP and ranked stories from the same document. No new schedule, homepage request or browser context. The manual backup retains browser collection for ABC/CBS and extracts ranking from that same rendered HTML, removing its old second ABC crawl. Existing five-minute HTTP Cron, one-minute browser due checks (420-second observation freshness threshold), leases and manual backup remain. Browser execution stays in GitHub Actions. No Intelligence UI or frontend changes.

## Publisher strategy

| Publisher | Production method | Ranking scope/order |
|---|---|---|
| ABC (`abc1`) | HTTP | `main` Prism editorial cards, in document order; actual story/wireStory/live-updates URLs only; TV player excluded |
| CBS (`cbs1`) | HTTP | Latest News editorial cards, then More Top Stories, using article headings |
| NBC (`nbc1`) | Pixel 7 mobile | Visible storyline/package headings and related editorial headlines in vertical then horizontal order |
| CNN (`cnn1`) | Existing 820×1000 browser | Visible editorial container headlines in visual order; trending ribbon, paid/recommended modules and navigation excluded |
| AP (`ap1`) | Pixel 7 mobile | Main editorial PagePromo headlines in visual order, excluding trending carousel |
| USA Today (`usat1`) | Pixel 7 mobile | Hero then mobile editorial list anchors, including promoted photo/video reports; excluding horoscope, puzzles, sponsored links and the commercial `/story/shopping/` section (not editorial grocery/auto reporting) |
| Yahoo (`yahoo1`) | Pixel 7 mobile | Top Stories carousel by explicit slide number, including offscreen slides; never fill from personalized feed |
| Guardian (`guardian1`) | Pixel 7 mobile | News container cards in visual order; match visible headline to its labeled overlay article link |

Validation found narrow pre-existing CP mistakes: ABC's utility filter rejected real live-update leads; NBC's `multi-storyline` package spelling was absent; CNN's selector priority chose a lower title package before a higher live headline. Fixes retain the existing fetch/render method and use publisher editorial structure, rather than forcing Top 10 to agree with an incorrect CP.

## Persistence and quality

Migration `20260923143201_multi_publisher_top10.sql` reuses all existing tables and preserves historical ABC rows. New `top10_runs.quality`, `item_count`, `diagnostics`, and source-run `top10_status`/`top10_error` distinguish complete, partial, warning and failed extraction. Diagnostics include CP agreement, rejected candidates/reasons, duplicates and timing; browser candidate detail is capped at 30. No extra public dashboard diagnostics.

URL identity drops tracking/fragments, normalizes www/ABC/Yahoo aliases and trailing slash, retaining article identity parameters. Fingerprints no longer include title. Event comparison uses canonical URLs, so retitling produces TITLE_UPDATED rather than a false exit/entry. Movement and retitle can both occur. Only complete, CP-agree runs generate events, compared with the prior complete successful run for that publisher. Partial lists are stored without filling or false exit events.

The CP is persisted first. Top 10 writes/event generation occur inside a PL/pgSQL exception subtransaction; any failure records a source error while retaining raw/current CP. Story Identity remains its independent existing scheduled worker. Its existing input view reads ranked items from top10_items; incomplete/warning/failed lists are withheld rather than interpreted as exits. This conservative gate means consistently partial Yahoo/Guardian lists do not yet contribute full ranked Story Identity batches. Historical batch keys and ledger are preserved.

## Verification and operations

- `node --test scripts/crawl/top10.test.mjs scripts/crawl/collectors.test.mjs`
- `PLAYWRIGHT_BROWSER_CHANNEL=chrome node --test scripts/crawl/top10-browser.test.mjs scripts/crawl/mobile-hero.test.mjs scripts/crawl/github-browser-gap-fill.test.mjs scripts/crawl/browser-dispatch.test.mjs scripts/story/matcher.test.mjs`
- Run `supabase/tests/multi_publisher_top10.sql` against Supabase: transaction rolls back synthetic publisher/data; checks #8→#3, entry/exit/retitle, partial/error gates, raw persistence, replay, Story handoff and permissions.
- `PLAYWRIGHT_BROWSER_CHANNEL=chrome node scripts/crawl/validate-top10.mjs [source_id]` collects read-only live diagnostics, HTML and optional same-page screenshots in ignored `archive/`. No DB writes.
- Deploy HTTP code with `supabase functions deploy newsboard-crawl --project-ref aknclkofrjliaecsjbnp --use-api --no-verify-jwt`. The function authenticates the existing private x-newsboard-token; do not enable gateway JWT verification on this Cron endpoint.
- Browser code deploys by pushing main; the next existing Supabase scheduled dispatch checks out main. Manual `workflow_dispatch` still respects freshness/leases.

Reference: [PostgreSQL exception subtransactions](https://www.postgresql.org/docs/current/plpgsql-control-structures.html#PLPGSQL-ERROR-TRAPPING). Supabase changelog checked September 23; no applicable breaking database/Edge change.

## Storage and retention

At the nominal cadence, two HTTP publishers ×288 =576 runs/day; six browser publishers ×(1440/7) ≈1,234 runs/day, or ~1,810 ranked runs and up to 18,100 items/day. Browser startup/collection/queue time reduces actual frequency; seven minutes is a freshness threshold, not a guaranteed observation interval. Partial lists reduce item totals. Initial full baseline produces ten entries; later events depend on actual editorial change. A worst-case full replacement produces 20 entry/exit events per complete transition (~36,000/day at the nominal upper rate), while an unchanged list produces zero. Retain raw ranked observations 30–90 days eventually, with longer derived events/memberships; implement retention separately. Nothing is deleted here.

## Rollback

Revert the crawler commit and redeploy the previous HTTP function with the same private authentication flag. Keep additive columns/data. Browser uses the reverted main on its next existing dispatch; do not restore GitHub cron or delete snapshots. To revert database behavior, restore the previous save_source and story_raw_batches definitions via a new reviewed forward migration; avoid dropping tables or resetting ABC history.

## Live results

Verified September 23, 2026, UTC. Implementation commits: `fc6cf7d4`, `2bb3deed` (HTTP parse reuse), `a39ddf71` (editorial filter refinement/manual backup preservation).

Supabase migration applied as `20260923143201`. HTTP function deployed with gateway JWT disabled, retaining its token check. All three production Cron jobs remain active with unchanged schedules. The first live HTTP probe saved ABC/CBS but exhausted Edge compute due to redundant parsing. That run was explicitly marked failed; after sharing the parsed tree and returning immediately for out-of-scope publishers, the next probe returned HTTP 200, with all six HTTP CPs successful in 2.350 seconds. The normal 14:40 Cron run also completed. No unresolved resource-limit failure is being counted as success.

[Controlled GitHub browser run 35875549743](https://github.com/mattwilhalme/newsboard/actions/runs/35875549743) completed successfully. Supabase crawl `099c93ac-c161-437a-889b-438958326d45` ran 14:37:57.397–14:39:32.153: six attempted, six CP successes, zero failures. Its HTML/JSON artifacts were downloaded and checked against each adapter's module/visual order. Local same-page screenshots supported the NBC/CNN mismatch investigation; captured HTML supplied the broader ranked hierarchy. Screenshots can contain consent/advert overlays, so they are not by themselves proof of all ten positions.

| Publisher | Method | Items / unique | #1 matches CP | Persisted observation UTC | Top 10 run ID | Result |
|---|---|---:|---|---|---|---|
| ABC | HTTP | 10 / 10 | Yes | 14:45:01.594 | 75f24392-596a-4f09-91c1-412d9c3f6b44 | PASS |
| CBS | HTTP | 10 / 10 | Yes | 14:45:02.022 | 23bfc10d-7478-4f60-b028-f6d5e142c620 | PASS |
| NBC | Mobile | 10 / 10 | Yes | 14:46:42.350 | cabd63d0-88a1-420e-9167-f395dffe160a | PASS |
| CNN | Browser | 10 / 10 | Yes | 14:46:36.413 | 9564ab3a-3b5f-4efd-8375-61517c45a690 | PASS |
| AP | Mobile | 10 / 10 | Yes | 14:46:31.752 | a97039f1-38fa-41c7-8034-22f3f19727f8 | PASS |
| USA Today | Mobile | 10 / 10 | Yes | 14:46:53.972 | 74e36a11-d1ef-4b52-a0b6-dea5e5dc63e9 | PASS |
| Yahoo | Mobile | 6 / 6 | Yes | 14:46:59.384 | e0a62b80-8839-4a4a-a696-56562f99fefb | PARTIAL: editorial carousel only |
| Guardian | Mobile | 9 / 9 | Yes | 14:46:45.965 | c8a775e6-25a6-47b2-b799-f42841d9dd56 | PARTIAL: News container only |

These eight snapshots contain 75 persisted items. Partial is deliberately not PASS. Yahoo and Guardian remain useful raw ranked observations but are withheld from full-list events/Story Identity. USA Today's initial overbroad shopping filter was caught in the archived-HTML review and corrected, also retaining promoted editorial photos/videos. A new local live run and the final automatic production run confirmed the corrected ten-story hierarchy and CP agreement.

Fifty ENTERED_TOP10 baseline events were created (ten each for CBS/AP/CNN/NBC/USA). Repeated unchanged ABC/CBS observations generated no additional events. The rollback-only SQL test proved #8→#3 MOVED, one entry, one exit and same-URL TITLE_UPDATED, with no events from partial/warning/failed lists. It also exercised an actual Story worker lease rejection and verified Top 10/CP still existed. No synthetic tests were retained in production.

The existing Story worker returned HTTP 200, processed 16 batches, and reported no remaining batch backlog for its window. New complete batches from ABC/CBS/AP/CNN/NBC/USA reached its existing ledger. A legitimate new cross-publisher pickup was observed:

- Story `9a399c34-fba6-4853-8407-aea26ec8bc8f`: DOJ's defense of the White House press ban and access as a privilege.
- First detected: ABC, September 23 11:20:02.923, #3. It remained #3 in this window.
- New pickup: NBC, September 23 14:39:08.847, #6. Its headline describes the same DOJ defense; same-story score 0.8916, above the existing 0.75 threshold, corroborated by distinctive phrases and URL terms.
- No rank progression was invented: this window establishes ABC #3 → NBC #6 across publishers, not a within-publisher climb. Broader related stories were not manually merged.

### Performance and remaining limits

Production browser ranking overhead for the first run: AP806ms, CNN24ms, NBC13ms, Guardian3ms, USA1199ms, Yahoo57ms; total 2.102s within a 94.757s collection run (~2.2%). This measures the added extraction work directly, not a controlled before/after total. Earlier 22 browser runs averaged 50.257s (range 16.664–113.161s); homepage/network variability prevents attributing that total difference to ranking. HTTP ranking after parse reuse: ABC37–56ms, CBS6–9ms. Earlier 28 general runs averaged 2.167s; the verified new manual run took 2.350s. No extra homepage loads.

Publisher markup can change, and responsive package order is an approximation of editorial priority. Yahoo's limited editorial carousel and Guardian's nine-card News container are the principal coverage gaps. Next: validate another clearly editorial module for those publishers before admitting fuller lists, and eventually support partial-presence observations without deriving exits. Do not weaken quality gates merely to reach ten. NPR/BBC/Fox/LA Times could reuse their HTTP documents later but were left outside scope.

Security advisor check after migration showed only the same five informational, intentionally private RLS-without-policy tables as before; no new security findings. No credentials or scheduling internals were added to the public dashboard.


### Changed files

- `supabase/functions/_shared/top10.js`: shared URL identity, deduplication, sequential ranking, quality/diagnostics.
- `supabase/functions/newsboard-crawl/top10-http.js`: ABC/CBS editorial adapters.
- `supabase/functions/newsboard-crawl/collectors.js`: one parsed HTTP tree for CP/ranks; ABC live-article lead fix; extraction timing.
- `lib/top10Browser.js`: six rendered-page ranking adapters and debug screenshots.
- `lib/mobileHero.js`: NBC lead package spelling support.
- `server.js`: ranked outputs from existing page; CNN lead-order correction; same-render ABC/CBS manual backup ranking.
- `scripts/crawl/github-browser-gap-fill.mjs` and `github-backup.mjs`: forward ranked output to the existing persistence RPC, with no second ABC fetch.
- `scripts/crawl/validate-top10.mjs`: read-only live validation command.
- `scripts/crawl/top10.test.mjs` and `top10-browser.test.mjs`: normalization, scope, ordering, partial lists, mismatch, failure and rendered fixtures.
- `supabase/migrations/20260923143201_multi_publisher_top10.sql`: quality fields, isolated writes/events, existing Story input view integration.
- `supabase/tests/multi_publisher_top10.sql`: rollback-only database integration tests.
- This operational/validation report.

Final complete regression command `PLAYWRIGHT_BROWSER_CHANNEL=chrome node --test scripts/crawl/*.test.mjs scripts/story/*.test.mjs` passed **72/72** tests. The SQL integration test also passed after the live crawl released its lease; an attempted test during an active crawl correctly hit the existing one-active-crawl constraint and rolled back without touching production data.

### Final automatic run and subsequent events

[Scheduled GitHub run 35876596899](https://github.com/mattwilhalme/newsboard/actions/runs/35876596899) ran commit `a39ddf71` and completed successfully. Supabase attempt `f86fb213-b204-45d0-ac0e-8564b8ff9599`: due 14:45:58.155, dispatched 14:46:00.508, runner start 14:46:07, crawler start 14:46:17.587, completion 14:47:00.330. Crawl `43c65def-875b-4c16-85ee-30eda344495d` completed six of six publishers in 42.743s. The 14:47 tick saw `dispatch_active`, creating no duplicate. Supabase success is backed by persisted publisher observations, not merely GitHub API acceptance.

Added ranking time on this final run totaled 901ms (AP228, CNN29, NBC98, Guardian3, USA293, Yahoo250), about 2.1% of collection time, without extra renders. All six matched CP; all URLs were unique. The table above uses this final browser run and the latest completed HTTP observations at validation time.

By 14:47 UTC, the validation window had 55 ENTERED_TOP10,5 EXITED_TOP10,1 MOVED and2 TITLE_UPDATED events. The two real title changes were CNN and NBC. USA's extra 5 entries,5 exits and one movement came from the reviewed adapter correction between the two runs, not evidence of a publisher editorial promotion. ABC/CBS unchanged snapshots produced no spurious churn; Yahoo/Guardian partial lists produced no events.

HTTP function version 7 is active; an unauthenticated request returned 401. The existing Story worker and browser dispatch function were not redeployed or modified.

Final database check (14:49 UTC): the 14:35–14:48 validation window contains **20 Top 10 runs and 190 item rows**; the latest eight-publisher set contains 75 items. A second explicit existing Story worker invocation processed the four new complete browser batches (AP/CNN/NBC/USA), returned HTTP 200, and reported no remaining batches in its window. At 14:49 the unchanged browser scheduler returned `fresh`, with no new dispatch.
