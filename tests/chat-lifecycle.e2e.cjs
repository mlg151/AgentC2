// Public component props and ChatApi promises reproduce connection/lifecycle
// races in the production ChatView without credentials or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const { contract } = require('../electron/chat-protocol.cjs');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-chat-lifecycle-'));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-vite-chat-life-'));
const sessionId = 'chat-0123456789abcdef0123456789abcdef', timestamp = '2026-01-01T00:00:00Z';
const session = { id: sessionId, provider: 'codex', providerSessionId: null, title: 'Lifecycle fixture', state: 'idle', cwd: '/fixture', roeProfile: 'gated', activeTurnId: null, createdAt: timestamp, updatedAt: timestamp, capabilities: { provider: 'codex', version: 'fixture', status: 'supported', reason: null, ...Object.fromEntries(contract.capabilities.map((key) => [key, true])) } };
const calls = [], errors = [], handlers = new Map();
let server, browser, page, counter = 0, controlAllowed = true;
function snapshot(id, text, sequence, retainedFrom = 1) { return { id, session, events: [{ protocolVersion: 1, sessionId, sequence, timestamp, provider: 'codex', providerSessionId: null, itemId: text, turnId: null, type: 'message.completed', data: { role: 'assistant', text } }], cursor: sequence, latestCursor: sequence, retainedFrom, hasMore: false, truncated: false, pendingRequests: [], pendingCommands: [], state: { id, sessionId, canControl: controlAllowed, controller: { id: 'desktop', name: 'Desktop' }, connection: 'connected' } }; }
async function until(predicate, label) { for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw Error(label); }
async function mount(connected) {
  await page.evaluate((connected) => window.qaMountChat({ connected }), connected);
  // root.render schedules work. Observe the offline commit before reconnecting
  // so React cannot coalesce both prop updates and skip attachment cleanup.
  if (!connected) await page.getByRole('status').filter({ hasText: /^Reconnecting$/ }).waitFor();
}
async function publish(value) { await page.evaluate((value) => window.dispatchEvent(new CustomEvent('chat:events', { detail: value })), value); }
async function settled(name, id) {
  const count = calls.filter((call) => call[0] === name && call[1] === id).length;
  await page.waitForFunction(({ name, id, count }) => window.qaChatSettled.filter((call) => call.name === name && call.args[0] === id).length >= count, { name, id, count });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

(async () => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    server = await createServer({ root: path.resolve(__dirname, '..'), cacheDir: cache, server: { port: 0, host: '127.0.0.1', strictPort: false } }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await context.addInitScript(() => {
      window.qaScrollWrites = [];
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(Element.prototype, 'scrollTop', { ...descriptor, set(value) {
        descriptor.set.call(this, value);
        if (this.classList.contains('chat-transcript')) window.qaScrollWrites.push({ requested: value, actual: this.scrollTop, height: this.clientHeight, scrollHeight: this.scrollHeight });
      } });
    });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    let opening;
    handlers.set('open', async () => new Promise((resolve, reject) => { opening = { resolve, reject }; }));
    handlers.set('close', async () => { throw Error('Closed attachment was already unavailable'); }); handlers.set('refresh', async () => {});
    await page.exposeFunction('invokeChat', async (name, ...args) => { calls.push([name, ...structuredClone(args)]); const handler = handlers.get(name); assert.ok(handler, 'Unexpected ChatApi call: ' + name); return handler(...args); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/chat-boundaries.html`);
    await until(() => opening, 'Opening promise missing');
    await mount(false); opening.resolve('closed-before-open');
    await until(() => calls.some((call) => call[0] === 'close'), 'Late attachment was not closed');
    assert.equal(await page.getByRole('alert').count(), 0, 'Closing a cancelled attachment must not show a stale error');
    opening = null; await mount(true); await until(() => opening, 'Second opening promise missing');
    await mount(false); opening.reject(Error('Late cancelled open failure'));
    await page.getByRole('status').filter({ hasText: 'Reconnecting' }).waitFor(); assert.equal(await page.getByRole('alert').count(), 0);

    let ready, current;
    handlers.set('open', async () => { current = 'view-' + ++counter; return current; });
    handlers.set('ready', async () => new Promise((resolve) => { ready = resolve; })); handlers.set('close', async () => {});
    await mount(true); await until(() => ready, 'Ready promise missing');
    await publish(snapshot(current, 'Buffered live update', 251));
    assert.equal(await page.getByText('Buffered live update', { exact: true }).count(), 0, 'Events before the initial snapshot must stay buffered');
    ready(snapshot(current, 'Ready baseline', 250));
    await page.getByText('Ready baseline', { exact: true }).waitFor(); await page.getByText('Buffered live update', { exact: true }).waitFor();
    await publish(snapshot(current, Array.from({ length: 40 }, (_, index) => 'Retained paragraph ' + index).join('\n\n'), 260));
    await page.getByText('Retained paragraph 39', { exact: true }).waitFor();
    await page.waitForFunction(() => { const node = document.querySelector('.chat-transcript'); return node.scrollHeight > node.clientHeight + 100 && node.scrollHeight - node.scrollTop - node.clientHeight < 3; });
    const transcript = page.getByRole('log', { name: 'Conversation messages', exact: true });
    const box = await transcript.boundingBox(); await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.wheel(0, -600);
    await page.getByRole('button', { name: 'Latest', exact: true }).waitFor();
    const readingTop = await transcript.evaluate((node) => node.scrollTop);
    await publish(snapshot(current, 'New output while reading older messages', 261));
    await page.getByText('New output while reading older messages', { exact: true }).waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(Math.abs(await transcript.evaluate((node) => node.scrollTop) - readingTop) < 2, 'New output must not pull a reader away from older messages');
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    await page.waitForFunction(() => { const node = document.querySelector('.chat-transcript'); return node.scrollHeight - node.scrollTop - node.clientHeight < 3; });
    ready = null; await mount(false); await mount(true); await until(() => ready, 'Cancelled ready promise missing');
    const cancelledReady = ready; await mount(false); cancelledReady(snapshot(current, 'Stale ready response', 252));
    assert.equal(await page.getByText('Stale ready response', { exact: true }).count(), 0);

    handlers.set('ready', async () => snapshot(current, 'Current history head', 300));
    let history;
    handlers.set('history', async (id) => new Promise((resolve) => { history = { id, resolve }; }));
    await mount(true); await page.getByText('Current history head', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Load earlier managed messages', exact: true }).click();
    await until(() => history, 'History promise missing');
    await mount(false);
    handlers.set('ready', async () => snapshot(current, 'Reconnected history head', 500, 400));
    await mount(true); await page.getByText('Reconnected history head', { exact: true }).waitFor();
    history.resolve(snapshot(history.id, 'History from closed view', 2));
    assert.equal(await page.getByText('History from closed view', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Load earlier managed messages', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Load earlier managed messages', exact: true }).isEnabled(), true, 'A cancelled old history read must not leave the reconnected view permanently busy');
    handlers.set('history', async () => { throw Error('Current history fixture refused'); });
    await page.getByRole('button', { name: 'Load earlier managed messages', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Current history fixture refused' }).waitFor();
    await page.getByRole('button', { name: 'Dismiss chat error', exact: true }).click();
    let lateHistory;
    handlers.set('history', async () => new Promise((_resolve, reject) => { lateHistory = reject; }));
    await page.getByRole('button', { name: 'Load earlier managed messages', exact: true }).click(); await until(() => lateHistory, 'Late history rejection missing');
    await mount(false); handlers.set('ready', async () => snapshot(current, 'Newest history head', 700, 600));
    await mount(true); await page.getByText('Newest history head', { exact: true }).waitFor();
    lateHistory(Error('Stale history error from closed attachment'));
    await page.waitForFunction(() => window.qaChatSettled.filter((call) => call.name === 'history').length >= 3);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('alert').count(), 0);
    controlAllowed = false; await publish(snapshot(current, 'Read-only owner evidence', 701, 600));
    let take;
    handlers.set('take', async (id) => new Promise((resolve, reject) => { take = { id, resolve, reject }; }));
    await page.getByRole('button', { name: 'Take control', exact: true }).click(); await until(() => take, 'Take-control promise missing');
    await mount(false); handlers.set('ready', async () => snapshot(current, 'Reconnected read-only view', 900, 800));
    await mount(true); await page.getByText('Reconnected read-only view', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Take control', exact: true }).isEnabled(), true, 'A cancelled old ownership request must not disable the new attachment');
    const oldTake = take; take = null;
    await page.getByRole('button', { name: 'Take control', exact: true }).click(); await until(() => take, 'New ownership request missing');
    oldTake.resolve({ ...snapshot(oldTake.id, '', 1).state, canControl: true });
    await settled('take', oldTake.id);
    assert.equal(await page.getByText('You control this chat', { exact: true }).count(), 0, 'A late result for an old handle must not grant control to a read-only new handle');
    assert.equal(await page.getByRole('button', { name: 'Take control', exact: true }).isDisabled(), true, 'Old ownership completion must not clear a new request’s busy flag');
    take.resolve({ ...snapshot(take.id, '', 1).state, canControl: true });
    await page.getByText('You control this chat', { exact: true }).waitFor();
    await publish(snapshot(current, 'Read-only after transfer', 901, 800));
    take = null; await page.getByRole('button', { name: 'Take control', exact: true }).click(); await until(() => take, 'Late failing ownership request missing');
    await mount(false); handlers.set('ready', async () => snapshot(current, 'Latest read-only attachment', 950, 900));
    await mount(true); await page.getByText('Latest read-only attachment', { exact: true }).waitFor();
    take.reject(Error('Ownership error from closed attachment'));
    await settled('take', take.id);
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.screenshot({ path: path.join(directory, 'chat-reconnected-readonly.png') });
    controlAllowed = true; session.state = 'stopped';
    await page.getByText('Transcript storage', { exact: true }).click();
    for (const rejectOld of [false, true]) {
      const base = rejectOld ? 2000 : 1000;
      const prunes = [];
      handlers.set('prune', async (id) => new Promise((resolve, reject) => { prunes.push({ id, resolve, reject }); }));
      await publish(snapshot(current, 'Stopped transcript ' + base, base, base - 100));
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Remove managed transcript', exact: true }).click(); await until(() => prunes.length === 1, 'Old prune promise missing');
      await mount(false); handlers.set('ready', async () => snapshot(current, 'Reopened stopped transcript ' + base, base + 200, base + 100));
      await mount(true); await page.getByText('Reopened stopped transcript ' + base, { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /Remove managed transcript|Removing transcript/ }).innerText(), 'Remove managed transcript', 'A prune request from a closed attachment must not keep the inspected new attachment busy');
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Remove managed transcript', exact: true }).click(); await until(() => prunes.length === 2, 'Current prune promise missing');
      if (rejectOld) prunes[0].reject(Error('Old prune acknowledgement lost'));
      else prunes[0].resolve(snapshot(prunes[0].id, 'Old prune reply', base + 1));
      await settled('prune', prunes[0].id);
      assert.equal(await page.getByRole('button', { name: /Remove managed transcript|Removing transcript/ }).innerText(), 'Removing transcript…', 'An old prune completion must not clear a new request’s busy state');
      assert.equal(await page.getByRole('alert').count(), 0, 'Errors from closed attachments must not overwrite the current view');
      prunes[1].resolve({ ...snapshot(current, '', base + 300, base + 301), events: [] });
      await page.getByRole('button', { name: 'Remove managed transcript', exact: true }).waitFor();
      await page.getByText('Earlier transcript content was removed under the retention policy.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Old prune reply', { exact: true }).count(), 0);
    }
    await page.screenshot({ path: path.join(directory, 'chat-reconnected-history.png') });
    await page.evaluate(() => window.qaUnmountChat()); await page.getByText('Chat fixture unmounted', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS cancelled open/ready handling, buffered live events, history recovery, epoch-scoped ownership and transcript removal, and old replies/errors unable to change new attachment state');
  } catch (error) { if (page && !page.isClosed()) { fs.writeFileSync(path.join(directory, 'scroll-state.json'), JSON.stringify(await page.evaluate(() => ({ writes: window.qaScrollWrites, nodes: Array.from(document.querySelectorAll('main,.structured-chat,.chat-transcript')).map((node) => ({ tag: node.tagName, className: node.className, top: node.scrollTop, height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY })) })), null, 2)); await page.screenshot({ path: path.join(directory, 'chat-lifecycle-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure-body.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable')); } throw error; }
  finally { await browser?.close(); await server?.close(); fs.rmSync(cache, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
