import { chromium } from "playwright";

export function browserLaunchOptions(overrides = {}) {
  const requested = String(process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome").trim();
  const channel = requested && requested !== "chromium" ? requested : undefined;
  return { headless: true, ...(channel ? { channel } : {}), ...overrides };
}

export async function launchTestBrowser(overrides = {}) {
  const options = browserLaunchOptions(overrides);
  try {
    return await chromium.launch(options);
  } catch (error) {
    const target = options.channel || "Playwright Chromium";
    const hint = options.channel
      ? `Install ${target}, or run \`npm run install-browsers\` and set PLAYWRIGHT_BROWSER_CHANNEL=chromium.`
      : "Run `npm run install-browsers` to install Playwright Chromium.";
    const wrapped = new Error(`Unable to launch ${target} for Newsboard browser tests. ${hint}`);
    wrapped.cause = error;
    throw wrapped;
  }
}
