import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";

const app = express();
app.use(express.json());
app.use(express.static("."));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = 3001;
const ARCHIVE_DIR = path.join(process.cwd(), "archive");
const CACHE_FILE = path.join(process.cwd(), "cache.json");

if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function nowISO() {
  return new Date().toISOString();
}

function cleanText(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return u;
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function ensureCacheShape(raw) {
  const base = {
    generatedAt: null,
    sources: {
      abc: {
        id: "abc",
        name: "ABC News",
        homeUrl: "https://abcnews.go.com/",
        updatedAt: null,
        ok: false,
        error: "Not refreshed yet",
        stale: false,
        runId: null,
        archive: null,
        items: [],
      },
      cbs: {
        id: "cbs",
        name: "CBS News",
        homeUrl: "https://www.cbsnews.com/",
        updatedAt: null,
        ok: false,
        error: "Not refreshed yet",
        stale: false,
        runId: null,
        archive: null,
        items: [],
      },
    },
  };

  if (!raw || typeof raw !== "object") return base;

  if (raw.sources && typeof raw.sources === "object") {
    return {
      ...base,
      ...raw,
      sources: {
        ...base.sources,
        ...raw.sources,
        abc: { ...base.sources.abc, ...(raw.sources.abc || {}) },
        cbs: { ...base.sources.cbs, ...(raw.sources.cbs || {}) },
      },
    };
  }

  if (raw.abc || raw.cbs) {
    return {
      ...base,
      generatedAt: raw.generatedAt || null,
      sources: {
        ...base.sources,
        abc: { ...base.sources.abc, ...(raw.abc || {}) },
        cbs: { ...base.sources.cbs, ...(raw.cbs || {}) },
      },
    };
  }

  return base;
}

async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function archiveRun(page, runId, snapshotObj) {
  const htmlPath = path.join(ARCHIVE_DIR, `${runId}.html`);
  const pngPath = path.join(ARCHIVE_DIR, `${runId}.png`);
  const jsonPath = path.join(ARCHIVE_DIR, `${runId}.json`);

  try {
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
  } catch {}
  try {
    await page.screenshot({ path: pngPath, fullPage: true });
  } catch {}
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(snapshotObj, null, 2), "utf8");
  } catch {}

  return { htmlPath, pngPath, jsonPath };
}

// -------- Scrapers --------

export async function scrapeABCFrontPage({ maxItems = 40, scrollPasses = 6 } = {}) {
  return await withBrowser(async (page) => {
    const runId = `abc_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://abcnews.go.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForSelector("main", { timeout: 20000 });
    await page.waitForTimeout(1500);

    for (let i = 0; i < scrollPasses; i++) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(700);
    }

    const rows = await page.evaluate((limit) => {
      function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
      }
      function absUrl(href) {
        try {
          return new URL(href, window.location.origin).toString();
        } catch {
          return null;
        }
      }

      const main = document.querySelector("main") || document.body;
      const bands = Array.from(main.querySelectorAll('[data-container="band"]'));
      const cards = Array.from(main.querySelectorAll('[data-testid="prism-card"]'));

      const out = [];
      const seenUrl = new Set();

      function bandIndexFor(el) {
        const band = el.closest('[data-container="band"]');
        if (!band) return -1;
        return bands.indexOf(band);
      }

      for (let cardIdx = 0; cardIdx < cards.length; cardIdx++) {
        const card = cards[cardIdx];

        const h2 =
          card.querySelector('h2[id$="headline"]') ||
          card.querySelector("h2") ||
          null;

        const title = clean(h2?.textContent || "");
        if (!title || title.length < 8) continue;

        const a =
          (h2 && h2.closest('a[data-testid="prism-linkbase"][href]')) ||
          card.querySelector('a[data-testid="prism-linkbase"][href]') ||
          null;

        const href = a?.getAttribute("href") || "";
        const url = absUrl(href);
        if (!url) continue;

        if (seenUrl.has(url)) continue;
        seenUrl.add(url);

        const bandIdx = bandIndexFor(card);

        let bandCardIndex = -1;
        if (bandIdx >= 0) {
          const band = bands[bandIdx];
          const bandCards = Array.from(band.querySelectorAll('[data-testid="prism-card"]'));
          bandCardIndex = bandCards.indexOf(card);
        }

        const domSig = clean(
          `${card.tagName}|${card.getAttribute("data-testid") || ""}|${bandIdx}|${bandCardIndex}`
        );

        out.push({ title, url, bandIdx, bandCardIndex, domSig });

        if (out.length >= limit) break;
      }

      return out;
    }, maxItems);

    let items = rows.map((r, i) => {
      const url = normalizeUrl(r.url);
      const title = cleanText(r.title);
      const slotKey = sha1(`${r.bandIdx}|${r.bandCardIndex}|${r.domSig}`).slice(0, 12);
      return {
        rank: i + 1,
        title,
        url,
        slotKey,
        bandIdx: r.bandIdx,
        bandCardIndex: r.bandCardIndex,
      };
    });

    items = items.slice(0, 10);
    if (items.length >= 2) items.splice(1, 1); // drop position #2
    items = items.map((it, idx) => ({ ...it, rank: idx + 1 }));

    const snapshot = { id: "abc", fetchedAt: nowISO(), runId, items };
    const archive = await archiveRun(page, runId, snapshot);

    return {
      ok: items.length > 0,
      error: items.length > 0 ? null : "No ABC prism-card headlines extracted",
      updatedAt: nowISO(),
      runId,
      archive,
      items,
    };
  });
}

export async function scrapeCBSFrontPage({ scrollPasses = 2 } = {}) {
  return await withBrowser(async (page) => {
    const runId = `cbs_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cbsnews.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForSelector("#component-latest-news", { timeout: 20000 });
    await page.waitForTimeout(1200);

    for (let i = 0; i < scrollPasses; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(600);
    }

    const rows = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
      }
      function absUrl(href) {
        try {
          return new URL(href, window.location.origin).toString();
        } catch {
          return null;
        }
      }

      const out = [];
      const root = document.querySelector("#component-latest-news");
      if (!root) return out;

      const articles = Array.from(root.querySelectorAll("article.item"));
      const seen = new Set();

      for (let idx = 0; idx < articles.length; idx++) {
        const art = articles[idx];
        const a = art.querySelector("a.item__anchor[href]");
        const h = art.querySelector("h4.item__hed");

        const title = clean(h?.textContent || "");
        const url = absUrl(a?.getAttribute("href") || "");

        if (!title || !url) continue;
        if (title.length < 6) continue;
        if (seen.has(url)) continue;
        seen.add(url);

        const domSig = `cbs|latest-news|articleIndex:${idx}`;
        out.push({ title, url, domSig });

        if (out.length >= 10) break;
      }

      return out;
    });

    const items = rows.map((r, i) => {
      const url = normalizeUrl(r.url);
      const title = cleanText(r.title);
      const slotKey = sha1(r.domSig).slice(0, 12);
      return { rank: i + 1, title, url, slotKey };
    });

    const snapshot = { id: "cbs", fetchedAt: nowISO(), runId, items };
    const archive = await archiveRun(page, runId, snapshot);

    return {
      ok: items.length > 0,
      error: items.length > 0 ? null : "No CBS headlines extracted",
      updatedAt: nowISO(),
      runId,
      archive,
      items,
    };
  });
}

