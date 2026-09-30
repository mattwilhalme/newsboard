# AP collection investigation — September 30, 2026

## Finding

The AP selectors still work. The scheduled GitHub browser is receiving a
Cloudflare managed interstitial (HTTP 403, title `Just a moment...`) instead of
the homepage. Last production success at the initial check was September 28,
21:01:00 UTC (2:01 p.m. Pacific). Nine actual browser attempts since that success
were blocked. The per-publisher blocked backoff reached eight hours.

The health counters also count five-minute Edge routing notices as failed
browser collections. `newsboard-crawl/index.ts` throws for configured browser
publishers without opening a browser. These notices overwrite the latest error
with `Rendered mobile homepage is authoritative; collected by existing browser
worker`. They do not mean AP was fetched hundreds of times. Fixing that reporting
is separate from making AP accessible.

## Verified results

| Collection path | Result | Evidence |
| --- | --- | --- |
| Local stock Chrome, existing mobile adapter | HTTP 200, exact lead and ten ranked items | `archive/ap1_mobile_2026-09-30T16-05-50-496Z.json` |
| Local stock Chrome, bounded-readiness adapter | HTTP 200, exact lead and ten ranked items | `archive/ap1_mobile_2026-09-30T16-15-18-757Z.json` |
| Production GitHub Ubuntu browser | HTTP 403, managed interstitial | [Run 36716908972](https://github.com/mattwilhalme/newsboard/actions/runs/36716908972) |
| GitHub Ubuntu with ten-second ordinary rendering wait | Still HTTP 403; no homepage module | [Read-only run 36742755489](https://github.com/mattwilhalme/newsboard/actions/runs/36742755489) |
| GitHub macOS with the same adapter and wait | Still HTTP 403; no homepage module | [Read-only run 36743059899](https://github.com/mattwilhalme/newsboard/actions/runs/36743059899) |
| Direct HTTP homepage, `index.rss`, historical hub RSS URL, sitemap | HTTP 403 | Live requests on September 30 |
| Open RSS AP feed | HTTP 200, valid RSS, stale | `https://openrss.org/feed/apnews.com`, last build September 26, 21:40:08 UTC |
| Google News AP search RSS | HTTP 200, valid RSS, 100 items | Last build September 30, 16:18:05 UTC; current AP headlines |

The local lead in both tests was the AP story about the emergency landing of a
flight carrying Israelis. Existing mobile selectors chose the primary StandardE
lead and Top 10 rank one agreed with it.

## Changes prepared

`lib/apHomepage.js` allows one bounded ordinary rendering interval when AP
returns an interstitial, tracks main-document responses separately from ad and
iframe responses, and requires a served homepage and visible editorial module.
Persistent interstitials remain blocked, including interstitials returned with
HTTP 200. It does not click challenges, solve CAPTCHAs, use stealth settings,
reuse clearance tokens, or repeatedly retry denials. The cloud tests establish
that this hardening alone does **not** restore scheduled AP collection.

The existing browser workflow has an optional `validate_ap` input. It skips the
database collector and runs only AP's diagnostic collector. `validation_runner`
selects Ubuntu or macOS for this diagnostic mode. Regular production dispatches
still use Ubuntu. The diagnostic mode has a separate concurrency group and uses
no Supabase credentials.

Validation: 66 unit tests, 27 targeted browser tests, workflow contract checks,
and two live local successful extractions. Both isolated cloud tests failed
cleanly and left production data unchanged. Changes are on `codex/ap-cloud-access`.

## Cloud ingestion options

1. **Exact homepage tracking:** retain AP's current last-good lead and Top 10
   until an approved cloud browser or AP-authorized access serves the homepage.
   Moving to GitHub macOS was tested and did not help. A new hosting provider is
   not proven to work merely because local Chrome works.
2. **Unranked AP discovery:** ingest the public Google News AP feed into a
   separate, explicitly labeled discovery stream. It can supply current AP
   headlines but its order is Google's, its article links are Google redirect
   URLs, and indexing time is not AP homepage observation time. Do not save these
   rows as AP centerpiece snapshots or complete Top 10 lists.
3. **Licensed AP content:** [AP Media API](https://api.ap.org/media/v/docs/Getting_Started_API.htm)
   supports continuous licensed content feeds using an `x-api-key` header and
   account entitlements. This needs existing AP credentials/licensing and a
   server-side adapter. The documented feed does not establish APNews homepage
   prominence; that would still be separate.

Google feed tested:
`https://news.google.com/rss/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen`.

The current story ledger permits only `hero` and `top10` coverage and requires
ranks 1–10. A discovery feed needs a distinct coverage scope and corresponding
event/UI behavior; feeding it into the current ranked ledger would invent AP
lead/rank observations. The user requires cloud-only exact homepage tracking
and has declined the unranked-discovery substitution. No local scheduled
collector was installed.
