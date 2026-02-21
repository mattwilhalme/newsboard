// scripts/run-scrape.js
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import {
  SOURCE_REGISTRY,
  scrapeABCHero,
  scrapeABCTop10,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  scrapeCNNHero,
  scrapeGuardianHero,
  scrapeAPHero,
  scrapeLATimesHero,
  scrapeNPRHero,
  scrapeBBCHero,
  scrapeFoxHero,
  scrapeWPHero,
} from "../server.js";

const DATA_DIR = path.join("docs", "data");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");
const TOP10_ABC_HISTORY_PATH = path.join(DATA_DIR, "top10_abc_history.json");
const TOP10_ABC_EVENTS_HISTORY_PATH = path.join(DATA_DIR, "top10_abc_events_history.json");
const TOP10_ABC_LATEST_PATH = path.join(DATA_DIR, "top10_abc_latest.json");
const TOP10_ABC_EVENTS_24H_PATH = path.join(DATA_DIR, "top10_abc_events_24h.json");
const TIMELINE_HOURS = Number(process.env.TIMELINE_HOURS || 12);
const SUPABASE_SCREENSHOT_BUCKET = process.env.SUPABASE_SCREENSHOT_BUCKET || "screenshots";
const TOP10_SOURCE_ID = "abc1";
const TOP10_HISTORY_CAP = Number(process.env.TOP10_HISTORY_CAP || 336);
const TOP10_EVENTS_CAP = Number(process.env.TOP10_EVENTS_CAP || 3000);

const SOURCES = Object.fromEntries(
  SOURCE_REGISTRY.map((s) => [s.id, { id: s.id, name: s.name, homeUrl: s.home_url }]),
);

const SUPABASE_RETRY_ATTEMPTS = Number(process.env.SUPABASE_RETRY_ATTEMPTS || 4);
const SUPABASE_RETRY_BASE_MS = Number(process.env.SUPABASE_RETRY_BASE_MS || 700);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactSupabaseError(err) {
  const status = err?.status ? `status=${err.status}` : null;
  const code = err?.code ? `code=${err.code}` : null;
  const details = err?.details ? `details=${String(err.details).slice(0, 180)}` : null;
  const hint = err?.hint ? `hint=${String(err.hint).slice(0, 180)}` : null;

  let message = String(err?.message || err || "Unknown error");
  const cfTitleMatch = message.match(/<title>([^<]+)<\/title>/i);
  if (cfTitleMatch?.[1]) {
    message = cfTitleMatch[1].trim();
  } else {
    // Collapse giant HTML payloads into the first readable line.
    message = message
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
  }

  return [status, code, details, hint, `message=${message}`].filter(Boolean).join(" | ");
}

function isTransientSupabaseError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if ([408, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) return true;

  const text = String(err?.message || err || "").toLowerCase();
  return (
    text.includes("connection timed out") ||
    text.includes("error code 522") ||
    text.includes("etimedout") ||
    text.includes("econnreset") ||
    text.includes("fetch failed") ||
    text.includes("network error") ||
    text.includes("temporarily unavailable")
  );
}

function isOutageLikeSummary(summary) {
  const s = String(summary || "").toLowerCase();
  return (
    s.includes("status=522") ||
    s.includes("status=520") ||
    s.includes("status=524") ||
    s.includes("connection timed out") ||
    s.includes("temporarily unavailable") ||
    s.includes("fetch failed")
  );
}

