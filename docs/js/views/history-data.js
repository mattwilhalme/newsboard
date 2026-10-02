(function (global) {
  "use strict";

  function createHistoryData({ parseHoursSpec, windowStartMs, now = () => Date.now() }) {
    function historyEntryBoundsMs(entry) {
      const start = Date.parse(String(entry?.firstSeenAt || entry?.lastSeenAt || ""));
      const endRaw = Date.parse(String(entry?.lastSeenAt || entry?.firstSeenAt || ""));
      if (!Number.isFinite(start) && !Number.isFinite(endRaw)) return null;
      const startMs = Number.isFinite(start) ? start : endRaw;
      const endMs = Number.isFinite(endRaw) ? endRaw : startMs;
      return { startMs, endMs: endMs >= startMs ? endMs : startMs };
    }

    function canonicalStoryKey(entry) {
      const rawUrl = String(entry?.url || "").trim().toLowerCase();
      if (rawUrl) {
        try {
          const url = new URL(rawUrl);
          url.hash = "";
          if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
          for (const key of [...url.searchParams.keys()]) {
            const lower = key.toLowerCase();
            if (lower.startsWith("utm_") || lower === "fbclid" || lower === "gclid") url.searchParams.delete(key);
          }
          url.searchParams.sort();
          return `u:${url.toString()}`;
        } catch {}
      }
      const title = String(entry?.title || "").trim().toLowerCase();
      return title ? `t:${title}` : "unknown";
    }

    function computeSourceDataMetrics(entries, windowSpec) {
      const winStart = windowStartMs(windowSpec);
      const hours = parseHoursSpec(windowSpec);
      const daysDivisor = hours === 168 ? 7 : 1;
      const normalized = [...(Array.isArray(entries) ? entries : [])]
        .map((entry) => {
          const bounds = historyEntryBoundsMs(entry);
          return bounds ? { ...entry, ...bounds } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
      const inWindow = normalized.filter((entry) => entry.endMs >= winStart);
      const distinctUrls = new Set(inWindow.map(canonicalStoryKey));
      const liveBlogUrls = new Set(inWindow.filter((entry) => {
        const type = String(entry?.contentType || entry?.content_type || "").toLowerCase();
        const url = String(entry?.url || "").toLowerCase();
        const title = String(entry?.title || "").toLowerCase();
        return (type === "live" || /\/live(\/|$)/.test(url) || /\blive blog\b/.test(title)) && url;
      }).map(canonicalStoryKey));
      const breakingNewsCount = inWindow.filter((entry) => {
        const label = String(entry?.breakingLabel || entry?.breaking_label || "").toLowerCase();
        const headline = String(entry?.breakingHeadline || entry?.breaking_headline || "").toLowerCase();
        const title = String(entry?.title || "").toLowerCase();
        return label.includes("breaking") || headline.includes("breaking") || title.startsWith("breaking");
      }).length;

      let urlChanges = 0;
      let headlineOnlyChanges = 0;
      for (let index = 1; index < normalized.length; index += 1) {
        const previous = normalized[index - 1];
        const current = normalized[index];
        if (current.endMs < winStart) continue;
        if (canonicalStoryKey(current) !== canonicalStoryKey(previous)) urlChanges += 1;
        else if (String(current?.title || "") !== String(previous?.title || "")) headlineOnlyChanges += 1;
      }

      let longestRunMs = 0;
      let index = 0;
      while (index < normalized.length) {
        const first = normalized[index];
        const key = canonicalStoryKey(first);
        let runEnd = first.endMs;
        let next = index + 1;
        while (next < normalized.length && canonicalStoryKey(normalized[next]) === key) {
          runEnd = Math.max(runEnd, normalized[next].endMs);
          next += 1;
        }
        if (runEnd >= winStart) longestRunMs = Math.max(longestRunMs, Math.max(0, runEnd - Math.max(first.startMs, winStart)));
        index = next;
      }

      const bucketMs = (hours <= 6 ? 30 : 60) * 60 * 1000;
      const bucketCount = Math.max(1, Math.ceil((now() - winStart) / bucketMs));
      const buckets = Array.from({ length: bucketCount }, (_, bucketIndex) => ({ startMs: winStart + bucketIndex * bucketMs, url: 0, headline: 0 }));
      for (let eventIndex = 1; eventIndex < normalized.length; eventIndex += 1) {
        const previous = normalized[eventIndex - 1];
        const current = normalized[eventIndex];
        if (current.endMs < winStart) continue;
        const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor((current.endMs - winStart) / bucketMs)));
        if (canonicalStoryKey(current) !== canonicalStoryKey(previous)) buckets[bucketIndex].url += 1;
        else if (String(current?.title || "") !== String(previous?.title || "")) buckets[bucketIndex].headline += 1;
      }

      const liveBlogs = liveBlogUrls.size;
      return {
        urlChanges,
        headlineOnlyChanges,
        uniqueStories: distinctUrls.size,
        longestRunMs,
        urlChangesDisplay: urlChanges / daysDivisor,
        headlineOnlyChangesDisplay: headlineOnlyChanges / daysDivisor,
        uniqueStoriesDisplay: distinctUrls.size / daysDivisor,
        perDay: daysDivisor > 1,
        liveBlogs,
        breakingNews: breakingNewsCount,
        liveBlogsDisplay: liveBlogs / daysDivisor,
        breakingNewsDisplay: breakingNewsCount / daysDivisor,
        buckets,
      };
    }

    function fmtMetricValue(value, perDay) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "—";
      const rounded = perDay ? Math.round(number * 10) / 10 : Math.round(number);
      return perDay ? `${rounded.toFixed(1)}/day` : String(rounded);
    }

    return { canonicalStoryKey, computeSourceDataMetrics, fmtMetricValue, historyEntryBoundsMs };
  }

  global.NewsboardHistoryData = { createHistoryData };
})(window);
