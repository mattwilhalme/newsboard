const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const STOP = new Set("a an the and or but of to in on at by for from with as is are was were be been being it its this that these those his her their they he she we you your our has have had will would could can may might says said say new latest live updates update breaking news watch video photos what know about after before over under into amid also than how why who when where which some more most now just here there report reports reported exclusive analysis opinion".split(" "));
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|dclid$|ocid$|mc_cid$|mc_eid$|_ga$|_gl$|cmp$|cid$|ref$)/i;

export function normalizeDomain(value) {
  try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return String(value || "").toLowerCase().replace(/^www\./, "").split("/")[0]; }
}

export function canonicalCoverageUrl(value) {
  try {
    const u = new URL(String(value || ""));
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hostname = normalizeDomain(u.hostname);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    u.pathname = u.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return u.href;
  } catch { return ""; }
}

export function headlineTerms(value) {
  return [...new Set(String(value || "").normalize("NFKC").toLowerCase()
    .replace(/^(?:(?:live(?: updates)?|breaking(?: news)?|updates?|watch)\s*[:|–—-]\s*)+/i, "")
    .replace(/\s+[|–—]\s+[^|–—]{2,40}$/u, "")
    .replace(/[^\p{L}\p{N}' -]+/gu, " ").split(/\s+/)
    .map(t => t.replace(/^['-]+|['-]+$/g, "")).filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)))];
}

export function buildGdeltQuery(headline) {
  const original = String(headline || "").trim();
  const entities = [...original.matchAll(/\b(?:[A-Z][\p{L}'-]+)(?:\s+(?:[A-Z][\p{L}'-]+)){1,3}\b/gu)]
    .map(m => m[0].replace(/["()]/g, "").trim()).filter(v => !/^(Breaking News|Live Updates)$/i.test(v));
  const terms = headlineTerms(original);
  const picked = [];
  for (const entity of entities.slice(0, 2)) picked.push(`"${entity}"`);
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (picked.join(" ").toLowerCase().includes(term)) continue;
    picked.push(term);
    if (picked.length >= 4) break;
  }
  if (picked.length < 3) picked.push(...terms.filter(t => !picked.includes(t)).slice(0, 3 - picked.length));
  return `${picked.slice(0, 4).join(" ")} sourcelang:english`.trim();
}

function gdeltDate(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export function coverageWindow(observedAt) {
  const center = Date.parse(String(observedAt || ""));
  if (!Number.isFinite(center)) throw new Error("A valid Newsboard observed timestamp is required");
  return { start: new Date(center - 24 * 3600000), end: new Date(center + 6 * 3600000) };
}

export function buildGdeltUrl(story) {
  const query = buildGdeltQuery(story?.title);
  if (headlineTerms(story?.title).length < 2) throw new Error("Headline does not contain enough distinctive terms");
  const window = coverageWindow(story?.observed_at);
  const url = new URL(GDELT_DOC_URL);
  for (const [key, value] of Object.entries({ query, mode: "artlist", format: "json", maxrecords: "100", sort: "dateasc", startdatetime: gdeltDate(window.start), enddatetime: gdeltDate(window.end) })) url.searchParams.set(key, value);
  return { query, url: url.href, window };
}

function parseSeenAt(value) {
  const raw = String(value || "").trim();
  if (/^\d{14}$/.test(raw)) return new Date(`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(8,10)}:${raw.slice(10,12)}:${raw.slice(12,14)}Z`).toISOString();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function scoreCoverageTitle(candidateTitle, storyTitle) {
  const a = headlineTerms(candidateTitle), b = headlineTerms(storyTitle);
  const shared = a.filter(t => b.includes(t));
  const dice = a.length + b.length ? (2 * shared.length) / (a.length + b.length) : 0;
  const containment = Math.min(a.length, b.length) ? shared.length / Math.min(a.length, b.length) : 0;
  return Number((0.55 * dice + 0.45 * containment).toFixed(4));
}

export function normalizeGdeltResponse(payload, story, { trackedDomains = [], maxResults = 20 } = {}) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  const storyUrl = canonicalCoverageUrl(story?.url);
  const tracked = new Set(trackedDomains.map(normalizeDomain).filter(Boolean));
  const seen = new Set();
  const results = [];
  for (const article of articles) {
    const url = canonicalCoverageUrl(article?.url);
    const title = String(article?.title || "").replace(/\s+/g, " ").trim();
    if (!url || !title || seen.has(url)) continue;
    const match_score = scoreCoverageTitle(title, story?.title);
    const sharedCount = headlineTerms(title).filter(t => headlineTerms(story?.title).includes(t)).length;
    if (match_score < 0.42 || sharedCount < 2 || (sharedCount < 3 && match_score < 0.65)) continue;
    seen.add(url);
    const domain = normalizeDomain(article?.domain || url);
    results.push({ title, url, domain, gdelt_seen_at: parseSeenAt(article?.seendate || article?.date), match_score, tracked_by_newsboard: tracked.has(domain), is_newsboard_article: Boolean(storyUrl && url === storyUrl) });
  }
  results.sort((a, b) => (Date.parse(a.gdelt_seen_at || "9999") || Infinity) - (Date.parse(b.gdelt_seen_at || "9999") || Infinity) || b.match_score - a.match_score);
  return { raw_result_count: articles.length, results: results.slice(0, maxResults), earliest_match: results.find(r => r.gdelt_seen_at) || null };
}

export async function fetchGdeltCoverage(story, options = {}) {
  const { query, url, window } = buildGdeltUrl(story);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  let response;
  try { response = await (options.fetchImpl || fetch)(url, { signal: controller.signal, headers: { accept: "application/json" } }); }
  catch (error) { throw new Error(error?.name === "AbortError" ? "GDELT request timed out" : `GDELT request failed: ${error?.message || error}`); }
  finally { clearTimeout(timer); }
  if (response.status === 429) throw Object.assign(new Error("GDELT rate limit reached; try again shortly"), { status: 429 });
  if (!response.ok) throw new Error(`GDELT returned HTTP ${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("GDELT returned malformed JSON"); }
  const normalized = normalizeGdeltResponse(payload, story, options);
  return { query, request_url: url, search_window: { start: window.start.toISOString(), end: window.end.toISOString() }, newsboard_story: story, ...normalized };
}
