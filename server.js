// server.js
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";
import { fileURLToPath } from "url";

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
  const baseSource = (id, name, homeUrl) => ({
    id,
    name,
    homeUrl,
    updatedAt: null,
    ok: false,
    error: "Not refreshed yet",
    stale: false,
    runId: null,
    archive: null,
    items: [],
    item: null, // for hero sources
  });

  const base = {
    generatedAt: null,
    sources: {
      abc: baseSource("abc", "ABC News", "https://abcnews.go.com/"),
      cbs: baseSource("cbs", "CBS News", "https://www.cbsnews.com/"),

      abc1: baseSource("abc1", "ABC News", "https://abcnews.go.com/"),
      cbs1: baseSource("cbs1", "CBS News", "https://www.cbsnews.com/"),
      usat1: baseSource("usat1", "USA Today", "https://www.usatoday.com/"),
      nbc1: baseSource("nbc1", "NBC News", "https://www.nbcnews.com/"),
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
        abc1: { ...base.sources.abc1, ...(raw.sources.abc1 || {}) },
        cbs1: { ...base.sources.cbs1, ...(raw.sources.cbs1 || {}) },
        usat1: { ...base.sources.usat1, ...(raw.sources.usat1 || {}) },
        nbc1: { ...base.sources.nbc1, ...(raw.sources.nbc1 || {}) },
      },
    };
  }

  if (raw.abc || raw.cbs || raw.abc1 || raw.cbs1 || raw.usat1 || raw.nbc1) {
    return {
      ...base,
      generatedAt: raw.generatedAt || null,
      sources: {
        ...base.sources,
        abc: { ...base.sources.abc, ...(raw.abc || {}) },
        cbs: { ...base.sources.cbs, ...(raw.cbs || {}) },
        abc1: { ...base.sources.abc1, ...(raw.abc1 || {}) },
        cbs1: { ...base.sources.cbs1, ...(raw.cbs1 || {}) },
        usat1: { ...base.sources.usat1, ...(raw.usat1 || {}) },
        nbc1: { ...base.sources.nbc1, ...(raw.nbc1 || {}) },
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

  // ---- Playwright diagnostics ----
  page.on("console", (msg) => {
    try {
      const type = msg.type();
      if (type === "error" || type === "warning") {
        console.log(`[PW console.${type}] ${msg.text()}`.slice(0, 1200));
      }
    } catch {}
  });

  page.on("pageerror", (err) => {
    console.log(`[PW pageerror] ${String(err)}`.slice(0, 1200));
  });

  page.on("requestfailed", (req) => {
    try {
      const fail = req.failure();
      if (fail?.errorText) {
        console.log(`[PW requestfailed] ${fail.errorText} :: ${req.url()}`.slice(0, 1200));
      }
    } catch {}
  });

  page.on("response", (res) => {
    try {
      const s = res.status();
      if (s >= 400) console.log(`[PW response ${s}] ${res.url()}`.slice(0, 1200));
    } catch {}
  });
  // -------------------------------

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

  // Screenshots disabled for now (storage + speed).
  // try { await page.screenshot({ path: pngPath, fullPage: true }); } catch {}

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(snapshotObj, null, 2), "utf8");
  } catch {}

  return { htmlPath, pngPath, jsonPath };
}

// -------- Scrapers (Top headlines / legacy) --------

