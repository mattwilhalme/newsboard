// server.js
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

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
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

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(obj) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function ensureCacheShape(raw) {
  const baseSource = (id, name, homeUrl) => ({
    id,
    name,
    homeUrl,
    updatedAt: null,
    ok: false,
    error: "Not refreshed yet",
    runId: null,
    archive: null,
    item: null,
  });

  const base = {
    generatedAt: null,
    sources: {
      abc1: baseSource("abc1", "ABC News", "https://abcnews.go.com/"),
      cbs1: baseSource("cbs1", "CBS News", "https://www.cbsnews.com/"),
      usat1: baseSource("usat1", "USA Today", "https://www.usatoday.com/"),
      nbc1: baseSource("nbc1", "NBC News", "https://www.nbcnews.com/"),
      cnn1: baseSource("cnn1", "CNN", "https://www.cnn.com/"),
    },
  };

  if (!raw || typeof raw !== "object") return base;

  const merged = {
    ...base,
    ...raw,
    sources: { ...base.sources, ...(raw.sources || {}) },
  };

  for (const k of Object.keys(base.sources)) {
    merged.sources[k] = { ...base.sources[k], ...(merged.sources[k] || {}) };
  }

  return merged;
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

  page.on("pageerror", (err) => console.log("[PW pageerror]", String(err).slice(0, 900)));

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
  const jsonPath = path.join(ARCHIVE_DIR, `${runId}.json`);

  try { fs.writeFileSync(htmlPath, await page.content(), "utf8"); } catch {}
  try { fs.writeFileSync(jsonPath, JSON.stringify(snapshotObj, null, 2), "utf8"); } catch {}

  return { htmlPath, jsonPath };
}