// -------- Archive + Diff helpers --------

function listSnapshotFiles(id) {
  return fs
    .readdirSync(ARCHIVE_DIR)
    .filter((f) => f.startsWith(`${id}_`) && f.endsWith(".json"))
    .map((f) => path.join(ARCHIVE_DIR, f))
    .sort();
}

function readSnapshot(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

function diffSnapshots(prevSnap, currSnap) {
  const prevItems = Array.isArray(prevSnap?.items) ? prevSnap.items : [];
  const currItems = Array.isArray(currSnap?.items) ? currSnap.items : [];

  const prevByUrl = new Map(prevItems.map((it) => [it.url, it]));
  const currByUrl = new Map(currItems.map((it) => [it.url, it]));

  const prevBySlot = new Map(prevItems.map((it) => [it.slotKey, it]));
  const currBySlot = new Map(currItems.map((it) => [it.slotKey, it]));

  const added = [];
  const removed = [];
  const moved = [];
  const slotChanged = [];
  const retitled = [];

  for (const it of currItems) {
    const prev = prevByUrl.get(it.url);
    if (!prev) {
      added.push(it);
      continue;
    }
    if (prev.rank !== it.rank) {
      moved.push({ url: it.url, title: it.title, fromRank: prev.rank, toRank: it.rank });
    }
    if ((prev.title || "") !== (it.title || "")) {
      retitled.push({ url: it.url, fromTitle: prev.title, toTitle: it.title, rank: it.rank });
    }
  }

  for (const it of prevItems) {
    if (!currByUrl.has(it.url)) removed.push(it);
  }

  for (const [slotKey, curr] of currBySlot.entries()) {
    const prev = prevBySlot.get(slotKey);
    if (!prev) continue;
    if (prev.url !== curr.url || prev.title !== curr.title) {
      slotChanged.push({
        slotKey,
        from: { rank: prev.rank, title: prev.title, url: prev.url },
        to: { rank: curr.rank, title: curr.title, url: curr.url },
      });
    }
  }

  const changeLog = [
    ...added.map((x) => ({ type: "added", rank: x.rank, title: x.title, url: x.url })),
    ...removed.map((x) => ({ type: "removed", rank: x.rank, title: x.title, url: x.url })),
    ...moved.map((x) => ({ type: "moved", fromRank: x.fromRank, toRank: x.toRank, title: x.title, url: x.url })),
    ...retitled.map((x) => ({ type: "retitled", rank: x.rank, fromTitle: x.fromTitle, toTitle: x.toTitle, url: x.url })),
    ...slotChanged.map((x) => ({ type: "slotChanged", slotKey: x.slotKey, from: x.from, to: x.to })),
  ].sort((a, b) => {
    const ar = Number.isFinite(a.rank) ? a.rank : (Number.isFinite(a.toRank) ? a.toRank : 999);
    const br = Number.isFinite(b.rank) ? b.rank : (Number.isFinite(b.toRank) ? b.toRank : 999);
    return ar - br;
  });

  return {
    prev: { runId: prevSnap.runId, fetchedAt: prevSnap.fetchedAt },
    curr: { runId: currSnap.runId, fetchedAt: currSnap.fetchedAt },
    counts: {
      added: added.length,
      removed: removed.length,
      moved: moved.length,
      retitled: retitled.length,
      slotChanged: slotChanged.length,
      totalChanges: changeLog.length,
    },
    changeLog,
  };
}

// -------- Load cache --------

let cache = ensureCacheShape(null);
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    cache = ensureCacheShape(raw);
  }
} catch {
  cache = ensureCacheShape(null);
}

