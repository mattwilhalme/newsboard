const {
  fmtTime, ago, fmtDurationSeconds, fmtDurationMs, normalizeUrlForStory,
  normalizeTitleForStory, summarizeError, escapeHtml,
} = window.NewsboardFormat;
const NewsboardData = window.NewsboardData;
const { derivePublisherHealth } = window.NewsboardHealth;
const $ = (id) => document.getElementById(id);

const isLocal =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1";

const isGitHubPages =
  location.hostname.endsWith("github.io");

// Retire the obsolete persisted snapshot; live requests never read it.
try { localStorage.removeItem("nb_last_successful_snapshot_v1"); } catch {}
let retryTimer = null;
const TIMELINE_URL = "./data/timeline.json";

// Expect exactly these sources; render placeholders when missing
const EXPECTED_SOURCE_IDS = ["abc1","cbs1","usat1","nbc1","cnn1","guardian1","apgoogle1","latimes1","npr1","bbc1","fox1","yahoo1"];
const isDiscoverySource = id => canonicalSourceId(id) === "apgoogle1";
let discoveriesExpanded = false;


const HISTORY_WINDOW_OPTIONS = [6, 24, 168];
const HISTORY_WINDOW_DEFAULT_HOURS = 24;
const DEEP_DIVE_DEFAULT_HOURS = 24;
const VIEW_STORAGE_KEY = "newsboard_view";
const CLUSTER_CARD_ORDER_KEY = "nb_cluster_card_order";
const CLUSTER_STRICTNESS_KEY = "nb_cluster_strictness";
const CLUSTER_DEBUG_KEY = "nb_cluster_debug";
const CLUSTER_PRESETS = {
  loose: {
    entityStrong: 0.22,
    entityWeak: 0.12,
    tokenWithEntity: 0.16,
    tokenOnly: 0.27,
    relaxedEntity: 0.10,
    relaxedToken: 0.14,
    merge: 0.24,
  },
  balanced: {
    entityStrong: 0.25,
    entityWeak: 0.15,
    tokenWithEntity: 0.18,
    tokenOnly: 0.30,
    relaxedEntity: 0.12,
    relaxedToken: 0.14,
    merge: 0.28,
  },
  strict: {
    entityStrong: 0.30,
    entityWeak: 0.18,
    tokenWithEntity: 0.20,
    tokenOnly: 0.34,
    relaxedEntity: 0.15,
    relaxedToken: 0.16,
    merge: 0.32,
  },
};
const CLUSTER_MERGE_WINDOW_MS = 6 * 60 * 60 * 1000;
const CLUSTER_HARD_JOIN_WINDOW_MS = 12 * 60 * 60 * 1000;
const CLUSTER_DOMINANT_WINDOW_MS = 12 * 60 * 60 * 1000;
const CLUSTER_ENTITY_BUDGET = 3;
let activeView = "overview";
let selectedWindowHours = HISTORY_WINDOW_DEFAULT_HOURS;
let latestDrawerPayload = { normalizedHistory: null, sources: null, indicators: null };
let latestOverviewPayload = { sources: {}, indicators: {}, timelineBySource: {} };
let selectedSourceDataId = "";
let sourceDataWindowHours = HISTORY_WINDOW_DEFAULT_HOURS;
let selectedHistoryItem = null;
let selectedDetailsTab = "changes";
let momentStatusText = "";
let clusterCardOrder = {};
let momentState = {
  sourceId: "",
  url: "",
  title: "",
  t0: null,
  lookbackMinutes: 120,
  startEarliest: true,
  payload: null,
  frames: [],
  currentIdx: 0,
  autoTimer: null,
};
let isRefreshing = false;
let lastRefreshError = null;
let lastSuccessfulUpdateTs = 0;
let clusteringStrictness = "balanced";
let clusteringDebugMode = false;
let latestClusterAssignmentsBySource = {};
const PLAY_X_PLAY_RECENT_LIMIT = 16;

function isNarrowLayout(){
  return window.matchMedia("(max-width: 700px)").matches;
}

// UI rules
const RECENT_CHANGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function fmtWindowRange(windowSpec){
  const startMs = windowStartMs(windowSpec);
  const endMs = Date.now();
  const start = new Date(startMs);
  const end = new Date(endMs);
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return `${dateFmt.format(start)} ${timeFmt.format(start)} - ${dateFmt.format(end)} ${timeFmt.format(end)}`;
}

function parseHoursSpec(windowSpec){
  const n = Number(windowSpec);
  if (!Number.isFinite(n)) return HISTORY_WINDOW_DEFAULT_HOURS;
  if (HISTORY_WINDOW_OPTIONS.includes(n)) return n;
  return HISTORY_WINDOW_DEFAULT_HOURS;
}

function windowStartMs(windowSpec){
  const hours = parseHoursSpec(windowSpec);
  return Date.now() - (hours * 60 * 60 * 1000);
}

