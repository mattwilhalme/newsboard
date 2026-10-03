(function initNewsboardClusterAssignment(global) {
  "use strict";
  function create({ CLUSTER_PRESETS, CLUSTER_STOPWORDS, CLUSTER_TITLE_DEPRIORITIZED, CLUSTER_MERGE_WINDOW_MS, CLUSTER_HARD_JOIN_WINDOW_MS, CLUSTER_DOMINANT_WINDOW_MS, CLUSTER_ENTITY_BUDGET, CLUSTER_ACRONYM_ALLOWLIST, buildStoryFeature, clusterLabelFromTokens, compactTwoWordLabel, clusterScoringTools, slugify, stableHash, jaccard }) {
    function sortClustersStable(clusters){
      return [...(clusters || [])].sort((a, b) => {
        const ta = Number(a?.firstSeenMs || 0);
        const tb = Number(b?.firstSeenMs || 0);
        if (ta !== tb) return ta - tb;
        return String(a?.label || "").localeCompare(String(b?.label || ""));
      });
    }

    function entityDisplayName(entity){
      const value = String(entity || "");
      if (/^[a-z]{2,6}$/.test(value) && CLUSTER_ACRONYM_ALLOWLIST.has(value.toUpperCase())) {
        return value.toUpperCase();
      }
      return value
        .split("_")
        .filter(Boolean)
        .map((w) => (/^[a-z]{2,6}$/.test(w) && CLUSTER_ACRONYM_ALLOWLIST.has(w.toUpperCase()))
          ? w.toUpperCase()
          : (w.charAt(0).toUpperCase() + w.slice(1)))
        .join(" ");
    }

    function computeEntityTokenSimilarity(feature, cluster, preset){
      return clusterScoringTools.compare(feature, cluster, preset);
    }

    function relaxedSimilarity(feature, cluster, preset){
      return clusterScoringTools.compareRelaxed(feature, cluster, preset);
    }

    function recomputeClusterMetadata(cluster){
      const entityFreq = new Map();
      const tokenFreq = new Map();
      for (const item of (cluster.items || [])) {
        for (const entity of (item.entities || [])) {
          entityFreq.set(entity, (entityFreq.get(entity) || 0) + 1);
        }
        const descriptorSource = Array.isArray(item.labelTokens) && item.labelTokens.length
          ? item.labelTokens
          : (item.tokens || []);
        for (const tok of descriptorSource) {
          tokenFreq.set(tok, (tokenFreq.get(tok) || 0) + 1);
        }
      }
      const topEntities = [...entityFreq.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([entity]) => entity)
        .slice(0, 2);
      const entityTokenBlocklist = new Set(topEntities.flatMap((e) => e.split("_")));
      const descriptor = [...tokenFreq.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([token]) => token)
        .find((token) => !entityTokenBlocklist.has(token) && !CLUSTER_TITLE_DEPRIORITIZED.has(token) && token.length >= 4) || "";
      const primaryEntityLabel = topEntities.length ? entityDisplayName(topEntities[0]) : "";
      const descriptorLabel = descriptor ? (descriptor.charAt(0).toUpperCase() + descriptor.slice(1)) : "";
      const fallbackLabel = clusterLabelFromTokens(cluster.exemplarTokens, cluster.exemplarTokens);
      const rawLabel = primaryEntityLabel
        ? (descriptorLabel ? `${primaryEntityLabel} ${descriptorLabel}` : primaryEntityLabel)
        : fallbackLabel;
      const label = compactTwoWordLabel(rawLabel);
      const unionEntities = new Set();
      for (const entity of entityFreq.keys()) unionEntities.add(entity);
      return {
        ...cluster,
        label,
        entityFreq,
        tokenFreq,
        topEntities,
        entitySet: unionEntities,
      };
    }

    function mergeClusterInto(base, other){
      const baseFirst = Number(base.firstSeenMs || 0);
      const otherFirst = Number(other.firstSeenMs || 0);
      const useOtherExemplar = otherFirst < baseFirst;
      const merged = {
        ...base,
        firstSeenMs: Math.min(baseFirst, otherFirst),
        exemplarTitle: useOtherExemplar ? other.exemplarTitle : base.exemplarTitle,
        exemplarNorm: useOtherExemplar ? other.exemplarNorm : base.exemplarNorm,
        exemplarEntitySet: useOtherExemplar ? new Set(other.exemplarEntitySet || []) : new Set(base.exemplarEntitySet || []),
        exemplarTokenSet: useOtherExemplar ? new Set(other.exemplarTokenSet || []) : new Set(base.exemplarTokenSet || []),
        exemplarTokens: useOtherExemplar ? [...(other.exemplarTokens || [])] : [...(base.exemplarTokens || [])],
        items: [...(base.items || []), ...(other.items || [])].sort((a, b) => (a.firstSeenMs || 0) - (b.firstSeenMs || 0)),
      };
      return recomputeClusterMetadata(merged);
    }

    function entityClusterCountInWindow(clusters, entity, anchorMs){
      return (clusters || []).filter((cluster) =>
        cluster.entitySet?.has(entity) &&
        Math.abs(Number(cluster.firstSeenMs || 0) - Number(anchorMs || 0)) <= CLUSTER_MERGE_WINDOW_MS).length;
    }

    function enforceEntityBudget(clusters, preset){
      let out = sortClustersStable(clusters);
      const hasWindowOverflow = (entity) => {
        const ms = out
          .filter((cluster) => cluster.entitySet?.has(entity))
          .map((cluster) => Number(cluster.firstSeenMs || 0))
          .sort((a, b) => a - b);
        for (let i = 0; i < ms.length; i += 1) {
          let count = 1;
          for (let j = i + 1; j < ms.length; j += 1) {
            if (ms[j] - ms[i] > CLUSTER_MERGE_WINDOW_MS) break;
            count += 1;
            if (count > CLUSTER_ENTITY_BUDGET) return true;
          }
        }
        return false;
      };

      const allEntities = () => {
        const outSet = new Set();
        for (const cluster of out) {
          for (const entity of (cluster.entitySet || [])) outSet.add(entity);
        }
        return [...outSet].sort((a, b) => a.localeCompare(b));
      };

      for (const entity of allEntities()) {
        let guard = 0;
        while (hasWindowOverflow(entity) && guard < 48) {
          guard += 1;
          let bestPair = null;
          for (let i = 0; i < out.length; i += 1) {
            if (!out[i].entitySet?.has(entity)) continue;
            for (let j = i + 1; j < out.length; j += 1) {
              if (!out[j].entitySet?.has(entity)) continue;
              const delta = Math.abs(Number(out[i].firstSeenMs || 0) - Number(out[j].firstSeenMs || 0));
              if (delta > CLUSTER_MERGE_WINDOW_MS) continue;
              const fa = {
                entities: out[i].exemplarEntitySet || new Set(),
                tokenSet: out[i].exemplarTokenSet || new Set(),
              };
              const sim = relaxedSimilarity(fa, out[j], preset);
              if (!sim.ok) continue;
              if (!bestPair || sim.score > bestPair.score) bestPair = { i, j, score: sim.score };
            }
          }
          if (!bestPair) break;
          out[bestPair.i] = mergeClusterInto(out[bestPair.i], out[bestPair.j]);
          out.splice(bestPair.j, 1);
          out = sortClustersStable(out);
        }
      }
      return out;
    }

    function enforceDominantEntityMerge(clusters){
      let out = sortClustersStable(clusters);
      const hasOverflowInWindow = (entity) => {
        const ms = out
          .filter((cluster) => cluster.entitySet?.has(entity))
          .map((cluster) => Number(cluster.firstSeenMs || 0))
          .sort((a, b) => a - b);
        for (let i = 0; i < ms.length; i += 1) {
          let count = 1;
          for (let j = i + 1; j < ms.length; j += 1) {
            if (ms[j] - ms[i] > CLUSTER_DOMINANT_WINDOW_MS) break;
            count += 1;
            if (count > CLUSTER_ENTITY_BUDGET) return true;
          }
        }
        return false;
      };

      const allEntities = () => {
        const set = new Set();
        for (const cluster of out) {
          for (const entity of (cluster.entitySet || [])) set.add(entity);
        }
        return [...set].sort((a, b) => a.localeCompare(b));
      };

      for (const dominant of allEntities()) {
        let guard = 0;
        while (hasOverflowInWindow(dominant) && guard < 60) {
          guard += 1;
          let bestPair = null;
          for (let i = 0; i < out.length; i += 1) {
            const a = out[i];
            if (!a.entitySet?.has(dominant)) continue;
            for (let j = i + 1; j < out.length; j += 1) {
              const b = out[j];
              if (!b.entitySet?.has(dominant)) continue;
              const delta = Math.abs(Number(a.firstSeenMs || 0) - Number(b.firstSeenMs || 0));
              if (delta > CLUSTER_DOMINANT_WINDOW_MS) continue;
              const tokenOverlap = jaccard(a.exemplarTokenSet, b.exemplarTokenSet);
              const secondaryShared = [...(a.entitySet || [])]
                .some((entity) => entity !== dominant && b.entitySet?.has(entity));
              if (!(tokenOverlap >= 0.18 || secondaryShared)) continue;
              const score = tokenOverlap + (secondaryShared ? 0.5 : 0);
              if (!bestPair || score > bestPair.score) bestPair = { i, j, score };
            }
          }
          if (!bestPair) break;
          out[bestPair.i] = mergeClusterInto(out[bestPair.i], out[bestPair.j]);
          out.splice(bestPair.j, 1);
          out = sortClustersStable(out);
        }
      }
      return out;
    }

    function reassignSoloClusters(clusters){
      const sorted = sortClustersStable(clusters);
      const grouped = sorted.filter((cluster) => (cluster.items || []).length > 1);
      const solos = sorted.filter((cluster) => (cluster.items || []).length === 1);
      const otherSourceIds = new Set();
      if (!solos.length) return { clusters: sorted, otherSourceIds };
      if (!grouped.length) {
        for (const solo of solos) {
          const item = (solo.items || [])[0];
          if (item?.sourceId) otherSourceIds.add(String(item.sourceId));
        }
        return { clusters: [], otherSourceIds };
      }

      const byId = new Map(grouped.map((cluster) => [cluster.id, { ...cluster, items: [...(cluster.items || [])] }]));
      const orderedSolos = [...solos].sort((a, b) => {
        const ia = (a.items || [])[0] || {};
        const ib = (b.items || [])[0] || {};
        const ta = Number(ia.firstSeenMs || 0);
        const tb = Number(ib.firstSeenMs || 0);
        if (ta !== tb) return ta - tb;
        return String(ia.sourceId || "").localeCompare(String(ib.sourceId || ""));
      });

      for (const solo of orderedSolos) {
        const item = (solo.items || [])[0];
        if (!item?.sourceId) continue;
        const itemEntities = new Set(item.entities || []);
        const itemTokens = new Set(item.tokens || []);
        let best = null;
        for (const cluster of byId.values()) {
          const clusterEntities = cluster.entitySet instanceof Set ? cluster.entitySet : new Set(cluster.exemplarEntitySet || []);
          const clusterTokens = cluster.tokenFreq ? new Set(cluster.tokenFreq.keys()) : new Set(cluster.exemplarTokenSet || []);
          const sharedEntities = [...itemEntities].filter((entity) => clusterEntities.has(entity));
          const sharedTokens = [...itemTokens].filter((token) =>
            clusterTokens.has(token) &&
            !CLUSTER_STOPWORDS.has(String(token || "").toLowerCase()) &&
            !CLUSTER_TITLE_DEPRIORITIZED.has(String(token || "").toLowerCase()));
          if (!sharedEntities.length && !sharedTokens.length) continue;
          const entityOverlap = jaccard(itemEntities, clusterEntities);
          const tokenOverlap = jaccard(itemTokens, new Set(cluster.exemplarTokenSet || []));
          const score = (entityOverlap * 0.5) + (tokenOverlap * 0.25)
            + Math.min(0.2, sharedEntities.length * 0.12)
            + Math.min(0.2, sharedTokens.length * 0.06);
          if (!best || score > best.score) {
            best = { clusterId: cluster.id, score, sharedEntities, sharedTokens, entityOverlap, tokenOverlap };
          }
        }

        if (!best) {
          otherSourceIds.add(String(item.sourceId));
          continue;
        }

        const target = byId.get(best.clusterId);
        if (!target) {
          otherSourceIds.add(String(item.sourceId));
          continue;
        }
        target.items.push({
          ...item,
          rule: "solo_reassign",
          why: `solo_reassign(${best.sharedEntities.slice(0, 2).join(",") || "token"}${best.sharedTokens.length ? `;tokens:${best.sharedTokens.slice(0, 2).join(",")}` : ""})`,
          hardJoinAnchor: best.sharedEntities[0] || item.hardJoinAnchor || "",
          score: best.score,
          entityOverlap: best.entityOverlap,
          tokenOverlap: best.tokenOverlap,
        });
        byId.set(best.clusterId, recomputeClusterMetadata(target));
      }

      return { clusters: sortClustersStable([...byId.values()]), otherSourceIds };
    }

    function buildStoryClusters(items, strictness = "balanced"){
      const preset = CLUSTER_PRESETS[strictness] || CLUSTER_PRESETS.balanced;
      const features = (items || []).map((item) => buildStoryFeature(item));
      const ordered = [...features].sort((a, b) => {
        if (a.firstSeenMs !== b.firstSeenMs) return a.firstSeenMs - b.firstSeenMs;
        return a.sourceId.localeCompare(b.sourceId);
      });

      let clusters = [];
      for (const feature of ordered) {
        let best = null;
        const candidates = sortClustersStable(clusters);
        for (const cluster of candidates) {
          const delta = Math.abs(Number(cluster.firstSeenMs || 0) - Number(feature.firstSeenMs || 0));
          if (delta > CLUSTER_HARD_JOIN_WINDOW_MS) continue;
          const shared = [...feature.entities].filter((entity) => cluster.entitySet?.has(entity));
          if (!shared.length) continue;
          const sim = computeEntityTokenSimilarity(feature, cluster, preset);
          const clusterTokenPool = cluster.tokenFreq ? new Set(cluster.tokenFreq.keys()) : new Set(cluster.exemplarTokenSet || []);
          const sharedNouns = [...feature.tokenSet].filter((token) =>
            clusterTokenPool.has(token) &&
            !CLUSTER_TITLE_DEPRIORITIZED.has(String(token || "").toLowerCase()) &&
            !CLUSTER_STOPWORDS.has(String(token || "").toLowerCase()));
          const hardJoinScore = sim.score + (sharedNouns.length ? Math.min(0.18, sharedNouns.length * 0.06) : 0);
          if (!best || hardJoinScore > best.score) {
            best = {
              cluster,
              ...sim,
              score: hardJoinScore,
              matched: true,
              rule: "hard_join_entity",
              why: `hard_join(${shared.slice(0, 3).join(",")}${sharedNouns.length ? `;tokens:${sharedNouns.slice(0, 2).join(",")}` : ""})`,
              sharedAnchor: shared[0],
            };
          }
        }

        if (!best) {
          for (const cluster of candidates) {
            const sim = computeEntityTokenSimilarity(feature, cluster, preset);
            if (!sim.matched) continue;
            if (!best || sim.score > best.score) {
              best = { cluster, ...sim, why: "direct_match" };
            }
          }
        }

        if (!best) {
          const budgetEntities = [...feature.entities]
            .filter((entity) => entityClusterCountInWindow(clusters, entity, feature.firstSeenMs) >= CLUSTER_ENTITY_BUDGET)
            .sort((a, b) => a.localeCompare(b));
          if (budgetEntities.length) {
            for (const cluster of candidates) {
              if (![...cluster.entitySet || []].some((entity) => budgetEntities.includes(entity))) continue;
              const relaxed = relaxedSimilarity(feature, cluster, preset);
              if (!relaxed.ok) continue;
              if (!best || relaxed.score > best.score) {
                best = {
                  cluster,
                  matched: true,
                  score: relaxed.score,
                  entityOverlap: relaxed.entityOverlap,
                  tokenOverlap: relaxed.tokenOverlap,
                  rule: "entity_budget_relaxed",
                  why: `entity_budget(${budgetEntities.join(",")})`,
                };
              }
            }
          }
        }

        if (!best) {
          const label = clusterLabelFromTokens(feature.labelTokens, feature.canonicalTokens);
          const id = `${slugify(label)}-${stableHash(`${label}|${feature.sourceId}|${feature.norm}`)}`;
          const newCluster = recomputeClusterMetadata({
            id,
            label,
            exemplarTitle: feature.title || label,
            exemplarNorm: feature.norm,
            exemplarEntitySet: new Set(feature.entities),
            exemplarTokenSet: new Set(feature.tokenSet),
            exemplarTokens: [...feature.topTokens],
            firstSeenMs: feature.firstSeenMs,
            items: [],
            entitySet: new Set(feature.entities),
          });
          clusters.push(newCluster);
          best = {
            cluster: newCluster,
            matched: true,
            score: 1,
            entityOverlap: feature.entities.size ? 1 : 0,
            tokenOverlap: 1,
            rule: "new",
            why: "created_new_cluster",
          };
        }

        const nextItem = {
          sourceId: feature.sourceId,
          score: best.score,
          entityOverlap: best.entityOverlap,
          tokenOverlap: best.tokenOverlap,
          rule: best.rule,
          why: best.why || best.rule,
          hardJoinAnchor: best.sharedAnchor || "",
          entities: [...feature.entities].sort(),
          labelTokens: [...feature.labelTokens].sort(),
          tokens: [...feature.tokenSet].sort(),
          topTokens: [...feature.topTokens],
          norm: feature.norm,
          title: feature.title,
          titleRaw: feature.titleRaw,
          titleNorm: feature.titleNorm,
          firstSeenMs: feature.firstSeenMs,
          clusterKey: feature.clusterKey,
        };

        const clusterIdx = clusters.findIndex((c) => c.id === best.cluster.id);
        if (clusterIdx >= 0) {
          const target = { ...clusters[clusterIdx], items: [...clusters[clusterIdx].items, nextItem] };
          clusters[clusterIdx] = recomputeClusterMetadata(target);
        }
      }

      clusters = enforceEntityBudget(clusters, preset);
      clusters = enforceDominantEntityMerge(clusters);

      let merged = sortClustersStable(clusters);
      let changed = true;
      while (changed) {
        changed = false;
        outer: for (let i = 0; i < merged.length; i += 1) {
          for (let j = i + 1; j < merged.length; j += 1) {
            const a = merged[i];
            const b = merged[j];
            if (Math.abs((a.firstSeenMs || 0) - (b.firstSeenMs || 0)) > CLUSTER_MERGE_WINDOW_MS) continue;
            const score = jaccard(a.exemplarTokenSet, b.exemplarTokenSet);
            if (score < preset.merge) continue;
            merged[i] = mergeClusterInto(a, b);
            merged.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }

      const soloResolution = reassignSoloClusters(merged);
      merged = sortClustersStable(soloResolution.clusters || []);
      const forcedOtherSourceIds = new Set(soloResolution.otherSourceIds || []);

      merged = sortClustersStable(merged).map((cluster, idx) => ({
        ...cluster,
        id: `${slugify(cluster.label)}-${stableHash(`${cluster.exemplarNorm}|${idx}`)}`,
      }));

      const mergedBySource = {};
      for (const cluster of merged) {
        const exemplarEntities = [...(cluster.exemplarEntitySet || [])].sort().slice(0, 6);
        const exemplarTokens = [...(cluster.exemplarTokenSet || [])].sort().slice(0, 6);
        for (const item of cluster.items) {
          mergedBySource[item.sourceId] = {
            clusterId: cluster.id,
            clusterLabel: cluster.label,
            score: item.score,
            entityOverlap: item.entityOverlap,
            tokenOverlap: item.tokenOverlap,
            rule: item.rule,
            why: item.why,
            hardJoinAnchor: item.hardJoinAnchor || "",
            entities: (item.entities || []).slice(0, 8),
            itemTokens: (item.tokens || []).slice(0, 8),
            exemplarEntities,
            exemplarTokens: exemplarTokens.slice(0, 8),
            titleRaw: item.titleRaw || item.title || "",
            titleNorm: item.titleNorm || item.norm || "",
            clusterKey: item.clusterKey,
          };
        }
      }
      for (const sourceId of forcedOtherSourceIds) {
        mergedBySource[sourceId] = {
          clusterId: "other",
          clusterLabel: "Other",
          score: 0,
          entityOverlap: 0,
          tokenOverlap: 0,
          rule: "solo_other",
          why: "solo_no_match",
          hardJoinAnchor: "",
          entities: [],
          itemTokens: [],
          exemplarEntities: [],
          exemplarTokens: [],
          titleRaw: "",
          titleNorm: "",
          clusterKey: "",
        };
      }
      return { clusters: merged, bySource: mergedBySource, strictness };
    }

    return { buildStoryClusters, entityDisplayName };
  }
  global.NewsboardClusterAssignment = { create };
})(window);

