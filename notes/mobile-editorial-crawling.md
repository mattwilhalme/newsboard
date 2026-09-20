# Mobile editorial centerpiece crawling

Implemented September 20, 2026. Only AP, USA Today, NBC, Yahoo and Guardian change editorial selection. CNN keeps its existing browser implementation; all other publishers and ABC Top 10 remain unchanged.

## Existing implementation and routing

AP previously used rendered desktop StandardE lead scoring (HTTP received 403). USA Today used desktop hero/live-story scoring, with an optional HTTP image lookup. Guardian used rendered post-header geometry with extra live-story weights. Yahoo used a mobile-sized viewport and Safari UA, but lacked full mobile/touch emulation and used broad link scoring/structured fallback. NBC's scheduled path was HTTP; its browser backup combined viewport/DOM scoring and structured-data fallbacks.

All five now use the canonical homepage in a rendered Android/Chrome mobile context: 390 × 844 viewport, mobile enabled, touch enabled. Normal redirects are followed (Guardian redirects to `/us`). No security bypasses, invented mobile domains, HTTP headline fallback, or structured-data lead selection are used. Ordinary close buttons may dismiss Guardian's privacy notice and USA Today's special-offer overlay.

## Publisher-specific selection and fallbacks

| Publisher | Primary mobile logic | Fallback within the same editorial module |
| --- | --- | --- |
| AP | First visible `main .PageListStandardE`, then `.PageListStandardE-leadPromo-info .PagePromo-title a` | Lead-promo title or `h2.PagePromo-title` in that first module; excludes trending/navigation |
| USA Today | `main a.gnt_m_hm[data-t-l*="hero"]`, the dedicated mobile hero | Hero-marked Top Table link, then legacy `.gnt_m_he`; never the live ticker or a random story link |
| NBC | First rendered storyline package, then `.storyline__headline` / `.multistoryline__headline` link | Semantic headline test IDs, then `h1`/`h2` article link inside that same package; excludes marquee and watch-only links |
| Yahoo | `#top-stories` carousel's first editorial slide and `elm:hdln` link | Visible headline with `cpos:1` in Top stories; ignores hidden/offscreen slides and personalized Stories for you |
| Guardian | First news card in `main #container-news > ul > li`; `.card-headline .headline-text` matched to overlay link's `aria-label` | `.card-headline` with the same link-label match; excludes pre-masthead promotions and smaller sublinks |

Rendered position chooses the first module and first headline within that module. Shared validation rejects hidden/offscreen elements, foreign or non-article URLs, empty/utility headlines, and unstable selections. A second read confirms that the headline and URL remain stable. Missing/uninterpretable modules fail cleanly; there is no fallback to a lower unrelated module. NBC and USA Today's breaking-banner metadata is preserved separately and cannot become the centerpiece.

## Live individual tests

Each adapter ran individually twice from the local Chrome environment. All five canonical homepages returned HTTP 200 and the same lead across both runs. The table below records the final run around 15:05–15:07 UTC, September 20. Screenshots were manually compared with the selected headlines: AP's top image/headline, USA Today's mobile hero above the smaller list, NBC's first storyline (not its embedded video), Yahoo slide 1 of 8, and Guardian's first News card below the promotional strip.