const MOMENT_STOPWORDS = new Set(["the","and","for","with","this","that","from","into","about","after","before","amid","over","under","latest","update","updates","live","news","story","stories","video","photos","photo","says","said","new","today","will","just","more","than","what","when","where","why","how","who","are","was","were","has","have","had","its","their","they","them","his","her","our","your"]);
function extractStoryKeywords(titleNorm){
  const out = [];
  const seen = new Set();
  for (const token of String(titleNorm || "").split(/\s+/g).filter(Boolean)) {
    let t = String(token || "").trim();
    if (!t) continue;
    t = t.replace(/[’']/g, "'");
    t = t.replace(/'s$/i, "");
    if (t.endsWith("s") && t.length > 4 && !t.endsWith("ss")) t = t.slice(0, -1);
    if (t.length < 3) continue;
    if (MOMENT_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

function jaccardKeywords(a, b){
  const sa = new Set((Array.isArray(a) ? a : []).map((x) => String(x || "").trim()).filter(Boolean));
  const sb = new Set((Array.isArray(b) ? b : []).map((x) => String(x || "").trim()).filter(Boolean));
  if (!sa.size || !sb.size) return { score: 0, overlap: 0 };
  let overlap = 0;
  for (const tok of sa) if (sb.has(tok)) overlap += 1;
  const union = sa.size + sb.size - overlap;
  return { score: union > 0 ? (overlap / union) : 0, overlap };
}

function momentKeywordMatch(anchorKeywords, eventKeywords){
  const sim = jaccardKeywords(anchorKeywords, eventKeywords);
  const aLen = Array.isArray(anchorKeywords) ? anchorKeywords.length : 0;
  const bLen = Array.isArray(eventKeywords) ? eventKeywords.length : 0;
  const shortHeadline = Math.min(aLen, bLen) <= 5;
  const minOverlap = shortHeadline ? 2 : 3;
  const minScore = shortHeadline ? 0.24 : 0.30;
  return { matched: sim.overlap >= minOverlap && sim.score >= minScore, sim };
}

function syncWindowSelectors(windowSpec){
  const hours = String(parseHoursSpec(windowSpec));
  const historySel = $("history-window");
  const dataSel = $("data-window");
  const dataPageSel = $("data-window-page");
  if (historySel && historySel.value !== hours) historySel.value = hours;
  if (dataSel && dataSel.value !== hours) dataSel.value = hours;
  if (dataPageSel && dataPageSel.value !== hours) dataPageSel.value = hours;
}

function rerenderDrawers(){
  const normalizedHistory = latestDrawerPayload?.normalizedHistory;
  const sources = latestDrawerPayload?.sources;
  const indicators = latestDrawerPayload?.indicators;
  if (!normalizedHistory || !sources || !indicators) return;
  renderData(normalizedHistory, indicators, sources, selectedWindowHours);
  renderHistory(normalizedHistory, sources, indicators, {
    hostId: "playxplay-history",
    useWindow: false,
    recentLimit: PLAY_X_PLAY_RECENT_LIMIT,
  });
  const sourceDrawerOpen = $("drawer-source-data")?.classList.contains("open");
  if (sourceDrawerOpen && selectedSourceDataId) {
    renderSourceDataPanel(selectedSourceDataId);
  }
}

function setSelectedWindowHours(windowSpec){
  selectedWindowHours = parseHoursSpec(windowSpec);
  syncWindowSelectors(selectedWindowHours);
  rerenderDrawers();
}

function showToast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 1200);
}

function renderStatusLine(){
  const subline = $("subline");
  const refreshIndicator = $("refresh-indicator");
  const tsLabel = lastSuccessfulUpdateTs ? fmtTime(new Date(lastSuccessfulUpdateTs).toISOString()) : "—";

  if (refreshIndicator) refreshIndicator.textContent = isRefreshing ? "⟳ Refreshing" : "";
  if (!subline) return;

  if (lastRefreshError) {
    subline.textContent = "Live data unavailable — retrying automatically.";
    return;
  }
  if (lastSuccessfulUpdateTs) {
    subline.textContent = `Last update: ${tsLabel}`;
    return;
  }
  subline.textContent = isRefreshing ? "Refreshing…" : "Top story tracker";
}

function setPlayXPlayStatus(text){
  const el = $("playxplay-status");
  if (!el) return;
  el.textContent = String(text || "");
}

function stopMomentAutoplay(){
  if (momentState?.autoTimer) {
    clearInterval(momentState.autoTimer);
    momentState.autoTimer = null;
  }
  const btn = $("btn-moment-autoplay");
  if (btn) btn.textContent = "Auto-play";
}

function momentFrameTsMs(frame){
  const ms = Date.parse(String(frame?.ts || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function setMomentStatus(text){
  momentStatusText = String(text || "");
  const el = $("moment-status");
  if (el) el.textContent = momentStatusText;
}

function ensureMomentSnapshotDiffs(frames){
  let prev = null;
  for (const frame of frames) {
    if (frame?.type !== "snapshot") continue;
    if (frame?.diffs && Array.isArray(frame.diffs.events)) {
      prev = frame;
      continue;
    }
    const prevByKey = new Map((prev?.top10 || []).map((row) => [String(row?.url || ""), row]));
    const currTop = Array.isArray(frame?.top10) ? frame.top10 : [];
    const entered = currTop.filter((row) => !prevByKey.has(String(row?.url || ""))).map((row) => ({ rank: row?.rank, title: row?.title, url: row?.url }));
    const moved = currTop
      .map((row) => {
        const p = prevByKey.get(String(row?.url || ""));
        if (!p) return null;
        const pr = Number(p?.rank);
        const cr = Number(row?.rank);
        if (!Number.isFinite(pr) || !Number.isFinite(cr) || pr === cr) return null;
        return { from_rank: pr, to_rank: cr, title: row?.title, url: row?.url };
      })
      .filter(Boolean);
    const events = [];
    if (entered.length) events.push({ code: "ENTER", count: entered.length });
    if (moved.length) events.push({ code: "MOVE", count: moved.length });
    frame.diffs = {
      entered,
      exited: [],
      moved,
      edits: [],
      hero_swap: false,
      events,
    };
    prev = frame;
  }
}

function renderMomentFrame(){
  const host = $("moment-frame-view");
  if (!host) return;
  host.innerHTML = "";
  const frames = Array.isArray(momentState?.frames) ? momentState.frames : [];
  if (!frames.length) {
    const empty = document.createElement("div");
    empty.className = "momentEmpty";
    empty.textContent = "Run to build a moment.";
    host.appendChild(empty);
    return;
  }

  const idx = Math.max(0, Math.min(frames.length - 1, Number(momentState.currentIdx || 0)));
  momentState.currentIdx = idx;
  const frame = frames[idx];

  const head = document.createElement("div");
  head.className = "momentFrameHead";
  head.innerHTML = `<span>${escapeHtml(String(frame?.type || "frame"))}</span><span>${escapeHtml(fmtTime(frame?.ts))}</span>`;
  host.appendChild(head);

  if (frame?.type === "snapshot") {
    const heroTitle = String(frame?.hero?.title || "—");
    const heroUrl = String(frame?.hero?.url || "");
    const hero = document.createElement("div");
    hero.className = "historyMetaCard";
    hero.innerHTML = `<div class="statLabel">Hero</div><div class="statValue">${escapeHtml(heroTitle)}</div>`;
    if (heroUrl) {
      const a = document.createElement("a");
      a.className = "top10Link";
      a.href = heroUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = heroUrl;
      hero.appendChild(a);
    }
    host.appendChild(hero);

    const top = document.createElement("div");
    top.className = "historyMetaCard";
    const list = document.createElement("ol");
    list.className = "top10List";
    const topRows = (Array.isArray(frame?.top10) ? frame.top10 : []).slice(0, 5);
    for (const row of topRows) {
      const li = document.createElement("li");
      li.className = "top10Row";
      li.innerHTML = `<div class="top10Rank">${escapeHtml(String(row?.rank || "?"))}.</div><div class="deepEventBody"><a class="top10Link" href="${escapeHtml(String(row?.url || "#"))}" target="_blank" rel="noopener">${escapeHtml(String(row?.title || "—"))}</a></div>`;
      list.appendChild(li);
    }
    if (!topRows.length) {
      const li = document.createElement("li");
      li.className = "top10Row";
      li.textContent = "No Top 10 rows for this frame.";
      list.appendChild(li);
    }
    top.appendChild(list);
    host.appendChild(top);

    const pills = document.createElement("div");
    pills.className = "momentPills";
    for (const ev of frame?.diffs?.events || []) {
      const pill = document.createElement("span");
      pill.className = "momentPill";
      pill.textContent = `${ev?.code || "EVENT"}${Number(ev?.count || 0) > 1 ? ` ${Number(ev.count)}` : ""}`;
      pills.appendChild(pill);
    }
    if (!pills.childElementCount) {
      const quiet = document.createElement("span");
      quiet.className = "momentMeta";
      quiet.textContent = "No diff events in this snapshot.";
      pills.appendChild(quiet);
    }
    host.appendChild(pills);
  } else {
    const meta = document.createElement("div");
    meta.className = "momentMeta";
    const srcLabel = frame?.source_name || sourceLabel(frame?.source_id || "", null);
    meta.textContent = `${srcLabel} · ${timelineKindLabel(frame?.kind || "heartbeat")} · ${frame?.title || "—"}`;
    host.appendChild(meta);
  }
  setMomentStatus(`Frame ${idx + 1} / ${frames.length}`);
}

function renderMomentList(){
  const host = $("moment-frame-list");
  if (!host) return;
  host.innerHTML = "";
  const frames = Array.isArray(momentState?.frames) ? momentState.frames : [];
  if (!frames.length) {
    const empty = document.createElement("div");
    empty.className = "momentEmpty";
    empty.textContent = "No frames available in this range.";
    host.appendChild(empty);
    return;
  }
  const activeIdx = Math.max(0, Math.min(frames.length - 1, Number(momentState.currentIdx || 0)));
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const row = document.createElement("button");
    row.type = "button";
    row.className = `momentFrame ${i === activeIdx ? "active" : ""}`;
    row.innerHTML = `
      <div class="momentFrameHead">
        <span>${escapeHtml(frame?.source_name || sourceLabel(frame?.source_id || "", null))} · ${escapeHtml(frame?.type === "snapshot" ? "snapshot" : (frame?.kind || "headline"))}</span>
        <span>${escapeHtml(fmtTime(frame?.ts))}</span>
      </div>
      <div>${escapeHtml(frame?.type === "snapshot" ? (frame?.hero?.title || "Snapshot") : (frame?.title || "Headline"))}</div>
    `;
    row.addEventListener("click", () => {
      stopMomentAutoplay();
      momentState.currentIdx = i;
      renderMomentFrame();
      renderMomentList();
    });
    host.appendChild(row);
  }
}

function applyMomentPayload(payload){
  momentState.payload = payload || null;
  momentState.frames = Array.isArray(payload?.frames) ? payload.frames : [];
  momentState.frames.sort((a, b) => {
    const ta = momentFrameTsMs(a);
    const tb = momentFrameTsMs(b);
    if (ta !== tb) return ta - tb;
    if (String(a?.type || "") === String(b?.type || "")) return 0;
    return a?.type === "snapshot" ? -1 : 1;
  });
  ensureMomentSnapshotDiffs(momentState.frames);

  const startMs = momentFrameTsMs(payload?.start_at);
  const targetIdx = momentState.frames.findIndex((frame) => momentFrameTsMs(frame) >= startMs);
  momentState.currentIdx = targetIdx >= 0 ? targetIdx : 0;

  const anchorTitle = $("moment-anchor-title");
  const anchorMeta = $("moment-anchor-meta");
  const sourceLine = $("moment-source-line");
  if (anchorTitle) anchorTitle.textContent = String(payload?.anchor?.title || momentState.title || "Moment Reel");
  if (anchorMeta) {
    anchorMeta.textContent = `Primary: ${payload?.primary?.reason === "earliest_match" ? "earliest match" : "anchor"} · ${fmtTime(payload?.primary?.ts)} · t0 ${fmtTime(payload?.t0)}`;
  }
  if (sourceLine) sourceLine.textContent = `${sourceLabel(momentState.sourceId, null)} · ${fmtTime(payload?.start_at)} to ${fmtTime(payload?.end_at)}`;

  renderMomentFrame();
  renderMomentList();
}

function jumpMomentToTs(ts){
  const targetMs = Date.parse(String(ts || ""));
  if (!Number.isFinite(targetMs)) return;
  const idx = momentState.frames.findIndex((frame) => momentFrameTsMs(frame) >= targetMs);
  if (idx < 0) return;
  stopMomentAutoplay();
  momentState.currentIdx = idx;
  renderMomentFrame();
  renderMomentList();
}

async function buildMomentFallbackLocal({ sourceId, url, title, t0Iso, lookbackMinutes, forwardMinutes, startEarliest }) {
  const timelinePayload = await fetchJSON(`${TIMELINE_URL}?ts=${Date.now()}`).catch(() => ({ events: [] }));
  const timelineEvents = Array.isArray(timelinePayload?.events) ? timelinePayload.events : [];
  const canonicalTarget = normalizeUrlForStory(url || "");
  const t0Ms = Number.isFinite(Date.parse(String(t0Iso || ""))) ? Date.parse(String(t0Iso)) : Date.now();
  const lookbackStart = t0Ms - (Number(lookbackMinutes) * 60 * 1000);
  const windowEnd = t0Ms + (Number(forwardMinutes) * 60 * 1000);
  const clusterTitleNorm = normalizeTitleForStory(title || "");
  const clusterKeywords = extractStoryKeywords(clusterTitleNorm);

  const sortedEvents = timelineEvents
    .filter((ev) => {
      const ms = Date.parse(String(ev?.ts || ""));
      return Number.isFinite(ms) && ms >= lookbackStart && ms <= windowEnd;
    })
    .sort((a, b) => Date.parse(String(a?.ts || "")) - Date.parse(String(b?.ts || "")));

  const anchorEvent = [...sortedEvents]
    .filter((ev) => String(ev?.source_id || "") === String(sourceId || ""))
    .reverse()
    .find((ev) => normalizeUrlForStory(ev?.url || "") === canonicalTarget)
    || sortedEvents[sortedEvents.length - 1]
    || null;
  let primaryEvent = anchorEvent;
  const lookbackEvents = sortedEvents.filter((ev) => {
    const ms = Date.parse(String(ev?.ts || ""));
    return Number.isFinite(ms) && ms <= t0Ms;
  });
  if (startEarliest) {
    for (const ev of lookbackEvents) {
      const evCanonical = normalizeUrlForStory(ev?.url || "");
      const canonicalMatch = Boolean(canonicalTarget) && evCanonical === canonicalTarget;
      const evKw = extractStoryKeywords(normalizeTitleForStory(ev?.title || ""));
      const keywordMatch = momentKeywordMatch(clusterKeywords, evKw).matched;
      if (canonicalMatch || keywordMatch) {
        primaryEvent = ev;
        break;
      }
    }
  }

  const startMs = Number.isFinite(Date.parse(String(primaryEvent?.ts || ""))) ? Date.parse(String(primaryEvent?.ts || "")) : t0Ms;
  const frames = sortedEvents
    .filter((ev) => {
      const ms = Date.parse(String(ev?.ts || ""));
      if (!Number.isFinite(ms) || ms < startMs || ms > windowEnd) return false;
      const evCanonical = normalizeUrlForStory(ev?.url || "");
      const canonicalMatch = Boolean(canonicalTarget) && evCanonical === canonicalTarget;
      const evKw = extractStoryKeywords(normalizeTitleForStory(ev?.title || ""));
      const keywordMatch = momentKeywordMatch(clusterKeywords, evKw).matched;
      return canonicalMatch || keywordMatch;
    })
    .map((ev) => ({
      ts: ev?.ts || null,
      type: "headline",
      source_id: ev?.source_id || null,
      source_name: sourceLabel(ev?.source_id || "", null),
      kind: ev?.kind || "headline",
      title: ev?.title || null,
      url: ev?.url || null,
    }));

  return {
    ok: true,
    source_id: sourceId || "",
    t0: new Date(t0Ms).toISOString(),
    start_at: new Date(startMs).toISOString(),
    end_at: new Date(windowEnd).toISOString(),
    anchor: { title: anchorEvent?.title || title || momentState.title || null, url: canonicalTarget || url || null, ts: anchorEvent?.ts || new Date(t0Ms).toISOString() },
    primary: {
      title: primaryEvent?.title || title || momentState.title || null,
      url: canonicalTarget || url || null,
      ts: primaryEvent?.ts || new Date(t0Ms).toISOString(),
      reason: (primaryEvent && anchorEvent && primaryEvent !== anchorEvent) ? "earliest_match" : "anchor",
    },
    cluster: { canonical_url: canonicalTarget || null, keywords: clusterKeywords },
    frames,
  };
}

async function runMomentBuild(){
  const runBtn = $("btn-moment-run");
  if (runBtn) runBtn.disabled = true;
  stopMomentAutoplay();
  setMomentStatus("Building moment...");
  try {
    const sourceId = momentState.sourceId || "abc1";
    const url = momentState.url || "";
    const title = momentState.title || "";
    const t0 = momentState.t0 || null;
    let payload = null;

    if (!isGitHubPages) {
      const params = new URLSearchParams();
      params.set("source", sourceId);
      if (url) params.set("url", url);
      if (title) params.set("title", title);
      if (t0) params.set("t0", t0);
      params.set("lookback_minutes", String(momentState.lookbackMinutes));
      params.set("forward_minutes", "30");
      params.set("start_earliest", "1");
      payload = await fetchJSON(`/api/moment/build?${params.toString()}`);
    }

    if (!payload || !payload.ok) {
      payload = await buildMomentFallbackLocal({
        sourceId,
        url,
        title,
        t0Iso: t0,
        lookbackMinutes: momentState.lookbackMinutes,
        forwardMinutes: 30,
        startEarliest: true,
      });
    }
    applyMomentPayload(payload);
  } catch (err) {
    setMomentStatus(`Failed: ${summarizeError(err)}`);
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

function openMomentDrawer({ sourceId, url, title, t0 }){
  momentState.sourceId = String(sourceId || "abc1");
  momentState.url = normalizeUrlForStory(url || "");
  momentState.title = String(title || "").trim();
  momentState.t0 = t0 || null;
  momentState.startEarliest = true;
  const lookbackSel = $("moment-lookback");
  if (lookbackSel) lookbackSel.value = String(momentState.lookbackMinutes);
  const anchorTitle = $("moment-anchor-title");
  const anchorMeta = $("moment-anchor-meta");
  const sourceLine = $("moment-source-line");
  if (anchorTitle) anchorTitle.textContent = momentState.title || "Moment Reel";
  if (anchorMeta) anchorMeta.textContent = momentState.url || "No URL";
  if (sourceLine) sourceLine.textContent = sourceLabel(momentState.sourceId, null);
  setMomentOpen(true);
  renderMomentFrame();
  renderMomentList();
}

let intelligenceDrawers = null;
const drawerManager = window.NewsboardDrawers.createDrawerManager({
  drawerIds: ["drawer-story-history", "drawer-gdelt", "drawer-history", "drawer-data", "drawer-source-data", "drawer-menu", "drawer-history-item", "drawer-moment"],
  beforeClose: () => {
    stopMomentAutoplay();
    intelligenceDrawers?.cancel();
  },
});
function closeAllDrawers() { drawerManager.closeAll(); }

function setMomentOpen(open){
  const drawer = $("drawer-moment");
  const overlay = $("drawer-overlay");
  if (!drawer || !overlay) return;
  if (open) closeAllDrawers();
  if (!open) stopMomentAutoplay();
  drawer.classList.toggle("open", Boolean(open));
  overlay.classList.toggle("show", Boolean(open));
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
}

function setMenuOpen(open){
  const drawer = $("drawer-menu");
  const overlay = $("drawer-overlay");
  if (!drawer || !overlay) return;
  if (open) closeAllDrawers();
  drawer.classList.toggle("open", Boolean(open));
  overlay.classList.toggle("show", Boolean(open));
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
}

function setHistoryOpen(open){
  const drawer = $("drawer-history");
  const overlay = $("drawer-overlay");
  const btn = $("btn-history");
  if (!drawer || !overlay) return;
  if (open) {
    closeAllDrawers();
  }
  drawer.classList.toggle("open", Boolean(open));
  overlay.classList.toggle("show", Boolean(open));
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  if (!open && btn) btn.focus();
}

function setSourceDataOpen(open, sourceId = selectedSourceDataId){
  const drawer = $("drawer-source-data");
  const overlay = $("drawer-overlay");
  const sel = $("source-data-window");
  if (!drawer || !overlay) return;
  if (open) {
    closeAllDrawers();
  }
  selectedSourceDataId = sourceId || selectedSourceDataId || "";
  if (sel) sel.value = String(parseHoursSpec(sourceDataWindowHours));
  if (open && selectedSourceDataId) {
    renderSourceDataPanel(selectedSourceDataId);
  }
  drawer.classList.toggle("open", Boolean(open));
  overlay.classList.toggle("show", Boolean(open));
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
}

function setDetailsTab(tab){
  const valid = new Set(["changes", "data"]);
  selectedDetailsTab = valid.has(tab) ? tab : "changes";
  const tabs = [
    ["details-tab-changes", "changes"],
    ["details-tab-data", "data"],
  ];
  for (const [id, key] of tabs) {
    const btn = $(id);
    if (!btn) continue;
    const active = key === selectedDetailsTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  if (selectedSourceDataId) renderSourceDataPanel(selectedSourceDataId);
}

function setDataOpen(open){
  const drawer = $("drawer-data");
  const overlay = $("drawer-overlay");
  const btn = $("tab-data");
  if (!isNarrowLayout()) {
    if (drawer) {
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
    }
    if (overlay) overlay.classList.remove("show");
    return;
  }
  if (!drawer || !overlay) return;
  if (open) {
    closeAllDrawers();
  }
  drawer.classList.toggle("open", Boolean(open));
  overlay.classList.toggle("show", Boolean(open));
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  if (!open && btn) btn.focus();
}

function setHistoryItemOpen(open){
  const drawer = $("drawer-history-item");
  const overlay = $("drawer-overlay");
  if (!drawer || !overlay) return;
  if (open) closeAllDrawers();
  drawer.classList.toggle("open", Boolean(open));
  overlay.classList.toggle("show", Boolean(open));
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
}

function canonicalSourceId(rawId){
  const s = String(rawId || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, "");
  if (!s) return "";
  if (s === "abc" || s === "abc1") return "abc1";
  if (s === "cbs" || s === "cbs1") return "cbs1";
  if (s === "usat" || s === "usat1" || s === "usatoday" || s === "usatoday1") return "usat1";
  if (s === "nbc" || s === "nbc1") return "nbc1";
  if (s === "cnn" || s === "cnn1") return "cnn1";
  if (s === "reuters" || s === "reuters1") return "guardian1";
  if (s === "guardian" || s === "guardian1") return "guardian1";
  if (s === "ap" || s === "ap1" || s === "associatedpress") return "ap1";
  if (s === "latimes" || s === "latimes1" || s === "losangelestimes") return "latimes1";
  if (s === "wsj" || s === "wsj1" || s === "wallstreetjournal") return "";
  if (s === "npr" || s === "npr1" || s === "nationalpublicradio") return "npr1";
  if (s === "bbc" || s === "bbc1") return "bbc1";
  if (s === "fox" || s === "fox1") return "fox1";
  if (s === "yahoo" || s === "yahoo1" || s === "yahoonews") return "yahoo1";
  if (s === "wp" || s === "wp1" || s === "wapo" || s === "washingtonpost") return "yahoo1";
  return s;
}

function mergeSourceRows(prev, next){
  if (!prev) return next;
  const prevTs = Date.parse(prev?.updatedAt || prev?.lastChangeAt || "");
  const nextTs = Date.parse(next?.updatedAt || next?.lastChangeAt || "");
  const chooseNext = Number.isFinite(nextTs) && (!Number.isFinite(prevTs) || nextTs >= prevTs);
  const newer = chooseNext ? next : prev;
  const older = chooseNext ? prev : next;
  return {
    ...older,
    ...newer,
    item: { ...(older?.item || {}), ...(newer?.item || {}) },
  };
}

function sourceLabel(k, row){
  // Normalize IDs coming from Supabase/views (case, punctuation, aliases)
  const s = canonicalSourceId(k);
  const n = row?.sourceName || row?.name || null;
  if (s === "yahoo1") return "Yahoo News";
  if (s === "guardian1") return "The Guardian";
  if (s === "apgoogle1") return "AP via Google News";
  if (n) return String(n);

  if (s === "abc" || s === "abc1") return "ABC News";
  if (s === "cbs" || s === "cbs1") return "CBS News";
  if (s === "usat" || s === "usat1" || s === "usatoday" || s === "usatoday1") return "USA Today";
  if (s === "nbc" || s === "nbc1") return "NBC News";
  if (s === "cnn" || s === "cnn1") return "CNN";
  if (s === "guardian" || s === "guardian1") return "The Guardian";
  if (s === "ap" || s === "ap1" || s === "associatedpress") return "Associated Press";
  if (s === "latimes" || s === "latimes1" || s === "losangelestimes") return "Los Angeles Times";
  if (s === "npr" || s === "npr1" || s === "nationalpublicradio") return "NPR";
  if (s === "bbc" || s === "bbc1") return "BBC";
  if (s === "fox" || s === "fox1") return "Fox News";

  return k || "Source";
}

function sourceHomeUrl(k, row){
  const s = canonicalSourceId(k);
  if (s === "guardian1") return "https://www.theguardian.com/";
  if (s === "yahoo1") return "https://news.yahoo.com/";
  const fromRow = row?.home_url || row?.homeUrl || null;
  if (fromRow) return String(fromRow);
  if (s === "abc1") return "https://abcnews.com/";
  if (s === "cbs1") return "https://www.cbsnews.com/";
  if (s === "usat1") return "https://www.usatoday.com/";
  if (s === "nbc1") return "https://www.nbcnews.com/";
  if (s === "cnn1") return "https://www.cnn.com/";
  if (s === "ap1") return "https://apnews.com/";
  if (s === "apgoogle1") return "https://news.google.com/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen";
  if (s === "latimes1") return "https://www.latimes.com/";
  if (s === "npr1") return "https://www.npr.org/";
  if (s === "bbc1") return "https://www.bbc.com/";
  if (s === "fox1") return "https://www.foxnews.com/";
  return null;
}

function copyText(txt){
  if (!txt) return;
  return navigator.clipboard.writeText(txt);
}

async function fetchJSON(url, opts) {
  // Preserve renderer payloads while moving changing data to bounded RPCs.
  const path = String(url).split("?")[0];
  try {
    if (path === TIMELINE_URL || path === "/api/timeline") {
      const hours = Number(new URL(String(url), location.href).searchParams.get("hours") || 12);
      return await NewsboardData.getTimeline(hours);
    }
  } catch (error) {
    throw error; // Frozen GitHub JSON is never a current-data fallback.
  }
  return await NewsboardData.requestJson(url, opts);
}

async function loadFromSupabase(){
  return await NewsboardData.getCurrentObservations();
}

function canonicalStoryUrl(url){
  const raw = String(url || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    for (const k of [...u.searchParams.keys()]) {
      const lk = k.toLowerCase();
      if (lk.startsWith("utm_") || lk === "fbclid" || lk === "gclid") u.searchParams.delete(k);
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function openHistoryItemDrawer(sourceId, storyUrl, storyTitle, observedAt){
  const titleEl = $("history-item-title");
  const sourceEl = $("history-item-source");
  const bodyEl = $("history-item-body");
  if (!titleEl || !sourceEl || !bodyEl) return;

  const normalizedHistory = latestDrawerPayload?.normalizedHistory || { sources: {} };
  const entries = Array.isArray(normalizedHistory?.sources?.[sourceId]?.entries)
    ? normalizedHistory.sources[sourceId].entries
    : [];
  const target = canonicalStoryUrl(storyUrl);
  const matching = entries.filter((entry) => canonicalStoryUrl(entry?.url || "") === target);
  const firstSeen = matching.length ? (matching[0]?.firstSeenAt || matching[0]?.lastSeenAt || null) : null;
  const sinceAt = latestDrawerPayload?.indicators?.[sourceId]?.currentSinceAt || firstSeen || null;
  const durationMs = Number.isFinite(Date.parse(String(sinceAt || ""))) ? Math.max(0, Date.now() - Date.parse(String(sinceAt))) : 0;

  const headlineChanges = [];
  for (let i = 1; i < matching.length; i += 1) {
    const prev = matching[i - 1];
    const cur = matching[i];
    const prevTitle = String(prev?.title || "");
    const curTitle = String(cur?.title || "");
    if (prevTitle && curTitle && prevTitle !== curTitle) {
      headlineChanges.push({
        changedAt: cur?.firstSeenAt || cur?.lastSeenAt || null,
        fromTitle: prevTitle,
        toTitle: curTitle,
      });
    }
  }

  titleEl.textContent = storyTitle || "Story Details";
  sourceEl.textContent = sourceLabel(sourceId, latestDrawerPayload?.sources?.[sourceId] || null);
  bodyEl.innerHTML = "";

  const statsCard = document.createElement("div");
  statsCard.className = "historyMetaCard";
  const statsGrid = document.createElement("div");
  statsGrid.className = "historyMetaGrid";
  statsGrid.innerHTML = `
    <div><div class="statLabel">First seen</div><div class="statValue">${escapeHtml(firstSeen ? fmtTime(firstSeen) : "—")}</div></div>
    <div><div class="statLabel">Duration</div><div class="statValue">${escapeHtml(durationMs ? fmtDurationMs(durationMs) : "—")}</div></div>
  `;
  statsCard.appendChild(statsGrid);
  bodyEl.appendChild(statsCard);

  if (storyUrl) {
    const linkCard = document.createElement("div");
    linkCard.className = "historyMetaCard";
    const link = document.createElement("a");
    link.href = storyUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "top10Link";
    link.textContent = storyUrl;
    linkCard.appendChild(link);
    bodyEl.appendChild(linkCard);
  }

  const changesCard = document.createElement("div");
  changesCard.className = "historyMetaCard";
  if (!headlineChanges.length) {
    changesCard.innerHTML = `<div class="inlineEmpty">No headline change history for this story yet.</div>`;
  } else {
    for (const ev of headlineChanges) {
      const diff = document.createElement("div");
      diff.className = "headlineDiff";
      const meta = document.createElement("div");
      meta.className = "headlineDiffMeta";
      meta.innerHTML = `<strong>Updated:</strong> ${escapeHtml(fmtTime(ev?.changedAt))}`;
      diff.appendChild(meta);
      appendHeadlineEditMarkup(diff, ev?.fromTitle, ev?.toTitle);
      changesCard.appendChild(diff);
    }
  }
  bodyEl.appendChild(changesCard);

  selectedHistoryItem = { sourceId, storyUrl, storyTitle, observedAt };
  setHistoryItemOpen(true);
}

function renderCollectionHealth(sources = {}, operational = {}){
  const hosts = [$("collection-health"), $("collection-health-mobile")].filter(Boolean);
  if (!hosts.length) return;
  const buildTable = (mobile = false) => {
  const table = document.createElement("table");
  table.className = "dataTable collectionHealthTable";
  table.innerHTML = "<thead><tr><th>Publisher</th><th>Health</th><th>Last valid</th><th>Last attempt</th><th>24h success</th><th>Fallback</th><th>Top 10</th><th>Story processing</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const id of EXPECTED_SOURCE_IDS) {
    const source = sources?.[id] || null;
    const op = operational?.[id] || {};
    const health = op.health ? { ...derivePublisherHealth(source), state: op.health[0].toUpperCase()+op.health.slice(1) } : derivePublisherHealth(source);
    const row = document.createElement("tr");
    row.setAttribute(mobile ? "data-mobile-health-source" : "data-health-source", id);
    const publisher = document.createElement("td"); publisher.textContent = sourceLabel(id, source);
    const state = document.createElement("td"); state.className = `healthState ${health.state.toLowerCase()}`; state.textContent = health.state;
    const lastGood = document.createElement("td"); lastGood.textContent = health.timestamp ? ago(health.timestamp).replace(" ago", "") : "—";
    const attempt = document.createElement("td");
    const effectiveAttempt = op.last_attempt_status ? `${op.last_attempt_status}${op.http_status ? ` ${op.http_status}` : ""}` : (source?.health?.crawlStatus || "—");
    const primaryAttempt = op.last_primary_attempt_status && op.last_primary_attempt_status !== "success"
      ? `primary ${op.last_primary_attempt_status}${op.primary_http_status ? ` ${op.primary_http_status}` : ""}`
      : null;
    attempt.textContent = op.recovered_by_fallback && primaryAttempt ? `${effectiveAttempt} · fallback (${primaryAttempt})` : effectiveAttempt;
    attempt.title = [op.last_error || health.error, op.last_primary_error].filter(Boolean).join(" · ");
    const rate = document.createElement("td"); rate.textContent = op.success_rate_24h == null ? "—" : `${Math.round(Number(op.success_rate_24h)*100)}%`;
    const fallback = document.createElement("td"); fallback.textContent = op.browser_fallback_state ? `${op.browser_fallback_state}${op.next_retry_at ? ` · retry ${fmtTime(op.next_retry_at)}` : ""}` : "—";
    const top10 = document.createElement("td"); top10.textContent = isDiscoverySource(id) ? "Not applicable (unranked)" : op.top10_quality ? `${op.top10_quality} (${op.top10_items ?? 0})` : "Unavailable";
    const story = document.createElement("td"); story.textContent = isDiscoverySource(id) ? "Discovery only" : op.story_processed_through ? `${Math.round(Number(op.story_processing_lag_seconds||0)/60)}m lag` : "Unprocessed";
    row.append(publisher, state, lastGood, attempt, rate, fallback, top10, story); body.appendChild(row);
  }
  table.appendChild(body);
  return table;
  };
  for (const host of hosts) host.replaceChildren(buildTable(host.id === "collection-health-mobile"));
}

function drawMiniBars(canvas, buckets){
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 120;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const data = Array.isArray(buckets) ? buckets : [];
  if (!data.length) return;
  const max = Math.max(1, ...data.map((b) => Number(b.url || 0) + Number(b.headline || 0)));
  const gap = 2;
  const barW = Math.max(2, Math.floor((cssW - (data.length - 1) * gap) / data.length));
  let x = 0;
  for (const b of data) {
    const total = Number(b.url || 0) + Number(b.headline || 0);
    const h = Math.round((total / max) * (cssH - 12));
    ctx.fillStyle = "#E5E7EB";
    ctx.fillRect(x, cssH - h, barW, h);
    const hu = Math.round((Number(b.url || 0) / max) * (cssH - 12));
    const hh = Math.round((Number(b.headline || 0) / max) * (cssH - 12));
    ctx.fillStyle = "rgba(30,142,62,.9)";
    if (hu > 0) ctx.fillRect(x, cssH - hu, barW, hu);
    ctx.fillStyle = "rgba(23,92,211,.85)";
    if (hh > 0) ctx.fillRect(x, cssH - hu - hh, barW, hh);
    x += barW + gap;
  }
}

function drawSplitBars(canvas, metrics){
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 120;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const url = Number(metrics?.urlChanges || 0);
  const hl = Number(metrics?.headlineOnlyChanges || 0);
  const max = Math.max(1, url, hl);
  const barW = Math.floor((cssW - 48) / 2);
  const baseY = cssH - 18;
  const h1 = Math.round((url / max) * (cssH - 32));
  const h2 = Math.round((hl / max) * (cssH - 32));
  ctx.fillStyle = "rgba(30,142,62,.9)";
  ctx.fillRect(14, baseY - h1, barW, h1);
  ctx.fillStyle = "rgba(23,92,211,.9)";
  ctx.fillRect(28 + barW, baseY - h2, barW, h2);
  ctx.fillStyle = "#5e6977";
  ctx.font = "11px sans-serif";
  ctx.fillText("URL", 14, cssH - 4);
  ctx.fillText("Headline", 28 + barW, cssH - 4);
}

function renderSourceDataPanel(sourceId){
  const host = $("source-data");
  const title = $("source-data-title");
  const range = $("source-data-range");
  if (!host || !title) return;
  host.innerHTML = "";

  const normalizedHistory = latestDrawerPayload?.normalizedHistory || { sources: {} };
  const indicatorsById = latestDrawerPayload?.indicators || {};
  const currentSources = latestDrawerPayload?.sources || {};
  const sourceRow = currentSources?.[sourceId] || {};
  const sourceName = sourceLabel(sourceId, sourceRow);
  title.textContent = `${sourceName} Details`;
  const discovery = isDiscoverySource(sourceId);
  host.closest('aside').querySelector('.detailsTabs').style.display = discovery ? 'none' : '';
  $("source-data-window").closest('.row').style.display = discovery ? 'none' : '';
  if (discovery) {
    title.textContent = 'Associated Press — Discoveries';
    if (range) range.textContent = `via Google News · Collected ${sourceRow.updatedAt ? fmtTime(sourceRow.updatedAt) : '—'}`;
    const note = document.createElement('p');
    note.className = 'tiny';
    note.textContent = 'AP articles indexed by Google News. Latest published first; unranked, not AP homepage lead or Top 10. Links open via Google News. Publication times come from the feed and may differ from discovery time.';
    host.appendChild(note);
    const items = (Array.isArray(sourceRow.items) ? sourceRow.items : []).filter(item => {
      let url;
      try { url = new URL(item?.url); } catch { return false; }
      return url.protocol === 'https:' && url.hostname === 'news.google.com' && typeof item.title === 'string' && item.title.trim();
    });
    const list = document.createElement('div'); list.className = 'historyList discoveryList';
    const renderDiscoveries = () => {
      list.replaceChildren();
      for (const item of items.slice(0, discoveriesExpanded ? items.length : 20)) {
        const card = document.createElement('article'); card.className = 'latestItem discoveryItem';
        const meta = document.createElement('div'); meta.className = 'latestMetaRow';
        const date = document.createElement('div'); date.className = 'srcTime';
        date.textContent = `Published ${fmtTime(item.publishedAt)} · ${ago(item.publishedAt)}`;
        meta.appendChild(date);
        const body = document.createElement('div'); body.className = 'latestBody';
        const main = document.createElement('div'); main.className = 'latestMain';
        const headline = document.createElement('h3'); headline.className = 'latestTitle';
        const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = item.title;
        headline.appendChild(link); main.appendChild(headline); body.appendChild(main);
        card.append(meta, body); list.appendChild(card);
      }
    };
    renderDiscoveries();
    host.appendChild(list);
    if (items.length > 20) {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'linkbtn';
      const updateToggle = () => { toggle.textContent = discoveriesExpanded ? 'Show fewer' : 'Show all'; toggle.setAttribute('aria-expanded', String(discoveriesExpanded)); };
      updateToggle(); toggle.addEventListener('click', () => { discoveriesExpanded = !discoveriesExpanded; renderDiscoveries(); updateToggle(); }); host.appendChild(toggle);
    }
    if (!items.length) { const empty = document.createElement('p'); empty.className = 'inlineEmpty'; empty.textContent = 'No discoveries available yet.'; host.appendChild(empty); }
    return;
  }
  if (range) range.textContent = fmtWindowRange(sourceDataWindowHours);

  const entries = Array.isArray(normalizedHistory?.sources?.[sourceId]?.entries)
    ? normalizedHistory.sources[sourceId].entries
    : [];
  const metrics = computeSourceDataMetrics(entries, sourceDataWindowHours);
  const timelineEvents = Array.isArray(latestOverviewPayload?.timelineBySource?.[sourceId])
    ? [...latestOverviewPayload.timelineBySource[sourceId]]
    : [];
  timelineEvents.sort((a, b) => Date.parse(String(a?.ts || "")) - Date.parse(String(b?.ts || "")));
  const headlineHistory = headlineHistoryFromTimeline(timelineEvents, sourceRow?.item?.url || null);

  if (selectedDetailsTab === "changes") {
    const wrap = document.createElement("div");
    wrap.className = "relatedPanel open";
    if (headlineHistory.original?.title) {
      const first = document.createElement("div");
      first.className = "headlineDiff";
      first.innerHTML = `<div class="headlineDiffMeta"><strong>Original:</strong> ${escapeHtml(fmtTime(headlineHistory.original.ts))}</div><div>${escapeHtml(headlineHistory.original.title)}</div>`;
      wrap.appendChild(first);
    }
    if (headlineHistory.previous?.title) {
      const prev = document.createElement("div");
      prev.className = "headlineDiff";
      prev.innerHTML = `<div class="headlineDiffMeta"><strong>Previous:</strong> ${escapeHtml(fmtTime(headlineHistory.previous.ts))}</div><div>${escapeHtml(headlineHistory.previous.title)}</div>`;
      wrap.appendChild(prev);
    }
    for (const ev of headlineHistory.changes || []) {
      const diff = document.createElement("div");
      diff.className = "headlineDiff";
      const meta = document.createElement("div");
      meta.className = "headlineDiffMeta";
      meta.innerHTML = `<strong>Updated:</strong> ${escapeHtml(fmtTime(ev?.changedAt))}`;
      diff.appendChild(meta);
      appendHeadlineEditMarkup(diff, ev?.fromTitle, ev?.toTitle);
      wrap.appendChild(diff);
    }
    if (!wrap.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "inlineEmpty";
      empty.textContent = "Not enough history yet.";
      host.appendChild(empty);
      return;
    }
    host.appendChild(wrap);
    return;
  }

  if (selectedDetailsTab === "data") {
    const hasData = (metrics.urlChanges + metrics.headlineOnlyChanges) > 0;
    const stats = document.createElement("div");
    stats.className = "statsGrid";
    const statsRows = [
      ["URL changes", String(metrics.urlChanges)],
      ["Headline Changes", String(metrics.headlineOnlyChanges)],
      ["Live Blogs", String(metrics.liveBlogs)],
      ["Breaking News", String(metrics.breakingNews)],
      ["Longest run", fmtDurationMs(metrics.longestRunMs)],
    ];
    for (const [label, value] of statsRows) {
      const card = document.createElement("div");
      card.className = "statCard";
      card.innerHTML = `<div class="statLabel">${escapeHtml(label)}</div><div class="statValue">${escapeHtml(value)}</div>`;
      stats.appendChild(card);
    }
    host.appendChild(stats);
    if (!hasData) {
      const empty = document.createElement("div");
      empty.className = "inlineEmpty";
      empty.textContent = "Not enough history yet.";
      host.appendChild(empty);
      return;
    }
    const c1 = document.createElement("div");
    c1.className = "chartCard";
    c1.innerHTML = `<div class="chartTitle">Changes over time</div>`;
    const canvas1 = document.createElement("canvas");
    canvas1.className = "chartCanvas";
    c1.appendChild(canvas1);
    host.appendChild(c1);
    drawMiniBars(canvas1, metrics.buckets);

    const c2 = document.createElement("div");
    c2.className = "chartCard";
    c2.innerHTML = `<div class="chartTitle">URL vs headline-only split</div>`;
    const canvas2 = document.createElement("canvas");
    canvas2.className = "chartCanvas";
    c2.appendChild(canvas2);
    host.appendChild(c2);
    drawSplitBars(canvas2, metrics);
    return;
  }

}

// ---- Indicator state: 2h active windows for URL/headline changes ----
function loadState(){
  try{
    const raw = localStorage.getItem("nb_source_state_v2");
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function saveState(state){
  try{
    localStorage.setItem("nb_source_state_v2", JSON.stringify(state || {}));
  } catch {}
}

function deriveFromHistoryEntries(entries, currentUrl, currentTitle, nowMs){
  const out = {
    changeType: null,
    urlFirstSeenAt: 0,
    urlFirstSeenEverAt: 0,
    urlCurrentSinceAt: 0,
    titleFirstSeenAt: 0,
    lastChangeAt: 0,
    lastSeenAt: 0,
    reenteredAt: 0,
  };

  if (!currentUrl || !Array.isArray(entries) || !entries.length) return out;

  const toMs = (x) => {
    const m = Date.parse(String(x || ""));
    return Number.isFinite(m) ? m : 0;
  };
  const entryMs = (e) => toMs(e.firstSeenAt || e.lastSeenAt);
  const ordered = [...entries]
    .filter((e) => e && e.url)
    .map((e) => ({ ...e, __ms: entryMs(e) }))
    .filter((e) => e.__ms > 0)
    .sort((a, b) => a.__ms - b.__ms);
  if (!ordered.length) return out;

  out.lastSeenAt = ordered[ordered.length - 1].__ms;

  const allMatches = ordered.filter((e) => String(e.url) === String(currentUrl));
  if (!allMatches.length) return out;
  out.urlFirstSeenEverAt = entryMs(allMatches[0]);

  const tail = [];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    if (String(e.url) !== String(currentUrl)) break;
    tail.unshift(e);
  }
  if (!tail.length) return out;

  out.urlFirstSeenAt = entryMs(tail[0]);
  out.urlCurrentSinceAt = out.urlFirstSeenAt;
  if (out.urlFirstSeenEverAt > 0 && out.urlCurrentSinceAt > out.urlFirstSeenEverAt) {
    out.reenteredAt = out.urlCurrentSinceAt;
  }

  const titleTail = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (String(e.title || "") !== String(currentTitle || "")) break;
    titleTail.unshift(e);
  }
  out.titleFirstSeenAt = titleTail.length ? entryMs(titleTail[0]) : out.urlCurrentSinceAt;
  out.lastChangeAt = Math.max(out.urlCurrentSinceAt, out.titleFirstSeenAt);

  if (out.urlCurrentSinceAt > 0 && nowMs - out.urlCurrentSinceAt < RECENT_CHANGE_MS) {
    out.changeType = "url";
  } else if (
    out.titleFirstSeenAt > out.urlCurrentSinceAt &&
    out.titleFirstSeenAt > 0 &&
    nowMs - out.titleFirstSeenAt < RECENT_CHANGE_MS
  ) {
    out.changeType = "headline";
  }

  return out;
}

function computeIndicators(nextSources, historyObj = null){
  const prevState = loadState();
  const nextState = { ...prevState };
  const indicators = {};
  const now = Date.now();

  for (const [id, src] of Object.entries(nextSources || {})){
    const curUrl = src?.item?.url || null;
    const curTitle = src?.item?.title || null;
    const histEntries = historyObj?.sources?.[id]?.entries || null;
    const histDerived = deriveFromHistoryEntries(histEntries, curUrl, curTitle, now);

    if (Array.isArray(histEntries) && histEntries.length && curUrl) {
      nextState[id] = {
        url: curUrl,
        title: curTitle || null,
        urlFirstSeenAt: histDerived.urlFirstSeenAt || 0,
        urlFirstSeenEverAt: histDerived.urlFirstSeenEverAt || histDerived.urlFirstSeenAt || 0,
        urlCurrentSinceAt: histDerived.urlCurrentSinceAt || histDerived.urlFirstSeenAt || 0,
        titleFirstSeenAt: histDerived.titleFirstSeenAt || 0,
        lastChangeAt: histDerived.lastChangeAt || 0,
        lastSeenAt: histDerived.lastSeenAt || 0,
      };
      indicators[id] = {
        changeType: histDerived.changeType,
        firstSeenEverAt: histDerived.urlFirstSeenEverAt || histDerived.urlFirstSeenAt || 0,
        currentSinceAt: histDerived.urlCurrentSinceAt || histDerived.urlFirstSeenAt || 0,
        headlineSinceAt: histDerived.titleFirstSeenAt || 0,
        lastSeenAt: histDerived.lastSeenAt || 0,
        reenteredAt: histDerived.reenteredAt || 0,
      };
      continue;
    }

    const prev = prevState?.[id] || null;
    const prevUrlFirstSeenAt = Number(prev?.urlFirstSeenAt || prev?.lastChangeAt || 0);
    const prevTitleFirstSeenAt = Number(prev?.titleFirstSeenAt || prev?.lastChangeAt || 0);

    let urlFirstSeenAt = prevUrlFirstSeenAt;
    let titleFirstSeenAt = prevTitleFirstSeenAt;

    if (!prev && curUrl) {
      urlFirstSeenAt = now;
      titleFirstSeenAt = now;
    } else if (prev && curUrl) {
      if (String(prev.url || "") !== String(curUrl || "")) {
        urlFirstSeenAt = now;
        titleFirstSeenAt = now;
      } else if (String(prev.title || "") !== String(curTitle || "")) {
        titleFirstSeenAt = now;
      }
    }

    let changeType = null;
    if (curUrl && urlFirstSeenAt > 0 && now - urlFirstSeenAt < RECENT_CHANGE_MS) {
      changeType = "url";
    } else if (
      curUrl &&
      titleFirstSeenAt > urlFirstSeenAt &&
      titleFirstSeenAt > 0 &&
      now - titleFirstSeenAt < RECENT_CHANGE_MS
    ) {
      changeType = "headline";
    }

    const lastChangeAt = Math.max(urlFirstSeenAt, titleFirstSeenAt, 0);

    nextState[id] = {
      url: curUrl,
      title: curTitle || null,
      urlFirstSeenAt,
      urlFirstSeenEverAt: urlFirstSeenAt,
      urlCurrentSinceAt: urlFirstSeenAt,
      titleFirstSeenAt,
      lastChangeAt,
      lastSeenAt: now,
    };
    indicators[id] = {
      changeType,
      firstSeenEverAt: urlFirstSeenAt,
      currentSinceAt: urlFirstSeenAt,
      headlineSinceAt: titleFirstSeenAt,
      lastSeenAt: now,
      reenteredAt: 0,
    };
  }

  return { indicators, nextState };
}

function ensureExpectedSources(sources){
  const out = { ...(sources || {}) };
  for (const id of EXPECTED_SOURCE_IDS){
    if (!out[id]) {
      out[id] = {
        ok: false,
        updatedAt: null,
        error: "No data yet",
        item: { title: "—", url: null }
      };
    } else {
      // normalize missing shapes
      if (!out[id].item) out[id].item = { title: "—", url: null };
      if (out[id].item.title == null) out[id].item.title = "—";
    }
  }
  return out;
}

function validateLiveSources(rawSources) {
  const sources = ensureExpectedSources(canonicalizeSourcesMap(rawSources));
  for (const [id, row] of Object.entries(sources)) {
    let validUrl = false;
    try { validUrl = /^https?:$/.test(new URL(row.item?.url).protocol); } catch {}
    const valid = row.ok !== false && typeof row.item?.title === "string" && row.item.title.trim() && row.item.title !== "—" && validUrl && Number.isFinite(Date.parse(row.updatedAt));
    const status = ["success", "pending", "running", "failed"].includes(row.health?.crawlStatus) ? row.health.crawlStatus : "unknown";
    // Observation validity and attempt status are independent for each source.
    sources[id] = { ...row, ok: Boolean(valid), health: { ...row.health, crawlStatus: valid || status !== "success" ? status : "unknown", observationValid: Boolean(valid) } };
    if (!valid) Object.assign(sources[id], { updatedAt: null, item: { title: "—", url: null }, error: "No valid observation available" });
  }
  return sources;
}

function canonicalizeSourcesMap(sources){
  const out = {};
  for (const [rawId, src] of Object.entries(sources || {})) {
    const id = canonicalSourceId(rawId);
    if (!id) continue;
    const row = src || {};
    const item = row.item || {};
    const last = row.last || {};
    const mapped = {
      ...row,
      ok: row.ok !== false,
      updatedAt: row.updatedAt || row.updated_at || last.fetchedAt || null,
      firstSeenAt: row.firstSeenAt || row.first_seen_at || row.since || null,
      secondsInTop: row.secondsInTop ?? row.seconds_in_top ?? null,
      sourceName: row.sourceName || row.source_name || row.name || null,
      changeType: row.changeType || row.change_type || null,
      lastChangeAt: row.lastChangeAt || row.last_change_at || null,
      item: {
        ...item,
        title: item.title || null,
        url: item.url || null,
        contentType: item.contentType || item.content_type || row.contentType || row.content_type || null,
        breakingLabel: item.breakingLabel || item.breaking_label || row.breakingLabel || row.breaking_label || null,
        breakingHeadline: item.breakingHeadline || item.breaking_headline || row.breakingHeadline || row.breaking_headline || null,
        breakingUrl: item.breakingUrl || item.breaking_url || row.breakingUrl || row.breaking_url || null,
      },
    };
    out[id] = mergeSourceRows(out[id], mapped);
  }
  return out;
}

function canonicalizeHistoryObj(history){
  const out = { generatedAt: history?.generatedAt || new Date().toISOString(), sources: {} };
  for (const [rawId, payload] of Object.entries(history?.sources || {})) {
    const id = canonicalSourceId(rawId);
    if (!id) continue;
    if (!out.sources[id]) out.sources[id] = { entries: [] };
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    out.sources[id].entries.push(...entries);
  }
  return out;
}

// ---- Dynamic cards ----
let storyBadges = [];
let recentStories = [];
let storyRadar = null;
let openedStoryDeepLink = false;
const FIRST_MEANING = "First detected by NewsBoard among monitored publishers in available processed history—not first published worldwide.";

async function loadStoryBadges(){
  try {
    const rows = await NewsboardData.getStoryBadges();
    storyBadges = Array.isArray(rows) ? rows : [];
  } catch { storyBadges = []; } // Optional intelligence never blocks raw news.
}
function storyRadarOptions(){
  return {
    hours: Number($("story-radar-window")?.value || 24),
    minPublishers: Number($("story-radar-min-publishers")?.value || 2),
    sort: $("story-radar-sort")?.value || "recent",
    activeOnly: Boolean($("story-radar-active")?.checked),
    publisher: $("story-radar-publisher")?.value || "",
    reachedNumberOne: Boolean($("story-radar-number-one")?.checked),
  };
}
function renderRecentStoryViews(){
  if (!storyRadar) return;
  storyRadar.render($("recent-stories"), recentStories, { hours:24, minPublishers:2, sort:"recent", compact:true, limit:6, emptyText:"No multi-publisher stories detected in the last 24 hours." });
  const matches=storyRadar.render($("story-radar-list"), recentStories, storyRadarOptions());
  const summary=$("story-radar-summary");
  if(summary)summary.textContent=`${matches.length} ${matches.length===1?"story":"stories"} in this view · select a card for its observed propagation history`;
}
async function loadRecentStories(){
  const host=$("recent-stories"),healthHost=$("story-processing-health");if(!host)return;
  try{
    const [rows,health]=await Promise.all([NewsboardData.getRecentStories(168,200),NewsboardData.getStoryOperationalHealth().catch(()=>null)]);
    if(healthHost)healthHost.textContent=health?`Story processing: ${health.status} · ${Math.round(Number(health.lag_seconds||0)/60)}m lag · ${health.unprocessed_batches||0} queued`:"Story processing status unavailable";
    recentStories=Array.isArray(rows)?rows:[];
    renderRecentStoryViews();
  }catch{recentStories=[];host.textContent="Recent Story History is temporarily unavailable.";const radarHost=$("story-radar-list");if(radarHost)radarHost.textContent="Story Radar is temporarily unavailable.";if(healthHost)healthHost.textContent="Story processing status unavailable";}
}
function storyBadge(sourceId, item){
  const badge = storyBadges.find(row => row.source_id === sourceId &&
    normalizeUrlForStory(row.url) === normalizeUrlForStory(item?.url) &&
    String(row.title || "").trim() === String(item?.title || "").trim());
  if (!badge || Number(badge.publisher_count) < 2) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "storyIntelBadge";
  const first = badge.first_source_id === sourceId;
  button.textContent = `${first ? "FIRST · " : ""}${badge.publisher_count} pubs`;
  button.title = `${first ? FIRST_MEANING + " " : ""}Publishers still carrying this story in their latest observed coverage, refreshed within two hours. Open Story History.`;
  button.setAttribute("aria-label", `Story History: ${button.textContent}`);
  button.addEventListener("click", e => { e.stopPropagation(); openStoryHistory(badge.story_id, button); });
  return button;
}
function openStoryHistory(storyId, trigger){ return intelligenceDrawers.openStoryHistory(storyId, trigger); }

function trackedPublisherDomains(sources = latestOverviewPayload?.sources || {}){
  return [...new Set(Object.entries(sources).flatMap(([id, src]) => [sourceHomeUrl(id, src), src?.item?.url].map(value => { try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean)))];
}
function openGdeltCoverage(story){ return intelligenceDrawers.openGdeltCoverage(story); }

intelligenceDrawers = window.NewsboardIntelligenceDrawers.create({
  $, data: NewsboardData, drawerManager, format: window.NewsboardFormat,
  getTrackedDomains: trackedPublisherDomains, isGitHubPages, fetchJSON,
  firstMeaning: FIRST_MEANING, headlineDiffHtml,
});
storyRadar = window.NewsboardStoryRadar.create({
  format: window.NewsboardFormat, openStoryHistory,
  sourceLabel: (sourceId) => sourceLabel(sourceId, null),
});

const {
  applyCardEntrance,
  buildCardEl,
  pickCardSourceIds,
  renderCards,
  sortedOverviewIds,
} = window.NewsboardOverview.createOverviewCards({
  expectedSourceIds: EXPECTED_SOURCE_IDS,
  isDiscoverySource,
  sourceHomeUrl,
  sourceLabel,
  ago,
  fmtDurationSeconds,
  storyBadge,
  openGdeltCoverage,
});

const {
  computeSourceDataMetrics,
  createDataRenderer,
  createHistoryRenderer,
} = window.NewsboardHistoryData.createHistoryData({
  parseHoursSpec,
  windowStartMs,
});
const {
  render: renderData,
  renderInto: renderDataInto,
} = createDataRenderer({
  pickCardSourceIds,
  isDiscoverySource,
  sourceLabel,
  fmtDurationMs,
  escapeHtml,
  onSortChange: rerenderDrawers,
});
const { render: renderHistory } = createHistoryRenderer({
  sourceLabel,
  fmtTime,
  ago,
  openHistoryItemDrawer,
});

const { normalize: normalizeForCluster, slugify, stableHash } = window.NewsboardClusterEngine;

function titleCaseShortLabel(phrase){
  const tokens = normalizeForCluster(phrase).split(" ").filter(Boolean);
  const sliced = tokens.slice(0, 2);
  if (!sliced.length) return "Topic";
  return sliced.map((tok) => tok.charAt(0).toUpperCase() + tok.slice(1)).join(" ");
}

function loadJSONStorage(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSONStorage(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function loadClusterCardOrder(){
  const raw = loadJSONStorage(CLUSTER_CARD_ORDER_KEY, {});
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

function saveClusterCardOrder(){
  saveJSONStorage(CLUSTER_CARD_ORDER_KEY, clusterCardOrder || {});
}

function loadClusterStrictness(){
  const raw = String(loadJSONStorage(CLUSTER_STRICTNESS_KEY, "balanced") || "balanced").toLowerCase();
  return CLUSTER_PRESETS[raw] ? raw : "balanced";
}

function saveClusterStrictness(value){
  const mode = CLUSTER_PRESETS[value] ? value : "balanced";
  saveJSONStorage(CLUSTER_STRICTNESS_KEY, mode);
}

function loadClusterDebugMode(){
  return Boolean(loadJSONStorage(CLUSTER_DEBUG_KEY, false));
}

function saveClusterDebugMode(value){
  saveJSONStorage(CLUSTER_DEBUG_KEY, Boolean(value));
}

clusteringStrictness = loadClusterStrictness();
clusteringDebugMode = loadClusterDebugMode();
clusterCardOrder = loadClusterCardOrder();

function overviewItemsFromSources(sources){
  const out = [];
  for (const [sourceId, src] of Object.entries(sources || {})) {
    if (sourceId === 'ap1' || isDiscoverySource(sourceId)) continue;
    out.push({
      sourceId,
      sourceName: sourceLabel(sourceId, src),
      title: String(src?.item?.title || ""),
      url: String(src?.item?.url || ""),
      firstSeenAt: src?.firstSeenAt || src?.updatedAt || null,
    });
  }
  return out;
}

const CLUSTER_BOILERPLATE = [
  "what we know",
  "live updates",
  "latest",
  "analysis",
  "explainer",
  "why it matters",
  "details emerge",
  "here's what",
  "watch",
  "photos",
  "video",
  "what to know",
  "what's happening",
  "whats happening",
];

const CLUSTER_STOPWORDS = new Set([
  "the", "this", "that", "a", "an", "and", "or", "to", "of", "in", "on", "at", "for", "from", "with",
  "after", "before", "as", "by", "about", "into", "over", "under", "what", "why", "how", "who", "where",
  "when", "we", "you", "our",
]);
const CLUSTER_TITLE_DEPRIORITIZED = new Set([
  "what", "know", "happening", "running", "latest", "live", "update", "updates",
  "watch", "video", "photos", "why", "how", "new", "say", "says", "said",
  "warn", "warns", "warning", "tell", "told", "take", "takes", "taking",
  "impact", "impacted", "affect", "affected", "details", "detail", "emerge", "emerges", "continue", "continues",
]);

const CLUSTER_ALIAS_GROUPS = [
  ["mexican", "mexico"],
  ["venezuelan", "venezuela"],
  ["british", "uk"],
  ["russian", "russia"],
  ["ukrainian", "ukraine"],
  ["israeli", "israel"],
  ["palestinian", "palestine"],
  ["iranian", "iran"],
  ["chinese", "china"],
  ["troops", "soldiers"],
  ["guard", "nationalguard"],
  ["cartel", "drugcartel"],
  ["boss", "leader"],
  ["us", "u.s", "u.s.", "usa", "america", "unitedstates"],
];

const CLUSTER_CANONICAL_OVERRIDES = new Map([
  ["u.s", "us"],
  ["u.s.", "us"],
  ["usa", "us"],
  ["america", "us"],
  ["unitedstates", "us"],
]);
const CLUSTER_ACRONYM_ALLOWLIST = new Set([
  "DHS", "DOJ", "FBI", "CIA", "IRS", "ICE", "UN", "NATO", "EU", "CDC", "WHO", "SEC", "FAA", "US",
]);

const CLUSTER_JOINED_BIGRAMS = new Map([
  ["national guard", "nationalguard"],
  ["drug cartel", "drugcartel"],
  ["united states", "us"],
]);

const CLUSTER_ALIAS_INDEX = (() => {
  const out = new Map();
  for (const group of CLUSTER_ALIAS_GROUPS) {
    const normalized = group.map((x) => String(x || "").toLowerCase());
    for (const token of normalized) {
      out.set(token, new Set(normalized));
    }
  }
  return out;
})();

const clusterFeatureTools = window.NewsboardClusterEngine.createFeatureTools({
  boilerplate: CLUSTER_BOILERPLATE,
  stopwords: CLUSTER_STOPWORDS,
  canonicalOverrides: CLUSTER_CANONICAL_OVERRIDES,
  acronymAllowlist: CLUSTER_ACRONYM_ALLOWLIST,
  aliasIndex: CLUSTER_ALIAS_INDEX,
  joinedBigrams: CLUSTER_JOINED_BIGRAMS,
});

const CLUSTER_ENTITY_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "to", "of", "in", "on", "at", "from",
  "after", "amid", "as", "by", "into", "what", "why", "how", "latest", "live", "updates",
  "news", "video", "photos", "opinion",
]);

const CLUSTER_DEMONYM_TO_COUNTRY = new Map([
  ["mexican", "mexico"],
  ["venezuelan", "venezuela"],
  ["british", "uk"],
  ["russian", "russia"],
  ["ukrainian", "ukraine"],
  ["israeli", "israel"],
  ["palestinian", "palestine"],
  ["iranian", "iran"],
  ["chinese", "china"],
  ["american", "us"],
]);

const CLUSTER_ENTITY_PHRASE_MAP = new Map([
  ["u.s.", "us"],
  ["u.s", "us"],
  ["us", "us"],
  ["united states", "us"],
  ["america", "us"],
  ["uk", "uk"],
  ["e.u.", "eu"],
  ["eu", "eu"],
  ["u.n.", "un"],
  ["un", "un"],
  ["nato", "nato"],
  ["fbi", "fbi"],
  ["cia", "cia"],
  ["mexico", "mexico"],
  ["jalisco", "jalisco"],
  ["venezuela", "venezuela"],
  ["russia", "russia"],
  ["ukraine", "ukraine"],
  ["israel", "israel"],
  ["palestine", "palestine"],
  ["iran", "iran"],
  ["china", "china"],
  ["national guard", "national_guard"],
  ["mexican national guard", "mexico_national_guard"],
  ["drug cartel", "drug_cartel"],
  ["cartel", "drug_cartel"],
  ["el mencho", "el_mencho"],
  ["prince andrew", "prince_andrew"],
]);
const CLUSTER_BROAD_ENTITIES = new Set([
  "us", "uk", "eu", "un", "nato",
  "mexico", "venezuela", "russia", "ukraine", "israel", "palestine", "iran", "china",
]);
const clusterScoringTools = window.NewsboardClusterEngine.createScoringTools({
  broadEntities: CLUSTER_BROAD_ENTITIES,
});

const clusterEntityTools = window.NewsboardClusterEngine.createEntityTools({
  stopwords: CLUSTER_ENTITY_STOPWORDS,
  demonymToCountry: CLUSTER_DEMONYM_TO_COUNTRY,
  phraseMap: CLUSTER_ENTITY_PHRASE_MAP,
  acronymAllowlist: CLUSTER_ACRONYM_ALLOWLIST,
  joinedBigrams: CLUSTER_JOINED_BIGRAMS,
});
const extractEntitiesFromHeadline = clusterEntityTools.extract;
const jaccard = window.NewsboardClusterEngine.jaccard;

function trigramSet(text){
  const input = ` ${String(text || "").trim()} `;
  const out = new Set();
  if (input.length < 3) return out;
  for (let i = 0; i + 3 <= input.length; i += 1) {
    out.add(input.slice(i, i + 3));
  }
  return out;
}

function charTrigramSimilarity(a, b){
  return jaccard(trigramSet(a), trigramSet(b));
}

function isNounLikeToken(token){
  const t = String(token || "").toLowerCase();
  if (!t || t.length < 3) return false;
  if (CLUSTER_STOPWORDS.has(t)) return false;
  if (CLUSTER_TITLE_DEPRIORITIZED.has(t)) return false;
  if (/ing$/.test(t) || /ed$/.test(t)) return false;
  return true;
}

function clusterLabelFromTokens(primaryTokens, fallbackTokens = []){
  const picks = [];
  const seen = new Set();
  const tryPick = (token) => {
    const t = String(token || "").toLowerCase();
    if (!t || seen.has(t)) return;
    seen.add(t);
    if (!isNounLikeToken(t)) return;
    picks.push(t);
  };
  for (const token of (primaryTokens || [])) {
    tryPick(token);
    if (picks.length >= 2) break;
  }
  if (picks.length < 2) {
    for (const token of (primaryTokens || [])) {
      const t = String(token || "").toLowerCase();
      if (!t || seen.has(t) || CLUSTER_STOPWORDS.has(t) || CLUSTER_TITLE_DEPRIORITIZED.has(t)) continue;
      seen.add(t);
      picks.push(t);
      if (picks.length >= 2) break;
    }
  }
  if (picks.length < 2) {
    for (const token of (fallbackTokens || [])) {
      const t = String(token || "").toLowerCase();
      if (!t || seen.has(t) || CLUSTER_STOPWORDS.has(t)) continue;
      seen.add(t);
      picks.push(t);
      if (picks.length >= 2) break;
    }
  }
  if (!picks.length) return "Topic";
  return picks.map((tok) => tok.charAt(0).toUpperCase() + tok.slice(1)).join(" ");
}

function compactTwoWordLabel(label){
  const words = String(label || "")
    .replace(/[’']/g, "")
    .split(/\s+/g)
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter((word) => word.length >= 2 && word.toLowerCase() !== "s")
    .slice(0, 2)
    .map((word) => {
      const upper = word.toUpperCase();
      if (CLUSTER_ACRONYM_ALLOWLIST.has(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
  return words.length ? words.join(" ") : "Topic";
}

function buildStoryFeature(item){
  const titleRaw = String(item?.title || "").trim();
  const tokenMetadata = clusterFeatureTools.buildTokenMetadata(titleRaw);
  const titleNorm = tokenMetadata.titleNorm;
  const normTokensUpper = tokenMetadata.tokensUpper;
  const canonicalTokens = tokenMetadata.tokensCore;
  const tokenSet = tokenMetadata.tokenSet;
  const entities = extractEntitiesFromHeadline(titleRaw, titleNorm, {
    tokensUpper: normTokensUpper,
    tokensCore: canonicalTokens,
  });
  const labelTokens = [];
  for (const token of canonicalTokens) {
    if (!labelTokens.includes(token)) labelTokens.push(token);
    if (labelTokens.length >= 8) break;
  }
  const topTokens = [];
  for (const token of labelTokens) {
    if (!topTokens.includes(token)) topTokens.push(token);
    if (topTokens.length >= 6) break;
  }
  return {
    sourceId: String(item?.sourceId || ""),
    title: titleRaw,
    titleRaw,
    titleNorm,
    url: String(item?.url || ""),
    firstSeenAt: item?.firstSeenAt || null,
    firstSeenMs: Number.isFinite(Date.parse(String(item?.firstSeenAt || ""))) ? Date.parse(String(item.firstSeenAt)) : 0,
    norm: titleNorm,
    labelTokens,
    canonicalTokens,
    tokenSet,
    entities,
    topTokens,
    clusterKey: canonicalTokens.slice(0, 8).join("|") || slugify(titleRaw || item?.sourceId || "topic"),
  };
}

const { buildStoryClusters, entityDisplayName } = window.NewsboardClusterAssignment.create({
  CLUSTER_PRESETS, CLUSTER_STOPWORDS, CLUSTER_TITLE_DEPRIORITIZED,
  CLUSTER_MERGE_WINDOW_MS, CLUSTER_HARD_JOIN_WINDOW_MS, CLUSTER_DOMINANT_WINDOW_MS,
  CLUSTER_ENTITY_BUDGET, CLUSTER_ACRONYM_ALLOWLIST,
  buildStoryFeature, clusterLabelFromTokens, compactTwoWordLabel, clusterScoringTools,
  slugify, stableHash, jaccard,
});

function renderOverview(sources, indicatorsById, timelineBySource = {}){
  latestOverviewPayload = { sources, indicators: indicatorsById, timelineBySource };
  renderCards(sources, indicatorsById, timelineBySource);
}

const labsView = window.NewsboardLabsView.create({
  document, requestAnimationFrame, console, buildStoryClusters, entityDisplayName,
  titleCaseShortLabel, escapeHtml, sortedOverviewIds, buildCardEl, applyCardEntrance,
  overviewItemsFromSources,
  getStrictness: () => clusteringStrictness,
  getDebugMode: () => clusteringDebugMode,
  getCardOrder: () => clusterCardOrder,
  saveCardOrder: saveClusterCardOrder,
  getAssignments: () => latestClusterAssignmentsBySource,
  setAssignments: (value) => { latestClusterAssignmentsBySource = value; },
  setLatestOverviewPayload: (value) => { latestOverviewPayload = value; },
});
const renderStoryClusters = labsView.renderStoryClusters;
window.__clusterHarness = labsView.runClusteringHarness;

// Copy/details handlers (URL not displayed)
document.addEventListener("click", async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest("button[data-action]") : null;
  if (!btn) return;

  const action = btn.getAttribute("data-action");
  const id = btn.getAttribute("data-id");
  if (!action) return;

  const link = id
    ? document.querySelector(`a[data-role="headline-link"][data-id="${CSS.escape(id)}"]`)
    : null;
  const href = link && link.href && link.href !== "#" ? link.href : "";

  if (action === "copy-headline") {
    if (!href) return showToast("Nothing to copy");
    try { await copyText(href); showToast("Copied"); } catch { showToast("Copy failed"); }
    return;
  }

  if (action === "open-source-data") {
    if (!id) return;
    setDetailsTab("changes");
    setSourceDataOpen(true, id);
    return;
  }

  if (action === "open-moment") {
    const sourceId = String(id || "abc1");
    const url = btn.getAttribute("data-url") || href || "";
    const title = btn.getAttribute("data-title") || "";
    const ts = btn.getAttribute("data-ts") || null;
    if (!isNarrowLayout()) {
      setSourceDataOpen(true, sourceId);
      setDetailsTab("changes");
      momentState.sourceId = sourceId;
      momentState.url = normalizeUrlForStory(url || "");
      momentState.title = String(title || "").trim();
      momentState.t0 = ts || null;
      momentState.startEarliest = true;
      stopMomentAutoplay();
      setMomentStatus("Building moment...");
      renderSourceDataPanel(sourceId);
      runMomentBuild();
      return;
    }
    openMomentDrawer({ sourceId, url, title, t0: ts });
    setMomentStatus("Ready. Click Run to build frames.");
  }
});


async function loadPublishedTimeline(hours = 12) {
  try {
    const payload = await fetchJSON(`${TIMELINE_URL}?ts=${Date.now()}`);
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const cutoffMs = Date.now() - (Number(hours) * 60 * 60 * 1000);
    return events.filter((ev) => {
      const t = Date.parse(String(ev?.ts || ""));
      return Number.isFinite(t) ? t >= cutoffMs : false;
    });
  } catch {
    return [];
  }
}

function viewFromHash(){
  const raw = String(location.hash || "").replace(/^#/, "").trim().toLowerCase();
  const valid = new Set(["overview", "data", "stories", "playxplay", "labs"]);
  return valid.has(raw) ? raw : "";
}

function setView(which, persist = true) {
  const valid = new Set(["overview", "data", "stories", "playxplay", "labs"]);
  activeView = valid.has(which) ? which : "overview";
  const views = {
    overview: $("view-overview"), data: $("view-data"), stories: $("view-stories"),
    playxplay: $("view-playxplay"), labs: $("view-labs"),
  };
  for (const [name, node] of Object.entries(views)) {
    if (node) node.style.display = activeView === name && (name !== "data" || !isNarrowLayout()) ? "" : "none";
  }
  for (const name of Object.keys(views)) {
    const tab = $(name === "playxplay" ? "tab-playxplay" : `tab-${name}`);
    if (tab) {
      tab.classList.toggle("active", activeView === name);
      tab.setAttribute("aria-selected", activeView === name ? "true" : "false");
    }
  }
  if (persist) {
    try { localStorage.setItem(VIEW_STORAGE_KEY, activeView); } catch {}
    const nextHash = `#${activeView}`;
    if (location.hash !== nextHash) history.replaceState(null, "", `${location.pathname}${location.search}${nextHash}`);
  }
  if (activeView === "labs") renderStoryClusters(latestOverviewPayload.sources, latestOverviewPayload.indicators, latestOverviewPayload.timelineBySource);
  setDataOpen(activeView === "data" ? isNarrowLayout() : false);
}

async function loadCardTimelineBySource(hours = 12, sourcesData = null) {
  function buildFromCacheSources(srcMap){
    const out = {};
    for (const [rawId, rawSrc] of Object.entries(srcMap || {})) {
      const id = canonicalSourceId(rawId);
      if (!id) continue;
      const src = rawSrc || {};
      if (!out[id]) out[id] = [];
      out[id].push({
        ts: src.updatedAt || src.updated_at || src.last?.fetchedAt || null,
        source_id: id,
        kind: src.changeType || src.change_type || "headline",
        title: src?.item?.title || null,
        url: src?.item?.url || null,
      });
    }
    return out;
  }

  if (isGitHubPages) {
    const published = await loadPublishedTimeline(hours);
    if (published.length) {
      const out = {};
      for (const ev of published) {
        const id = canonicalSourceId(ev?.source_id || "");
        if (!id) continue;
        if (!out[id]) out[id] = [];
        out[id].push(ev);
      }
      return out;
    }
    return buildFromCacheSources(sourcesData || {});
  }

  try {
    const resp = await fetchJSON(`/api/timeline?hours=${encodeURIComponent(String(hours))}`);
    const events = Array.isArray(resp?.events) ? resp.events : [];
    const out = {};
    for (const ev of events) {
      const id = canonicalSourceId(ev?.source_id || "");
      if (!id) continue;
      if (!out[id]) out[id] = [];
      out[id].push(ev);
    }
    return out;
  } catch {
    return buildFromCacheSources(sourcesData || {});
  }
}

function timelineKindLabel(kind){
  if (kind === "new_url") return "URL changed";
  if (kind === "new_headline") return "Headline changed";
  return "Heartbeat";
}

function headlineDiffHtml(prevTitle, nextTitle){
  const a = String(prevTitle || ""), b = String(nextTitle || "");
  if (!a && !b) return "—";
  if (!a || !b || a === b) return escapeHtml(b || a);
  let start = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start += 1;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
  return `${escapeHtml(a.slice(0, start))}<span class="diffDel">${escapeHtml(a.slice(start, endA + 1))}</span><span class="diffAdd">${escapeHtml(b.slice(start, endB + 1))}</span>${escapeHtml(b.slice(endB + 1))}`;
}

function isMinorHeadlineEdit(prevTitle, nextTitle){
  const a = String(prevTitle || "").trim(), b = String(nextTitle || "").trim();
  if (!a || !b || a === b) return true;
  let start = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start += 1;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
  return Math.max(0, endA - start + 1) + Math.max(0, endB - start + 1) <= Math.max(14, Math.round(Math.max(a.length, b.length) * 0.28));
}

function appendHeadlineEditMarkup(host, prevTitle, nextTitle){
  if (!isMinorHeadlineEdit(prevTitle, nextTitle)) {
    const newest = document.createElement("div");
    newest.className = "headlineNew";
    newest.textContent = String(nextTitle || "—");
    host.appendChild(newest);
  }
  const line = document.createElement("div");
  line.innerHTML = headlineDiffHtml(prevTitle, nextTitle);
  host.appendChild(line);
}

function headlineHistoryFromTimeline(events, currentUrl = null){
  const rows = [...(events || [])].filter((ev) => ev && ev.ts && ev.title && ev.url).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!rows.length) return { original: null, previous: null, changes: [] };
  const activeUrl = String(currentUrl || rows.at(-1)?.url || "");
  const streak = [];
  for (let i = rows.length - 1; i >= 0 && String(rows[i].url || "") === activeUrl; i--) streak.unshift(rows[i]);
  if (!streak.length) return { original: null, previous: null, changes: [] };
  const start = rows.length - streak.length;
  const previous = start ? { title: String(rows[start - 1].title || "").trim(), ts: rows[start - 1].ts, url: rows[start - 1].url || null } : null;
  const changes = [];
  let previousTitle = null;
  for (const ev of streak) {
    const title = String(ev.title || "").trim();
    if (!title) continue;
    if (previousTitle !== null && title !== previousTitle) changes.push({ fromTitle: previousTitle, toTitle: title, changedAt: ev.ts });
    previousTitle = title;
  }
  return { original: { title: String(streak[0].title || "").trim(), ts: streak[0].ts, url: activeUrl }, previous, changes: changes.reverse() };
}

async function reload() {
  if (isRefreshing) return;
  clearTimeout(retryTimer);
  NewsboardData.clearCache();
  const btnReload = $("btn-reload");
  if (btnReload) btnReload.disabled = true;
  isRefreshing = true;
  renderStatusLine();
  setPlayXPlayStatus("Loading updates...");

  try {
    let data = null;
    let history = null;
    let timelineBySource = {};

    let snapshot = null;
    let liveError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        snapshot = await loadFromSupabase();
        if (!snapshot?.cacheLike?.sources || typeof snapshot.cacheLike.sources !== "object" || Array.isArray(snapshot.cacheLike.sources)) {
          throw new Error("Invalid live snapshot envelope");
        }
        break;
      } catch (error) { NewsboardData.invalidateCurrentObservations(); snapshot = null; liveError = error; }
    }
    if (!snapshot) throw liveError;
    data = snapshot.cacheLike;
    history = snapshot.history;

    // Ensure we always have the full set, so cards don't disappear
    const sources = validateLiveSources(data?.sources || {});
    const latestSourceTs = Math.max(
      0,
      ...Object.values(sources || {}).map((src) => {
        const ms = Date.parse(String(src?.updatedAt || src?.lastChangeAt || ""));
        return Number.isFinite(ms) ? ms : 0;
      })
    );
    const generatedMs = Date.parse(String(data?.generatedAt || ""));
    lastSuccessfulUpdateTs = latestSourceTs || (Number.isFinite(generatedMs) ? generatedMs : 0);
    lastRefreshError = null;
    renderStatusLine();

    if (!history) {
      history = { sources: {} };
    }
    const normalizedHistory = canonicalizeHistoryObj(history || {});
    // Render current headlines before optional history/Story Intelligence requests.
    const preliminary = computeIndicators(sources, normalizedHistory);
    renderCollectionHealth(sources);
    renderOverview(sources, preliminary.indicators, {});
    // Paint current headlines before enriching them. These requests are
    // independent and used to run serially, making their latencies add up
    // during every page load.
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const operationalHealthPromise = NewsboardData.getCollectionHealth().catch(() => ({}));
    const timelinePromise = loadCardTimelineBySource(12, sources);
    const storyBadgesPromise = loadStoryBadges();
    const recentStoriesPromise = loadRecentStories();
    const [operationalHealth, loadedTimeline] = await Promise.all([
      operationalHealthPromise,
      timelinePromise,
      storyBadgesPromise,
      recentStoriesPromise,
    ]);
    timelineBySource = loadedTimeline;
    renderCollectionHealth(sources, operationalHealth);
    const { indicators, nextState } = computeIndicators(sources, normalizedHistory);
    latestDrawerPayload = { normalizedHistory, sources, indicators };
    renderData(normalizedHistory, indicators, sources, selectedWindowHours);
    renderHistory(normalizedHistory, sources, indicators, {
      hostId: "playxplay-history",
      useWindow: false,
      recentLimit: PLAY_X_PLAY_RECENT_LIMIT,
    });
    renderOverview(sources, indicators, timelineBySource);
    renderStoryClusters(sources, indicators, timelineBySource);
    if (nextState) saveState(nextState);
    setPlayXPlayStatus(`Updated ${fmtTime(new Date().toISOString())}`);
    if ($("drawer-source-data")?.classList.contains("open") && selectedSourceDataId) {
      renderSourceDataPanel(selectedSourceDataId);
    }
    if(!openedStoryDeepLink){const storyId=new URL(location.href).searchParams.get("story");if(storyId){openedStoryDeepLink=true;openStoryHistory(storyId,null);}}

  } catch (e) {
    console.error("Refresh error:", e);
    lastRefreshError = summarizeError(e);
    showToast(`Refresh failed: ${lastRefreshError}`);
    const hasExisting = Object.keys(latestOverviewPayload?.sources || {}).length > 0;
    if (!hasExisting) {
      const placeholderSources = ensureExpectedSources({});
      const placeholderIndicators = {};
      const normalizedHistory = { generatedAt: null, sources: {} };
      latestDrawerPayload = { normalizedHistory, sources: placeholderSources, indicators: placeholderIndicators };
      renderCollectionHealth(placeholderSources);
      renderData(normalizedHistory, placeholderIndicators, placeholderSources, selectedWindowHours);
      renderHistory(normalizedHistory, placeholderSources, placeholderIndicators, {
        hostId: "playxplay-history",
        useWindow: false,
        recentLimit: PLAY_X_PLAY_RECENT_LIMIT,
      });
      renderOverview(placeholderSources, placeholderIndicators, {});
      renderStoryClusters(placeholderSources, placeholderIndicators, {});
    }
    setPlayXPlayStatus("Live updates unavailable. Retrying automatically.");
  } finally {
    isRefreshing = false;
    if (lastRefreshError) retryTimer = setTimeout(reload, 15000);
    renderStatusLine();
    if (btnReload) btnReload.disabled = false;
  }
}

async function runScrapeLocal() {
  const btnRun = $("btn-run");
  if (btnRun) btnRun.disabled = true;

  try {
    await fetchJSON(`/api/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    await reload();
    showToast("Scrape complete");
  } catch (e) {
    console.error("Run scrape error:", e);
    showToast("Scrape failed");
  } finally {
    if (btnRun) btnRun.disabled = false;
  }
}

$("btn-reload")?.addEventListener("click", reload);
$("btn-menu")?.addEventListener("click", () => setMenuOpen(true));
$("btn-menu-close")?.addEventListener("click", () => setMenuOpen(false));
$("legend-toggle")?.addEventListener("click", () => {
  const panel = $("legend-more");
  const btn = $("legend-toggle");
  if (!panel || !btn) return;
  const open = panel.classList.toggle("open");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
});
$("tab-overview")?.addEventListener("click", () => setView("overview"));
$("tab-data")?.addEventListener("click", () => setView("data"));
$("tab-stories")?.addEventListener("click", () => setView("stories"));
$("tab-playxplay")?.addEventListener("click", () => setView("playxplay"));
$("tab-labs")?.addEventListener("click", () => setView("labs"));
$("details-tab-changes")?.addEventListener("click", () => setDetailsTab("changes"));
$("details-tab-data")?.addEventListener("click", () => setDetailsTab("data"));
$("cluster-strictness")?.addEventListener("change", (e) => {
  const next = String(e.target?.value || "balanced").toLowerCase();
  clusteringStrictness = CLUSTER_PRESETS[next] ? next : "balanced";
  saveClusterStrictness(clusteringStrictness);
  renderStoryClusters(latestOverviewPayload.sources, latestOverviewPayload.indicators, latestOverviewPayload.timelineBySource);
});
$("cluster-debug")?.addEventListener("change", (e) => {
  clusteringDebugMode = Boolean(e.target?.checked);
  saveClusterDebugMode(clusteringDebugMode);
  renderStoryClusters(latestOverviewPayload.sources, latestOverviewPayload.indicators, latestOverviewPayload.timelineBySource);
});

$("btn-history-close")?.addEventListener("click", () => setHistoryOpen(false));
$("btn-data-close")?.addEventListener("click", () => setDataOpen(false));
$("btn-source-data-close")?.addEventListener("click", () => setSourceDataOpen(false));
$("btn-history-item-close")?.addEventListener("click", () => setHistoryItemOpen(false));
$("btn-moment-close")?.addEventListener("click", () => setMomentOpen(false));
$("moment-lookback")?.addEventListener("change", (e) => {
  momentState.lookbackMinutes = Number(e.target.value || 120);
});
$("btn-moment-run")?.addEventListener("click", runMomentBuild);
$("btn-moment-prev")?.addEventListener("click", () => {
  stopMomentAutoplay();
  if (!momentState.frames.length) return;
  momentState.currentIdx = Math.max(0, Number(momentState.currentIdx || 0) - 1);
  renderMomentFrame();
  renderMomentList();
});
$("btn-moment-next")?.addEventListener("click", () => {
  stopMomentAutoplay();
  if (!momentState.frames.length) return;
  momentState.currentIdx = Math.min(momentState.frames.length - 1, Number(momentState.currentIdx || 0) + 1);
  renderMomentFrame();
  renderMomentList();
});
$("btn-moment-autoplay")?.addEventListener("click", () => {
  if (!momentState.frames.length) return;
  const btn = $("btn-moment-autoplay");
  if (momentState.autoTimer) {
    stopMomentAutoplay();
    return;
  }
  if (btn) btn.textContent = "Stop";
  momentState.autoTimer = setInterval(() => {
    if (!momentState.frames.length) {
      stopMomentAutoplay();
      return;
    }
    const next = Number(momentState.currentIdx || 0) + 1;
    if (next >= momentState.frames.length) {
      stopMomentAutoplay();
      return;
    }
    momentState.currentIdx = next;
    renderMomentFrame();
    renderMomentList();
  }, 1400);
});
$("btn-moment-jump-primary")?.addEventListener("click", () => jumpMomentToTs(momentState.payload?.primary?.ts));
$("btn-moment-jump-t0")?.addEventListener("click", () => jumpMomentToTs(momentState.payload?.t0));
$("source-data-window")?.addEventListener("change", (e) => {
  sourceDataWindowHours = parseHoursSpec(e.target.value);
  if (selectedSourceDataId) renderSourceDataPanel(selectedSourceDataId);
});
$("history-window")?.addEventListener("change", (e) => setSelectedWindowHours(e.target.value));
$("data-window")?.addEventListener("change", (e) => setSelectedWindowHours(e.target.value));
$("data-window-page")?.addEventListener("change", (e) => setSelectedWindowHours(e.target.value));
$("story-radar-window")?.addEventListener("change", renderRecentStoryViews);
$("story-radar-min-publishers")?.addEventListener("change", renderRecentStoryViews);
$("story-radar-sort")?.addEventListener("change", renderRecentStoryViews);
$("story-radar-publisher")?.addEventListener("change", renderRecentStoryViews);
$("story-radar-active")?.addEventListener("change", renderRecentStoryViews);
$("story-radar-number-one")?.addEventListener("change", renderRecentStoryViews);
$("btn-story-history-close")?.addEventListener("click", () => closeAllDrawers());
$("btn-gdelt-close")?.addEventListener("click", () => closeAllDrawers());
$("menu-go-overview")?.addEventListener("click", () => {
  setMenuOpen(false);
  setView("overview");
});
$("menu-go-data")?.addEventListener("click", () => {
  setMenuOpen(false);
  setView("data");
});
$("menu-go-stories")?.addEventListener("click", () => {
  setMenuOpen(false);
  setView("stories");
});
$("menu-go-playxplay")?.addEventListener("click", () => {
  setMenuOpen(false);
  setView("playxplay");
});
$("menu-go-labs")?.addEventListener("click", () => {
  setMenuOpen(false);
  setView("labs");
});


window.addEventListener("resize", () => {
  if (activeView === "data") setDataOpen(isNarrowLayout());
});
window.addEventListener("hashchange", () => {
  const fromHash = viewFromHash();
  if (!fromHash || fromHash === activeView) return;
  setView(fromHash, true);
});

if (isLocal && !isGitHubPages) {
  const btnRun = $("btn-run");
  if (btnRun) {
    btnRun.style.display = "inline-block";
    btnRun.addEventListener("click", runScrapeLocal);
  }
}

let initialView = "overview";
try {
  const savedView = String(localStorage.getItem(VIEW_STORAGE_KEY) || "").toLowerCase();
  if (savedView === "overview" || savedView === "data" || savedView === "stories" || savedView === "playxplay" || savedView === "labs") {
    initialView = savedView;
  }
} catch {}
const hashView = viewFromHash();
if (hashView) initialView = hashView;
setView(initialView, false);
setSelectedWindowHours(HISTORY_WINDOW_DEFAULT_HOURS);
sourceDataWindowHours = HISTORY_WINDOW_DEFAULT_HOURS;
setDetailsTab("changes");
const sourceDataWindow = $("source-data-window");
if (sourceDataWindow) sourceDataWindow.value = String(sourceDataWindowHours);
const momentLookback = $("moment-lookback");
if (momentLookback) momentLookback.value = String(momentState.lookbackMinutes);
const clusterStrictnessEl = $("cluster-strictness");
if (clusterStrictnessEl) clusterStrictnessEl.value = clusteringStrictness;
const clusterDebugEl = $("cluster-debug");
if (clusterDebugEl) clusterDebugEl.checked = clusteringDebugMode;
renderStatusLine();
reload();
window.addEventListener("online", () => reload());
document.addEventListener("visibilitychange", () => { if (!document.hidden) reload(); });
// Refresh visible data after each collection interval without page navigation.
setInterval(() => { if (!document.hidden && !isRefreshing) reload(); }, 300000);

const runClusterHarnessFromQuery = new URLSearchParams(location.search).get("cluster_harness");
if (runClusterHarnessFromQuery === "1" || runClusterHarnessFromQuery === "true") {
  labsView.runClusteringHarness();
}
