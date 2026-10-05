(function (global) {
  function create({
    document, requestAnimationFrame, console,
    buildStoryClusters, entityDisplayName, titleCaseShortLabel, escapeHtml,
    sortedOverviewIds, buildCardEl, applyCardEntrance, overviewItemsFromSources,
    getStrictness, getDebugMode, getCardOrder, saveCardOrder,
    getAssignments, setAssignments, setLatestOverviewPayload,
  }) {
    const byId = (id) => document.getElementById(id);
    function renderClusterChips(clusterResult) {
      const activeHost = byId("cluster-active");
      const suggHost = byId("cluster-suggestions");
      if (activeHost) activeHost.innerHTML = "";
      if (suggHost) suggHost.innerHTML = "";

      const clusters = Array.isArray(clusterResult?.clusters) ? clusterResult.clusters : [];
      if (activeHost) {
        for (const cluster of clusters) {
          const chip = document.createElement("div");
          chip.className = "chip";
          chip.textContent = `${cluster.label} (${cluster.items.length})`;
          chip.title = [...(cluster.entitySet || [])].map(entityDisplayName).join(", ");
          activeHost.appendChild(chip);
        }
      }
      if (suggHost) {
        const chip = document.createElement("div");
        chip.className = "chip";
        chip.textContent = `Mode: ${titleCaseShortLabel(clusterResult?.strictness || "balanced")}`;
        suggHost.appendChild(chip);
      }
    }

    function appendClusterDebugInfo(card, sourceId) {
      if (!getDebugMode()) return;
      const details = getAssignments()?.[sourceId];
      if (!details) return;
      const body = card.querySelector(".cardBody .headlineWrap");
      if (!body) return;
      const box = document.createElement("div");
      box.className = "clusterDebugCard";
      const score = Number.isFinite(Number(details.score)) ? Number(details.score).toFixed(3) : "0.000";
      const entityOverlap = Number.isFinite(Number(details.entityOverlap)) ? Number(details.entityOverlap).toFixed(3) : "0.000";
      const tokenOverlap = Number.isFinite(Number(details.tokenOverlap)) ? Number(details.tokenOverlap).toFixed(3) : "0.000";
      box.innerHTML = [
        `<div><strong>Cluster:</strong> ${escapeHtml(details.clusterLabel || "Other")}</div>`,
        `<div><strong>Score:</strong> ${escapeHtml(score)} (${escapeHtml(details.rule || "new")})</div>`,
        `<div><strong>Why:</strong> ${escapeHtml(details.why || details.rule || "—")}</div>`,
        `<div><strong>Hard-join anchor:</strong> ${escapeHtml(details.hardJoinAnchor ? entityDisplayName(details.hardJoinAnchor) : "—")}</div>`,
        `<div><strong>Entity overlap:</strong> ${escapeHtml(entityOverlap)} | <strong>Token overlap:</strong> ${escapeHtml(tokenOverlap)}</div>`,
        `<div><strong>Entities:</strong> ${escapeHtml((details.entities || []).slice(0, 8).map(entityDisplayName).join(", ") || "—")}</div>`,
        `<div><strong>Exemplar entities:</strong> ${escapeHtml((details.exemplarEntities || []).slice(0, 8).map(entityDisplayName).join(", ") || "—")}</div>`,
        `<div><strong>Tokens:</strong> ${escapeHtml((details.itemTokens || []).slice(0, 8).join(", ") || "—")}</div>`,
        `<div><strong>Exemplar tokens:</strong> ${escapeHtml((details.exemplarTokens || []).slice(0, 8).join(", ") || "—")}</div>`,
      ].join("");
      body.appendChild(box);
    }

    function renderClusteredOverview(sources, indicatorsById, timelineBySource = {}, clusterResult = null) {
      const groupsHost = byId("cluster-groups");
      if (!groupsHost) return;
      groupsHost.innerHTML = "";
      if (!sources || !Object.keys(sources).length) return;

      function applySavedOrder(clusterId, idsInGroup) {
        const saved = Array.isArray(getCardOrder()?.[clusterId]) ? getCardOrder()[clusterId] : [];
        if (!saved.length) return [...idsInGroup];
        const keep = new Set(idsInGroup);
        const ordered = saved.filter((id) => keep.has(id));
        for (const id of idsInGroup) if (!ordered.includes(id)) ordered.push(id);
        return ordered;
      }

      function persistGridOrder(clusterId, gridEl) {
        const order = [...gridEl.querySelectorAll(".card[data-source-id]")]
          .map((el) => String(el.getAttribute("data-source-id") || ""))
          .filter(Boolean);
        getCardOrder()[clusterId] = order;
        saveCardOrder();
      }

      function afterElementByY(container, y) {
        const candidates = [...container.querySelectorAll(".card:not(.dragging)")];
        let best = { offset: Number.NEGATIVE_INFINITY, el: null };
        for (const child of candidates) {
          const rect = child.getBoundingClientRect();
          const offset = y - rect.top - (rect.height / 2);
          if (offset < 0 && offset > best.offset) best = { offset, el: child };
        }
        return best.el;
      }

      const ids = sortedOverviewIds(sources, indicatorsById);
      const clusters = Array.isArray(clusterResult?.clusters) ? clusterResult.clusters : [];
      const grouped = new Map(clusters.map((cluster) => [cluster.id, []]));
      grouped.set("other", []);
      for (const id of ids) {
        const clusterId = getAssignments()?.[id]?.clusterId || "other";
        if (!grouped.has(clusterId)) grouped.set(clusterId, []);
        grouped.get(clusterId).push(id);
      }

      for (const clusterId of [...clusters.map((cluster) => cluster.id), "other"]) {
        const idsInGroup = applySavedOrder(clusterId, grouped.get(clusterId) || []);
        if (!idsInGroup.length) continue;
        const section = document.createElement("section");
        section.className = "clusterGroup";
        const head = document.createElement("div");
        head.className = "clusterHeader";
        const h1 = document.createElement("h1");
        h1.textContent = clusterId === "other" ? "Other" : (clusters.find((cluster) => cluster.id === clusterId)?.label || "Other");
        const count = document.createElement("span");
        count.className = "tiny";
        count.textContent = `(${idsInGroup.length})`;
        head.appendChild(h1);
        head.appendChild(count);

        const groupGrid = document.createElement("div");
        groupGrid.className = "grid";
        for (const id of idsInGroup) {
          const card = buildCardEl(id, sources?.[id] || {}, indicatorsById?.[id] || { changeType: null }, timelineBySource);
          appendClusterDebugInfo(card, id);
          card.draggable = true;
          card.addEventListener("dragstart", (event) => {
            card.classList.add("dragging");
            event.dataTransfer?.setData("text/plain", id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          });
          card.addEventListener("dragend", () => {
            card.classList.remove("dragging");
            persistGridOrder(clusterId, groupGrid);
          });
          applyCardEntrance(card, id, groupGrid.children.length);
          groupGrid.appendChild(card);
        }
        groupGrid.addEventListener("dragover", (event) => {
          event.preventDefault();
          const dragging = groupGrid.querySelector(".card.dragging");
          if (!dragging) return;
          const after = afterElementByY(groupGrid, event.clientY);
          if (!after) groupGrid.appendChild(dragging);
          else groupGrid.insertBefore(dragging, after);
        });
        groupGrid.addEventListener("drop", (event) => {
          event.preventDefault();
          persistGridOrder(clusterId, groupGrid);
        });
        section.appendChild(head);
        section.appendChild(groupGrid);
        groupsHost.appendChild(section);
      }

      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const card of groupsHost.querySelectorAll(".card.card-enter")) card.classList.add("card-settle");
      }));
    }

    function renderStoryClusters(sources, indicatorsById, timelineBySource = {}) {
      setLatestOverviewPayload({ sources, indicators: indicatorsById, timelineBySource });
      try {
        const result = buildStoryClusters(overviewItemsFromSources(sources), getStrictness());
        setAssignments(result.bySource || {});
        renderClusterChips(result);
        renderClusteredOverview(sources, indicatorsById, timelineBySource, result);
      } catch (error) {
        console.error("Cluster render failed", error);
        const groupsHost = byId("cluster-groups");
        const activeHost = byId("cluster-active");
        const suggHost = byId("cluster-suggestions");
        if (activeHost) activeHost.innerHTML = "";
        if (suggHost) suggHost.innerHTML = "";
        if (!groupsHost) return;
        groupsHost.innerHTML = "";
        const alert = document.createElement("div");
        alert.className = "inlineEmpty";
        alert.textContent = "Story clustering is temporarily unavailable. Showing unclustered cards.";
        groupsHost.appendChild(alert);
        const fallback = document.createElement("section");
        fallback.className = "clusterGroup";
        const grid = document.createElement("div");
        grid.className = "grid";
        for (const id of sortedOverviewIds(sources, indicatorsById)) {
          grid.appendChild(buildCardEl(id, sources?.[id] || {}, indicatorsById?.[id] || { changeType: null }, timelineBySource));
        }
        fallback.appendChild(grid);
        groupsHost.appendChild(fallback);
      }
    }

    function runClusteringHarness() {
      const sample = [
        { sourceId: "s0", title: "Dhs warns of new border threats", url: "" },
        { sourceId: "s0b", title: "DHS warning: border threats rise", url: "" },
        { sourceId: "s0c", title: "Schumer's proposal advances in Senate", url: "" },
        { sourceId: "s0d", title: "Schumers proposal advances in Senate", url: "" },
        { sourceId: "s1", title: "Mexican drug cartel boss captured in Jalisco", url: "" },
        { sourceId: "s2", title: "Cartel leader arrested in Mexico after raid", url: "" },
        { sourceId: "s3", title: "Tourists told to take shelter after National Guard troops killed", url: "" },
        { sourceId: "s4", title: "National Guard soldiers killed; shelter warning issued to tourists", url: "" },
        { sourceId: "s5", title: "Federal Reserve signals no change to rates", url: "" },
      ];
      const result = buildStoryClusters(sample, getStrictness());
      console.log(`[cluster-harness] strictness=${getStrictness()} clusters=${result.clusters.length}`);
      for (const cluster of result.clusters) console.log(`- ${cluster.label} (${cluster.items.length})`, cluster.items.map((item) => item.title));
      return result;
    }

    return { renderStoryClusters, runClusteringHarness };
  }

  global.NewsboardLabsView = { create };
})(window);
