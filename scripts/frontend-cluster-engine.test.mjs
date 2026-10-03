import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../docs/js/views/cluster-engine.js", import.meta.url), "utf8");
const context = { window: {} };
vm.runInNewContext(source, context, { filename: "cluster-engine.js" });
const engine = context.window.NewsboardClusterEngine;
const assignmentSource = await readFile(new URL("../docs/js/views/cluster-assignment.js", import.meta.url), "utf8");
vm.runInNewContext(assignmentSource, context, { filename: "cluster-assignment.js" });

test("cluster normalization and slugs are stable across punctuation and URLs", () => {
  assert.equal(engine.normalize("  U.S. Election: Live Updates!  "), "u s election live updates");
  assert.equal(engine.slugify("https://Example.com/Big Story"), "example-com-big-story");
  assert.equal(engine.slugify("Big   Story"), "big-story");
});

test("cluster hashes are deterministic and distinguish inputs", () => {
  assert.equal(engine.stableHash("same story"), engine.stableHash("same story"));
  assert.notEqual(engine.stableHash("same story"), engine.stableHash("different story"));
  assert.match(engine.slugify(""), /^cluster-[a-z0-9]+$/);
});

test("feature tools remove boilerplate while preserving acronyms, stems, and aliases", () => {
  const aliasIndex = new Map([["mexico", new Set(["mexico", "mexican"])], ["nationalguard", new Set(["nationalguard", "guard"])]]);
  const tools = engine.createFeatureTools({
    boilerplate: ["live updates", "what we know"],
    stopwords: new Set(["the", "of", "in"]),
    canonicalOverrides: new Map([["usa", "us"]]),
    acronymAllowlist: new Set(["DHS", "US"]),
    aliasIndex,
    joinedBigrams: new Map([["national guard", "nationalguard"]]),
  });
  const metadata = tools.buildTokenMetadata("Live Updates: DHS warns Mexican National Guard soldiers");
  assert.equal(metadata.titleNorm, "DHS warns Mexican National Guard soldiers");
  assert.ok(metadata.tokensCore.includes("DHS"));
  assert.ok(metadata.tokensCore.includes("warn"));
  assert.ok(metadata.tokensCore.includes("mexican"));
  assert.ok(metadata.aliases.has("nationalguard"));
  assert.ok(metadata.aliases.has("guard"));
});

test("cluster scoring distinguishes entity, token, and broad-entity evidence", () => {
  const scoring = engine.createScoringTools({ broadEntities: new Set(["us"]) });
  const preset = { entityStrong: 0.5, entityWeak: 0.25, tokenWithEntity: 0.3, tokenOnly: 0.5, relaxedEntity: 0.2, relaxedToken: 0.2 };
  const cluster = { entitySet: new Set(["us"]), exemplarEntitySet: new Set(["us"]), exemplarTokenSet: new Set(["election", "vote"]) };
  const broadOnly = scoring.compare({ entities: new Set(["us"]), tokenSet: new Set(["economy"]) }, cluster, preset);
  assert.equal(broadOnly.matched, false);
  assert.equal(broadOnly.rule, "entity_broad_needs_tokens");
  const corroborated = scoring.compare({ entities: new Set(["us"]), tokenSet: new Set(["election"]) }, cluster, preset);
  assert.equal(corroborated.matched, true);
  assert.equal(corroborated.rule, "entity_strong");
  const tokenOnly = scoring.compare({ entities: new Set(), tokenSet: new Set(["election"]) }, cluster, preset);
  assert.equal(tokenOnly.matched, true);
  assert.equal(tokenOnly.rule, "token_fallback");
});

test("entity tools canonicalize countries, phrases, acronyms, and demonyms", () => {
  const entities = engine.createEntityTools({
    stopwords: new Set(["the", "after"]),
    demonymToCountry: new Map([["mexican", "mexico"]]),
    phraseMap: new Map([["national guard", "national_guard"], ["fbi", "fbi"]]),
    acronymAllowlist: new Set(["FBI", "US"]),
    joinedBigrams: new Map([["national guard", "nationalguard"]]),
  });
  assert.equal(entities.canonicalize("Mexican"), "mexico");
  assert.equal(entities.canonicalize("National Guard"), "national_guard");
  assert.deepEqual(
    [...entities.extract("FBI joins Mexican National Guard", "FBI joins Mexican National Guard", {
      tokensUpper: ["FBI", "joins", "Mexican", "National", "Guard"],
      tokensCore: ["FBI", "join", "mexican", "national", "guard"],
    })].sort(),
    ["fbi", "mexican_national_guard", "mexico", "national_guard", "nationalguard"],
  );
});

test("assignment groups corroborated stories and leaves unrelated solos in Other", () => {
  const preset = { entityStrong: 0.5, entityWeak: 0.25, tokenWithEntity: 0.25, tokenOnly: 0.5, relaxedEntity: 0.2, relaxedToken: 0.2, merge: 0.5 };
  const scoring = engine.createScoringTools({ broadEntities: new Set() });
  const features = {
    a: { sourceId: "a", title: "Quake strikes city", titleRaw: "Quake strikes city", titleNorm: "Quake strikes city", norm: "quake strikes city", firstSeenMs: 1, entities: new Set(["city"]), tokenSet: new Set(["quake", "city"]), labelTokens: ["quake", "city"], canonicalTokens: ["quake", "city"], topTokens: ["quake", "city"], clusterKey: "quake|city" },
    b: { sourceId: "b", title: "City hit by quake", titleRaw: "City hit by quake", titleNorm: "City hit by quake", norm: "city hit by quake", firstSeenMs: 2, entities: new Set(["city"]), tokenSet: new Set(["quake", "city"]), labelTokens: ["city", "quake"], canonicalTokens: ["city", "quake"], topTokens: ["city", "quake"], clusterKey: "city|quake" },
    c: { sourceId: "c", title: "Markets close higher", titleRaw: "Markets close higher", titleNorm: "Markets close higher", norm: "markets close higher", firstSeenMs: 3, entities: new Set(), tokenSet: new Set(["market", "close"]), labelTokens: ["market", "close"], canonicalTokens: ["market", "close"], topTokens: ["market", "close"], clusterKey: "market|close" },
  };
  const assignment = context.window.NewsboardClusterAssignment.create({
    CLUSTER_PRESETS: { balanced: preset }, CLUSTER_STOPWORDS: new Set(), CLUSTER_TITLE_DEPRIORITIZED: new Set(),
    CLUSTER_MERGE_WINDOW_MS: 100, CLUSTER_HARD_JOIN_WINDOW_MS: 100, CLUSTER_DOMINANT_WINDOW_MS: 100,
    CLUSTER_ENTITY_BUDGET: 3, CLUSTER_ACRONYM_ALLOWLIST: new Set(), buildStoryFeature: (item) => features[item.sourceId],
    clusterLabelFromTokens: (tokens) => tokens.join(" "), compactTwoWordLabel: (label) => label,
    clusterScoringTools: scoring, slugify: engine.slugify, stableHash: engine.stableHash, jaccard: engine.jaccard,
  });
  const result = assignment.buildStoryClusters([{ sourceId: "a" }, { sourceId: "b" }, { sourceId: "c" }]);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].items.length, 2);
  assert.equal(result.bySource.a.clusterId, result.bySource.b.clusterId);
  assert.equal(result.bySource.c.clusterId, "other");
});
