# Testing guide and roadmap

## Current automated coverage

`npm run verify` is the safe top-level regression command. It combines:

- HTTP collector rejection and URL normalization;
- Top 10 validation, deduplication, centerpiece/rank quality, and failure behavior;
- browser dispatcher authentication, atomic dispatch, retry, and response handling;
- targeted browser worker selection/persistence behavior;
- deterministic Story Identity matching and ambiguity rejection;
- publisher-registry parity and sanitized centerpiece parser fixtures;
- frontend formatting, URL normalization, error summarization, and HTML escaping;
- frontend data-boundary caching/invalidation and operational-metadata preservation;
- deterministic Overview, Data, History, and Labs navigation/rendering;
- GitHub Actions read-only/action-entry-point contracts;
- first-load live-data retry, stale-cache avoidance, last-session retention, publisher isolation, and fallback-state rendering;
- rendered mobile centerpiece and browser Top 10 extraction fixtures;
- GDELT normalization/matching and drawer UI behavior.

Publisher-specific live commands (`test:bbc`, `test:fox`, and `test:yahoo`) remain available but depend on current external pages and are not deterministic enough for the default suite. `scripts/crawl/validate-*.mjs`, deployed UI smoke scripts, and Supabase SQL tests are also intentionally separate.

## SQL integration coverage

`supabase/tests/` contains rollback-oriented suites for crawler safety, combined attempt state, browser dispatch scheduling, multi-publisher Top 10 persistence, and Story Intelligence. They cover invariants that cannot be proven by JavaScript mocks alone, including last-good retention, partial runs, leases, RLS, replay/idempotency, rank events, and raw/derived failure isolation.

Run these only against an explicitly selected test or controlled project and preserve their transaction/rollback wrappers. They are not part of `npm run verify` because an accidental production connection would be unsafe.

## Important gaps

1. Browser adapters do not yet consume the shared sanitized publisher fixture corpus directly.
2. Blocked, invalid, rewrite, replacement, and rank-movement fixture variants are not complete for every publisher.
3. Frontend views beyond first-load and targeted drawers lack focused DOM fixtures.
4. Workflow validation is a focused action contract check, not a complete YAML/schema validator.
5. Long-retention Story Intelligence candidate saturation and reconstruction performance are not benchmarked.
6. External GDELT latency/rate-limit behavior prevents deterministic live-result assertions.

## Fixture roadmap

Minimal sanitized centerpiece HTML now lives under `test/fixtures/publishers/<source-id>/`. Each fixture contains only the DOM and embedded metadata required by its adapter—never full downloaded publisher pages. Extend this corpus with the cases below and migrate browser tests to consume it directly.

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