async function scrapeABCFrontPage({ maxItems = 40, scrollPasses = 6 } = {}) {
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

async function scrapeCBSFrontPage({ scrollPasses = 2 } = {}) {
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

// -------- Hero-only scrapers --------

async function scrapeABCHero() {
  return await withBrowser(async (page) => {
    const runId = `abc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://abcnews.go.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForSelector("main", { timeout: 20000 });
    await page.waitForTimeout(1200);

    const hero = await page.evaluate(() => {
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
      function pickFromSrcset(srcset) {
        if (!srcset) return null;
        const parts = srcset.split(",").map((p) => p.trim()).filter(Boolean);
        let best = null;
        for (const p of parts) {
          const [u, w] = p.split(/\s+/);
          const width = w && w.endsWith("w") ? Number(w.slice(0, -1)) : 0;
          if (!best || width > best.width) best = { url: u, width };
        }
        return best?.url || null;
      }

      const h2 = document.querySelector(
        'main a[data-testid="prism-linkbase"][href] h2[id$="headline"]'
      );
      if (!h2) return { ok: false, error: "ABC headline not found" };

      const a = h2.closest('a[data-testid="prism-linkbase"][href]');
      const title = clean(h2.textContent);
      const url = absUrl(a?.getAttribute("href") || "");

      let imgUrl = null;
      let imgAlt = null;

      const card =
        a?.closest('[data-testid="prism-card"]') ||
        a?.closest('[data-container="band"]') ||
        a?.closest("article") ||
        a?.closest("section") ||
        a?.parentElement;

      if (card) {
        const img = card.querySelector("img[src], img[srcset]");
        if (img) {
          imgAlt = clean(img.getAttribute("alt") || "") || null;
          imgUrl = absUrl(img.getAttribute("src") || "") || null;
          if (!imgUrl) {
            const fromSet = pickFromSrcset(img.getAttribute("srcset") || "");
            imgUrl = fromSet ? absUrl(fromSet) : null;
          }
        }

        if (!imgUrl) {
          const source = card.querySelector("source[srcset]");
          if (source) {
            const fromSet = pickFromSrcset(source.getAttribute("srcset") || "");
            imgUrl = fromSet ? absUrl(fromSet) : null;
          }
        }
      }

      return { ok: Boolean(title && url), title, url, imgUrl, imgAlt };
    });

    let finalUrl = hero?.url ? normalizeUrl(hero.url) : null;
    let finalTitle = cleanText(hero?.title || "");
    let finalImgUrl = hero?.imgUrl ? normalizeUrl(hero.imgUrl) : null;

    if (hero?.ok && finalUrl && !finalImgUrl) {
      try {
        const r = await page.request.get(finalUrl, { timeout: 20000 });
        const html = await r.text();
        const m = html.match(
          /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i
        );
        if (m?.[1]) finalImgUrl = normalizeUrl(m[1]);
      } catch {}
    }

    const item = hero?.ok
      ? {
          title: finalTitle,
          url: finalUrl,
          imgUrl: finalImgUrl,
          imgAlt: hero?.imgAlt || null,
          slotKey: sha1("abc|hero").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "abc1",
      fetchedAt: nowISO(),
      runId,
      item,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "ABC not found"),
    };

    const archive = await archiveRun(page, runId, snapshot);

    return {
      ok: Boolean(item),
      error: snapshot.error,
      updatedAt: nowISO(),
      runId,
      archive,
      item,
    };
  });
}

async function scrapeCBSHero() {
  return await withBrowser(async (page) => {
    const runId = `cbs1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cbsnews.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(1200);

    const hero = await page.evaluate(() => {
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
      function pickFromSrcset(srcset) {
        if (!srcset) return null;
        const parts = srcset.split(",").map((p) => p.trim()).filter(Boolean);
        let best = null;
        for (const p of parts) {
          const [u, dpr] = p.split(/\s+/);
          const mult = dpr && dpr.endsWith("x") ? Number(dpr.slice(0, -1)) : 0;
          if (!best || mult > best.mult) best = { url: u, mult };
        }
        return best?.url || parts[parts.length - 1]?.split(/\s+/)?.[0] || null;
      }

      const firstAnchor = document.querySelector("main article.item a.item__anchor[href]");
      const article =
        firstAnchor?.closest("article.item") || document.querySelector("article.item");

      if (!article) return { ok: false, error: "CBS article.item not found" };

      const a = article.querySelector("a.item__anchor[href]");
      const h = article.querySelector("h4.item__hed");
      const img = article.querySelector("img[src], img[srcset]");

      const title = clean(h?.textContent || "");
      const url = absUrl(a?.getAttribute("href") || "");

      let imgUrl = null;
      let imgAlt = null;

      if (img) {
        imgAlt = clean(img.getAttribute("alt") || "") || null;
        imgUrl = absUrl(img.getAttribute("src") || "") || null;
        if (!imgUrl) {
          const fromSet = pickFromSrcset(img.getAttribute("srcset") || "");
          imgUrl = fromSet ? absUrl(fromSet) : null;
        }
      }

      if (!imgUrl) {
        const source = article.querySelector("source[srcset]");
        if (source) {
          const fromSet = pickFromSrcset(source.getAttribute("srcset") || "");
          imgUrl = fromSet ? absUrl(fromSet) : null;
        }
      }

      return { ok: Boolean(title && url), title, url, imgUrl, imgAlt };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
          imgAlt: hero.imgAlt || null,
          slotKey: sha1("cbs|hero").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "cbs1",
      fetchedAt: nowISO(),
      runId,
      item,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "CBS not found"),
    };

    const archive = await archiveRun(page, runId, snapshot);

    return {
      ok: Boolean(item),
      error: snapshot.error,
      updatedAt: nowISO(),
      runId,
      archive,
      item,
    };
  });
}

async function scrapeUSATHero() {
  return await withBrowser(async (page) => {
    const runId = `usat1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.usatoday.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Hydration can be late.
    await page.waitForTimeout(1200);
    // Wait for network to be mostly idle
    await page
      .waitForFunction(() => {
        return performance.now() - performance.timing.navigationStart > 3000;
      }, { timeout: 25000 })
      .catch(() => {});
    await page.waitForTimeout(600);

    await page
      .waitForSelector('a.gnt_m_he[data-t-l*="|hero"] span.gnt_m_he__lc[data-tb-title]', {
        timeout: 20000,
      })
      .catch(() => {});

    const hero = await page.evaluate(() => {
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
      function pickFromSrcset(srcset) {
        if (!srcset) return null;
        const parts = srcset.split(",").map((p) => p.trim()).filter(Boolean);
        if (!parts.length) return null;

        let best = null;
        for (const p of parts) {
          const [u, dpr] = p.split(/\s+/);
          const mult = dpr && dpr.endsWith("x") ? Number(dpr.slice(0, -1)) : 0;
          if (!best || mult > best.mult) best = { url: u, mult };
        }
        return best?.url || parts[parts.length - 1]?.split(/\s+/)?.[0] || null;
      }

      const a =
        document.querySelector('a.gnt_m_he[data-t-l*="|hero"][href]') ||
        document.querySelector("a.gnt_m_he.gnt_m_he__br[href]") ||
        document.querySelector("a.gnt_m_he[href]");

      if (!a) {
        return {
          ok: false,
          error: "USA Today anchor not found (a.gnt_m_he).",
          debug: {
            hasAnyGntHero: Boolean(document.querySelector("a.gnt_m_he")),
            hasAnyHeroTL: Boolean(document.querySelector('a.gnt_m_he[data-t-l*="|hero"]')),
          },
        };
      }

      const href = a.getAttribute("href") || "";
      const url = absUrl(href);

      const span =
        a.querySelector('span.gnt_m_he__lc[data-tb-title]') ||
        a.querySelector("span.gnt_m_he__lc") ||
        a.querySelector("span.gnt_lbl_lc.gnt_m_he__lc") ||
        a.querySelector("[data-tb-title]") ||
        null;

      const title = clean(span?.textContent || "");

      const img =
        a.querySelector("img.gnt_m_he_i[src], img.gnt_m_he_i[srcset]") ||
        a.querySelector("img[src], img[srcset]") ||
        null;

      let imgUrl = null;
      let imgAlt = null;

      if (img) {
        imgAlt = clean(img.getAttribute("alt") || "") || null;
        imgUrl = absUrl(img.getAttribute("src") || "") || null;
        if (!imgUrl) {
          const fromSet = pickFromSrcset(img.getAttribute("srcset") || "");
          imgUrl = fromSet ? absUrl(fromSet) : null;
        }
      }

      const dek = clean(a.getAttribute("data-c-br") || "") || null;

      const sbt = a.querySelector("[data-c-ms], [data-c-dt], [data-tb-cat-and-date]");
      const label = clean(sbt?.getAttribute("data-c-ms") || "") || null;
      const dt = clean(sbt?.getAttribute("data-c-dt") || "") || null;

      return {
        ok: Boolean(title && url),
        title,
        url,
        imgUrl,
        imgAlt,
        dek,
        label,
        dt,
        debug: {
          href,
          aClass: a.getAttribute("class") || null,
          dataTL: a.getAttribute("data-t-l") || null,
        },
      };
    });

    let finalUrl = hero?.url ? normalizeUrl(hero.url) : null;
    let finalTitle = cleanText(hero?.title || "");
    let finalImgUrl = hero?.imgUrl ? normalizeUrl(hero.imgUrl) : null;

    if (hero?.ok && finalUrl && !finalImgUrl) {
      try {
        const r = await page.request.get(finalUrl, { timeout: 20000 });
        const html = await r.text();
        const m = html.match(
          /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i
        );
        if (m?.[1]) finalImgUrl = normalizeUrl(m[1]);
      } catch {}
    }

    const item = hero?.ok
      ? {
          title: finalTitle,
          url: finalUrl,
          imgUrl: finalImgUrl,
          imgAlt: hero?.imgAlt || null,
          dek: hero?.dek || null,
          label: hero?.label || null,
          dt: hero?.dt || null,
          slotKey: sha1("usat|hero").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "usat1",
      fetchedAt: nowISO(),
      runId,
      item,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "USA Today not found"),
      debug: hero?.debug || null,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return {
      ok: Boolean(item),
      error: snapshot.error,
      updatedAt: nowISO(),
      runId,
      archive,
      item,
    };
  });
}

async function scrapeNBCHero() {
  return await withBrowser(async (page) => {
    const runId = `nbc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.nbcnews.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForSelector("main", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1400);

    const hero = await page.evaluate(() => {
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
      function pickFromSrcset(srcset) {
        if (!srcset) return null;
        const parts = srcset.split(",").map((p) => p.trim()).filter(Boolean);
        if (!parts.length) return null;

        // NBC srcset often uses widths like "762w". Prefer max width.
        let best = null;
        for (const p of parts) {
          const [u, w] = p.split(/\s+/);
          const width = w && w.endsWith("w") ? Number(w.slice(0, -1)) : 0;
          if (!best || width > best.width) best = { url: u, width };
        }
        return best?.url || parts[parts.length - 1]?.split(/\s+/)?.[0] || null;
      }

      const main = document.querySelector("main") || document.body;

      // Primary: multistory lead headline you pasted:
      // <h2 class="multistoryline__headline ..."><a href="...">TITLE</a></h2>
      let story =
        main.querySelector('[data-testid="multi-storyline-container"] .story-item') ||
        main.querySelector(".multistory-container .story-item") ||
        null;

      // If that first story-item doesn't contain the expected headline, find the first that does.
      if (story) {
        const has = story.querySelector("h2.multistoryline__headline a[href]");
        if (!has) {
          const all = Array.from(
            main.querySelectorAll('[data-testid="multi-storyline-container"] .story-item, .multistory-container .story-item')
          );
          story = all.find((s) => s.querySelector("h2.multistoryline__headline a[href]")) || story;
        }
      }

      const a =
        story?.querySelector("h2.multistoryline__headline a[href]") ||
        main.querySelector("h2.multistoryline__headline a[href]") ||
        main.querySelector("h2 a[href]") ||
        null;

      const title = clean(a?.textContent || "");
      const url = absUrl(a?.getAttribute("href") || "");

      // image: prefer picture/source/img near the story
      let imgUrl = null;
      let imgAlt = null;

      const scope =
        a?.closest(".story-item") ||
        a?.closest("[data-contentid]") ||
        story ||
        a?.closest("article") ||
        main;

      if (scope) {
        const img =
          scope.querySelector("picture img[src], img[src], img[srcset]") ||
          null;

        if (img) {
          imgAlt = clean(img.getAttribute("alt") || "") || null;
          imgUrl = absUrl(img.getAttribute("src") || "") || null;
          if (!imgUrl) {
            const fromSet = pickFromSrcset(img.getAttribute("srcset") || "");
            imgUrl = fromSet ? absUrl(fromSet) : null;
          }
        }

        if (!imgUrl) {
          const source = scope.querySelector("picture source[srcset], source[srcset]");
          if (source) {
            const fromSet = pickFromSrcset(source.getAttribute("srcset") || "");
            imgUrl = fromSet ? absUrl(fromSet) : null;
          }
        }
      }

      if (!title || title.length < 8 || !url) {
        return {
          ok: false,
          error: "NBC hero not found (headline anchor missing)",
          debug: {
            hasMultiStory: Boolean(main.querySelector('[data-testid="multi-storyline-container"], .multistory-container')),
            hasAnyMultistoryHeadline: Boolean(main.querySelector("h2.multistoryline__headline a[href]")),
            hasAnyH2Link: Boolean(main.querySelector("h2 a[href]")),
          },
        };
      }

      return { ok: true, title, url, imgUrl, imgAlt };
    });

    let finalUrl = hero?.url ? normalizeUrl(hero.url) : null;
    let finalTitle = cleanText(hero?.title || "");
    let finalImgUrl = hero?.imgUrl ? normalizeUrl(hero.imgUrl) : null;

    if (hero?.ok && finalUrl && !finalImgUrl) {
      try {
        const r = await page.request.get(finalUrl, { timeout: 20000 });
        const html = await r.text();
        const m = html.match(
          /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i
        );
        if (m?.[1]) finalImgUrl = normalizeUrl(m[1]);
      } catch {}
    }

    const item = hero?.ok
      ? {
          title: finalTitle,
          url: finalUrl,
          imgUrl: finalImgUrl,
          imgAlt: hero?.imgAlt || null,
          slotKey: sha1("nbc|hero").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "nbc1",
      fetchedAt: nowISO(),
      runId,
      item,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "NBC not found"),
      debug: hero?.debug || null,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return {
      ok: Boolean(item),
      error: snapshot.error,
      updatedAt: nowISO(),
      runId,
      archive,
      item,
    };
  });
}

// -------- Archive + Diff helpers (legacy top headlines) --------

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
    ...moved.map((x) => ({
      type: "moved",
      fromRank: x.fromRank,
      toRank: x.toRank,
      title: x.title,
      url: x.url,
    })),
    ...retitled.map((x) => ({
      type: "retitled",
      rank: x.rank,
      fromTitle: x.fromTitle,
      toTitle: x.toTitle,
      url: x.url,
    })),
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

// -------- Core refresh (shared by API + CLI) --------

async function refreshSources({ id = "", maxItems = 40, scrollPasses = 6 } = {}) {
  cache = ensureCacheShape(cache);

  const whichId = String(id || "").toLowerCase(); // abc | cbs | abc1 | cbs1 | usat1 | nbc1 | "" (all)
  const toRun = whichId ? [whichId] : ["abc", "cbs", "abc1", "cbs1", "usat1", "nbc1"];

  for (const which of toRun) {
    let result;

    if (which === "abc") result = await scrapeABCFrontPage({ maxItems, scrollPasses });
    else if (which === "cbs") result = await scrapeCBSFrontPage({ scrollPasses: 2 });
    else if (which === "abc1") result = await scrapeABCHero();
    else if (which === "cbs1") result = await scrapeCBSHero();
    else if (which === "usat1") result = await scrapeUSATHero();
    else if (which === "nbc1") result = await scrapeNBCHero();
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
      item: result?.item ?? null,
    };
  }

  cache.generatedAt = nowISO();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");

  return cache;
}

// -------- API (local use only) --------

app.get("/api/headlines", (req, res) => {
  cache = ensureCacheShape(cache);
  res.json(cache);
});

app.post("/api/refresh", async (req, res) => {
  const id = (req.body?.id || "").toLowerCase();
  const maxItems = Number(req.body?.x ?? 40);
  const scrollPasses = Number(req.body?.scrollPasses ?? 6);

  try {
    const out = await refreshSources({ id, maxItems, scrollPasses });
    res.json(out);
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

// -------- Entrypoints --------

// IMPORTANT: only start the server when running `node server.js`.
const __filename = fileURLToPath(import.meta.url);

// CLI mode (for GitHub Actions): `node server.js --refresh`
// Optional: `--id usat1` to refresh one
if (process.argv[1] === __filename && process.argv.includes("--refresh")) {
  const idIdx = process.argv.indexOf("--id");
  const id = idIdx >= 0 ? String(process.argv[idIdx + 1] || "") : "";
  refreshSources({ id })
    .then(() => {
      console.log(`Wrote ${CACHE_FILE}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Refresh failed:", err?.message || err);
      process.exit(1);
    });
} else if (process.argv[1] === __filename) {
  app.listen(PORT, () => {
    console.log(`Newsboard API + UI: http://localhost:${PORT}`);
  });
}

// Exports for scripts/run-scrape.js and local tooling
export {
  scrapeABCFrontPage,
  scrapeCBSFrontPage,
  scrapeABCHero,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  refreshSources,
};