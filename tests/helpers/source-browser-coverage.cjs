const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { snapshot } = require('../../scripts/source-coverage.cjs');
const collectors = new WeakMap();

// No application API is added. The binding exists only inside a browser context
// controlled by this test process, and transports static source counters only.
function install() {
  if (globalThis.__agentc2SourceCoverageSave) return;
  globalThis.__agentc2SourceCoverageEpoch = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  globalThis.__agentc2SourceCoverageSave = () => {
    if (!globalThis.__agentc2SourceCoverage || typeof globalThis.__agentc2SourceCoverageSink !== 'function') return;
    return globalThis.__agentc2SourceCoverageSink({ coverage: globalThis.__agentc2SourceCoverage, hashes: globalThis.__agentc2SourceHashes, epoch: globalThis.__agentc2SourceCoverageEpoch });
  };
  const save = () => { globalThis.__agentc2SourceCoverageSave()?.catch(() => {}); };
  globalThis.addEventListener('pagehide', save);
  globalThis.addEventListener('beforeunload', save);
}

async function instrumentSourceCoverage(context) {
  if (collectors.has(context)) return collectors.get(context);
  const identity = `browser-${process.pid}-${randomUUID()}`;
  const directory = process.env.AGENTC2_SOURCE_COVERAGE_DIR || path.resolve(__dirname, '../../test-results/coverage/source');
  const errors = [], pages = new Map(), workers = new Set();
  await context.exposeBinding('__agentc2SourceCoverageSink', (_origin, data) => {
    try {
      if (!data || typeof data.epoch !== 'string') throw Error('Browser source coverage identity is missing');
      snapshot(data.coverage, data.hashes, identity + ':' + data.epoch, directory);
    } catch (error) { errors.push(error); }
  });
  await context.addInitScript(install);
  async function save(page) {
    if (page.isClosed()) return;
    // Electron can remove Playwright's exposed bindings before closing the
    // document. Pull counters directly at explicit boundaries so the final
    // snapshot does not depend on a binding that is already being torn down.
    const data = await page.evaluate(() => {
      if (!globalThis.__agentc2SourceCoverage) return null;
      globalThis.__agentc2SourceCoverageEpoch ||= globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      return { coverage: globalThis.__agentc2SourceCoverage, hashes: globalThis.__agentc2SourceHashes, epoch: globalThis.__agentc2SourceCoverageEpoch };
    }).catch((error) => { if (!page.isClosed() && !/Execution context was destroyed|Target closed|Target page.*closed/.test(error.message)) throw error; });
    if (data) snapshot(data.coverage, data.hashes, identity + ':' + data.epoch, directory);
  }
  function attach(page) {
    if (pages.has(page)) return pages.get(page);
    const started = page.evaluate(install).catch((error) => { if (!page.isClosed() && !/Execution context was destroyed|Target closed/.test(error.message)) throw error; });
    // Preserve cumulative counters before explicit navigation; pagehide also
    // handles navigation and native window close initiated by the app itself.
    for (const method of ['goto', 'reload', 'close']) {
      const original = page[method].bind(page);
      page[method] = async (...args) => { await save(page); return original(...args); };
    }
    started.catch((error) => errors.push(error));
    pages.set(page, started);
    return started;
  }
  context.on('page', attach);
  async function saveWorker(worker) {
    // Service workers have their own global scope and no page binding. Read
    // their original counters directly, retaining one epoch across snapshots.
    try {
      const data = await worker.evaluate(() => {
        globalThis.__agentc2SourceCoverageEpoch ||= globalThis.crypto.randomUUID();
        return { coverage: globalThis.__agentc2SourceCoverage, hashes: globalThis.__agentc2SourceHashes, epoch: globalThis.__agentc2SourceCoverageEpoch };
      });
      snapshot(data.coverage, data.hashes, identity + ':worker:' + data.epoch, directory);
    } catch (error) {
      // A worker may terminate after activation. It must have been captured
      // while alive; the no-loaded-source guard still rejects missing evidence.
      if (!/Target closed|Target page.*closed|Service worker.*closed/.test(error.message)) throw error;
    }
  }
  context.on('serviceworker', (worker) => { workers.add(worker); });
  for (const worker of context.serviceWorkers()) workers.add(worker);
  const saveAll = async () => {
    await Promise.all([...pages].map(async ([page, started]) => { await started; await save(page); }));
    await Promise.all([...workers].map(saveWorker));
    if (errors.length) throw new AggregateError(errors, 'Browser source coverage collection failed');
  };
  const close = context.close.bind(context);
  context.close = async (...args) => { try { await saveAll(); } finally { await close(...args); } };
  collectors.set(context, saveAll);
  await Promise.all(context.pages().map(attach));
  return saveAll;
}
module.exports = { instrumentSourceCoverage };
