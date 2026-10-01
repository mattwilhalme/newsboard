# Newsboard

Newsboard observes how major news publishers promote, rewrite, rank, and move stories across their homepages over time. The product records editorial decisions—not merely a list of scraped links—and distinguishes what Newsboard observed from what a publisher says it published.

## Production system

```text
Publisher homepage
  → Supabase HTTP/Edge crawl, or targeted GitHub/Playwright browser crawl
  → validated per-publisher observations in Supabase
  → Top 10/rank history and Story Identity processing
  → GitHub Pages frontend using public read-only RPCs
```

Supabase is the production system of record. A five-minute private Edge crawl handles publishers with validated HTTP adapters. Browser-authoritative publishers and failed HTTP attempts are queued independently for the targeted GitHub Actions gap-fill worker. Every publisher result is persisted independently, so one failure cannot erase or delay the last successful observation for another publisher. A separate Edge worker derives Story Identity and propagation events from successful observations.

The manual browser backup workflow remains available for recovery. `server.js`, `cache.json`, `archive/`, and the generated JSON builder support local development, diagnostics, and legacy tooling; they are not the production dashboard's source of current headlines. The frontend is the static [docs/index.html](docs/index.html) page and loads current data directly from Supabase.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for implementation detail and production invariants.

## Publisher capabilities

This matrix reflects the current collectors, browser ranking adapters, migrations, and verified routing notes. “Top 10” means a ranked list when the adapter passes its quality gates; it is not promised on every run.

| Publisher | Current top story | Top 10 | Primary production crawl | Browser fallback | Story Intelligence |
| --- | --- | --- | --- | --- | --- |
| ABC News | Yes | Yes | HTTP Edge | Yes | Yes |
| CBS News | Yes | Yes | HTTP Edge | Yes | Yes |
| USA Today | Yes | Yes | Mobile browser | Yes | Yes |
| NBC News | Yes | Yes | Mobile browser | Yes | Yes |
| CNN | Yes | Yes | Browser | Yes | Yes |
| The Guardian | Yes | Partial-capable | Mobile browser | Yes | Yes |
| AP via Google News | Latest discovery, not homepage lead | Unranked | Google News RSS / HTTP Edge | No | Excluded from homepage/rank intelligence |
| Los Angeles Times | Yes | No | HTTP Edge | Yes | Yes |
| NPR | Yes | No | HTTP Edge | Yes | Yes |
| BBC | Yes | No | HTTP Edge | Yes | Yes |
| Fox News | Yes | No | HTTP Edge | Yes | Yes |
| Yahoo News | Yes | Partial-capable | Mobile browser | Yes | Yes |

Browser fallback capability is configured for the eleven homepage publishers. AP uses a cloud-only Google News RSS search feed, with no browser fallback. Database routing remains authoritative if it differs from static code during an operational rollout.

AP via Google News (`apgoogle1`) is an unranked discovery source of AP articles indexed by Google. The card highlights the latest publication date returned by the feed, not AP's editorial lead or Google's importance ranking. The discovery drawer lists up to 100 deduplicated articles, latest published first; links remain Google News redirect links. Feed publication dates are separate from Newsboard's observation time. Invalid/empty/stale feeds preserve the last good data and report failure. Historical AP homepage data (`ap1`, Associated Press) is retained unchanged, but its active browser routing is retired. Discovery snapshots do not generate hero, Top 10, headline/rank events, or enter homepage-based Story Identity processing.

The AP card displays **Associated Press** with **via Google News** on a separate muted line. Discoveries reuse History's card typography/layout, showing 20 articles initially with a keyboard-accessible “Show all” toggle. AP crawl-status/error text is hidden only on the overview card; collection failures remain recorded and visible in Data. Overview timestamps stay on one line, with the metadata block moving intact when the header is too narrow.

## Data concepts

- **Observation time:** when a successful Newsboard collector saw a publisher state.
- **First detected time:** the earliest observation in available processed history for a story or publisher state; not proof of first publication.
- **Publication time:** publisher-provided metadata when available. It is nullable and never inferred from observation time.
- **Top-story promotion time:** the first observation at rank 1/homepage lead, subject to crawl cadence.
- **Headline rewrite:** a changed headline on the same observed article identity.
- **URL/story change:** a different canonical article URL in a tracked slot.
- **Rank movement:** the same canonical article moving between ranks in complete ranked coverage.
- **Story Identity:** a conservative derived grouping of cross-publisher observations. Raw observations remain authoritative and are never rewritten by the grouping process.

The Story Radar view surfaces recent multi-publisher identities by reach, active coverage, No. 1 appearances, rank movement, and headline rewrites. Its timing labels describe Newsboard observations rather than publication order.

Private Story Identity review tooling can label matcher quality, move a publisher article to an existing identity, or create a new manual identity. Corrections preserve raw evidence, rebuild derived public reads, and remain active for future observations of the same canonical publisher URL.

### Local Story Review console

The local console provides a drag-and-drop editor for the same private correction operations used by `scripts/story/audit.mjs`. First apply `supabase/migrations/20260930190000_story_review_console.sql` through the project's normal migration workflow (or paste that file into the Supabase SQL Editor and run it once). Then launch with server-side credentials:

```bash
SUPABASE_URL="https://YOUR_PROJECT.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" \
npm run story:review
```

