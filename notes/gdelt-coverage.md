# GDELT Coverage proof of concept

## Scope

This experiment adds an on-demand `Trace coverage` action to each Newsboard story. It does not persist GDELT data, change story identity, merge stories, or infer an original publisher.

## API and matching

- Endpoint: GDELT DOC 2.0 `https://api.gdeltproject.org/api/v2/doc/doc`
- Mode: `artlist`, JSON output, chronological order, up to 100 raw candidates.
- Window: 24 hours before through 6 hours after Newsboard's first observation.
- Language: `sourcelang:english`.
- Filtering: normalized headline token overlap, a transparent score, canonical URL deduplication, and a maximum of 20 displayed matches.
- Cache: in-memory 15-minute TTL in both the local Express endpoint and Supabase Edge Function. This is intentionally ephemeral.

The UI labels the final value **Earliest GDELT match**, which means the earliest matching `seendate` returned by GDELT. It is not a claim about first publication or story origin.

## Real Newsboard test case

Story captured in `docs/data/current.json`:

- Publisher: CBS News
- Newsboard observed: `2026-09-19T14:45:43.737Z`
- Headline: `CNN, MS NOW and Politico staffers barred from White House after Trump ban`
- Generated query: `"MS NOW" "White House" politico staffers sourcelang:english`
- Search window: `2026-09-18T14:45:43Z` through `2026-09-19T20:45:43Z`

## Validation status

- Fixture raw results: 3
- Fixture results after filtering/deduplication: 1
- Fixture earliest match: `cnn.com` at `2026-09-26T16:00:00.000Z`
- Real GDELT raw results: pending a successful live response
- Real filtered count: pending
- Real earliest match: pending

The first live request exceeded the production-style 8-second timeout. Diagnostic requests on September 26 and 27 returned HTTP 429, and the deployed Edge Function returned its expected HTTP 504 response when GDELT exceeded the eight-second budget. This validates the timeout and rate-limit error paths but prevented recording credible live counts. Do not tune the query or match threshold without a successful upstream response.

## Deployment and UI verification

- Deployed `gdelt-coverage` to Supabase project `aknclkofrjliaecsjbnp` on September 27, 2026.
- Confirmed the deployed function accepts the existing Newsboard publishable/anonymous client credential, returns wildcard CORS headers, and returns HTTP 400 for missing required input.
- Confirmed the full deployed request path returns a structured HTTP 504 response when GDELT times out.
- Added a headless-browser smoke test that opens the drawer and verifies chronological result links, the tracked-publisher badge, current-article badge, earliest-match footer, and absence of page errors.
- `npm run test:gdelt` and `npm run test:gdelt-ui` pass.

## Known limitations

- GDELT `seendate` is discovery evidence, not verified publication time.
- Headline matching is deliberately lexical. Paraphrases with few shared terms may be missed, while closely worded unrelated follow-ups can still require threshold tuning.
- Entity extraction is capitalization-based and intentionally small; it is not a full named-entity model.
- In-memory caching is per runtime instance and can disappear on restart or edge eviction.
- Missing GDELT timestamps sort after timestamped results and are never selected as the earliest match.
- GDELT latency and public rate limits can make an on-demand request temporarily unavailable.

## Remaining field work

1. Retry the real story only after GDELT's upstream throttling clears and record raw count, filtered count, and earliest match above.
2. Adjust the lexical threshold/query budget only if a successful live response shows clear false positives or false negatives.
