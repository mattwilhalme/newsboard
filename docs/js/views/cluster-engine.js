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
  global.NewsboardClusterEngine = { createFeatureTools, normalize, slugify, stableHash };
})(window);
