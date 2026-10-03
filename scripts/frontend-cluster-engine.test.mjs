import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../docs/js/views/cluster-engine.js", import.meta.url), "utf8");
const context = { window: {} };
vm.runInNewContext(source, context, { filename: "cluster-engine.js" });
const engine = context.window.NewsboardClusterEngine;

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
