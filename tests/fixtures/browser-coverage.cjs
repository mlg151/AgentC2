const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Start before page.goto(); call the returned stop function before closing the page.
async function startBrowserCoverage(page, label = 'browser') {
  if (!process.env.AGENTC2_COVERAGE && !process.env.NODE_V8_COVERAGE) return async () => {};
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
  return async () => {
    const entries = (await page.coverage.stopJSCoverage()).filter((entry) => entry.url && !entry.url.startsWith('extensions::'));
    const directory = path.resolve(process.env.AGENTC2_COVERAGE_BROWSER_DIR || 'coverage/browser');
    fs.mkdirSync(directory, { recursive: true });
    const name = `${label.replace(/[^a-z0-9_-]/gi, '-')}-${process.pid}-${crypto.randomUUID()}.json`;
    fs.writeFileSync(path.join(directory, name), JSON.stringify(entries));
  };
}

module.exports = { startBrowserCoverage };
