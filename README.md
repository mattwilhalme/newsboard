# Newsboard

A private newsroom tooling experiment that observes editorial decision changes over time by tracking front-page headlines from major publishers.

## What it does

- Scrapes front-page headlines from major publishers (currently ABC News and CBS News)
- Stores snapshots of each scrape (HTML, PNG, JSON)
- Computes diffs between runs to track headline additions, removals, rank changes, retitles, and slot changes
- Displays current top headlines with freshness/status indicators
- Provides an interactive history timeline of headline movement

## Architecture

**Backend**
- `server.js` - Node + Express server using Playwright for scraping
- Archives every run to `/archive` with HTML, PNG, and JSON snapshots
- Maintains `cache.json` as current state
- Computes diffs between snapshots server-side

**Frontend**
- `index.html` - Entire UI rendered in single file
- Vanilla JS + CSS only (no frameworks)
- Card layout per publisher with slide-out history drawer
- Newspaper-like minimal aesthetic

## Core principles

- **Stability over cleverness** - DOM selectors are intentionally defensive
- **Slot keys matter more than raw rank** - Tracks DOM position stability
- **Diffs are the product** - Screenshots and HTML archives support analysis
- **Private by default** - No auth, no public exposure assumptions
- **Editorial realism** - Headlines ranked as users see them

## Getting started

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server will start on `http://localhost:3001`.

## API endpoints

- `GET /api/headlines` - Current cached headlines
- `POST /api/refresh` - Trigger fresh scrape (supports `{"id": "abc|cbs"}` for single source)
- `GET /api/diff?id=abc` - Diff between last two snapshots
- `GET /api/history?id=abc&limit=20` - Historical timeline with diffs

## Glossary

- **snapshot** - One scrape run (JSON + HTML + PNG)
- **slotKey** - Hash representing DOM position identity
- **diff** - Comparison between two snapshots
- **retitle** - Same URL, changed headline text
- **moved** - Same URL, changed rank
- **slotChanged** - Same slot, different story

## Design notes

This is not a generic scraper or SEO tool — it's designed to observe editorial decision changes over time. The scrapers are intentionally fragile (news sites change DOM structure frequently) and use Playwright instead of Axios/Cheerio to handle dynamic content properly.

Storage is local filesystem, not cloud, making this suitable for private analysis workflows.
