import { readFile } from "node:fs/promises";

export async function loadPublisherFixture(sourceId, name = "centerpiece.html") {
  const safeSourceId = String(sourceId || "");
  const safeName = String(name || "");
  if (!/^[a-z0-9]+$/.test(safeSourceId) || !/^[a-z0-9.-]+$/.test(safeName)) {
    throw new Error("Invalid publisher fixture path");
  }
  return readFile(new URL(`../../test/fixtures/publishers/${safeSourceId}/${safeName}`, import.meta.url), "utf8");
}
