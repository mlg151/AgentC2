// Preloaded by the suite runner, before tests import Playwright. Preserve evidence
// before test finally blocks close their browser, including on assertion failures.
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS;
if (directory) {
  const playwright = require('playwright-core');
  let sequence = 0;
  async function instrument(context) {
    const id = ++sequence;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    let saved = false;
    async function save() {
      if (saved) return;
      saved = true;
      for (const [index, page] of context.pages().entries()) {
        await page.screenshot({ path: path.join(directory, `browser-${id}-${index}.png`), timeout: 5000 }).catch(() => {});
      }
      await context.tracing.stop({ path: path.join(directory, `trace-${id}.zip`) }).catch(() => {});
    }
    const close = context.close.bind(context);
    context.close = async (...args) => { await save(); return close(...args); };
    return save;
  }
  const electronLaunch = playwright._electron.launch.bind(playwright._electron);
  playwright._electron.launch = async (...args) => {
    const app = await electronLaunch(...args);
    const save = await instrument(app.context());
    const child = app.process();
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => fs.appendFileSync(path.join(directory, 'electron.log'), chunk));
    const close = app.close.bind(app);
    app.close = async (...values) => { await save(); return close(...values); };
    return app;
  };
  for (const type of [playwright.chromium, playwright.firefox, playwright.webkit]) {
    const launch = type.launch.bind(type);
    type.launch = async (...args) => {
      const browser = await launch(...args);
      const saves = [];
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...values) => {
        const context = await newContext(...values);
        saves.push(await instrument(context));
        return context;
      };
      const close = browser.close.bind(browser);
      browser.close = async (...values) => { for (const save of saves) await save(); return close(...values); };
      return browser;
    };
  }
}
