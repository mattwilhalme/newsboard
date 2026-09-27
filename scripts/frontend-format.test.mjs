import assert from "node:assert/strict";
import test from "node:test";

await import("../docs/js/format.js");
const format = globalThis.NewsboardFormat;

test("frontend format helpers retain URL and HTML safety behavior", () => {
  assert.equal(format.normalizeUrlForStory("https://www.example.com/a//b/?utm_source=x&z=2#part"), "https://example.com/a/b?z=2");
  assert.equal(format.normalizeTitleForStory("Hello, WORLD!"), "hello world");
  assert.equal(format.escapeHtml(`<a title="x">&`), "&lt;a title=&quot;x&quot;&gt;&amp;");
  assert.equal(format.summarizeError(new Error("  broken   request  ")), "broken request");
  assert.equal(format.fmtDurationSeconds(3600), "1h");
  assert.equal(format.fmtDurationMs(60_000), "1m");
});
