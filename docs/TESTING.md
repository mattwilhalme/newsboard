# Testing guide and roadmap

## Current automated coverage

`npm run verify` is the safe top-level regression command. It combines:

- HTTP collector rejection and URL normalization;
- Top 10 validation, deduplication, centerpiece/rank quality, and failure behavior;
- browser dispatcher authentication, atomic dispatch, retry, and response handling;
- targeted browser worker selection/persistence behavior;
- deterministic Story Identity matching and ambiguity rejection;
- first-load live-data retry, stale-cache avoidance, last-session retention, publisher isolation, and fallback-state rendering;
- rendered mobile centerpiece and browser Top 10 extraction fixtures;
- GDELT normalization/matching and drawer UI behavior.

Publisher-specific live commands (`test:bbc`, `test:fox`, and `test:yahoo`) remain available but depend on current external pages and are not deterministic enough for the default suite. `scripts/crawl/validate-*.mjs`, deployed UI smoke scripts, and Supabase SQL tests are also intentionally separate.

## SQL integration coverage

`supabase/tests/` contains rollback-oriented suites for crawler safety, combined attempt state, browser dispatch scheduling, multi-publisher Top 10 persistence, and Story Intelligence. They cover invariants that cannot be proven by JavaScript mocks alone, including last-good retention, partial runs, leases, RLS, replay/idempotency, rank events, and raw/derived failure isolation.

Run these only against an explicitly selected test or controlled project and preserve their transaction/rollback wrappers. They are not part of `npm run verify` because an accidental production connection would be unsafe.

## Important gaps

1. Several HTTP publishers rely on live markup without small checked-in parser fixtures.
2. Browser fixtures cover selectors but not a sanitized representative DOM for every publisher.
3. The database routing registry and code adapter registries have no automatic parity/capability check.
4. Frontend views beyond first-load and targeted drawers lack focused DOM fixtures.
5. Workflow YAML is syntax-checked during cleanup but has no local schema/action-contract test.
6. Long-retention Story Intelligence candidate saturation and reconstruction performance are not benchmarked.
7. External GDELT latency/rate-limit behavior prevents deterministic live-result assertions.

## Fixture roadmap

Add minimal sanitized HTML under a future `test/fixtures/publishers/<source-id>/` hierarchy. Each fixture should contain only the DOM and embedded metadata required by its adapter—headings, links, ordering containers, visibility attributes, and deliberate distractors. Do not check in full downloaded publisher pages.

For every publisher, cover:

- a valid centerpiece;
- blocked/interstitial and empty pages;
- invalid utility, navigation, sponsored, and off-domain candidates;
- a headline rewrite on the same canonical URL;
- a URL/story replacement;
- complete versus partial ranked output where supported;
- rank movement without false entry/exit events;
- fallback transition from primary failure to browser success and to definitive dual failure.

Prioritize AP/USA Today/NBC/Guardian/Yahoo browser fixtures, followed by the six HTTP-primary sources and CNN. Once fixtures exist, migrate the live publisher scripts to diagnostic-only status and keep the default suite fully offline and deterministic.
