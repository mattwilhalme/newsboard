// scripts/run-scrape.js
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import {
  scrapeABCHero,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  scrapeCNNHero,
  scrapeReutersHero,
} from "../server.js";

const DATA_DIR = path.join("docs", "data");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");

const SOURCES = {
  abc1: { id: "abc1", name: "ABC News", homeUrl: "https://abcnews.go.com/" },
  cbs1: { id: "cbs1", name: "CBS News", homeUrl: "https://www.cbsnews.com/" },
  usat1: { id: "usat1", name: "USA Today", homeUrl: "https://www.usatoday.com/" },
  nbc1: { id: "nbc1", name: "NBC News", homeUrl: "https://www.nbcnews.com/" },
  cnn1: { id: "cnn1", name: "CNN", homeUrl: "https://www.cnn.com/" },
  reuters1: { id: "reuters1", name: "Reuters", homeUrl: "https://www.reuters.com/" },
};

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !serviceKey) return null;

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}

async function upsertSourceRow(sb, source) {
  if (!sb) return;
  const row = {
    id: source.id,
    name: source.name,
    home_url: source.homeUrl,
  };

  const { error } = await sb.from("sources").upsert(row, { onConflict: "id" });
  if (error) throw error;
}

async function latestRunForSource(sb, sourceId) {
  const { data, error } = await sb
    .from("hero_runs")
    .select("source_id,title,url,ok,error")
    .eq("source_id", sourceId)
    .order("observed_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function insertHeroRun(sb, sourceId, result, observedAtISO) {
  if (!sb) return;

  const title = result?.item?.title || null;
  const url = result?.item?.url || null;
  const imgUrl = result?.item?.imgUrl || null;
  const ok = Boolean(result?.ok);
  const err = result?.error ? String(result.error) : null;

  // Optional dedup: if last row matches url+title+ok+error, skip.
  const last = await latestRunForSource(sb, sourceId);
  if (
    last &&
    String(last.title || "") === String(title || "") &&
    String(last.url || "") === String(url || "") &&
    Boolean(last.ok) === ok &&
    String(last.error || "") === String(err || "")
  ) {
    return;
  }

  const rawPayload = {
    ...result,
    observedAt: observedAtISO,
    sourceId,
  };

  const row = {
    source_id: sourceId,
    observed_at: observedAtISO,
    run_id: result?.runId || null,
    title,
    url,
    img_url: imgUrl,
    ok,
    error: err,
    raw: rawPayload,
  };

  const { error } = await sb.from("hero_runs").insert(row);
  if (error) throw error;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filename, payload) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(payload, null, 2), "utf8");
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
  const h = history && typeof history === "object" ? history : {};
  if (!h.sources || typeof h.sources !== "object") h.sources = {};
  if (!h.sources[sourceKey]) h.sources[sourceKey] = { entries: [] };
  if (!Array.isArray(h.sources[sourceKey].entries)) h.sources[sourceKey].entries = [];

  const entries = h.sources[sourceKey].entries;

  if (!item || !item.url) return h;

  const url = item.url;
  const title = item.title || "";
  const imgUrl = item.imgUrl || null;

  const last = entries.length ? entries[entries.length - 1] : null;

  if (last && last.url === url) {
    const lastTitle = String(last.title || "");
    const nextTitle = String(title || "");

    if (lastTitle === nextTitle) {
      last.lastSeenAt = generatedAtISO;
      last.seenCount = (last.seenCount || 0) + 1;
      last.imgUrl = imgUrl || last.imgUrl;
      return h;
    }

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

    let i = entries.length - 1;
    while (i - 1 >= 0 && entries[i - 1]?.url === currentUrl) i -= 1;
    return entries[i]?.firstSeenAt || last.firstSeenAt || null;
  } catch {
    return null;
  }
}

async function safeScrape(label, fn, generatedAt) {
  try {
    return await fn();
  } catch (err) {
    console.error(`❌ ${label} hero scrape failed`, err);
    return { ok: false, error: String(err), updatedAt: generatedAt, item: null };
  }
}

