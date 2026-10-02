# Frontend modularization plan

`docs/index.html` intentionally remains a single production artifact in Cleanup Pass 1. Its inline CSS and JavaScript are tightly coupled to global state, drawer behavior, RPC adapters, and direct DOM construction; bulk extraction would create unnecessary regression risk while crawler/loading behavior has only recently stabilized.

## Proposed vanilla-JS structure

```text
docs/
  css/
    tokens.css
    layout.css
    components.css
  js/
    config.js
    data/supabase.js
    data/normalization.js
    views/overview.js
    views/data.js
    views/history.js
    views/story-history.js
    views/labs.js
    ui/drawers.js
    ui/format.js
    app.js
```

No framework or bundler is required initially. Use native ES modules and preserve the static-hosting deployment.

## Extraction order

1. **Pure shared utilities (completed in Cleanup Pass 2):** escaping, time formatting, URL normalization, and error summarization now live in `docs/js/format.js` with direct unit coverage. It remains a classic static script to avoid converting the whole app to modules at once.
2. **Supabase/data access (completed in the frontend architecture pass):** `docs/js/data/supabase.js` now owns config loading, request timeouts, RPC calls, caching, invalidation, and transport error normalization. Application retry and retention policy remains inline by design.
3. **Drawer shell (completed):** `docs/js/ui/drawers.js` owns shared close, overlay, Escape, and focus-trap behavior. Deterministic browser coverage verifies Story History focus restoration.
4. **Story History and GDELT drawers (completed):** `docs/js/ui/intelligence-drawers.js` owns their independent fetch/render paths. Optional intelligence remains failure-isolated from raw headlines.
5. **Overview cards (completed):** `docs/js/views/overview-cards.js` now owns card construction, source ordering, health display, Story badges, coverage actions, and entrance behavior shared by Overview and clustered cards.
6. **History and Data views:** extract bounded history calculations and table rendering with fixture snapshots.
7. **Labs/clustering:** move the largest self-contained analysis block last; retain current storage keys and deterministic cluster tests.
8. **CSS by component:** only after markup modules are stable, split tokens/layout/components while comparing screenshots at desktop and narrow widths.

## Regression checks per step

- Inline/module scripts compile with no page errors.
- All twelve publisher cards render from a fixture snapshot.
- Current data comes from Supabase on first load; no `cache.json` or `docs/data` headline fallback occurs.
- A transient initial miss retries and recovers automatically.
- A failed refresh preserves only the current session's rendered state.
- Pending/running/final fallback states remain distinct.
- Top 10 counts, order, partial-quality handling, and events remain unchanged.
- Story badges/history and GDELT remain optional and failure-isolated.
- Drawer Close, overlay, Escape, and keyboard focus work on desktop and mobile.
- Visual screenshots show no unintentional layout or typography changes.

## Guardrails

- Do not introduce React, Vue, a build step, or generated bundles as part of extraction.
- Do not combine data normalization with view rendering.
- Do not change storage keys, RPC shapes, publisher IDs, or source ordering during file moves.
- Keep commits small enough that each module extraction can be reverted independently.
- Treat fewer lines in `index.html` as a consequence, not the success metric; behavioral equivalence is the requirement.
