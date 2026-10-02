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

    function createDataRenderer({
      pickCardSourceIds,
      isDiscoverySource,
      sourceLabel,
      fmtDurationMs,
      escapeHtml,
      onSortChange,
    }) {
      let sortState = { key: "publisher", dir: "asc" };
      const sortArrow = (key) => sortState.key !== key ? "↕" : sortState.dir === "asc" ? "↑" : "↓";
      function toggleSort(key) {
        sortState = sortState.key === key
          ? { key, dir: sortState.dir === "asc" ? "desc" : "asc" }
          : { key, dir: key === "publisher" ? "asc" : "desc" };
        onSortChange();
      }

      function renderInto(host, normalizedHistory, indicatorsById = {}, currentSources = {}, windowSpec = 24) {
        if (!host) return;
        host.innerHTML = "";
        const historySources = normalizedHistory?.sources && typeof normalizedHistory.sources === "object" ? normalizedHistory.sources : {};
        const sourceIds = pickCardSourceIds(currentSources || {}).filter((id) => !isDiscoverySource(id));
        const hasRows = sourceIds.some((id) => (historySources?.[id]?.entries?.length || currentSources?.[id]?.item?.url || currentSources?.[id]?.item?.title));
        if (!sourceIds.length || !hasRows) {
          const empty = document.createElement("div");
          empty.className = "tiny";
          empty.style.color = "var(--muted)";
          empty.textContent = "No data loaded.";
          host.appendChild(empty);
          return;
        }

        const winStart = windowStartMs(windowSpec);
        const rows = sourceIds.map((sourceId) => {
          const sourceRow = currentSources?.[sourceId] || null;
          return {
            sourceId,
            sourceRow,
            metrics: computeSourceDataMetrics(historySources?.[sourceId]?.entries || [], windowSpec),
            currentSinceAt: indicatorsById?.[sourceId]?.currentSinceAt || null,
            sortPublisher: sourceLabel(sourceId, sourceRow),
          };
        });
        const values = {
          publisher: (row) => row.sortPublisher,
          urlChanges: (row) => row.metrics.urlChangesDisplay,
          longestRun: (row) => row.metrics.longestRunMs,
          headlineOnly: (row) => row.metrics.headlineOnlyChangesDisplay,
          liveBlogs: (row) => row.metrics.liveBlogsDisplay,
          breakingNews: (row) => row.metrics.breakingNewsDisplay,
        };
        rows.sort((a, b) => {
          const aValue = values[sortState.key](a);
          const bValue = values[sortState.key](b);
          const comparison = sortState.key === "publisher" ? String(aValue).localeCompare(String(bValue)) : aValue - bValue;
          return sortState.dir === "asc" ? comparison : -comparison;
        });

        const table = document.createElement("table");
        table.className = "dataTable";
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const column of [
          ["publisher", "Publisher"], ["urlChanges", "URL changes"], ["longestRun", "Longest run"],
          ["headlineOnly", "Headline Changes"], ["liveBlogs", "Live Blogs"], ["breakingNews", "Breaking News"],
        ]) {
          const th = document.createElement("th");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "dataSortBtn";
          button.innerHTML = `${escapeHtml(column[1])} <span class="sortArrow">${escapeHtml(sortArrow(column[0]))}</span>`;
          button.addEventListener("click", () => toggleSort(column[0]));
          th.appendChild(button);
          headRow.appendChild(th);
        }
        head.appendChild(headRow);
        table.appendChild(head);
        const body = document.createElement("tbody");
        for (const row of rows) {
          const tr = document.createElement("tr");
          const publisher = document.createElement("td");
          publisher.className = "dataPublisherCell";
          publisher.textContent = sourceLabel(row.sourceId, row.sourceRow);
          const sinceMs = Date.parse(String(row.currentSinceAt || ""));
          if (Number.isFinite(sinceMs) && sinceMs > 0) {
            const run = document.createElement("div");
            run.className = "tiny";
            run.textContent = `Current run ${fmtDurationMs(Math.max(0, now() - Math.max(winStart, sinceMs)))}`;
            publisher.appendChild(document.createElement("br"));
            publisher.appendChild(run);
          }
          const cell = (text) => { const td = document.createElement("td"); td.textContent = text; return td; };
          tr.append(
            publisher,
            cell(fmtMetricValue(row.metrics.urlChangesDisplay, row.metrics.perDay)),
            cell(fmtDurationMs(row.metrics.longestRunMs)),
            cell(fmtMetricValue(row.metrics.headlineOnlyChangesDisplay, row.metrics.perDay)),
            cell(fmtMetricValue(row.metrics.liveBlogsDisplay, row.metrics.perDay)),
            cell(fmtMetricValue(row.metrics.breakingNewsDisplay, row.metrics.perDay)),
          );
          body.appendChild(tr);
        }
        table.appendChild(body);
        host.appendChild(table);
      }

      function render(normalizedHistory, indicatorsById, currentSources, windowSpec) {
        renderInto(document.getElementById("data"), normalizedHistory, indicatorsById, currentSources, windowSpec);
        renderInto(document.getElementById("data-page"), normalizedHistory, indicatorsById, currentSources, windowSpec);
      }
      return { render, renderInto };
    }

    return { canonicalStoryKey, computeSourceDataMetrics, createDataRenderer, fmtMetricValue, historyEntryBoundsMs };
  }

  global.NewsboardHistoryData = { createHistoryData };
})(window);
