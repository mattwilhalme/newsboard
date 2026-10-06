import { launchTestBrowser } from "./support/browser.mjs";

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>Newsboard browser preflight</title>");
  console.log(`Browser preflight passed: ${await browser.version()}`);
} finally {
  await browser.close();
}
