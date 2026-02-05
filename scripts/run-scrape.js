// scripts/run-scrape.js
import fs from "fs";
import path from "path";
import {
  scrapeABCFrontPage,
  scrapeCBSFrontPage
} from "../server.js";

const DATA_DIR = path.join("docs", "data");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filename, payload) {
  fs.writeFileSync(
    path.join(DATA_DIR, filename),
    JSON.stringify(payload, null, 2),
    "utf8"
  );
}

async function run() {
  console.log("🗞️ Newsboard scrape starting…");

  ensureDir(DATA_DIR);

  let abc = null;
  let cbs = null;

  try {
    abc = await scrapeABCFrontPage();
  } catch (err) {
    console.error("❌ ABC scrape failed", err);
    abc = {
      ok: false,
      error: String(err),
      updatedAt: new Date().toISOString(),
      items: []
    };
  }

  try {
    cbs = await scrapeCBSFrontPage();
  } catch (err) {
    console.error("❌ CBS scrape failed", err);
    cbs = {
      ok: false,
      error: String(err),
      updatedAt: new Date().toISOString(),
      items: []
    };
  }

  const generatedAt = new Date().toISOString();

  /**
   * current.json
   * Used by index.html for the "Now" view
   */
  const current = {
    ok: Boolean(abc?.ok || cbs?.ok),
    generatedAt,
    sources: {
      abc,
      cbs
    }
  };

  writeJSON("current.json", current);

  /**
   * unified.json
   * Temporary placeholder until hero-epoch logic is added.
   * Right now it just exposes the top item per source.
   */
  const unified = {
    generatedAt,
    items: [
      abc?.items?.[0]
        ? { source: "abc", ...abc.items[0], updatedAt: abc.updatedAt }
        : null,
      cbs?.items?.[0]
        ? { source: "cbs", ...cbs.items[0], updatedAt: cbs.updatedAt }
        : null
    ].filter(Boolean)
  };

  writeJSON("unified.json", unified);

  console.log("✅ Wrote docs/data/current.json");
  console.log("✅ Wrote docs/data/unified.json");
}

run().catch(err => {
  console.error("❌ Scrape failed hard");
  console.error(err);

  // Still ensure Pages has *something* to read
  ensureDir(DATA_DIR);
  writeJSON("current.json", {
    ok: false,
    generatedAt: new Date().toISOString(),
    error: String(err)
  });
  writeJSON("unified.json", {
    generatedAt: new Date().toISOString(),
    items: [],
    error: String(err)
  });

  process.exit(1);
});
