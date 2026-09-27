(function installNewsboardFormat(global) {
  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
    } catch { return "—"; }
  }

  function ago(ts) {
    if (!ts) return "—";
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return "—";
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function fmtDurationSeconds(seconds) {
    const s0 = Number(seconds);
    if (!Number.isFinite(s0) || s0 < 0) return "—";
    const s = Math.floor(s0);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function fmtDurationMs(ms) {
    const value = Number(ms);
    return !Number.isFinite(value) || value < 0 ? "—" : fmtDurationSeconds(Math.floor(value / 1000));
  }

  function normalizeUrlForStory(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      const host = String(url.hostname || "").toLowerCase();
      if (host.startsWith("www.")) url.hostname = host.slice(4);
      url.hash = "";
      url.pathname = url.pathname.replace(/\/{2,}/g, "/");
      if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
      const drop = new Set(["fbclid", "gclid", "dclid", "mc_cid", "mc_eid", "ocid", "_ga", "_gl", "spm"]);
      for (const key of [...url.searchParams.keys()]) {
        const lower = String(key || "").toLowerCase();
        if (lower.startsWith("utm_") || drop.has(lower)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      return url.toString();
    } catch { return raw; }
  }

  function normalizeTitleForStory(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  function summarizeError(err) {
    const raw = String(err?.message || err || "").trim();
    return raw ? raw.replace(/\s+/g, " ").slice(0, 120) : "Unknown error";
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  }

  global.NewsboardFormat = Object.freeze({
    fmtTime, ago, fmtDurationSeconds, fmtDurationMs, normalizeUrlForStory,
    normalizeTitleForStory, summarizeError, escapeHtml,
  });
})(globalThis);