// -------- API --------

app.get("/api/headlines", (req, res) => {
  cache = ensureCacheShape(cache);
  res.json(cache);
});

app.post("/api/refresh", async (req, res) => {
  cache = ensureCacheShape(cache);

  const id = (req.body?.id || "").toLowerCase(); // abc | cbs | "" (all)
  const maxItems = Number(req.body?.x ?? 40);
  const scrollPasses = Number(req.body?.scrollPasses ?? 6);

  const toRun = id ? [id] : ["abc", "cbs"];

  try {
    for (const which of toRun) {
      let result;
      if (which === "abc") result = await scrapeABCFrontPage({ maxItems, scrollPasses });
      else if (which === "cbs") result = await scrapeCBSFrontPage({ scrollPasses: 2 });
      else throw new Error(`Unknown source id: ${which}`);

      cache.sources[which] = {
        ...cache.sources[which],
        updatedAt: result?.updatedAt ?? nowISO(),
        ok: Boolean(result?.ok),
        error: result?.error ?? null,
        stale: !Boolean(result?.ok),
        runId: result?.runId ?? null,
        archive: result?.archive ?? null,
        items: Array.isArray(result?.items) ? result.items : [],
      };
    }

    cache.generatedAt = nowISO();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    res.json(cache);
  } catch (err) {
    cache.generatedAt = nowISO();
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch {}
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/api/diff", (req, res) => {
  const id = (req.query?.id || "abc").toLowerCase();
  try {
    const files = listSnapshotFiles(id);
    if (files.length < 2) {
      return res.status(400).json({
        ok: false,
        error: `Need at least 2 snapshots for ${id}. Run /api/refresh twice.`,
        id,
        snapshotsFound: files.length,
      });
    }

    const prevSnap = readSnapshot(files[files.length - 2]);
    const currSnap = readSnapshot(files[files.length - 1]);

    return res.json({
      ok: true,
      id,
      diff: diffSnapshots(prevSnap, currSnap),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, id, error: err?.message || String(err) });
  }
});

/**
 * New: history feed for the drawer.
 * Returns last N snapshots and diffs between each consecutive pair.
 *
 * GET /api/history?id=abc&limit=20
 */
app.get("/api/history", (req, res) => {
  const id = (req.query?.id || "abc").toLowerCase();
  const limit = Math.max(2, Math.min(80, Number(req.query?.limit || 20)));

  try {
    const filesAll = listSnapshotFiles(id);
    const files = filesAll.slice(Math.max(0, filesAll.length - limit));

    const snaps = files.map((p) => {
      const s = readSnapshot(p);
      return {
        runId: s.runId,
        fetchedAt: s.fetchedAt,
        count: Array.isArray(s.items) ? s.items.length : 0,
        path: p,
      };
    });

    // diffs[i] describes changes from snaps[i-1] -> snaps[i]
    const diffs = [];
    for (let i = 1; i < files.length; i++) {
      const prevSnap = readSnapshot(files[i - 1]);
      const currSnap = readSnapshot(files[i]);
      const d = diffSnapshots(prevSnap, currSnap);
      diffs.push({
        changedAt: currSnap.fetchedAt,
        prevRunId: prevSnap.runId,
        currRunId: currSnap.runId,
        counts: d.counts,
        changeLog: d.changeLog,
      });
    }

    res.json({ ok: true, id, totalSnapshots: filesAll.length, returned: snaps.length, snaps, diffs });
  } catch (err) {
    res.status(500).json({ ok: false, id, error: err?.message || String(err) });
  }
});

if (process.env.START_SERVER === "1") {
  app.listen(PORT, () => {
    console.log(`Newsboard API + UI: http://localhost:${PORT}`);
  });
}

