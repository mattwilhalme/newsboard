# AP collection through Browserbase

Browserbase replaces only AP's browser runtime. The GitHub worker still owns
scheduling and uses the same database lease, publisher backoff, extraction,
lead confirmation, Top 10 validation, and last-good preservation. Other
publishers continue using their existing runtime. No database migration or
frontend change is needed.

## Credentials and rollout

Add `BROWSERBASE_API_KEY` to the repository's GitHub Actions secrets. Never put
the key in source, public configuration, workflow inputs, or chat. The API can
infer the project from the key; optional `BROWSERBASE_PROJECT_ID` selects one
explicitly. Optional `BROWSERBASE_CONTEXT_ID` reuses an existing Browserbase
context in its default browser profile and persists it when the session ends.
No new context is allocated automatically on each crawl.

Production remains on the existing runtime until the read-only validation
passes. Run against the integration branch first:

```sh
gh workflow run browser-gap-fill.yml --repo mattwilhalme/newsboard \
  --ref codex/ap-cloud-access -f validate_ap=true \
  -f validation_runner=ubuntu-latest -f validation_browser=browserbase
```

The test does not receive Supabase credentials and performs no database writes.
It uses the actual AP collector and requires a usable homepage lead, complete
ten-item ranking, and agreement between rank one and the lead. Inspect its HTML,
JSON, and screenshot artifacts and repeat a capture before enabling production.
An HTTP 200 challenge page is a blocked attempt, never a valid observation.

After validation and publishing the integration to the production branch:

```sh
gh variable set NEWSBOARD_AP_BROWSER_PROVIDER --body browserbase \
  --repo mattwilhalme/newsboard
```

Rollback changes only the provider variable:

```sh
gh variable set NEWSBOARD_AP_BROWSER_PROVIDER --body local \
  --repo mattwilhalme/newsboard
```

Here `local` means the existing browser launched on the GitHub cloud runner,
not collection scheduled on the user's Mac. Both scheduled gap-fill and manual
backup workflows use the same provider variable and server-side credentials.
When Browserbase is selected, missing credentials fail explicitly; there is no
silent fallback or duplicate attempt from a blocked provider.

## Browser and usage limits

The remote default context receives the same Android mobile profile, touch
support, 390 × 844 viewport, and device scale factor as the existing AP
collector. New incognito contexts are not created, so an optional provider
profile is not accidentally discarded. Provider metadata and session ID are
included in diagnostic archives; keys and connection URLs are not logged.

Each remote session has a three-minute timeout, no keep-alive, and an explicit
release request in cleanup, including connection and setup failures. API calls
and CDP connections are bounded, without automatic retry loops. Provider
authentication/quota/connection failures are `infrastructure_error`, not AP
`blocked` failures. A release failure logs a sanitized warning and the remote
timeout remains a usage bound.

Managed proxy usage is disabled by default. To explicitly trial Browserbase's
US-geolocated proxy, set repository variable `NEWSBOARD_AP_BROWSERBASE_PROXY`
to `true`; it can incur additional provider charges. Geolocation is best effort,
not a guarantee of a fixed US IP or identical editorial regional content. Set
the variable back to `false` to disable it. CAPTCHA solving and advanced stealth
are disabled. A denied page remains denied; this integration does not establish
that AP permits Browserbase access.

References: [session creation](https://docs.browserbase.com/reference/api/create-a-session),
[session release](https://docs.browserbase.com/reference/api/update-a-session),
[persistent contexts](https://docs.browserbase.com/platform/browser/core-features/contexts),
[proxies](https://docs.browserbase.com/platform/identity/proxies).
