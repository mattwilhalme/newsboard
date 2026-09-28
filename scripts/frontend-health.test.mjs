import assert from "node:assert/strict";
import test from "node:test";

await import("../docs/js/health.js");
const { COLLECTION_FRESHNESS_MS, derivePublisherHealth } = globalThis.NewsboardHealth;
const now = Date.parse("2026-09-27T12:00:00Z");
const source = (ageMs, health = {}) => ({ ok: true, updatedAt: new Date(now - ageMs).toISOString(), item: { title: "Valid headline", url: "https://example.com/story" }, health });

test("recent successful observation is healthy", () => assert.equal(derivePublisherHealth(source(60_000), now).state, "Healthy"));
test("aging successful observation is degraded", () => assert.equal(derivePublisherHealth(source(COLLECTION_FRESHNESS_MS + 1), now).state, "Degraded"));
test("explicit failure preserves last-good age and reports degraded", () => {
  const result = derivePublisherHealth(source(17 * 60_000, { crawlStatus: "failed", latestError: "blocked" }), now);
  assert.equal(result.state, "Degraded"); assert.equal(result.ageMs, 17 * 60_000); assert.equal(result.error, "blocked");
});
test("blocked attempt is distinct while retaining a valid observation", () => assert.equal(derivePublisherHealth(source(6*60_000,{lastAttemptStatus:"blocked"}),now).state,"Blocked"));
test("missing observation is unavailable", () => assert.equal(derivePublisherHealth(null, now).state, "Unavailable"));
