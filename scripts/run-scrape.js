// scripts/run-scrape.js
import fs from "fs";
import path from "path";
import { scrapeABCHero, scrapeCBSHero, scrapeUSATHero } from "../server.js";

const DATA_DIR = path.join("docs", "data");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");

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

function readJSONIfExists(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function upsertHistory(history, sourceKey, generatedAtISO, item) {
  // history shape:
  // {
  //   generatedAt: "...",
  //   sources: {
  //     abc: { entries: [ {url,title,imgUrl,firstSeenAt,lastSeenAt,seenCount} ] },
  //     cbs: { entries: [...] }
  //   }
  // }
  const h = history && typeof history === "object" ? history : {};
  if (!h.sources || typeof h.sources !== "object") h.sources = {};
  if (!h.sources[sourceKey]) h.sources[sourceKey] = { entries: [] };
  if (!Array.isArray(h.sources[sourceKey].entries)) h.sources[sourceKey].entries = [];

  const entries = h.sources[sourceKey].entries;

  // If scrape failed or no item, do nothing
  if (!item || !item.url) return h;

  const url = item.url;
  const title = item.title || "";
  const imgUrl = item.imgUrl || null;

  const last = entries.length ? entries[entries.length - 1] : null;

  if (last && last.url === url) {
    const lastTitle = String(last.title || "");
    const nextTitle = String(title || "");

    if (lastTitle === nextTitle) {
      // Same URL + same title: extend lastSeenAt + increment count
      last.lastSeenAt = generatedAtISO;
      last.seenCount = (last.seenCount || 0) + 1;
      // Keep latest imgUrl in case image changes
      last.imgUrl = imgUrl || last.imgUrl;
      return h;
    }

    // Same URL but title changed: log a new variation entry
    entries.push({
      url,
      title: nextTitle,
      imgUrl,
      firstSeenAt: generatedAtISO,
      lastSeenAt: generatedAtISO,
      seenCount: 1,
    });
    return h;
  }

  // New hero URL: add a new entry
  entries.push({
    url,
    title,
    imgUrl,
    firstSeenAt: generatedAtISO,
    lastSeenAt: generatedAtISO,
    seenCount: 1,
  });

  return h;
}

function currentSinceFromHistory(history, sourceKey, currentUrl) {
  try {
    const entries = history?.sources?.[sourceKey]?.entries;
    if (!Array.isArray(entries) || !currentUrl) return null;

    const last = entries[entries.length - 1];
    if (last?.url !== currentUrl) return null;

    // Walk backwards across contiguous entries with the same URL (headline variations)
    // so "since" reflects when this URL first became the hero.
    let i = entries.length - 1;
    while (i - 1 >= 0 && entries[i - 1]?.url === currentUrl) i -= 1;
    return entries[i]?.firstSeenAt || last.firstSeenAt || null;
  } catch {
    return null;
  }
}

async function run() {
  console.log("🗞️ Newsboard hero scrape starting…");

  ensureDir(DATA_DIR);

  const generatedAt = new Date().toISOString();

  let abc = null;
  let cbs = null;
  let usat = null;

  try {
    abc = await scrapeABCHero();
  } catch (err) {
    console.error("❌ ABC hero scrape failed", err);
    abc = { ok: false, error: String(err), updatedAt: generatedAt, item: null };
  }

  try {
    cbs = await scrapeCBSHero();
  } catch (err) {
    console.error("❌ CBS hero scrape failed", err);
    cbs = { ok: false, error: String(err), updatedAt: generatedAt, item: null };
  }

  try {
    usat = await scrapeUSATHero();
  } catch (err) {
    console.error("❌ USA Today hero scrape failed", err);
    usat = { ok: false, error: String(err), updatedAt: generatedAt, item: null };
  }

  // Load existing history, update, and write back
  const history = readJSONIfExists(HISTORY_PATH, {
    generatedAt: null,
    sources: { abc: { entries: [] }, cbs: { entries: [] }, usat1: { entries: [] } },
  });

  history.generatedAt = generatedAt;
  upsertHistory(history, "abc", generatedAt, abc?.ok ? abc.item : null);
  upsertHistory(history, "cbs", generatedAt, cbs?.ok ? cbs.item : null);
  upsertHistory(history, "usat1", generatedAt, usat?.ok ? usat.item : null);

  writeJSON("history.json", history);

  // Determine "since" for current heroes (first time we saw this URL)
  const abcSince = currentSinceFromHistory(history, "abc", abc?.item?.url || null);
  const cbsSince = currentSinceFromHistory(history, "cbs", cbs?.item?.url || null);
  const usatSince = currentSinceFromHistory(history, "usat1", usat?.item?.url || null);

  // current.json (for "Now" view)
  const current = {
    ok: Boolean(abc?.ok || cbs?.ok || usat?.ok),
    generatedAt,
    sources: {
      abc: {
        ok: Boolean(abc?.ok),
        updatedAt: abc?.updatedAt || null,
        error: abc?.error || null,
        runId: abc?.runId || null,
        since: abcSince,          // <— NEW
        item: abc?.item || null,
      },
      cbs: {
        ok: Boolean(cbs?.ok),
        updatedAt: cbs?.updatedAt || null,
        error: cbs?.error || null,
        runId: cbs?.runId || null,
        since: cbsSince,          // <— NEW
        item: cbs?.item || null,
      },
      usat1: {
        ok: Boolean(usat?.ok),
        updatedAt: usat?.updatedAt || null,
        error: usat?.error || null,
        runId: usat?.runId || null,
        since: usatSince,
        item: usat?.item || null,
      },
    },
  };

  writeJSON("current.json", current);

  // unified.json (simple merged list)
  const unified = {
    ok: Boolean(abc?.ok || cbs?.ok || usat?.ok),
    generatedAt,
    items: [
      abc?.item ? { source: "abc", updatedAt: abc.updatedAt, since: abcSince, ...abc.item } : null,
      cbs?.item ? { source: "cbs", updatedAt: cbs.updatedAt, since: cbsSince, ...cbs.item } : null,
      usat?.item ? { source: "usat1", updatedAt: usat.updatedAt, since: usatSince, ...usat.item } : null,
    ].filter(Boolean),
  };

  writeJSON("unified.json", unified);

  console.log("✅ Wrote docs/data/current.json");
  console.log("✅ Wrote docs/data/unified.json");
  console.log("✅ Wrote docs/data/history.json");
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
