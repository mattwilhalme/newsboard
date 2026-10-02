(function (global) {
  "use strict";

  function createOverviewCards(options = {}) {
    const {
      expectedSourceIds = [],
      isDiscoverySource,
      sourceHomeUrl,
      sourceLabel,
      ago,
      fmtDurationSeconds,
      storyBadge,
      openGdeltCoverage,
    } = options;

    function pickCardSourceIds(sources) {
      const have = new Set(Object.keys(sources || {}));
      have.delete("ap1");
      const ordered = [];
      for (const id of expectedSourceIds) {
        ordered.push(id);
        have.delete(id);
      }
      for (const id of Array.from(have).sort()) ordered.push(id);
      return ordered;
    }

    function tsForSort(sources, id) {
      const timestamp = sources?.[id]?.updatedAt || sources?.[id]?.firstSeenAt || null;
      const milliseconds = Date.parse(timestamp || "");
      return Number.isFinite(milliseconds) ? milliseconds : 0;
    }

    function isVideoItem(src) {
      const contentType = String(src?.item?.contentType || src?.contentType || "").toLowerCase();
      if (contentType === "video") return true;
      const url = String(src?.item?.url || "").toLowerCase();
      const title = String(src?.item?.title || "").toLowerCase();
      return /\/video(\/|$)/.test(url) || (/\/live(\/|$)/.test(url) && /\babc news live\b/.test(title));
    }

    function isLiveBlogItem(src) {
      if (isVideoItem(src)) return false;
      const contentType = String(src?.item?.contentType || src?.contentType || "").toLowerCase();
      if (contentType === "live") return true;
      const url = String(src?.item?.url || "").toLowerCase();
      const title = String(src?.item?.title || "").toLowerCase();
      return /\/live(\/|$)/.test(url) || /\/live-blog\//.test(url) || /\/live-updates(\/|$)/.test(url) || /\blive blog\b/.test(title);
    }

    function changeTsForSort(sources, indicatorsById, id) {
      const indicator = indicatorsById?.[id] || {};
      const urlMilliseconds = Number(indicator?.currentSinceAt || 0);
      const headlineMilliseconds = Number(indicator?.headlineSinceAt || 0);
      const src = sources?.[id] || {};
      const fallbackMilliseconds = Date.parse(String(src?.lastChangeAt || src?.updatedAt || src?.firstSeenAt || ""));
      const best = Math.max(
        Number.isFinite(urlMilliseconds) ? urlMilliseconds : 0,
        Number.isFinite(headlineMilliseconds) ? headlineMilliseconds : 0,
        Number.isFinite(fallbackMilliseconds) ? fallbackMilliseconds : 0,
      );
      return Number.isFinite(best) ? best : 0;
    }

    function applyCardEntrance(card, id, index) {
      const column = index % 3;
      const row = Math.floor(index / 3);
      card.classList.add("card-enter");
      card.style.setProperty("--enter-x", `${(column - 1) * 10}px`);
      card.style.setProperty("--enter-y", `${18 + row * 3}px`);
      card.style.setProperty("--enter-r", `${(column - 1) * 0.55}deg`);
      card.style.setProperty("--enter-delay", `${Math.round(row * 90 + column * 60)}ms`);
    }

    function buildCardEl(id, src, indicator) {
      const discovery = isDiscoverySource(id);
      const card = document.createElement("section");
      card.className = "card";
      card.setAttribute("data-source-id", id);

      const head = document.createElement("div");
      head.className = "cardHead";
      const left = document.createElement("div");
      left.className = "srcTitle";
      const meta = document.createElement("div");
      meta.className = "srcMeta";
      const srcName = document.createElement("div");
      srcName.className = "srcName";
      const homeUrl = sourceHomeUrl(id, src);
      if (homeUrl) {
        const sourceAnchor = document.createElement("a");
        sourceAnchor.className = "srcNameLink";
        sourceAnchor.href = homeUrl;
        sourceAnchor.target = "_blank";
        sourceAnchor.rel = "noopener";
        sourceAnchor.textContent = discovery ? "Associated Press" : sourceLabel(id, src);
        srcName.appendChild(sourceAnchor);
      } else {
        srcName.textContent = discovery ? "Associated Press" : sourceLabel(id, src);
      }
      meta.appendChild(srcName);
      if (discovery) {
        const label = document.createElement("div");
        label.className = "srcVia";
        label.textContent = "via Google News";
        label.title = "Unranked AP story discovery, not AP homepage rankings";
        meta.appendChild(label);
      }
      left.appendChild(meta);

      const copyButton = document.createElement("button");
      copyButton.className = "copyIconBtn";
      copyButton.type = "button";
      copyButton.textContent = "⧉";
      copyButton.title = "Copy headline link";
      copyButton.setAttribute("aria-label", "Copy headline link");
      copyButton.setAttribute("data-action", "copy-headline");
      copyButton.setAttribute("data-id", id);
      left.appendChild(copyButton);

      const right = document.createElement("div");
      right.className = "rightMeta";
      const updatedAt = src?.updatedAt || null;
      const firstSeenAt = src?.firstSeenAt || src?.since || null;
      const hasHeadlineUpdate = indicator?.changeType === "headline";
      const firstSeenEverAt = indicator?.firstSeenEverAt || firstSeenAt || updatedAt || null;
      const headlineSinceAt = indicator?.headlineSinceAt || updatedAt || null;
      const reenteredAt = indicator?.reenteredAt || 0;

      const time = document.createElement("div");
      time.className = "tiny cardStamp";
      time.textContent = updatedAt ? `Updated ${ago(updatedAt || headlineSinceAt)}` : "";
      const since = document.createElement("div");
      since.className = "tiny cardStamp";
      since.textContent = reenteredAt ? `Re-entered ${ago(reenteredAt)}` : "";
      const firstSeenLine = document.createElement("div");
      firstSeenLine.className = "tiny cardStamp";
      if (hasHeadlineUpdate && headlineSinceAt) {
        firstSeenLine.textContent = firstSeenEverAt ? `First seen ${ago(firstSeenEverAt)}` : "First seen —";
      } else if (firstSeenEverAt) {
        firstSeenLine.textContent = `First seen ${ago(firstSeenEverAt)}`;
      } else if (src?.secondsInTop !== null && src?.secondsInTop !== undefined) {
        firstSeenLine.textContent = `First seen ${fmtDurationSeconds(src.secondsInTop)} ago`;
      } else {
        firstSeenLine.textContent = "First seen —";
      }
      right.appendChild(time);
      if (!discovery) {
        right.appendChild(since);
        right.appendChild(firstSeenLine);
      } else {
        const published = document.createElement("div");
        published.className = "tiny cardStamp";
        published.textContent = src?.item?.publishedAt ? `Published ${ago(src.item.publishedAt)}` : "Latest published discovery";
        right.appendChild(published);
      }
      const crawlStatus = src?.health?.crawlStatus || "unknown";
      if (!discovery && crawlStatus !== "success") {
        const healthLine = document.createElement("div");
        healthLine.className = "tiny crawlStatus";
        healthLine.textContent = ({ pending: "Browser crawl pending", running: "Browser crawl running", failed: src?.ok ? "Crawl Failed — showing last successful observation" : "Crawl Failed" })[crawlStatus] || "Crawl pending";
        healthLine.title = src?.health?.latestError || "";
        right.appendChild(healthLine);
      }
      head.appendChild(left);
      head.appendChild(right);

      const body = document.createElement("div");
      body.className = "cardBody";
      const wrap = document.createElement("div");
      wrap.className = "headlineWrap";
      if (src?.item?.breakingLabel) {
        const breakingTag = document.createElement("div");
        breakingTag.className = "breakingNewsTag";
        breakingTag.textContent = src.item.breakingLabel;
        wrap.appendChild(breakingTag);
      }
      if (isVideoItem(src)) {
        const videoTag = document.createElement("div");
        videoTag.className = "videoTag";
        videoTag.textContent = "Video";
        wrap.appendChild(videoTag);
      }
      if (isLiveBlogItem(src)) {
        const liveTag = document.createElement("div");
        liveTag.className = "liveBlogTag";
        liveTag.textContent = "Live Blog";
        wrap.appendChild(liveTag);
      }

      const headline = document.createElement("h2");
      headline.className = "headline";
      const headlineAnchor = document.createElement("a");
      headlineAnchor.setAttribute("data-role", "headline-link");
      headlineAnchor.setAttribute("data-id", id);
      headlineAnchor.href = src?.item?.url || "#";
      headlineAnchor.target = "_blank";
      headlineAnchor.rel = "noopener";
      headlineAnchor.textContent = src?.item?.title || "—";
      headline.appendChild(headlineAnchor);

      const changeRow = document.createElement("div");
      changeRow.className = "changeRow";
      const dot = document.createElement("span");
      const changeType = String(indicator?.changeType || "").toLowerCase();
      dot.className = `changeDot ${changeType === "url" ? "url" : changeType === "headline" ? "headline" : "none"}`;
      changeRow.appendChild(dot);

      const actions = document.createElement("div");
      actions.className = "cardActions";
      const detailsButton = document.createElement("button");
      detailsButton.type = "button";
      detailsButton.className = "linkbtn";
      detailsButton.textContent = discovery ? "View discoveries" : "Details";
      detailsButton.setAttribute("data-action", "open-source-data");
      detailsButton.setAttribute("data-id", id);
      if (!discovery) actions.appendChild(changeRow);
      actions.appendChild(detailsButton);
      const intelligence = discovery ? null : storyBadge(id, src?.item);
      if (intelligence) actions.appendChild(intelligence);
      const coverageButton = document.createElement("button");
      coverageButton.type = "button";
      coverageButton.className = "linkbtn";
      coverageButton.textContent = "Trace coverage";
      coverageButton.disabled = !src?.item?.title || !firstSeenEverAt;
      coverageButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const observedMilliseconds = Number(firstSeenEverAt) || Date.parse(firstSeenEverAt);
        openGdeltCoverage({
          title: src?.item?.title || "",
          url: src?.item?.url || "",
          source: sourceLabel(id, src),
          observed_at: new Date(observedMilliseconds).toISOString(),
        });
      });
      actions.appendChild(coverageButton);

      const error = document.createElement("div");
      error.className = "tiny";
      error.textContent = !discovery && src?.error ? String(src.error) : "";
      wrap.appendChild(headline);
      wrap.appendChild(actions);
      wrap.appendChild(error);
      body.appendChild(wrap);
      card.appendChild(head);
      card.appendChild(body);
      return card;
    }

    function sortedOverviewIds(sources, indicatorsById) {
      const ids = pickCardSourceIds(sources);
      const changePriority = (id) => {
        const type = String(indicatorsById?.[id]?.changeType || "").toLowerCase();
        return type === "url" ? 0 : type === "headline" ? 1 : 2;
      };
      ids.sort((a, b) => {
        const priorityDifference = changePriority(a) - changePriority(b);
        if (priorityDifference) return priorityDifference;
        const changeDifference = changeTsForSort(sources, indicatorsById, b) - changeTsForSort(sources, indicatorsById, a);
        if (changeDifference) return changeDifference;
        const timestampDifference = tsForSort(sources, b) - tsForSort(sources, a);
        return timestampDifference || String(a).localeCompare(String(b));
      });
      return ids;
    }

    function renderCards(sources, indicatorsById) {
      const grid = document.getElementById("cards-grid");
      if (!grid) return;
      grid.innerHTML = "";
      const ids = sortedOverviewIds(sources, indicatorsById);
      const hasContent = ids.some((id) => {
        const src = sources?.[id] || {};
        const title = String(src?.item?.title || "").trim();
        const url = String(src?.item?.url || "").trim();
        return (title && title !== "—") || url;
      });
      for (const id of ids) {
        const card = buildCardEl(id, sources?.[id] || {}, indicatorsById?.[id] || { changeType: null });
        applyCardEntrance(card, id, grid.children.length);
        grid.appendChild(card);
      }
      if (!hasContent) {
        const empty = document.createElement("div");
        empty.className = "emptyState";
        empty.style.gridColumn = "1 / -1";
        empty.textContent = "No data yet. Refreshing will repopulate cards when sources are available.";
        grid.appendChild(empty);
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const card of grid.querySelectorAll(".card.card-enter")) card.classList.add("card-settle");
      }));
    }

    return { applyCardEntrance, buildCardEl, pickCardSourceIds, renderCards, sortedOverviewIds };
  }

  global.NewsboardOverview = { createOverviewCards };
})(window);