async function withSupabaseRetry(label, work) {
  let lastErr = null;
  for (let attempt = 1; attempt <= SUPABASE_RETRY_ATTEMPTS; attempt++) {
    try {
      await work();
      if (attempt > 1) {
        console.warn(`⚠️ Supabase ${label} succeeded after retry ${attempt}/${SUPABASE_RETRY_ATTEMPTS}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      const transient = isTransientSupabaseError(err);
      const summary = compactSupabaseError(err);
      if (!transient || attempt === SUPABASE_RETRY_ATTEMPTS) {
        throw new Error(`${label} failed (${attempt}/${SUPABASE_RETRY_ATTEMPTS}) | ${summary}`);
      }

      const jitter = Math.floor(Math.random() * 250);
      const waitMs = (SUPABASE_RETRY_BASE_MS * Math.pow(2, attempt - 1)) + jitter;
      console.warn(`⚠️ Supabase ${label} transient error (${attempt}/${SUPABASE_RETRY_ATTEMPTS}) | ${summary} | retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }

  throw lastErr || new Error(`${label} failed`);
}

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

  await withSupabaseRetry(`upsert sources.${source.id}`, async () => {
    const { error } = await sb.from("sources").upsert(row, { onConflict: "id" });
    if (error) throw error;
  });
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
    boundaryY: Number.isFinite(Number(result?.meta?.boundaryY)) ? Number(result.meta.boundaryY) : null,
    pickedTopY: Number.isFinite(Number(result?.meta?.pickedTopY)) ? Number(result.meta.pickedTopY) : null,
    pickedDistance: Number.isFinite(Number(result?.meta?.pickedDistance)) ? Number(result.meta.pickedDistance) : null,
    candidateCount: Number.isFinite(Number(result?.meta?.candidateCount)) ? Number(result.meta.candidateCount) : null,
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

  await withSupabaseRetry(`insert hero_runs.${sourceId}`, async () => {
    const { error } = await sb.from("hero_runs").insert(row);
    if (error) throw error;
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filename, payload) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(payload, null, 2), "utf8");
}

function derivePublicShotUrl(objectPath) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!base || !objectPath) return null;
  return `${base}/storage/v1/object/public/${SUPABASE_SCREENSHOT_BUCKET}/${objectPath}`;
}

