// Production ChatView commands through the public ChatApi, including promises
// that settle after reconnect. No private React callbacks are invoked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const { poll: until } = require('./helpers/poll.cjs');
const { contract, validateCommand } = require('../electron/chat-protocol.cjs');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-chat-commands-'));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-vite-chat-command-'));
const sessionId = 'chat-0123456789abcdef0123456789abcdef', timestamp = '2026-01-01T00:00:00Z';
const session = { id: sessionId, provider: 'codex', providerSessionId: null, title: 'Command recovery fixture', state: 'idle', cwd: '/fixture', roeProfile: 'gated', activeTurnId: null, createdAt: timestamp, updatedAt: timestamp, capabilities: { provider: 'codex', version: 'fixture', status: 'supported', reason: null, ...Object.fromEntries(contract.capabilities.map((key) => [key, true])) } };
const calls = [], errors = [], handlers = new Map();
let server, browser, page, current, counter = 0, sequence = 300;
const state = (id = current) => ({ id, sessionId, canControl: true, controller: { id: 'desktop', name: 'Desktop' }, connection: 'connected' });
function snapshot(text = 'Current command attachment') { return { id: current, session: structuredClone(session), events: [{ protocolVersion: 1, sessionId, sequence: ++sequence, timestamp, provider: 'codex', providerSessionId: null, itemId: text, turnId: null, type: 'message.completed', data: { role: 'assistant', text } }], cursor: sequence, latestCursor: sequence, retainedFrom: 1, hasMore: false, truncated: false, pendingRequests: [], pendingCommands: [], state: state() }; }
const receipt = (commandId, status = 'completed') => ({ commandId, sessionId, state: status, result: {}, error: null });
const commands = () => calls.filter((call) => call[0] === 'submit');
async function settled(name, id) { const count = calls.filter((call) => call[0] === name && call[1] === id).length; await page.waitForFunction(({ name, id, count }) => window.qaChatSettled.filter((call) => call.name === name && call.args[0] === id).length >= count, { name, id, count }); await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function publish(text) { await page.evaluate((value) => window.dispatchEvent(new CustomEvent('chat:events', { detail: value })), snapshot(text)); }
async function mount(props) {
  await page.evaluate((props) => window.qaMountChat({ onRefresh: undefined, ...props }), props);
  if (props.connected === false) await page.getByRole('status').filter({ hasText: /^Reconnecting$/ }).waitFor();
}
async function reconnect(label) { const previous = current; await mount({ connected: false }); await mount({ connected: true }); await until(() => current !== previous && calls.some((call) => call[0] === 'ready' && call[1] === current), 'Reconnected ready call missing'); await settled('ready', current); if (label) await publish(label); }
(async () => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    server = await createServer({ root: path.resolve(__dirname, '..'), cacheDir: cache, server: { port: 0, host: '127.0.0.1', strictPort: false } }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    handlers.set('open', async () => { current = 'command-view-' + ++counter; return current; }); handlers.set('ready', async () => snapshot());
    handlers.set('close', async () => { throw Error('Already closed command attachment'); }); handlers.set('refresh', async () => {});
    handlers.set('submit', async (_id, command) => receipt(command.commandId)); handlers.set('receipt', async (_id, commandId) => receipt(commandId));
    await page.exposeFunction('invokeChat', async (name, ...args) => { calls.push([name, ...structuredClone(args)]); if (name === 'submit') validateCommand(args[1]); const handler = handlers.get(name); assert.ok(handler, 'Unexpected ChatApi call: ' + name); return handler(...args); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/chat-boundaries.html`);
    await page.getByText('Current command attachment', { exact: true }).waitFor(); await mount({});
    const draft = page.getByRole('textbox', { name: 'Message to agent', exact: true });
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const interrupt = page.getByRole('button', { name: 'Interrupt', exact: true });
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    // A different handle cannot inject transcript or controller evidence.
    const foreign = snapshot('Foreign attachment output'); foreign.id = 'foreign-view';
    await page.evaluate((value) => { window.dispatchEvent(new CustomEvent('chat:events', { detail: value })); window.dispatchEvent(new CustomEvent('chat:state', { detail: { ...value.state, id: value.id, canControl: false } })); }, foreign);
    assert.equal(await page.getByText('Foreign attachment output', { exact: true }).count(), 0); await page.getByText('You control this chat', { exact: true }).waitFor();
    session.state = 'running'; session.activeTurnId = 'running-turn'; await publish('Running agent');
    await interrupt.click(); await until(() => commands().some((call) => call[2].operation === 'interrupt'), 'Interrupt command missing'); await settled('receipt', current);
    assert.deepEqual(commands().at(-1)[2].payload, {});
    let before = commands().length;
    page.once('dialog', (dialog) => dialog.dismiss()); await stop.click(); assert.equal(commands().length, before);
    page.once('dialog', (dialog) => dialog.accept()); await stop.click(); await until(() => commands().length === before + 1, 'Confirmed stop missing'); await settled('receipt', current);
    assert.equal(commands().at(-1)[2].operation, 'stop');
    session.state = 'idle'; session.activeTurnId = null; await publish('Idle after stop fixture');
    await draft.fill('   '); await draft.press('Enter'); assert.equal(commands().length, before + 1);
    await draft.fill('Shift enters a new line'); await draft.press('Shift+Enter'); assert.equal(commands().length, before + 1); assert.ok((await draft.inputValue()).includes('\n'));

    // A transport failure permits an explicit retry of precisely the same ID.
    handlers.set('submit', async () => { throw Error('Submit acknowledgement lost'); });
    handlers.set('receipt', async () => { throw Error('Receipt remains unavailable'); });
    await draft.fill('Retry only this reviewed command'); await send.click();
    await page.getByRole('alert').filter({ hasText: 'Receipt remains unavailable' }).waitFor();
    const failed = commands().at(-1)[2]; before = commands().length;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(commands().length, before);
    handlers.set('submit', async (_id, command) => receipt(command.commandId));
    handlers.set('receipt', async (_id, commandId) => receipt(commandId));
    await page.getByRole('button', { name: 'Retry same action', exact: true }).click(); await send.waitFor();
    assert.deepEqual(commands().at(-1)[2], failed); assert.equal(commands().length, before + 1);

    // Accepted submit replies after reconnection keep the command for readback,
    // but cannot clear newly typed text from the new attachment.
    let submitted;
    handlers.set('submit', async (id, command) => new Promise((resolve, reject) => { submitted = { id, command, resolve, reject }; }));
    await draft.fill('Delayed accepted action'); await send.click(); await until(() => submitted, 'Deferred submit missing');
    const oldSubmit = submitted; await reconnect('Reconnected before submit acknowledgement'); await draft.fill('New draft after reconnect');
    oldSubmit.resolve(receipt(oldSubmit.command.commandId, 'accepted')); await settled('submit', oldSubmit.id); await settled('receipt', current);
    assert.equal(await draft.inputValue(), 'New draft after reconnect');
    assert.equal(commands().filter((call) => call[2].commandId === oldSubmit.command.commandId).length, 1);
    submitted = null; await send.click(); await until(() => submitted, 'Deferred rejected submit missing');
    const rejected = submitted; await reconnect('Reconnected before submit rejection'); await draft.fill('Draft after old rejection');
    rejected.reject(Error('Old attachment submit failed')); await settled('submit', rejected.id); await settled('receipt', current);
    assert.equal(await draft.inputValue(), 'Draft after old rejection'); assert.equal(await page.getByRole('alert').count(), 0);

    // A same-attachment delayed reply must also preserve edits made in flight.
    submitted = null; await send.click(); await until(() => submitted, 'In-flight edited submit missing');
    await draft.fill('Edited while send was in flight'); submitted.resolve(receipt(submitted.command.commandId)); await settled('submit', current); await settled('receipt', current);
    assert.equal(await draft.inputValue(), 'Edited while send was in flight');

    // An old poll result (success or rejection) is discarded after reconnect.
    handlers.set('submit', async (_id, command) => receipt(command.commandId, 'accepted'));
    for (const rejectOld of [false, true]) {
      const polls = [];
      handlers.set('receipt', async (id, commandId) => new Promise((resolve, reject) => { polls.push({ id, commandId, resolve, reject }); }));
      await draft.fill('Poll recovery ' + rejectOld); await send.click(); await until(() => polls.length === 1, 'Old poll missing');
      await reconnect('New poll attachment ' + rejectOld); await until(() => polls.length === 2, 'New attachment did not check the same command');
      assert.equal(polls[0].commandId, polls[1].commandId);
      if (rejectOld) polls[0].reject(Error('Stale poll failure')); else polls[0].resolve(receipt(polls[0].commandId, 'failed'));
      await settled('receipt', polls[0].id); assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).count(), 0, 'The new attachment must retain its pending receipt');
      polls[1].resolve(receipt(polls[1].commandId)); await send.waitFor();
    }

    // A directly unknown submit is terminal for automatic polling and retries.
    handlers.set('submit', async (_id, command) => receipt(command.commandId, 'unknown'));
    const receiptsBefore = calls.filter((call) => call[0] === 'receipt').length;
    await draft.fill('Direct unknown acknowledgement'); await send.click();
    await page.getByRole('status').filter({ hasText: 'A previous action has an uncertain outcome.' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Retry same action', exact: true }).count(), 0);
    assert.equal(calls.filter((call) => call[0] === 'receipt').length, receiptsBefore);
    await page.screenshot({ path: path.join(directory, 'chat-command-uncertainty.png') });
    await page.evaluate(() => window.qaUnmountChat()); await page.getByText('Chat fixture unmounted', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS exact stop/interrupt commands, foreign-handle rejection, keyboard guards, explicit same-ID retry, late submit/draft preservation, stale poll cancellation and unknown-submit fencing');
  } catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'chat-command-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure-body.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable')); } throw error; }
  finally { await browser?.close(); await server?.close(); fs.rmSync(cache, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