Open `http://localhost:3001/docs/review.html`. The review API rejects non-loopback clients and keeps the service-role key in Node; never put that key in `docs/` or browser storage. Recent cards use Newsboard detection time unless a publisher supplied a real publication timestamp. Drag a detection onto a group to persistently reassign that publisher URL, or onto **Create a new group** to create an identity. Select a group to inspect its members/history or change its editorial label. The page refreshes after every edit and polls once a minute.

To combine two existing identities, drag the group that should disappear onto the group that should remain. The console confirms the direction before moving all historical assignments, preserving future URL routing, rebuilding the surviving group, and removing the source group.

After a merge, the oldest observed article headline becomes the surviving identity's canonical default title. A manually edited editorial label remains authoritative and is not overwritten.

Use the time-window selector and search box to narrow both columns. Clicking a recent detection selects it for the non-drag workflow; then select a group and click **Move into this group**, or click the new-group drop zone. A reassignment moves every stored observation of that publisher's canonical article URL and remains in force for future Story Intelligence batches. Press `Ctrl-C` in the launch terminal to stop the console.

The Recent Detections column is a singleton queue: it shows only articles whose current Story Identity has one publisher member, ordered by newest Newsboard detection. Multi-publisher identities remain available in the Story Groups column.

The Story Groups column displays only identities with two or more publisher members. Singleton identities stay in Recent Detections and Suggested Matches rather than appearing in both columns.

Manually named singleton identities appear separately under **Groups being built**. They remain visible as drop targets until a second publisher article is added, at which point they graduate into the normal Story Groups list.

Dragging a Recent Detection onto empty space in the Story Groups column immediately creates a building group using the current headline as its label. Dragging an article onto an existing group also applies immediately. These additive article moves do not require confirmation; multi-group merges and **Remove group** remain confirmed operations.

Selecting a multi-publisher group renders each publisher article as a draggable bubble. Drop a bubble on another Story Group to reassign that article, or on **No group** to create a fresh singleton identity and return it to Recent Detections. The latter is a UI concept; the database continues to assign every processed article to a story identity.

**Remove group** dissolves an invalid derived grouping into one singleton identity per publisher + canonical URL. It moves every historical occurrence of each URL, records an audit entry, and never deletes raw crawler evidence. Use Merge—not Remove—when two groups represent the same real story and should survive as one identity.

Above that queue, Suggested Matches compares recent cross-publisher singleton groups with the production deterministic matcher. Only pairs meeting the normal automatic-match threshold are shown. **Merge** uses the audited group-merge operation; **Skip** records the rejected pair privately so it does not reappear.

Matcher v2 adds event signatures (entities, actions, locations, and meaningful numbers), can use retained card descriptions/decks, and stores the complete evidence snapshot behind reviewed Merge/Skip decisions. Run `npm run story:evaluate` with the server-side Supabase environment variables to summarize labeled decisions by matcher version.

The scheduled Story Intelligence worker also maintains a persistent suggestion queue using up to eight recent representatives per singleton. Skips suppress only the current evidence hash: a material headline/deck change or matcher-version change can resurface the pair. Pending suggestions remain available while the local console is closed and include expandable component-level evidence.

GDELT Coverage is a separate on-demand experiment. Its “earliest match” is GDELT discovery evidence, not a first-publisher claim.

## Operational behavior

- The Edge crawler records each publisher independently and reports `success`, `partial`, or `failed` at run level.
- Invalid, empty, blocked, or failed results never replace `crawler_current`; the last successful observation remains visible with attempt health shown separately.
- HTTP failures and due browser-authoritative publishers create source-specific browser jobs. The private dispatcher invokes the targeted GitHub workflow with duplicate protection, leases, and per-source retry/backoff.
- A fresh frontend load uses Supabase RPCs, retries transient failures, and does not resurrect persisted dashboard snapshots or generated JSON as current news.
- The manual backup runs eleven homepage collectors plus the AP Google News HTTP feed and writes through the same Supabase persistence RPCs.

Operational history and rollback detail live in [notes/](notes/). Those reports are intentionally retained even when they describe earlier migration stages.

## Local development

Requirements: Node.js, npm, and Chrome/Chromium for browser-backed tests.

```bash
npm ci
npm start                 # Express/local diagnostic server on port 3001
npm run verify            # non-destructive unit and browser regression suite
```

Useful focused commands:

```bash
npm run test:unit
npm run test:ui
npm run test:gdelt
npm run test:gdelt-ui
npm run test:bbc
npm run test:fox
npm run test:yahoo
```

Live validation scripts under `scripts/crawl/validate-*.mjs`, production crawl commands, deployment commands, and SQL integration suites are intentionally excluded from `npm run verify` because they require network access, credentials, browser diagnostics, or a rollback-capable database session.

## Repository map

- `docs/` — production static frontend, public Supabase configuration, architecture/testing plans, and retained historical JSON.
- `supabase/functions/` — Edge crawler, browser dispatcher, Story Intelligence worker, and GDELT lookup.
- `supabase/migrations/` — incremental production schema/routing history.
- `supabase/tests/` — rollback-oriented SQL integration checks.
- `scripts/crawl/` — browser workers, validation tools, and crawler regression tests.
- `scripts/story/` — Story Intelligence processing, diagnostics, and tests.
- `lib/` — shared local/browser collection helpers.
- `notes/` — operational decisions, rollout evidence, limitations, and rollback guidance.

Secrets belong only in server-side environment variables, Supabase Vault, or GitHub Actions secrets. `docs/supabase.json` contains the public client configuration; never place a service-role credential in `docs/`.