| Publisher | Mobile page loaded | Selected headline | Selected URL | Crawl method | Result |
| --- | --- | --- | --- | --- | --- |
| AP | HTTP 200 | Trump used to slam China. Here’s why he’s now rolling out the red carpet for Xi | [Article](https://apnews.com/article/trump-xi-china-relationship-ai-tariffs-iran-2716ee31afa579e9ca18ae76cbe35ab9) | browser (mobile) | PASS; visual lead matches |
| USA Today | HTTP 200 | Trump says triumphal arch will also serve as 'military complex' with snipers | [Article](https://usatoday.com/story/news/politics/2026/09/20/donald-trump-arch-military-complex/91859453007) | browser (mobile) | PASS; visual lead matches |
| NBC News | HTTP 200 | Sen. John Barrasso claims Trump isn’t violating the Constitution by banning reporters | [Article](https://nbcnews.com/politics/white-house/john-barrasso-says-trump-isnt-violating-constitution-banning-reporters-rcna598785) | browser (mobile) | PASS; visual lead matches |
| Yahoo News | HTTP 200 | North Korea launches 2 missiles within hours of each other as tensions rise | [Article](https://yahoo.com/news/articles/north-korea-fires-missile-off-061756384.html) | browser (mobile) | PASS; visual lead matches |
| The Guardian | HTTP 200 | As White House shields the AI gold rush, Trump family and other allies strike it rich – with few guardrails | [Article](https://theguardian.com/us-news/2026/sep/20/trump-ai-policy-financial-interest) | browser (mobile) | PASS; visual lead matches |

No publisher remained uninterpretable in local live validation. Publisher markup, advertisements, transient access failures, and regional editions can change; successful extraction is not a guarantee against future changes. AP has previously failed transiently in GitHub. Any such failure remains a recorded failure and preserves known-good current state.

Raw local evidence is in ignored `archive/mobile-validation.json` and its referenced timestamped HTML/JSON/PNG files. Screenshot capture is optional and cannot turn an otherwise successful crawl into a failure. Re-run all five or one source with:

```sh
PLAYWRIGHT_BROWSER_CHANNEL=chrome PW_TEST_SCREENSHOT_NO_FONTS_READY=1 node scripts/crawl/validate-mobile.mjs
PLAYWRIGHT_BROWSER_CHANNEL=chrome PW_TEST_SCREENSHOT_NO_FONTS_READY=1 node scripts/crawl/validate-mobile.mjs nbc1
```

## Persistence and scheduling

The five-minute Supabase Cron and Edge function remain unchanged. The deployed system already uses GitHub for rendered browser collection; there is no browser runtime connected to the Edge function. These five mobile adapters run through that existing scheduled browser worker, plus the full manual backup, using exactly the same `newsboard_start_run`, `newsboard_save_source`, and `newsboard_finish_run` RPCs and existing tables. This does not make mobile execution part of the Edge invocation itself. Doing that would require a remote browser/worker integration and is outside this narrow change.

Data-only migration `20260920150543_mobile_editorial_browser_sources.sql` sets these five sources to `browser` in `crawler_publishers`. NBC joins the existing browser gap-fill runner, preventing its previous Edge HTTP adapter from overwriting mobile editorial selection. There are now six HTTP sources and six browser sources, including unchanged CNN. GitHub's existing `*/7` schedule and manual backup are unchanged. No generated-data files are committed.

Successful results use `collection_method = browser` in `crawler_source_runs`, update `crawler_current`, and append `crawler_snapshots` through the existing atomic save RPC. Failed collections retain prior good state. Existing Top 10, history and frontend processing are unchanged. Mobile viewport/selector/page URL diagnostics are recorded in archive JSON without adding a schema field.

The unchanged Edge function continues logging browser-required outcomes for browser-configured sources. Those are routing notices recorded as failures, not attempted mobile HTTP requests; they can make `v_crawler_health.last_attempt_success` false after a browser success. A future focused change could distinguish delegated sources from actual collection failures. No monitoring redesign is included here.

## Verification and changed files

15 automated checks passed: eight rendered selector/mobile-context tests, three runner/lease/freshness tests, and four existing HTTP/Top 10 checks. Tests include NBC fallback, deceptive tickers, hidden/offscreen carousel slides, first-module failure, and foreign URLs.

- `lib/mobileHero.js`: explicit publisher adapters, mobile profile and rendered extraction/validation.
- `server.js`: five adapter wrappers, shared mobile invocation/diagnostics, local refresh routing.
- `scripts/crawl/github-browser-gap-fill.mjs`: adds NBC to the existing browser runner.
- `scripts/crawl/{mobile-hero.test.mjs,github-browser-gap-fill.test.mjs,validate-mobile.mjs}`: regression coverage and live validation command.
- `supabase/migrations/20260920150543_mobile_editorial_browser_sources.sql`: browser routing configuration only.
- `supabase/README.md`, `notes/{browser-gap-fill,crawler-migration,mobile-editorial-crawling}.md`: current routing and evidence.

## Deployed verification

Code was pushed to `main` in commit `8b623d7f`; the routing migration was applied to the existing Supabase project. The first workflow correctly skipped NBC while its prior HTTP success was still fresh. Final workflow https://github.com/mattwilhalme/newsboard/actions/runs/35518731863 completed collection with six attempted, six succeeded, zero failed (the five requested mobile publishers plus unchanged CNN).

Supabase run `28e0027e-c995-4f73-9834-da8a106b6f8a` recorded every source as `browser`, HTTP 200. Database queries confirmed a successful `crawler_source_runs` row, matching `crawler_current.run_id`, and a `crawler_snapshots` row for all six. All five mobile headlines matched the locally reviewed results above. The `newsboard-crawl` cron was verified active at `*/5 * * * *`. Workflow definitions, Edge function code, frontend/generated data, and ABC Top 10 were unchanged.
