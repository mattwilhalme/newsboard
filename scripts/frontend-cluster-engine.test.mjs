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
