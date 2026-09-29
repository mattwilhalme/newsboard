(function initNewsboardStoryRadar(global) {
  "use strict";

  function create({ format, openStoryHistory, sourceLabel }) {
    const { ago, fmtTime } = format;

    function number(value) {
      const parsed = Number(value || 0);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function metric(label, value, tone = "") {
      const pill = document.createElement("span");
      pill.className = `storyRadarMetric${tone ? ` ${tone}` : ""}`;
      pill.textContent = `${label} ${value}`;
      return pill;
    }

    function createCard(story, { compact = false } = {}) {
      const card = document.createElement("article");
      card.className = "latestItem isClickable storyRadarCard";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Open Story History: ${story.canonical_label}`);

      const meta = document.createElement("div");
      meta.className = "latestMetaRow";
      const identity = document.createElement("div");
      identity.className = "srcMeta srcMetaInline";
      const source = document.createElement("div");
      source.className = "srcName";
      source.textContent = `${number(story.publishers_detected)} publishers`;
      const detected = document.createElement("div");
      detected.className = "srcTime";
      detected.textContent = `First detected by ${sourceLabel(story.first_source_id)} · ${fmtTime(story.first_detected_at)}`;
      identity.append(source, detected);
      const lastSeen = document.createElement("div");
      lastSeen.className = "srcTime storyRadarLastSeen";
      lastSeen.textContent = `Updated ${ago(story.last_seen_at)}`;
      meta.append(identity, lastSeen);

      const body = document.createElement("div");
      body.className = "latestBody";
      const main = document.createElement("div");
      main.className = "latestMain";
      const title = document.createElement("h3");
      title.className = "latestTitle";
      title.textContent = story.canonical_label || "Untitled story";
      main.appendChild(title);

      const metrics = document.createElement("div");
      metrics.className = "storyRadarMetrics";
      metrics.appendChild(metric("Active", number(story.recent_publishers), number(story.recent_publishers) > 0 ? "isActive" : ""));
      if (!compact || number(story.publishers_reaching_number_one)) metrics.appendChild(metric("No. 1", number(story.publishers_reaching_number_one)));
      if (!compact || number(story.rank_changes)) metrics.appendChild(metric("Rank moves", number(story.rank_changes)));
      if (!compact || number(story.headline_changes)) metrics.appendChild(metric("Rewrites", number(story.headline_changes)));
      main.appendChild(metrics);
      body.appendChild(main);
      card.append(meta, body);

      const open = () => openStoryHistory(story.story_id, card);
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
      return card;
    }

    function filteredStories(stories, options = {}) {
      const hours = Math.max(1, number(options.hours) || 24);
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const minPublishers = Math.max(2, number(options.minPublishers) || 2);
      const activeOnly = Boolean(options.activeOnly);
      const rows = (Array.isArray(stories) ? stories : []).filter((story) => {
        const lastSeen = Date.parse(String(story.last_seen_at || ""));
        return Number.isFinite(lastSeen) && lastSeen >= cutoff && number(story.publishers_detected) >= minPublishers && (!activeOnly || number(story.recent_publishers) > 0);
      });
      const sort = options.sort || "recent";
      rows.sort((a, b) => {
        if (sort === "reach") return number(b.publishers_detected) - number(a.publishers_detected) || Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at);
        if (sort === "movement") {
          const score = (story) => number(story.rank_changes) + number(story.headline_changes) + number(story.publishers_reaching_number_one) * 2;
          return score(b) - score(a) || Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at);
        }
        return Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at);
      });
      return rows;
    }

    function render(host, stories, options = {}) {
      if (!host) return [];
      const rows = filteredStories(stories, options);
      const limit = Math.max(1, number(options.limit) || rows.length || 1);
      host.replaceChildren();
      for (const story of rows.slice(0, limit)) host.appendChild(createCard(story, { compact: options.compact }));
      if (!host.children.length) {
        const empty = document.createElement("div");
        empty.className = "inlineEmpty";
        empty.textContent = options.emptyText || "No multi-publisher stories matched this view.";
        host.appendChild(empty);
      }
      return rows;
    }

    return { createCard, filteredStories, render };
  }

  global.NewsboardStoryRadar = { create };
})(window);
