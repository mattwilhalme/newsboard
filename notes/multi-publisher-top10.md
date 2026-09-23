# Multi-publisher Top 10

The existing HTTP and browser crawlers now return both CP and ranked stories from the same document. No new schedule, homepage request or browser context. Existing five-minute HTTP Cron, one-minute browser due checks (420-second observation freshness threshold), leases and manual backup remain. Browser execution stays in GitHub Actions. No Intelligence UI or frontend changes.

## Publisher strategy

| Publisher | Production method | Ranking scope/order |
|---|---|---|
| ABC (`abc1`) | HTTP | `main` Prism editorial cards, in document order; actual story/wireStory/live-updates URLs only; TV player excluded |
| CBS (`cbs1`) | HTTP | Latest News editorial cards, then More Top Stories, using article headings |
| NBC (`nbc1`) | Pixel 7 mobile | Visible storyline/package headings and related editorial headlines in vertical then horizontal order |
| CNN (`cnn1`) | Existing 820×1000 browser | Visible editorial container headlines in visual order; trending ribbon, paid/recommended modules and navigation excluded |
| AP (`ap1`) | Pixel 7 mobile | Main editorial PagePromo headlines in visual order, excluding trending carousel |
| USA Today (`usat1`) | Pixel 7 mobile | Hero then mobile editorial list anchors, excluding horoscope, puzzles and shopping utilities |
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

At the nominal cadence, two HTTP publishers ×288 =576 runs/day; six browser publishers ×(1440/7) ≈1,234 runs/day, or ~1,810 ranked runs and up to18,100 items/day. Browser startup/collection/queue time reduces actual frequency; seven minutes is a freshness threshold, not a guaranteed observation interval. Partial lists reduce item totals. Initial full baseline produces ten entries; later events depend on actual editorial change. A worst-case full replacement produces20 entry/exit events per complete transition (~36,000/day at the nominal upper rate), while an unchanged list produces zero. Retain raw ranked observations 30–90 days eventually, with longer derived events/memberships; implement retention separately. Nothing is deleted here.

## Rollback

Revert the crawler commit and redeploy the previous HTTP function with the same private authentication flag. Keep additive columns/data. Browser uses the reverted main on its next existing dispatch; do not restore GitHub cron or delete snapshots. To revert database behavior, restore the previous save_source and story_raw_batches definitions via a new reviewed forward migration; avoid dropping tables or resetting ABC history.

## Live results

Pending final deployed observation checks below.
