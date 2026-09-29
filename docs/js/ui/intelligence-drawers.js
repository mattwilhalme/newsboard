(function initNewsboardIntelligenceDrawers(global) {
  "use strict";

  function create(options) {
    const {
      $, data, drawerManager, format, getTrackedDomains, isGitHubPages,
      fetchJSON, firstMeaning, headlineDiffHtml,
    } = options;
    const { ago, escapeHtml, fmtDurationSeconds, fmtTime, summarizeError } = format;
    let storyRequest = 0;
    let gdeltRequest = 0;
    let storyTrigger = null;

    function cancel() {
      storyRequest += 1;
      gdeltRequest += 1;
      if (storyTrigger?.isConnected) storyTrigger.focus();
      storyTrigger = null;
    }

    async function openStoryHistory(storyId, trigger) {
      drawerManager.open("drawer-story-history", { focusId: "btn-story-history-close" });
      storyTrigger = trigger;
      const request = ++storyRequest;
      const host = $("story-history-content");
      host.textContent = "Loading story history…";
      const deepLink = new URL(location.href);
      deepLink.searchParams.set("story", storyId);
      global.history.replaceState(null, "", deepLink);
      try {
        const payload = await data.getStoryHistory(storyId);
        if (request !== storyRequest) return;
        renderStoryHistory(host, payload);
      } catch {
        if (request === storyRequest) host.textContent = "Story History is temporarily unavailable. Headlines remain available; close and try again.";
      }
    }

    function renderStoryHistory(host, payload) {
      if (!payload?.story) {
        host.textContent = "Story history is not available yet.";
        return;
      }
      const story = payload.story;
      const members = payload.members || [];
      const summary = payload.metrics || {};
      const first = members.find((member) => member.source_id === story.first_source_id);
      const heading = document.createElement("h2");
      heading.className = "storyHistoryHeadline";
      heading.textContent = story.canonical_label;
      host.replaceChildren(heading);

      const metrics = document.createElement("dl");
      metrics.className = "storyHistoryMetrics";
      const values = [
        ["First detected by Newsboard", `${first?.publisher || story.first_source_id} · ${fmtTime(story.first_detected_at)}`],
        ["Detected", ago(story.first_detected_at)],
        ["Publishers detected", summary.publishers_detected ?? members.length],
        ["Recent publishers", payload.publisher_count],
        ["Time to peak coverage", summary.time_to_peak_seconds == null ? "—" : fmtDurationSeconds(summary.time_to_peak_seconds)],
        ["Time to first No. 1", summary.time_to_number_one_seconds == null ? "Not observed" : fmtDurationSeconds(summary.time_to_number_one_seconds)],
        ["Rank changes", summary.rank_changes ?? 0],
        ["Headline rewrites", summary.headline_changes ?? 0],
      ];
      for (const [label, value] of values) {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = label;
        dd.textContent = String(value);
        metrics.append(dt, dd);
      }
      host.appendChild(metrics);
      const note = document.createElement("p");
      note.className = "tiny";
      note.textContent = `${firstMeaning} Recent counts require a successful observation within two hours. Ranked events are generated only from complete, centerpiece-aligned Top 10 runs; partial coverage creates no movement or exit claims. Times are shown in your timezone.`;
      host.appendChild(note);

      if (members.length) {
        const title = document.createElement("h3");
        title.textContent = "Publisher journey";
        host.appendChild(title);
        const table = document.createElement("table");
        table.className = "storyJourney";
        table.innerHTML = "<thead><tr><th>Publisher</th><th>First detected</th><th>First rank</th><th>Peak</th><th>Observed</th></tr></thead>";
        const body = document.createElement("tbody");
        for (const member of members) {
          const row = document.createElement("tr");
          const cells = [member.publisher, fmtTime(member.first_seen_at), member.first_rank ? `#${member.first_rank}` : "Lead", member.peak_rank ? `#${member.peak_rank}` : "—", fmtDurationSeconds(member.observed_duration_seconds || 0)];
          for (const value of cells) {
            const cell = document.createElement("td");
            cell.textContent = String(value);
            row.appendChild(cell);
          }
          body.appendChild(row);
        }
        table.appendChild(body);
        host.appendChild(table);
      }

      const timelineTitle = document.createElement("h3");
      timelineTitle.textContent = "Observed timeline";
      host.appendChild(timelineTitle);
      const list = document.createElement("ol");
      list.className = "storyPropagation";
      for (const event of payload.events || []) {
        const li = document.createElement("li");
        const stamp = document.createElement("div");
        stamp.className = "tiny";
        stamp.textContent = `${fmtTime(event.observed_at)} · ${event.publisher}`;
        const text = document.createElement("div");
        text.className = "storyEventLabel";
        const meta = event.metadata || {};
        const labels = { FIRST_DETECTED: `First detected at #${event.rank}`, PUBLISHER_PICKUP: `Picked up at #${event.rank}`, ENTERED_TOP10: `Entered Top 10 at #${event.rank}`, REACHED_NUMBER_ONE: "Reached No. 1", RANK_CHANGED: `Moved #${meta.from_rank} → #${meta.to_rank}`, HEADLINE_CHANGED: "Headline changed", URL_CHANGED: "Article URL changed", EXITED_TOP10: "Left Top 10", LEFT_HOMEPAGE_LEAD: "Left homepage lead (lower ranks not observed)", RETURNED_TO_LEAD: "Returned to homepage lead" };
        text.textContent = labels[event.event_type] || event.event_type;
        li.append(stamp, text);
        if (event.event_type === "HEADLINE_CHANGED") {
          const diff = document.createElement("p");
          diff.className = "storyHeadlineDiff";
          diff.innerHTML = headlineDiffHtml(meta.old_headline, meta.new_headline);
          li.appendChild(diff);
        } else if (["FIRST_DETECTED", "PUBLISHER_PICKUP"].includes(event.event_type)) {
          const headline = document.createElement("p");
          headline.textContent = event.headline;
          li.appendChild(headline);
        }
        if (event.published_at) {
          const published = document.createElement("div");
          published.className = "tiny";
          published.textContent = `Published at ${fmtTime(event.published_at)} (publisher metadata)`;
          li.appendChild(published);
        }
        list.appendChild(li);
      }
      host.appendChild(list);
      if (payload.events_truncated) {
        const truncated = document.createElement("p");
        truncated.textContent = "Showing the first 1,000 events.";
        host.appendChild(truncated);
      }
    }

    async function coverageRequest(story) {
      const params = new URLSearchParams({ headline: story.title, url: story.url || "", source: story.source || "", observed_at: story.observed_at, tracked_domains: getTrackedDomains().join(",") });
      if (!isGitHubPages) return fetchJSON(`/api/gdelt/coverage?${params}`);
      const config = await data.getConfig();
      const response = await fetch(`${config.url}/functions/v1/gdelt-coverage?${params}`, { headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `Coverage request failed (${response.status})`);
      return body;
    }

    function renderGdeltCoverage(host, payload) {
      host.replaceChildren();
      const detected = document.createElement("div");
      detected.className = "gdeltDetected";
      const label = document.createElement("strong");
      label.textContent = "Newsboard detected";
      const meta = document.createElement("div");
      meta.textContent = `${payload.newsboard_story?.source || "Unknown publisher"} · ${fmtTime(payload.newsboard_story?.observed_at)}`;
      detected.append(label, meta);
      host.appendChild(detected);
      const results = Array.isArray(payload.results) ? payload.results : [];
      if (!results.length) {
        const empty = document.createElement("p");
        empty.textContent = "No credible matching English-language coverage was found in the selected window.";
        host.appendChild(empty);
      }
      const list = document.createElement("ol");
      list.className = "gdeltList";
      for (const result of results) {
        const li = document.createElement("li");
        li.className = "gdeltResult";
        const row = document.createElement("div");
        row.className = "gdeltResultMeta";
        row.textContent = `${result.gdelt_seen_at ? fmtTime(result.gdelt_seen_at) : "Time unavailable"} — ${result.domain || "Unknown publisher"}`;
        if (result.tracked_by_newsboard) {
          const pill = document.createElement("span"); pill.className = "gdeltPill"; pill.textContent = "Newsboard tracks"; row.appendChild(pill);
        }
        if (result.is_newsboard_article) {
          const pill = document.createElement("span"); pill.className = "gdeltPill gdeltSelf"; pill.textContent = "This article"; row.appendChild(pill);
        }
        const link = document.createElement("a");
        link.href = result.url; link.target = "_blank"; link.rel = "noopener"; link.textContent = result.title;
        li.append(row, link); list.appendChild(li);
      }
      host.appendChild(list);
      if (payload.earliest_match) {
        const earliest = document.createElement("div");
        earliest.className = "gdeltEarliest";
        earliest.innerHTML = `<strong>Earliest GDELT match:</strong> ${escapeHtml(payload.earliest_match.domain || "Unknown publisher")} · ${escapeHtml(payload.earliest_match.gdelt_seen_at ? fmtTime(payload.earliest_match.gdelt_seen_at) : "Time unavailable")}`;
        host.appendChild(earliest);
      }
      const debug = document.createElement("div");
      debug.className = "gdeltDebug";
      debug.textContent = `Query: ${payload.query || "—"} · ${Number(payload.raw_result_count || 0)} raw / ${results.length} shown`;
      host.appendChild(debug);
    }

    async function openGdeltCoverage(story) {
      drawerManager.open("drawer-gdelt", { focusId: "btn-gdelt-close" });
      const request = ++gdeltRequest;
      const host = $("gdelt-content");
      host.textContent = "Tracing GDELT coverage…";
      try {
        const payload = await coverageRequest(story);
        if (request === gdeltRequest) renderGdeltCoverage(host, payload);
      } catch (error) {
        if (request === gdeltRequest) host.textContent = `GDELT Coverage is temporarily unavailable: ${summarizeError(error)}`;
      }
    }

    return { cancel, openGdeltCoverage, openStoryHistory, renderGdeltCoverage, renderStoryHistory };
  }

  global.NewsboardIntelligenceDrawers = { create };
})(window);
