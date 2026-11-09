// Browser plugin is unavailable; exercise real Chromium service workers and
// original renderer counters through the repository's Playwright fallback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const source = require('../scripts/source-coverage.cjs');
const { instrumentSourceCoverage } = require('./helpers/source-browser-coverage.cjs');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-source-browser-'));
const previous = process.env.AGENTC2_SOURCE_COVERAGE_DIR;
const raw = process.env.AGENTC2_COVERAGE === '1' && previous ? previous : path.join(temporary, 'raw');
process.env.AGENTC2_SOURCE_COVERAGE_DIR = raw;
const counts = new Map();
let server, browser;
(async () => {
  try {
    const worker = source.instrument('public/companion-sw.js', fs.readFileSync(path.join(root, 'public/companion-sw.js'), 'utf8')).code;
    const timeline = require('typescript').transpileModule(source.instrument('src/chatTimeline.ts', fs.readFileSync(path.join(root, 'src/chatTimeline.ts'), 'utf8')).code, { compilerOptions: { module: require('typescript').ModuleKind.ESNext, target: require('typescript').ScriptTarget.ES2022 } }).outputText;
    server = http.createServer((request, response) => {
      counts.set(request.url, (counts.get(request.url) || 0) + 1);
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (request.url === '/companion-sw.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(worker); return; }
      if (request.url === '/timeline.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(timeline); return; }
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Source coverage fixture</title><script type="module">import {reduceChatTimeline,emptyChatTimeline} from "/timeline.js"; window.runTimeline=()=>reduceChatTimeline(emptyChatTimeline,{events:[],cursor:0,retainedFrom:1,pendingRequests:[]}); window.runTimeline();</script>'); return; }
      if (request.url === '/assets/failure.js') response.statusCode = 503;
      response.end('fixture:' + request.url);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const save = await instrumentSourceCoverage(context);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(origin); await page.waitForFunction(() => window.runTimeline);
    await page.evaluate(async () => {
      await caches.open('agent-hq-static-v1'); await caches.open('agent-hq-static-old'); await caches.open('unrelated-cache');
      await navigator.serviceWorker.register('/companion-sw.js'); await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    assert.deepEqual((await page.evaluate(() => caches.keys())).sort(), ['agent-hq-static-v1', 'unrelated-cache'], 'Activation retains the current cache and unrelated caches');
    const fetchText = (url, options) => page.evaluate(async ({ url, options }) => { const response = await fetch(url, options); return { status: response.status, text: await response.text() }; }, { url, options });
    assert.equal((await fetchText('/assets/first.js')).text, 'fixture:/assets/first.js');
    assert.equal((await fetchText('/assets/first.js')).text, 'fixture:/assets/first.js');
    assert.equal(counts.get('/assets/first.js'), 1, 'The second immutable asset request must use the cache');
    for (const url of ['/api/private', '/pair?token=fixture', '/assets/not-an-asset.txt']) { await fetchText(url); await fetchText(url); assert.equal(counts.get(url), 2); }
    await fetchText(`http://localhost:${server.address().port}/assets/foreign.js`);
    await fetchText(`http://localhost:${server.address().port}/assets/foreign.js`);
    assert.equal(counts.get('/assets/foreign.js'), 2, 'Foreign origins must bypass the asset cache');
    await fetchText('/assets/post.js', { method: 'POST', body: 'fixture' });
    for (let index = 0; index < 2; index++) assert.equal((await fetchText('/assets/failure.js')).status, 503);
    assert.equal(counts.get('/assets/failure.js'), 2, 'Failed asset responses must not persist');
    await page.evaluate(async () => { for (let index = 0; index < 41; index++) await fetch('/assets/item-' + index + '.css'); });
    const keys = await page.evaluate(async () => (await (await caches.open('agent-hq-static-v1')).keys()).map((request) => new URL(request.url).pathname));
    assert.equal(keys.length, 40); assert.equal(keys.includes('/assets/first.js'), false); assert.equal(keys.includes('/assets/item-0.css'), false); assert.equal(keys.includes('/assets/item-40.css'), true);
    await context.setOffline(true);
    assert.equal((await fetchText('/assets/item-40.css')).text, 'fixture:/assets/item-40.css');
    await context.setOffline(false);
    await save(); await save();
    // Reproduce Electron teardown ordering with real browser source counters:
    // page lifecycle callbacks must tolerate removal of the transport binding,
    // and an explicit collector pull must still retain the executed document.
    await page.evaluate(() => {
      delete globalThis.__agentc2SourceCoverageSink;
      window.runTimeline();
      window.dispatchEvent(new Event('pagehide'));
    });
    await save();
    await page.reload(); await page.waitForFunction(() => window.runTimeline);
    await page.close();
    const popup = await context.newPage(); await popup.goto(origin); await popup.waitForFunction(() => window.runTimeline);
    await save();
    await context.close();
    const report = source.report(raw);
    const file = report.fileCoverageFor('src/chatTimeline.ts').toJSON();
    const reducer = Object.entries(file.fnMap).find(([, value]) => value.name === 'reduceChatTimeline')[0];
    assert.ok(file.f[reducer] >= 4, 'Binding teardown, navigation, page close, and context close retain actual executions across source epochs');
    const serviceWorker = report.fileCoverageFor('public/companion-sw.js');
    assert.equal(serviceWorker.data.all, false, 'Worker execution must be recorded outside the page global');
    assert.equal(serviceWorker.toSummary().functions.pct, 100);
    console.log('PASS real service-worker installation, activation isolation, asset cache hits, API/pairing/POST bypass, failed responses, offline assets, 40-item eviction, and renderer/worker snapshot lifecycle');
  } finally {
    await browser?.close(); if (server) await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.AGENTC2_SOURCE_COVERAGE_DIR; else process.env.AGENTC2_SOURCE_COVERAGE_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
