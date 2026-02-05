// scripts/run-scrape.js
import fs from "fs";
import path from "path";
import { scrapeABCHero, scrapeCBSHero } from "../server.js";

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
  console.log("🗞️ Newsboard hero scrape starting…");

  ensureDir(DATA_DIR);

  const generatedAt = new Date().toISOString();

  let abc = null;
  let cbs = null;

  try {
    abc = await scrapeABCHero();
  } catch (err) {
    console.error("❌ ABC hero scrape failed", err);
    abc = {
      ok: false,
      error: String(err),
      updatedAt: new Date().toISOString(),
      item: null,
    };
  }

  try {
    cbs = await scrapeCBSHero();
  } catch (err) {
    console.error("❌ CBS hero scrape failed", err);
    cbs = {
      ok: false,
      error: String(err),
      updatedAt: new Date().toISOString(),
      item: null,
    };
  }

  // current.json (for "Now" view)
  const current = {
    ok: Boolean(abc?.ok || cbs?.ok),
    generatedAt,
    sources: {
      abc: {
        ok: Boolean(abc?.ok),
        updatedAt: abc?.updatedAt || null,
        error: abc?.error || null,
        runId: abc?.runId || null,
        item: abc?.item || null,
      },
      cbs: {
        ok: Boolean(cbs?.ok),
        updatedAt: cbs?.updatedAt || null,
        error: cbs?.error || null,
        runId: cbs?.runId || null,
        item: cbs?.item || null,
      },
    },
  };

  writeJSON("current.json", current);

  // unified.json (placeholder unified feed until epoch logic is added)
  // For now: just the two current hero items, with their updatedAt timestamps.
  const unified = {
    ok: Boolean(abc?.ok || cbs?.ok),
    generatedAt,
    items: [
      abc?.item ? { source: "abc", updatedAt: abc.updatedAt, ...abc.item } : null,
      cbs?.item ? { source: "cbs", updatedAt: cbs.updatedAt, ...cbs.item } : null,
    ].filter(Boolean),
  };

  writeJSON("unified.json", unified);

  console.log("✅ Wrote docs/data/current.json");
  console.log("✅ Wrote docs/data/unified.json");
}

run().catch((err) => {
  console.error("❌ Scrape failed hard");
  console.error(err);

  ensureDir(DATA_DIR);

  const generatedAt = new Date().toISOString();
  writeJSON("current.json", { ok: false, generatedAt, error: String(err) });
  writeJSON("unified.json", { ok: false, generatedAt, items: [], error: String(err) });

  process.exit(1);
});
