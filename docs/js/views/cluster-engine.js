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
  global.NewsboardClusterEngine = { normalize, slugify, stableHash };
})(window);
