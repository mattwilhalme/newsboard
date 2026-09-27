# Newsboard cleanup pass 2 — ChatGPT handoff

Copy/paste the section below into ChatGPT when continuing architecture or product planning.

---

We completed a second conservative cleanup pass on `mattwilhalme/newsboard` after the experimental GDELT Coverage implementation.

## Current repository state

- The local `main` branch started this pass two commits ahead of `origin/main`:
  - `f053639d` — Add experimental GDELT coverage tracing
  - `bcc7fa27` — Complete conservative repository cleanup pass
- Those commits were intentionally not pushed because pushing directly to the default branch had not been explicitly authorized.
- Pass 2 changes may still be uncommitted; inspect `git status`, run `npm run verify`, and review the diff before committing or pushing.

## Findings and decisions

1. The production database remains authoritative for operational crawler routing, due/lease state, browser dispatch, and persistence. We did not move those responsibilities into source code.
2. The app has 12 canonical publisher IDs: `abc1`, `cbs1`, `usat1`, `nbc1`, `cnn1`, `guardian1`, `ap1`, `latimes1`, `npr1`, `bbc1`, `fox1`, and `yahoo1`.
3. We added `lib/publisherRegistry.js` as a behavior-neutral metadata catalog (display name, homepage, primary collection method, fallback capability, Top 10 support, Story Intelligence eligibility). Production adapters still own their selectors and runtime behavior.
4. We added parity tests so drift among the server registry, Supabase Edge HTTP publishers, mobile/browser adapters, browser gap-fill collectors, and frontend source list fails locally.
5. We added small, sanitized publisher centerpiece fixtures under `test/fixtures/publishers/`. They contain only the DOM contract needed for parser testing—no copied full pages, scripts, images, or tracking content. The six HTTP-primary fixtures exercise the real Supabase Edge parser.
6. We made the first low-risk frontend extraction: formatting, URL normalization, error summarization, and HTML escaping now live in `docs/js/format.js`. The existing single-page UI consumes the same functions as a classic browser global, avoiding a broad module conversion.
7. We added focused unit coverage for those extracted helpers.
8. We added a local GitHub Actions contract validator. It checks required workflow structure, read-only contents permission, absence of repository pushes/write permission, pinned action references, and the expected crawler entry points. This is intentionally a focused contract check, not a complete YAML/schema validator.
9. No schema migration, Supabase deployment, crawler routing change, persistence change, or production configuration mutation was made in Pass 2.

## Architecture snapshot

- HTTP-primary centerpiece collection: ABC, CBS, LA Times, NPR, BBC, Fox.
- Browser-primary/mobile centerpiece collection: AP, USA Today, NBC, Guardian, Yahoo; CNN uses browser collection.
- Browser fallback remains available across the configured publisher set through database routing.
- Top 10 browser adapters exist for AP, USA Today, NBC, CNN, Guardian, and Yahoo. ABC/CBS use HTTP Top 10 extraction. Guardian/Yahoo may return partial lists; LA Times/NPR/BBC/Fox remain centerpiece-only.
- GDELT Coverage remains an on-demand proof of concept with no GDELT persistence or changes to story identity.

## Recommended next work

1. Review Pass 2's diff and `npm run verify` output, then commit it separately from the GDELT feature.
2. Add browser rendering tests that consume the sanitized AP/USA Today/NBC/CNN/Guardian/Yahoo fixtures directly. Existing browser adapter tests already cover those paths, but consolidating them onto the shared fixture corpus would reduce duplication.
3. Continue splitting `docs/index.html` by extracting one cohesive, pure domain at a time (view rendering or story matching), preserving the existing UI and running the full Playwright suite after each extraction.
4. Consider generating or validating the frontend publisher ID list from the metadata registry during the build/test process. Do not make the static GitHub Pages UI depend on a runtime server import.
5. Keep production Supabase routing database-driven and add migrations only for deliberate operational changes.

## Verification command

Run:

```bash
npm run verify
```

The expected scope is workflow contract checks, unit/parser/parity tests, existing browser UI tests, and the GDELT UI smoke test.

---
