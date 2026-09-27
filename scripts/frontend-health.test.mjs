import assert from "node:assert/strict";
import test from "node:test";

await import("../docs/js/health.js");
const { COLLECTION_FRESHNESS_MS, derivePublisherHealth } = globalThis.NewsboardHealth;
const now = Date.parse("2026-09-27T12:00:00Z");
const source = (ageMs, health = {}) => ({ ok: true, updatedAt: new Date(now - ageMs).toISOString(), item: { title: "Valid headline", url: "https://example.com/story" }, health });

test("recent successful observation is Current", () => assert.equal(derivePublisherHealth(source(60_000), now).state, "Current"));
test("old successful observation is Delayed", () => assert.equal(derivePublisherHealth(source(COLLECTION_FRESHNESS_MS + 1), now).state, "Delayed"));
test("explicit failure preserves last-good age and reports Issue", () => {
  const result = derivePublisherHealth(source(17 * 60_000, { crawlStatus: "failed", latestError: "blocked" }), now);
  assert.equal(result.state, "Issue"); assert.equal(result.ageMs, 17 * 60_000); assert.equal(result.error, "blocked");
});
test("missing observation is Unknown, not failure", () => assert.equal(derivePublisherHealth(null, now).state, "Unknown"));
