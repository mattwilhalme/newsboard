(function (global) {
  "use strict";
  function normalize(value) {
    return String(value || "").toLowerCase().replace(/https?:\/\//g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  function stableHash(value) {
    const input = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
  function slugify(value) {
    return normalize(value).replace(/\s+/g, "-") || `cluster-${stableHash(value || "topic")}`;
  }
  function jaccard(left, right) {
    const values = (input) => input && typeof input[Symbol.iterator] === "function" ? input : [];
    const a = left instanceof Set ? left : new Set(values(left));
    const b = right instanceof Set ? right : new Set(values(right));
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const value of a) if (b.has(value)) overlap += 1;
    const union = a.size + b.size - overlap;
    return union > 0 ? overlap / union : 0;
  }
  function createScoringTools({ broadEntities = new Set() } = {}) {
    function compare(feature, cluster, preset) {
      const clusterEntities = cluster.entitySet && typeof cluster.entitySet.has === "function"
        ? cluster.entitySet
        : (cluster.exemplarEntitySet || new Set());
      const entityOverlap = jaccard(feature.entities, clusterEntities);
      const tokenOverlap = jaccard(feature.tokenSet, cluster.exemplarTokenSet);
      const hasEntities = feature.entities.size > 0 && clusterEntities.size > 0;
      const sharedEntities = hasEntities
        ? [...feature.entities].filter((entity) => clusterEntities.has(entity))
        : [];
      let matched = false;
      let rule = "no_match";
      if (hasEntities) {
        if (entityOverlap >= preset.entityStrong) {
          const broadOnly = sharedEntities.length === 1 && broadEntities.has(sharedEntities[0]);
          if (broadOnly && tokenOverlap < preset.tokenWithEntity) rule = "entity_broad_needs_tokens";
          else { matched = true; rule = "entity_strong"; }
        } else if (entityOverlap >= preset.entityWeak && tokenOverlap >= preset.tokenWithEntity) {
          matched = true;
          rule = "entity_plus_token";
        }
      } else if (tokenOverlap >= preset.tokenOnly) {
        matched = true;
        rule = "token_fallback";
      }
      const score = hasEntities ? (entityOverlap * 0.68) + (tokenOverlap * 0.32) : tokenOverlap;
      return { matched, rule, score, entityOverlap, tokenOverlap, hasEntities, sharedEntities };
    }
    function compareRelaxed(feature, cluster, preset) {
      const entityOverlap = jaccard(feature.entities, cluster.exemplarEntitySet);
      const tokenOverlap = jaccard(feature.tokenSet, cluster.exemplarTokenSet);
      const hasEntities = feature.entities.size > 0 && cluster.exemplarEntitySet.size > 0;
      const ok = hasEntities
        ? entityOverlap >= preset.relaxedEntity && tokenOverlap >= preset.relaxedToken
        : tokenOverlap >= preset.relaxedToken;
      return {
        ok,
        score: hasEntities ? (entityOverlap * 0.6) + (tokenOverlap * 0.4) : tokenOverlap,
        entityOverlap,
        tokenOverlap,
      };
    }
    return { compare, compareRelaxed };
  }
  function createEntityTools({ stopwords, demonymToCountry, phraseMap, acronymAllowlist, joinedBigrams }) {
    const canonicalize = (value) => {
      const raw = String(value || "").toLowerCase().trim();
      if (!raw) return "";
      const compact = raw.replace(/\./g, "");
      const mapped = demonymToCountry.get(compact) || phraseMap.get(raw) || phraseMap.get(compact) || compact;
      return String(mapped || "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    };
    const isAcronym = (token) => {
      const value = String(token || "").trim();
      return /^[A-Z]{2,6}$/.test(value) && acronymAllowlist.has(value);
    };
    function extractCapitalized(rawTitle) {
      const words = (String(rawTitle || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').match(/[A-Za-z][A-Za-z'.-]*/g) || [])
        .map((word) => String(word || "").replace(/'s$/i, "").replace(/\.+$/g, "").trim())
        .filter((word) => word.length >= 2);
      const entities = new Set();
      let index = 0;
      while (index < words.length) {
        const word = words[index] || "";
        if (!/^[A-Z][a-z'.-]+$/.test(word) && !/^[A-Z]{2,}$/.test(word)) { index += 1; continue; }
        const sequence = [word];
        let next = index + 1;
        while (next < words.length && sequence.length < 4 && (/^[A-Z][a-z'.-]+$/.test(words[next]) || /^[A-Z]{2,}$/.test(words[next]))) {
          sequence.push(words[next]); next += 1;
        }
        const canonical = canonicalize(sequence.join(" "));
        const single = canonicalize(word);
        if (canonical && (sequence.length > 1 || phraseMap.has(canonical.replace(/_/g, " ")) || phraseMap.has(word.toLowerCase()) || demonymToCountry.has(word.toLowerCase()))) entities.add(canonical);
        else if (single && !stopwords.has(single)) entities.add(single);
        index = next;
      }
      return entities;
    }
    function extract(rawTitle, normalizedHeadline, tokenMeta = null) {
      const entities = extractCapitalized(rawTitle);
      const lower = String(normalizedHeadline || "").toLowerCase();
      for (const [phrase, canonical] of phraseMap.entries()) {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) {
          const value = canonicalize(canonical); if (value) entities.add(value);
        }
      }
      for (const token of lower.split(/\s+/g).filter((value) => value.length >= 2)) {
        const value = canonicalize(token);
        if (value && !stopwords.has(value) && (demonymToCountry.has(token) || phraseMap.has(token))) entities.add(value);
      }
      for (const token of Array.isArray(tokenMeta?.tokensUpper) ? tokenMeta.tokensUpper : []) {
        if (isAcronym(token)) entities.add(canonicalize(token));
      }
      const core = Array.isArray(tokenMeta?.tokensCore) ? tokenMeta.tokensCore : [];
      for (let index = 0; index + 1 < core.length; index += 1) {
        const joined = joinedBigrams.get(`${core[index]} ${core[index + 1]}`);
        if (joined) entities.add(canonicalize(joined));
      }
      return entities;
    }
    return { canonicalize, extract, extractCapitalized, isAcronym };
  }
  function createFeatureTools({ boilerplate, stopwords, canonicalOverrides, acronymAllowlist, aliasIndex, joinedBigrams }) {
    const isAcronym = (token) => {
      const value = String(token || "").trim();
      return /^[A-Z]{2,6}$/.test(value) && acronymAllowlist.has(value);
    };
    function normalizeAcronym(token) {
      const raw = String(token || "").trim();
      const compact = raw.replace(/[^A-Za-z]/g, "");
      const upper = compact.toUpperCase();
      return compact && /^[A-Za-z]{2,6}$/.test(compact) && acronymAllowlist.has(upper) ? upper : raw;
    }
    function cleanupToken(token) {
      let value = String(token || "").trim().replace(/[’']/g, "'").replace(/'s$/i, "");
      if (value.endsWith("s") && !(isAcronym(value) || value.length <= 4 || value.endsWith("ss"))) value = value.slice(0, -1);
      return value;
    }
    function normalizeHeadline(text) {
      let value = String(text || "").normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\bu\.?\s*s\.?\s*a?\b/gi, " US ").replace(/\bunited\s+states\b/gi, " US ");
      for (const phrase of boilerplate) value = value.replace(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
      return value.replace(/(^|[^A-Za-z0-9])-+|-+([^A-Za-z0-9]|$)/g, " ").replace(/[^A-Za-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim().split(/\s+/g).filter(Boolean).map(normalizeAcronym).join(" ");
    }
    const tokenize = (text) => String(text || "").split(/\s+/g).map((token) => token.trim()).filter((token) => token.length >= 2);
    function stemToken(token) {
      let value = String(token || "").trim();
      if (!value || isAcronym(value)) return value;
      if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
      if (value.endsWith("ing") && value.length > 5) value = value.slice(0, -3);
      if (value.endsWith("ed") && value.length > 4) value = value.slice(0, -2);
      if (value.endsWith("s") && value.length > 4 && !value.endsWith("ss")) value = value.slice(0, -1);
      return value;
    }
    function canonicalizeToken(token) {
      const raw = String(token || "").trim();
      if (!raw || isAcronym(raw)) return raw;
      const lower = raw.toLowerCase();
      return canonicalOverrides.get(lower) || lower;
    }
    const lowerUnlessAcronym = (token) => isAcronym(String(token || "").trim()) ? String(token).trim() : String(token || "").trim().toLowerCase();
    function expandAliases(tokens) {
      const output = new Set();
      const list = (Array.isArray(tokens) ? tokens : []).map((token) => canonicalizeToken(stemToken(token))).filter(Boolean);
      for (let index = 0; index < list.length; index += 1) {
        const token = list[index]; output.add(token);
        for (const alias of aliasIndex.get(token) || []) output.add(canonicalizeToken(alias));
        if (index + 1 < list.length) {
          const joined = joinedBigrams.get(`${token} ${list[index + 1]}`);
          if (joined) { output.add(joined); for (const alias of aliasIndex.get(joined) || []) output.add(canonicalizeToken(alias)); }
        }
      }
      return output;
    }
    function buildTokenMetadata(title) {
      const titleNorm = normalizeHeadline(title);
      const tokensUpper = tokenize(titleNorm).map(normalizeAcronym);
      const tokensCore = tokensUpper.map(cleanupToken).map(stemToken).map(lowerUnlessAcronym).map(canonicalizeToken).filter((token) => token.length >= 2 && !stopwords.has(String(token).toLowerCase()));
      return { titleNorm, tokensUpper, tokensCore, tokenSet: new Set(tokensCore), aliases: expandAliases(tokensCore) };
    }
    return { buildTokenMetadata, canonicalizeToken, cleanupToken, expandAliases, isAcronym, lowerUnlessAcronym, normalizeAcronym, normalizeHeadline, stemToken, tokenize };
  }
  global.NewsboardClusterEngine = { createEntityTools, createFeatureTools, createScoringTools, jaccard, normalize, slugify, stableHash };
})(window);