/* ---------------------------
   ABC (single top item)
--------------------------- */
async function scrapeABCHero() {
  return await withBrowser(async (page) => {
    const runId = `abc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://abcnews.go.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("main", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const hero = await page.evaluate(() => {
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){ try{ return new URL(h, location.origin).toString(); } catch { return null; } }

      const main = document.querySelector("main") || document.body;

      const first =
        main.querySelector('a[data-testid="prism-linkbase"][href]') ||
        main.querySelector('a[href*="/"]');

      if (!first) return { ok:false, error:"ABC: no link found" };

      const url = abs(first.getAttribute("href"));
      const title = clean(first.getAttribute("aria-label") || first.textContent || "");

      if (!url || !title || title.length < 8) return { ok:false, error:"ABC: missing url/title" };

      const scope = first.closest('[data-testid="prism-card"]') || first.closest("article") || main;
      const img = scope.querySelector("img[src]");
      const imgUrl = img?.getAttribute("src") ? abs(img.getAttribute("src")) : null;

      return { ok:true, url, title, imgUrl };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("abc1|top").slice(0, 12),
    } : null;

    const snapshot = {
      id: "abc1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "ABC not found"),
      item,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   CBS (single top item) - target item__thumb + item__hed
--------------------------- */
async function scrapeCBSHero() {
  return await withBrowser(async (page) => {
    const runId = `cbs1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cbsnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Wait for the card structure you pasted (thumb + hed)
    await page
      .waitForSelector('main a[href] span.item__thumb img[src], main a[href] h4.item__hed', { timeout: 25000 })
      .catch(() => {});
    await page.waitForTimeout(900);

    const hero = await page.evaluate(() => {
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){ try{ return new URL(h, location.origin).toString(); } catch { return null; } }
      function bestFromSrcset(srcset){
        if (!srcset) return null;
        const parts = srcset.split(",").map(p => p.trim()).filter(Boolean);
        // prefer last (often 2x) or largest width if present
        let best = null;
        for (const p of parts) {
          const [u, d] = p.split(/\s+/); // "1x" / "2x" or "640w"
          let score = 0;
          if (d && d.endsWith("x")) score = Number(d.slice(0, -1)) || 0;
          if (d && d.endsWith("w")) score = Number(d.slice(0, -1)) || 0;
          if (!best || score > best.score) best = { url: u, score };
        }
        return best?.url || parts[parts.length - 1].split(/\s+/)[0] || null;
      }
      function isVisible(el){
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r && r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight * 1.25;
      }

      const main = document.querySelector("main") || document.body;

      // Candidate anchors that look like the story cards you pasted
      const anchors = Array.from(main.querySelectorAll('a[href]'))
        .map(a => {
          const img = a.querySelector("span.item__thumb img[src]") || a.querySelector(".item__thumb img[src]");
          const hed = a.querySelector("h4.item__hed");
          const url = abs(a.getAttribute("href"));
          const title = clean(hed?.textContent || a.getAttribute("aria-label") || "");
          const r = a.getBoundingClientRect();
          return { a, img, hed, url, title, top: r?.top ?? 1e9, left: r?.left ?? 1e9 };
        })
        .filter(x =>
          x.url &&
          x.title &&
          x.title.length >= 12 &&
          x.url.startsWith("https://www.cbsnews.com/") &&
          x.url.includes("/news/") &&
          !x.url.includes("/video/") &&
          x.img &&
          isVisible(x.a)
        );

      if (!anchors.length) {
        return { ok:false, error:"CBS: missing url/title", debug:{ reason:"no item__thumb + item__hed anchors" } };
      }

      // Pick whichever card appears first on the page
      anchors.sort((a,b) => (a.top - b.top) || (a.left - b.left));
      const best = anchors[0];

      let imgUrl = null;
      const src = best.img.getAttribute("src");
      const srcset = best.img.getAttribute("srcset");
      imgUrl = bestFromSrcset(srcset) || src || null;
      imgUrl = imgUrl ? abs(imgUrl) : null;

      return { ok:true, url: best.url, title: best.title, imgUrl, debug:{ pickedUrl: best.url } };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("cbs1|top").slice(0, 12),
    } : null;

    const snapshot = {
      id: "cbs1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "CBS not found"),
      debug: hero?.debug || null,
      item,
    };

    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   USA Today (single top item) - target tb headline span
--------------------------- */
async function scrapeUSATHero() {
  return await withBrowser(async (page) => {
    const runId = `usat1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.usatoday.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){ try{ return new URL(h, location.origin).toString(); } catch { return null; } }
      function isVisible(el){
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width < 2 || r.height < 2) return false;
        return r.bottom > 0 && r.top < window.innerHeight * 1.25;
      }

      const main = document.querySelector("main") || document.body;

      const spans = Array.from(
        main.querySelectorAll('span[data-tb-shadow-region-title], span[data-tb-title]')
      )
        .map(sp => {
          const text = clean(sp.textContent || "");
          const r = sp.getBoundingClientRect();
          return { sp, text, top: r?.top ?? 1e9, left: r?.left ?? 1e9, ok: text.length >= 15 };
        })
        .filter(x => x.ok && isVisible(x.sp));

      if (!spans.length) return { ok:false, error:"USAT: no tb headline span found" };

      spans.sort((a,b) => (a.top - b.top) || (a.left - b.left));
      const bestSpan = spans[0].sp;
      const title = clean(bestSpan.textContent || "");

      const a =
        bestSpan.closest("a[href]") ||
        bestSpan.parentElement?.closest("a[href]") ||
        null;

      if (!a) return { ok:false, error:"USAT: headline span has no enclosing link" };

      const url = abs(a.getAttribute("href"));
      if (!url || !title || title.length < 8) return { ok:false, error:"USAT: missing url/title" };

      const scope =
        a.closest("article") ||
        a.closest("section") ||
        a.closest("div") ||
        main;

      const imgs = Array.from(scope.querySelectorAll("img"))
        .map(img => {
          const src = img.getAttribute("src") || "";
          const r = img.getBoundingClientRect();
          return { src, area: (r?.width ?? 0) * (r?.height ?? 0) };
        })
        .filter(x => x.src && x.area > 3000);

      imgs.sort((a,b) => b.area - a.area);
      const imgUrl = imgs[0]?.src ? abs(imgs[0].src) : null;

      return { ok:true, url, title, imgUrl };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("usat1|top").slice(0, 12),
    } : null;

    const snapshot = {
      id: "usat1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "USAT not found"),
      item,
    };

    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   NBC (single top item) - pick whichever appears first
--------------------------- */
async function scrapeNBCHero() {
  return await withBrowser(async (page) => {
    const runId = `nbc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.nbcnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("main", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1400);

    const hero = await page.evaluate(() => {
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){ try{ return new URL(h, location.origin).toString(); } catch { return null; } }

      const main = document.querySelector("main") || document.body;
      const candidates = [];

      function pushAnchor(a, reason){
        if (!a) return;
        const title = clean(a.textContent || a.getAttribute("aria-label") || "");
        const url = abs(a.getAttribute("href"));
        if (!url || !title || title.length < 8) return;

        const r = a.getBoundingClientRect();
        if (!r || r.width < 2 || r.height < 2) return;

        candidates.push({ a, url, title, top: r.top ?? 1e9, left: r.left ?? 1e9, reason });
      }

      for (const a of Array.from(main.querySelectorAll('h2.multistoryline__headline a[href], h2 a[href]')).slice(0, 10)) {
        pushAnchor(a, "h2");
      }

      for (const a of Array.from(main.querySelectorAll('a[href]')).slice(0, 250)) {
        const href = a.getAttribute("href") || "";
        const looksStory =
          href.startsWith("https://www.nbcnews.com/news/") ||
          href.startsWith("/news/") ||
          href.startsWith("/politics/") ||
          href.startsWith("/world/") ||
          href.startsWith("/business/") ||
          href.startsWith("/health/") ||
          href.startsWith("/tech/") ||
          href.startsWith("/science/") ||
          href.startsWith("/investigations/");

        if (!looksStory) continue;
        if (a.closest("nav, header, footer")) continue;

        pushAnchor(a, "story-link");
      }

      if (!candidates.length) return { ok:false, error:"NBC: no link found" };

      candidates.sort((x,y) => (x.top - y.top) || (x.left - y.left));
      const best = candidates[0];

      const scope =
        best.a.closest(".story-item") ||
        best.a.closest("article") ||
        best.a.closest("section") ||
        best.a.parentElement ||
        main;

      const img =
        scope.querySelector("picture img[src]") ||
        scope.querySelector("img[src]") ||
        main.querySelector("picture img[src]") ||
        main.querySelector("img[src]") ||
        null;

      const imgUrl = img?.getAttribute("src") ? abs(img.getAttribute("src")) : null;

      return { ok:true, url: best.url, title: best.title, imgUrl, debug:{ picked: best.reason } };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("nbc1|top").slice(0, 12),
    } : null;

    const snapshot = {
      id: "nbc1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "NBC not found"),
      debug: hero?.debug || null,
      item,
    };

    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   CNN (single top item) - target lead title H2
--------------------------- */
async function scrapeCNNHero() {
  return await withBrowser(async (page) => {
    const runId = `cnn1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cnn.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
  function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
  function abs(h){
    try { return new URL(h, "https://www.cnn.com").toString(); }
    catch { return null; }
  }
  function bestFromSrcset(srcset){
    if (!srcset) return null;
    const parts = srcset.split(",").map(p => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    let best = null;
    for (const p of parts) {
      const [u, w] = p.split(/\s+/);
      const width = w && w.endsWith("w") ? Number(w.slice(0, -1)) : 0;
      if (!best || width > best.width) best = { url: u, width };
    }
    return best?.url || parts[parts.length - 1].split(/\s+/)[0] || null;
  }

  // 1) Pick the lead-package container (prefer the stack_condensed area)
  const container =
    document.querySelector('.stack_condensed__items .container.container_lead-package[data-layout="container_lead-package"]') ||
    document.querySelector('.container.container_lead-package[data-layout="container_lead-package"]') ||
    document.querySelector('.container.container_lead-package') ||
    null;

  if (!container) return { ok:false, error:"CNN: lead-package container not found" };

  // 2) Canonical hero URL from the container title link
  const titleLinkEl =
    container.querySelector('a.container__title-url.container_lead-package__title-url[href]') ||
    container.querySelector('a.container_lead-package__title-url[href]') ||
    null;

  const relHref = titleLinkEl?.getAttribute("href") || null;
  const url = relHref ? abs(relHref) : null;
  if (!url) return { ok:false, error:"CNN: lead-package title link href not found" };

  // 3) Title from the container title h2
  const h2 =
    container.querySelector('h2.container__title_url-text.container_lead-package__title_url-text[data-editable="title"]') ||
    container.querySelector('h2.container_lead-package__title_url-text[data-editable="title"]') ||
    container.querySelector('h2[data-editable="title"]') ||
    null;

  const title = clean(h2?.textContent || "");
  if (!title || title.length < 8) return { ok:false, error:"CNN: missing title in lead-package container" };

  // 4) Find the matching card <li> whose open-link or live-story link matches the container href
  const list = container.querySelector("ul.container_lead-package__field-links") || container;

  const card =
    list.querySelector(`li.container_lead-package__item[data-open-link="${relHref}"]`) ||
    list.querySelector(`li.container_lead-package__item a.container__link[data-link-type="live-story"][href="${relHref}"]`)?.closest("li") ||
    // fallback: selected item, but only if it’s a live-story, not a video card
    list.querySelector('li.container_lead-package__item.container_lead-package__selected a[data-link-type="live-story"]')?.closest("li") ||
    null;

  if (!card) {
    return { ok:false, error:"CNN: matching lead card not found (href mismatch)" };
  }

  // 5) Image: prefer data-url inside THIS card; fall back to <img>
  const media =
    card.querySelector(".container__item-media.container_lead-package__item-media") ||
    card.querySelector(".container__item-media") ||
    card;

  let imgUrl = null;

  const comp = media.querySelector('.image[data-url]');
  if (comp?.getAttribute("data-url")) {
    imgUrl = comp.getAttribute("data-url");
  } else {
    const img =
      media.querySelector("picture img.image__dam-img[src]") ||
      media.querySelector("picture img[src]") ||
      media.querySelector("img.image__dam-img[src]") ||
      media.querySelector("img[src]") ||
      null;

    if (img?.getAttribute("src")) imgUrl = img.getAttribute("src");
    else if (img?.getAttribute("srcset")) imgUrl = bestFromSrcset(img.getAttribute("srcset"));
  }

  imgUrl = imgUrl ? abs(imgUrl) : null;

  return { ok:true, url, title, imgUrl };
});



    // ---- NEW: og:image override when DOM image looks wrong ----
    let finalUrl = hero?.ok ? normalizeUrl(hero.url) : null;
    let finalTitle = hero?.ok ? cleanText(hero.title) : "";
    let finalImgUrl = hero?.ok && hero.imgUrl ? normalizeUrl(hero.imgUrl) : null;

    const looksLikeStill =
      typeof finalImgUrl === "string" &&
      /\/prod\/still-|\/stellar\/prod\/still-|still[_-]\d|_still\.jpg|\/video\//i.test(finalImgUrl);

    const shouldOverrideFromOg =
      Boolean(hero?.ok && finalUrl) &&
      (!finalImgUrl || looksLikeStill || hero?.hasLiveUpdates);

    if (shouldOverrideFromOg) {
      try {
        const r = await page.request.get(finalUrl, { timeout: 20000 });
        const html = await r.text();

        // Try og:image (and fall back to twitter:image if needed)
        const mOg = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
        const mTw = html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);

        const picked = (mOg?.[1] || mTw?.[1] || "").trim();
        if (picked) finalImgUrl = normalizeUrl(picked);
      } catch {}
    }

    const item = hero?.ok ? {
      title: cleanText(finalTitle),
      url: finalUrl,
      imgUrl: finalImgUrl || null,
      slotKey: sha1("cnn1|top").slice(0, 12),
    } : null;

    const snapshot = {
      id: "cnn1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "CNN not found"),
      item,
    };

    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   Refresh / API
--------------------------- */
async function refreshSources({ id = "" } = {}) {
  const cache = ensureCacheShape(readCache());
  const which = String(id || "").toLowerCase();

  const runList = which ? [which] : ["abc1","cbs1","usat1","nbc1","cnn1"];

  for (const sid of runList) {
    let res;

    if (sid === "abc1") res = await scrapeABCHero();
    else if (sid === "cbs1") res = await scrapeCBSHero();
    else if (sid === "usat1") res = await scrapeUSATHero();
    else if (sid === "nbc1") res = await scrapeNBCHero();
    else if (sid === "cnn1") res = await scrapeCNNHero();
    else throw new Error(`Unknown source id: ${sid}`);

    cache.sources[sid] = {
      ...cache.sources[sid],
      ok: res.ok,
      error: res.error || null,
      updatedAt: res.updatedAt || nowISO(),
      runId: res.runId || null,
      archive: res.archive || null,
      item: res.item || null,
    };
  }

  cache.generatedAt = nowISO();
  writeCache(cache);
  return cache;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: nowISO() });
});

app.post("/api/refresh", async (req, res) => {
  try {
    const id = req.body?.id || "";
    const out = await refreshSources({ id });
    res.json({ ok: true, cache: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/cache", (req, res) => {
  const cache = ensureCacheShape(readCache());
  res.json(cache);
});

async function main() {
  const args = new Set(process.argv.slice(2));

  // CLI mode for GitHub Actions
  if (args.has("--refresh")) {
    try {
      await refreshSources({});
      console.log(`Refreshed cache.json at ${nowISO()}`);
      process.exit(0);
    } catch (e) {
      console.error("Refresh failed:", e);
      process.exit(1);
    }
  }

  // Start server only when run directly
  if (process.argv[1] && process.argv[1].endsWith("server.js")) {
    app.listen(PORT, () => console.log(`Newsboard server on http://localhost:${PORT}`));
  }
}

await main();

export {
  scrapeABCHero,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  scrapeCNNHero,
  refreshSources,
};