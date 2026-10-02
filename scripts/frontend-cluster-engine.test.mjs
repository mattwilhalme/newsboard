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