function readJSONIfExists(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function hoursToMs(hours) {
  return Math.max(1, Number(hours || 24)) * 60 * 60 * 1000;
}

function isoWithinHours(ts, hours) {
  const ms = Date.parse(String(ts || ""));
  if (!Number.isFinite(ms)) return false;
  return ms >= (Date.now() - hoursToMs(hours));
}

function computeTop10Diff(prevRun, currRun) {
  const prevItems = Array.isArray(prevRun?.items) ? prevRun.items : [];
  const currItems = Array.isArray(currRun?.items) ? currRun.items : [];

  const prevByFp = new Map(prevItems.map((it) => [String(it.fingerprint || ""), it]).filter(([fp]) => fp));
  const currByFp = new Map(currItems.map((it) => [String(it.fingerprint || ""), it]).filter(([fp]) => fp));

  const events = [];
  const observedAt = currRun?.observedAt || new Date().toISOString();

  for (const [fp, curr] of currByFp.entries()) {
    const prev = prevByFp.get(fp);
    if (!prev) {
      events.push({
        source_id: TOP10_SOURCE_ID,
        observed_at: observedAt,
        event_type: "ENTERED_TOP10",
        fingerprint: fp,
        from_rank: null,
        to_rank: curr.rank ?? null,
        from_title: null,
        to_title: curr.title || null,
      });
      continue;
    }

    if (Number(prev.rank) !== Number(curr.rank)) {
      events.push({
        source_id: TOP10_SOURCE_ID,
        observed_at: observedAt,
        event_type: "MOVED",
        fingerprint: fp,
        from_rank: prev.rank ?? null,
        to_rank: curr.rank ?? null,
        from_title: prev.title || null,
        to_title: curr.title || null,
      });
    }

    if (String(prev.title || "") !== String(curr.title || "")) {
      events.push({
        source_id: TOP10_SOURCE_ID,
        observed_at: observedAt,
        event_type: "TITLE_UPDATED",
        fingerprint: fp,
        from_rank: prev.rank ?? null,
        to_rank: curr.rank ?? null,
        from_title: prev.title || null,
        to_title: curr.title || null,
      });
    }
  }

  for (const [fp, prev] of prevByFp.entries()) {
    if (currByFp.has(fp)) continue;
    events.push({
      source_id: TOP10_SOURCE_ID,
      observed_at: observedAt,
      event_type: "EXITED_TOP10",
      fingerprint: fp,
      from_rank: prev.rank ?? null,
      to_rank: null,
      from_title: prev.title || null,
      to_title: null,
    });
  }

  return events;
}

async function insertTop10RunAndItems(sb, top10) {
  if (!sb || !top10) return null;

  const runRow = {
    source_id: TOP10_SOURCE_ID,
    observed_at: top10.observedAt || new Date().toISOString(),
    ok: Boolean(top10.ok),
    error: top10.error ? String(top10.error) : null,
  };

  const { data: runData, error: runErr } = await sb
    .from("top10_runs")
    .insert(runRow)
    .select("id,source_id,observed_at")
    .single();
  if (runErr) throw runErr;

  const items = Array.isArray(top10.items) ? top10.items : [];
  if (items.length) {
    const itemRows = items.map((it) => ({
      run_id: runData.id,
      source_id: TOP10_SOURCE_ID,
      rank: Number(it.rank) || null,
      title: it.title || null,
      url: it.url || null,
      fingerprint: it.fingerprint || null,
    }));
    const { error: itemErr } = await sb.from("top10_items").insert(itemRows);
    if (itemErr) throw itemErr;
  }

  return runData;
}

async function fetchTop10ItemsForRun(sb, runId) {
  if (!runId) return [];
  const { data, error } = await sb
    .from("top10_items")
    .select("rank,title,url,fingerprint")
    .eq("run_id", runId)
    .order("rank", { ascending: true });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function fetchPreviousTop10Run(sb, sourceId, observedAtIso) {
  const { data, error } = await sb
    .from("top10_runs")
    .select("id,source_id,observed_at")
    .eq("source_id", sourceId)
    .lt("observed_at", observedAtIso)
    .order("observed_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row) return null;
  const items = await fetchTop10ItemsForRun(sb, row.id);
  return { ...row, items };
}

async function insertTop10Events(sb, prevRun, currRun) {
  if (!sb || !currRun) return;
  const events = computeTop10Diff(prevRun, currRun);
  if (!events.length) return;
  const rows = events.map((ev) => ({
    source_id: ev.source_id,
    observed_at: ev.observed_at,
    event_type: ev.event_type,
    fingerprint: ev.fingerprint,
    from_rank: ev.from_rank,
    to_rank: ev.to_rank,
    from_title: ev.from_title,
    to_title: ev.to_title,
    from_run_id: prevRun?.id || null,
    to_run_id: currRun?.id || null,
  }));
  const { error } = await sb.from("top10_events").insert(rows);
  if (error) throw error;
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
    const res = await fn();
    if (res?.item) {
      res.item.contentType = inferContentType({ url: res.item.url, title: res.item.title });
    }
    return res;
  } catch (err) {
    console.error(`❌ ${label} hero scrape failed`, err);
    return { ok: false, error: String(err), updatedAt: generatedAt, item: null };
  }
}

function inferContentType({ url, title }) {
  const u = String(url || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  if (u.includes("/video") || u.includes("video.")) return "video";
  if (u.includes("/live") || /\blive\b/.test(t)) return "live";
  if (u.includes("/opinion") || u.includes("/editorial")) return "opinion";
  if (u.includes("/analysis")) return "analysis";
  if (u.includes("/photo") || u.includes("/gallery")) return "gallery";
  return "news";
}

async function loadTimelineEventsFromSupabase(sb, hours = 12) {
  if (!sb) return [];
  const cutoffIso = new Date(Date.now() - Math.max(1, Number(hours || 12)) * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from("screenshot_events")
    .select("ts,source_id,kind,title,url,object_path,shot_url")
    .gte("ts", cutoffIso)
    .order("ts", { ascending: true })
    .limit(10000);
  if (error) throw error;

  return (Array.isArray(data) ? data : []).map((row) => ({
    ts: row.ts || null,
    source_id: row.source_id || null,
    kind: row.kind || "heartbeat",
    title: row.title || null,
    url: row.url || null,
    object_path: row.object_path || null,
    shot_url:
      row.shot_url ||
      derivePublicShotUrl(row.object_path || null),
  }));
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
  const abcTop10Raw = await safeScrape("ABC Top 10", scrapeABCTop10, generatedAt);
  const abcTop10 = {
    sourceId: TOP10_SOURCE_ID,
    observedAt: abcTop10Raw?.observedAt || generatedAt,
    runId: abcTop10Raw?.runId || null,
    ok: Boolean(abcTop10Raw?.ok),
    error: abcTop10Raw?.error || null,
    items: Array.isArray(abcTop10Raw?.items) ? abcTop10Raw.items : [],
  };
  const cbs1 = await safeScrape("CBS", scrapeCBSHero, generatedAt);
  const usat1 = await safeScrape("USA Today", scrapeUSATHero, generatedAt);
  const nbc1 = await safeScrape("NBC", scrapeNBCHero, generatedAt);
  const cnn1 = await safeScrape("CNN", scrapeCNNHero, generatedAt);
  const guardian1 = await safeScrape("The Guardian", scrapeGuardianHero, generatedAt);
  const ap1 = await safeScrape("Associated Press", scrapeAPHero, generatedAt);
  const latimes1 = await safeScrape("Los Angeles Times", scrapeLATimesHero, generatedAt);
  const npr1 = await safeScrape("NPR", scrapeNPRHero, generatedAt);
  const bbc1 = await safeScrape("BBC", scrapeBBCHero, generatedAt);
  const fox1 = await safeScrape("Fox News", scrapeFoxHero, generatedAt);
  const yahoo1 = await safeScrape("Yahoo News", scrapeWPHero, generatedAt);

  if (supabase) {
    const sbWrites = [
      ...Object.values(SOURCES).map((s) => ({ label: `sources.${s.id}`, fn: () => upsertSourceRow(supabase, s) })),
      { label: "hero_runs.abc1", fn: () => insertHeroRun(supabase, "abc1", abc1, observedAt) },
      { label: "hero_runs.cbs1", fn: () => insertHeroRun(supabase, "cbs1", cbs1, observedAt) },
      { label: "hero_runs.usat1", fn: () => insertHeroRun(supabase, "usat1", usat1, observedAt) },
      { label: "hero_runs.nbc1", fn: () => insertHeroRun(supabase, "nbc1", nbc1, observedAt) },
      { label: "hero_runs.cnn1", fn: () => insertHeroRun(supabase, "cnn1", cnn1, observedAt) },
      { label: "hero_runs.guardian1", fn: () => insertHeroRun(supabase, "guardian1", guardian1, observedAt) },
      { label: "hero_runs.ap1", fn: () => insertHeroRun(supabase, "ap1", ap1, observedAt) },
      { label: "hero_runs.latimes1", fn: () => insertHeroRun(supabase, "latimes1", latimes1, observedAt) },
      { label: "hero_runs.npr1", fn: () => insertHeroRun(supabase, "npr1", npr1, observedAt) },
      { label: "hero_runs.bbc1", fn: () => insertHeroRun(supabase, "bbc1", bbc1, observedAt) },
      { label: "hero_runs.fox1", fn: () => insertHeroRun(supabase, "fox1", fox1, observedAt) },
      { label: "hero_runs.yahoo1", fn: () => insertHeroRun(supabase, "yahoo1", yahoo1, observedAt) },
    ];

    const failures = [];
    let outageLikeFailures = 0;
    for (const w of sbWrites) {
      if (outageLikeFailures >= 2) {
        console.warn("⚠️ Supabase appears broadly unavailable; skipping remaining Supabase writes for this run.");
        break;
      }
      try {
        await w.fn();
      } catch (e) {
        const summary = compactSupabaseError(e);
        failures.push({ label: w.label, error: summary });
        if (isOutageLikeSummary(summary)) outageLikeFailures += 1;
      }
    }

    if (failures.length) {
      console.error(`❌ Supabase writes failed (${failures.length}/${sbWrites.length})`);
      for (const f of failures) {
        console.error(`  - ${f.label}: ${f.error}`);
      }
    }

    try {
      await withSupabaseRetry("insert top10_runs/items", async () => {
        const currRun = await insertTop10RunAndItems(supabase, abcTop10);
        if (!currRun) return;
        const prevRun = await fetchPreviousTop10Run(supabase, TOP10_SOURCE_ID, String(currRun.observed_at || abcTop10.observedAt));
        const currItems = await fetchTop10ItemsForRun(supabase, currRun.id);
        await insertTop10Events(
          supabase,
          prevRun,
          { ...currRun, items: currItems }
        );
      });
    } catch (err) {
      console.warn(`⚠️ top10 Supabase write skipped: ${compactSupabaseError(err)}`);
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
      guardian1: { entries: [] },
      ap1: { entries: [] },
      latimes1: { entries: [] },
      npr1: { entries: [] },
      bbc1: { entries: [] },
      fox1: { entries: [] },
      yahoo1: { entries: [] },
    },
  });
  
  history.generatedAt = generatedAt;

  upsertHistory(history, "abc1", generatedAt, abc1?.ok ? abc1.item : null);
  upsertHistory(history, "cbs1", generatedAt, cbs1?.ok ? cbs1.item : null);
  upsertHistory(history, "usat1", generatedAt, usat1?.ok ? usat1.item : null);
  upsertHistory(history, "nbc1", generatedAt, nbc1?.ok ? nbc1.item : null);
  upsertHistory(history, "cnn1", generatedAt, cnn1?.ok ? cnn1.item : null);
  upsertHistory(history, "guardian1", generatedAt, guardian1?.ok ? guardian1.item : null);
  upsertHistory(history, "ap1", generatedAt, ap1?.ok ? ap1.item : null);
  upsertHistory(history, "latimes1", generatedAt, latimes1?.ok ? latimes1.item : null);
  upsertHistory(history, "npr1", generatedAt, npr1?.ok ? npr1.item : null);
  upsertHistory(history, "bbc1", generatedAt, bbc1?.ok ? bbc1.item : null);
  upsertHistory(history, "fox1", generatedAt, fox1?.ok ? fox1.item : null);
  upsertHistory(history, "yahoo1", generatedAt, yahoo1?.ok ? yahoo1.item : null);

  writeJSON("history.json", history);

  let timelinePayload = {
    ok: false,
    generatedAt,
    hours: TIMELINE_HOURS,
    events: [],
  };
  if (supabase) {
    try {
      const events = await loadTimelineEventsFromSupabase(supabase, TIMELINE_HOURS);
      timelinePayload = {
        ok: true,
        generatedAt,
        hours: TIMELINE_HOURS,
        events,
      };
    } catch (err) {
      console.warn("⚠️ timeline.json build failed from Supabase:", compactSupabaseError(err));
    }
  }
  writeJSON("timeline.json", timelinePayload);

  const top10History = readJSONIfExists(TOP10_ABC_HISTORY_PATH, {
    source_id: TOP10_SOURCE_ID,
    generatedAt: null,
    runs: [],
  });
  if (!Array.isArray(top10History.runs)) top10History.runs = [];

  const prevTop10Run = top10History.runs.length ? top10History.runs[top10History.runs.length - 1] : null;
  const currTop10Run = {
    runId: abcTop10.runId,
    observedAt: abcTop10.observedAt,
    ok: Boolean(abcTop10.ok),
    error: abcTop10.error || null,
    items: (Array.isArray(abcTop10.items) ? abcTop10.items : []).map((it) => ({
      rank: Number(it.rank) || null,
      title: it.title || null,
      url: it.url || null,
      fingerprint: it.fingerprint || null,
      related_links: Array.isArray(it.related_links)
        ? it.related_links
            .map((rel) => ({ title: rel?.title || null, url: rel?.url || null }))
            .filter((rel) => rel.url)
        : [],
    })),
  };
  top10History.generatedAt = generatedAt;
  top10History.source_id = TOP10_SOURCE_ID;
  top10History.runs.push(currTop10Run);
  if (top10History.runs.length > TOP10_HISTORY_CAP) {
    top10History.runs = top10History.runs.slice(-TOP10_HISTORY_CAP);
  }
  fs.writeFileSync(TOP10_ABC_HISTORY_PATH, JSON.stringify(top10History, null, 2), "utf8");

  const top10EventsHistory = readJSONIfExists(TOP10_ABC_EVENTS_HISTORY_PATH, {
    source_id: TOP10_SOURCE_ID,
    generatedAt: null,
    events: [],
  });
  if (!Array.isArray(top10EventsHistory.events)) top10EventsHistory.events = [];
  const newEvents = computeTop10Diff(prevTop10Run, currTop10Run);
  for (const ev of newEvents) top10EventsHistory.events.push(ev);
  if (top10EventsHistory.events.length > TOP10_EVENTS_CAP) {
    top10EventsHistory.events = top10EventsHistory.events.slice(-TOP10_EVENTS_CAP);
  }
  top10EventsHistory.generatedAt = generatedAt;
  fs.writeFileSync(TOP10_ABC_EVENTS_HISTORY_PATH, JSON.stringify(top10EventsHistory, null, 2), "utf8");

  const events24h = top10EventsHistory.events.filter((ev) => isoWithinHours(ev?.observed_at, 24));
  fs.writeFileSync(
    TOP10_ABC_EVENTS_24H_PATH,
    JSON.stringify(
      {
        source_id: TOP10_SOURCE_ID,
        generatedAt,
        hours: 24,
        events: events24h,
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    TOP10_ABC_LATEST_PATH,
    JSON.stringify(
      {
        source_id: TOP10_SOURCE_ID,
        generatedAt,
        observedAt: currTop10Run.observedAt,
        ok: currTop10Run.ok,
        error: currTop10Run.error,
        items: currTop10Run.items,
      },
      null,
      2
    ),
    "utf8"
  );

  const abcSince = currentSinceFromHistory(history, "abc1", abc1?.item?.url || null);
  const cbsSince = currentSinceFromHistory(history, "cbs1", cbs1?.item?.url || null);
  const usatSince = currentSinceFromHistory(history, "usat1", usat1?.item?.url || null);
  const nbcSince = currentSinceFromHistory(history, "nbc1", nbc1?.item?.url || null);
  const cnnSince = currentSinceFromHistory(history, "cnn1", cnn1?.item?.url || null);
  const guardianSince = currentSinceFromHistory(history, "guardian1", guardian1?.item?.url || null);
  const apSince = currentSinceFromHistory(history, "ap1", ap1?.item?.url || null);
  const latimesSince = currentSinceFromHistory(history, "latimes1", latimes1?.item?.url || null);
  const nprSince = currentSinceFromHistory(history, "npr1", npr1?.item?.url || null);
  const bbcSince = currentSinceFromHistory(history, "bbc1", bbc1?.item?.url || null);
  const foxSince = currentSinceFromHistory(history, "fox1", fox1?.item?.url || null);
  const yahooSince = currentSinceFromHistory(history, "yahoo1", yahoo1?.item?.url || null);

  const current = {
    ok: Boolean(abc1?.ok || cbs1?.ok || usat1?.ok || nbc1?.ok || cnn1?.ok || guardian1?.ok || ap1?.ok || latimes1?.ok || npr1?.ok || bbc1?.ok || fox1?.ok || yahoo1?.ok),
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
      guardian1: {
        ok: Boolean(guardian1?.ok),
        updatedAt: guardian1?.updatedAt || null,
        error: guardian1?.error || null,
        runId: guardian1?.runId || null,
        since: guardianSince,
        item: guardian1?.item || null,
      },
      ap1: {
        ok: Boolean(ap1?.ok),
        updatedAt: ap1?.updatedAt || null,
        error: ap1?.error || null,
        runId: ap1?.runId || null,
        since: apSince,
        item: ap1?.item || null,
      },
      latimes1: {
        ok: Boolean(latimes1?.ok),
        updatedAt: latimes1?.updatedAt || null,
        error: latimes1?.error || null,
        runId: latimes1?.runId || null,
        since: latimesSince,
        item: latimes1?.item || null,
      },
      npr1: {
        ok: Boolean(npr1?.ok),
        updatedAt: npr1?.updatedAt || null,
        error: npr1?.error || null,
        runId: npr1?.runId || null,
        since: nprSince,
        item: npr1?.item || null,
      },
      bbc1: {
        ok: Boolean(bbc1?.ok),
        updatedAt: bbc1?.updatedAt || null,
        error: bbc1?.error || null,
        runId: bbc1?.runId || null,
        since: bbcSince,
        item: bbc1?.item || null,
      },
      fox1: {
        ok: Boolean(fox1?.ok),
        updatedAt: fox1?.updatedAt || null,
        error: fox1?.error || null,
        runId: fox1?.runId || null,
        since: foxSince,
        item: fox1?.item || null,
      },
      yahoo1: {
        ok: Boolean(yahoo1?.ok),
        updatedAt: yahoo1?.updatedAt || null,
        error: yahoo1?.error || null,
        runId: yahoo1?.runId || null,
        since: yahooSince,
        item: yahoo1?.item || null,
      },
    },
  };

  writeJSON("current.json", current);

  const unified = {
    ok: Boolean(abc1?.ok || cbs1?.ok || usat1?.ok || nbc1?.ok || cnn1?.ok || guardian1?.ok || ap1?.ok || latimes1?.ok || npr1?.ok || bbc1?.ok || fox1?.ok || yahoo1?.ok),
    generatedAt,
    items: [
      abc1?.item ? { source: "abc1", updatedAt: abc1.updatedAt, since: abcSince, ...abc1.item } : null,
      cbs1?.item ? { source: "cbs1", updatedAt: cbs1.updatedAt, since: cbsSince, ...cbs1.item } : null,
      usat1?.item ? { source: "usat1", updatedAt: usat1.updatedAt, since: usatSince, ...usat1.item } : null,
      nbc1?.item ? { source: "nbc1", updatedAt: nbc1.updatedAt, since: nbcSince, ...nbc1.item } : null,
      cnn1?.item ? { source: "cnn1", updatedAt: cnn1.updatedAt, since: cnnSince, ...cnn1.item } : null,
      guardian1?.item
        ? { source: "guardian1", updatedAt: guardian1.updatedAt, since: guardianSince, ...guardian1.item }
        : null,
      ap1?.item ? { source: "ap1", updatedAt: ap1.updatedAt, since: apSince, ...ap1.item } : null,
      latimes1?.item
        ? { source: "latimes1", updatedAt: latimes1.updatedAt, since: latimesSince, ...latimes1.item }
        : null,
      npr1?.item ? { source: "npr1", updatedAt: npr1.updatedAt, since: nprSince, ...npr1.item } : null,
      bbc1?.item ? { source: "bbc1", updatedAt: bbc1.updatedAt, since: bbcSince, ...bbc1.item } : null,
      fox1?.item ? { source: "fox1", updatedAt: fox1.updatedAt, since: foxSince, ...fox1.item } : null,
      yahoo1?.item ? { source: "yahoo1", updatedAt: yahoo1.updatedAt, since: yahooSince, ...yahoo1.item } : null,
    ].filter(Boolean),
  };

  writeJSON("unified.json", unified);

  console.log("✅ Wrote docs/data/current.json");
  console.log("✅ Wrote docs/data/unified.json");
  console.log("✅ Wrote docs/data/history.json");
  console.log("✅ Wrote docs/data/timeline.json");
  console.log("✅ Wrote docs/data/top10_abc_latest.json");
  console.log("✅ Wrote docs/data/top10_abc_events_24h.json");
  console.log("✅ Wrote docs/data/top10_abc_events_history.json");
  console.log("✅ Wrote docs/data/top10_abc_history.json");
}

run().catch((err) => {
  console.error("❌ Scrape failed hard");
  console.error(err);

  ensureDir(DATA_DIR);

  const generatedAt = new Date().toISOString();
  writeJSON("current.json", { ok: false, generatedAt, error: String(err) });
  writeJSON("unified.json", { ok: false, generatedAt, items: [], error: String(err) });
  writeJSON("timeline.json", { ok: false, generatedAt, hours: TIMELINE_HOURS, events: [], error: String(err) });
  writeJSON("top10_abc_latest.json", { ok: false, generatedAt, source_id: TOP10_SOURCE_ID, observedAt: generatedAt, items: [], error: String(err) });
  writeJSON("top10_abc_events_24h.json", { ok: false, generatedAt, source_id: TOP10_SOURCE_ID, hours: 24, events: [], error: String(err) });
  writeJSON("top10_abc_events_history.json", { ok: false, generatedAt, source_id: TOP10_SOURCE_ID, events: [], error: String(err) });
  writeJSON("top10_abc_history.json", { ok: false, generatedAt, source_id: TOP10_SOURCE_ID, runs: [], error: String(err) });

  process.exit(1);
});