async function run() {
  console.log("🗞️ Newsboard hero scrape starting…");

  ensureDir(DATA_DIR);

  const generatedAt = new Date().toISOString();
  const observedAt = generatedAt;

  const supabase = getSupabaseAdmin();
  if (supabase) console.log("🧩 Supabase enabled: inserting hero_runs");
  else console.log("🧩 Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)");

  const abc1 = await safeScrape("ABC", scrapeABCHero, generatedAt);
  const cbs1 = await safeScrape("CBS", scrapeCBSHero, generatedAt);
  const usat1 = await safeScrape("USA Today", scrapeUSATHero, generatedAt);
  const nbc1 = await safeScrape("NBC", scrapeNBCHero, generatedAt);
  const cnn1 = await safeScrape("CNN", scrapeCNNHero, generatedAt);
  const reuters1 = await safeScrape("Reuters", scrapeReutersHero, generatedAt);

  if (supabase) {
    try {
      for (const s of Object.values(SOURCES)) await upsertSourceRow(supabase, s);

      await insertHeroRun(supabase, "abc1", abc1, observedAt);
      await insertHeroRun(supabase, "cbs1", cbs1, observedAt);
      await insertHeroRun(supabase, "usat1", usat1, observedAt);
      await insertHeroRun(supabase, "nbc1", nbc1, observedAt);
      await insertHeroRun(supabase, "cnn1", cnn1, observedAt);
      await insertHeroRun(supabase, "reuters1", reuters1, observedAt);
    } catch (e) {
      console.error("❌ Supabase insert failed", e);
    }
  }

  // Load existing history, update, and write back
  const history = readJSONIfExists(HISTORY_PATH, {
    generatedAt: null,
    sources: {
      abc1: { entries: [] },
      cbs1: { entries: [] },
      usat1: { entries: [] },
      nbc1: { entries: [] },
      cnn1: { entries: [] },
      reuters1: { entries: [] },
    },
  });

  history.generatedAt = generatedAt;

  upsertHistory(history, "abc1", generatedAt, abc1?.ok ? abc1.item : null);
  upsertHistory(history, "cbs1", generatedAt, cbs1?.ok ? cbs1.item : null);
  upsertHistory(history, "usat1", generatedAt, usat1?.ok ? usat1.item : null);
  upsertHistory(history, "nbc1", generatedAt, nbc1?.ok ? nbc1.item : null);
  upsertHistory(history, "cnn1", generatedAt, cnn1?.ok ? cnn1.item : null);
  upsertHistory(history, "reuters1", generatedAt, reuters1?.ok ? reuters1.item : null);

  writeJSON("history.json", history);

  const abcSince = currentSinceFromHistory(history, "abc1", abc1?.item?.url || null);
  const cbsSince = currentSinceFromHistory(history, "cbs1", cbs1?.item?.url || null);
  const usatSince = currentSinceFromHistory(history, "usat1", usat1?.item?.url || null);
  const nbcSince = currentSinceFromHistory(history, "nbc1", nbc1?.item?.url || null);
  const cnnSince = currentSinceFromHistory(history, "cnn1", cnn1?.item?.url || null);
  const reutersSince = currentSinceFromHistory(history, "reuters1", reuters1?.item?.url || null);

  const current = {
    ok: Boolean(abc1?.ok || cbs1?.ok || usat1?.ok || nbc1?.ok || cnn1?.ok || reuters1?.ok),
    generatedAt,
    sources: {
      abc1: {
        ok: Boolean(abc1?.ok),
        updatedAt: abc1?.updatedAt || null,
        error: abc1?.error || null,
        runId: abc1?.runId || null,
        since: abcSince,
        item: abc1?.item || null,
      },
      cbs1: {
        ok: Boolean(cbs1?.ok),
        updatedAt: cbs1?.updatedAt || null,
        error: cbs1?.error || null,
        runId: cbs1?.runId || null,
        since: cbsSince,
        item: cbs1?.item || null,
      },
      usat1: {
        ok: Boolean(usat1?.ok),
        updatedAt: usat1?.updatedAt || null,
        error: usat1?.error || null,
        runId: usat1?.runId || null,
        since: usatSince,
        item: usat1?.item || null,
      },
      nbc1: {
        ok: Boolean(nbc1?.ok),
        updatedAt: nbc1?.updatedAt || null,
        error: nbc1?.error || null,
        runId: nbc1?.runId || null,
        since: nbcSince,
        item: nbc1?.item || null,
      },
      cnn1: {
        ok: Boolean(cnn1?.ok),
        updatedAt: cnn1?.updatedAt || null,
        error: cnn1?.error || null,
        runId: cnn1?.runId || null,
        since: cnnSince,
        item: cnn1?.item || null,
      },
      reuters1: {
        ok: Boolean(reuters1?.ok),
        updatedAt: reuters1?.updatedAt || null,
        error: reuters1?.error || null,
        runId: reuters1?.runId || null,
        since: reutersSince,
        item: reuters1?.item || null,
      },
    },
  };

  writeJSON("current.json", current);

  const unified = {
    ok: Boolean(abc1?.ok || cbs1?.ok || usat1?.ok || nbc1?.ok || cnn1?.ok || reuters1?.ok),
    generatedAt,
    items: [
      abc1?.item ? { source: "abc1", updatedAt: abc1.updatedAt, since: abcSince, ...abc1.item } : null,
      cbs1?.item ? { source: "cbs1", updatedAt: cbs1.updatedAt, since: cbsSince, ...cbs1.item } : null,
      usat1?.item ? { source: "usat1", updatedAt: usat1.updatedAt, since: usatSince, ...usat1.item } : null,
      nbc1?.item ? { source: "nbc1", updatedAt: nbc1.updatedAt, since: nbcSince, ...nbc1.item } : null,
      cnn1?.item ? { source: "cnn1", updatedAt: cnn1.updatedAt, since: cnnSince, ...cnn1.item } : null,
      reuters1?.item
        ? { source: "reuters1", updatedAt: reuters1.updatedAt, since: reutersSince, ...reuters1.item }
        : null,
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