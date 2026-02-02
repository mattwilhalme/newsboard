// scripts/run-scrape.js
import fs from "fs";
import {
  scrapeABCFrontPage,
  scrapeCBSFrontPage
} from "../server.js";

async function run() {
  console.log("🗞️ Newsboard scrape starting…");

  const abc = await scrapeABCFrontPage();
  const cbs = await scrapeCBSFrontPage();

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      abc,
      cbs
    }
  };

  fs.writeFileSync(
    "latest.json",
    JSON.stringify(payload, null, 2),
    "utf8"
  );

  console.log("✅ Wrote latest.json");
}

run().catch(err => {
  console.error("❌ Scrape failed");
  console.error(err);
  process.exit(1);
});
