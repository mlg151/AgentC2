// Browser plugin is unavailable: real Chromium renders the production ChatView.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const { contract, validateCommand } = require('../electron/chat-protocol.cjs');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-chat-recovery-'));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-vite-chat-'));
const id = 'chat-0123456789abcdef0123456789abcdef', stamp = '2026-01-01T00:00:00Z';
const capabilities = { provider: 'codex', version: 'fixture', status: 'supported', reason: null, ...Object.fromEntries(contract.capabilities.map((key) => [key, true])) };
const session = { id, provider: 'codex', providerSessionId: null, title: 'Recovery fixture', cwd: '/fixture', roeProfile: 'gated', state: 'idle', activeTurnId: null, createdAt: stamp, updatedAt: stamp, capabilities };
let server, browser, page, handle = 'view-1', sequence = 0, openFailure = true, canControl = true;
const calls = [], errors = [], handlers = new Map(), events = [], requests = [], pendingCommands = [];
const state = () => ({ id: handle, sessionId: id, canControl, controller: canControl ? { id: 'desktop', name: 'Desktop' } : { id: 'phone', name: 'Companion' }, connection: 'connected' });
const snapshot = () => ({ id: handle, session: structuredClone(session), events: structuredClone(events), cursor: sequence, latestCursor: sequence, retainedFrom: 1, hasMore: false, truncated: false, pendingRequests: structuredClone(requests), pendingCommands: structuredClone(pendingCommands), state: state() });
function append(type, data, itemId = null, turnId = 'fixture-turn') { events.push({ protocolVersion: 1, sessionId: id, sequence: ++sequence, timestamp: stamp, provider: 'codex', providerSessionId: null, itemId, turnId, type, data }); }
async function publish() { await page.evaluate((value) => window.dispatchEvent(new CustomEvent('chat:events', { detail: value })), snapshot()); }
async function wait(predicate) { await page.waitForFunction(predicate); }
async function idle() { await page.getByRole('button', { name: 'Send', exact: true }).waitFor(); await wait(() => document.querySelector('.chat-live-state')?.textContent === 'idle'); }
const commandCalls = () => calls.filter((call) => call[0] === 'submit');
(async () => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    append('message.completed', { role: 'assistant', text: 'Recovery ready. ![](https://example.invalid/image)' }, 'intro');
    server = await createServer({ root: path.resolve(__dirname, '..'), cacheDir: cache, server: { host: '127.0.0.1', port: 0, strictPort: false } }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    await page.route('https://**', (route) => { errors.push('Unexpected network request'); return route.abort(); });
    handlers.set('open', async () => { if (openFailure) throw Error('Initial attachment fixture failed'); return handle; });
    handlers.set('ready', async () => snapshot()); handlers.set('close', async () => {}); handlers.set('refresh', async () => {});
    handlers.set('take', async () => state());
    handlers.set('submit', async (_view, command) => { validateCommand(command); return { commandId: command.commandId, sessionId: id, state: 'completed', result: {}, error: null }; });
    handlers.set('receipt', async (_view, commandId) => ({ commandId, sessionId: id, state: 'completed', result: {}, error: null }));
    await page.exposeFunction('invokeChat', async (name, ...args) => { calls.push([name, ...structuredClone(args)]); const handler = handlers.get(name); assert.ok(handler, 'Unexpected ChatApi call: ' + name); return handler(...args); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/chat-boundaries.html`);
    await page.getByRole('alert').filter({ hasText: 'Initial attachment fixture failed' }).waitFor();
    await page.getByRole('button', { name: 'Dismiss chat error', exact: true }).click();
    openFailure = false; await page.getByRole('button', { name: 'Attach chat', exact: true }).click(); await idle();
    await page.getByText('[Image: attachment]', { exact: true }).waitFor(); assert.equal(await page.locator('img').count(), 0);

    for (const outcome of ['completed', 'interrupted', 'denied', 'failed', 'unknown']) append('turn.completed', { outcome, detail: outcome === 'unknown' ? '' : 'Fixture outcome evidence' }, null, 'turn-' + outcome);
    append('error', { code: 'fixture', message: 'Reviewed provider notice', retryable: false });
    append('tool.started', { name: 'Empty failed tool', input: '' }, 'empty-tool');
    append('tool.completed', { name: 'Empty failed tool', output: '', isError: true }, 'empty-tool');
    append('request.resolved', { requestId: 'old-expired', state: 'expired', decision: null });
    append('usage.updated', { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0, contextUsedTokens: 50, contextCapacityTokens: 100 });
    capabilities.reason = 'Fixture capability evidence is limited'; capabilities.version = null;
    await publish();
    for (const label of ['Turn finished', 'Turn interrupted', 'Turn ended with a denied action', 'Turn failed', 'Turn outcome unknown']) await page.getByText(label, { exact: false }).waitFor();
    await page.getByText('Empty failed tool', { exact: true }).click(); await page.getByText('(No output)', { exact: true }).waitFor();
    await page.getByText('Interactive request · Expired', { exact: true }).waitFor();
    await page.getByText('Context 50%', { exact: true }).waitFor(); await page.getByText('Fixture capability evidence is limited', { exact: true }).waitFor();
    canControl = false; await publish();
    handlers.set('take', async () => { throw Error('Control fixture refused'); });
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Control fixture refused' }).waitFor();
    await page.getByRole('button', { name: 'Dismiss chat error', exact: true }).click();
    handlers.set('take', async () => { canControl = true; return state(); });
    await page.getByRole('button', { name: 'Take control', exact: true }).click(); await page.getByText('You control this chat', { exact: true }).waitFor();

    session.state = 'waiting'; session.activeTurnId = 'fixture-turn';
    const question = { requestId: 'questions', turnId: 'fixture-turn', itemId: 'question-item', state: 'pending', type: 'question.requested', data: { requestId: 'questions', questions: [{ id: 'single', question: 'Choose one route', options: ['Alpha', 'Beta'], multiple: false }, { id: 'multiple', question: 'Choose reviewed checks', options: ['Build', 'Test'], multiple: true }, { id: 'free', question: 'Explain the next step', options: [], multiple: false }] } };
    requests.push(question); append('question.requested', question.data, question.itemId); await publish();
    assert.equal(await page.getByRole('button', { name: 'Send answers', exact: true }).isDisabled(), true);
    await page.getByRole('radio', { name: 'Alpha', exact: true }).check();
    await page.getByRole('textbox', { name: 'Answer: Choose one route', exact: true }).fill('Written route');
    assert.equal(await page.getByRole('radio', { name: 'Alpha', exact: true }).isChecked(), false);
    await page.getByRole('radio', { name: 'Beta', exact: true }).check();
    assert.equal(await page.getByRole('textbox', { name: 'Answer: Choose one route', exact: true }).inputValue(), '');
    await page.getByRole('checkbox', { name: 'Build', exact: true }).check(); await page.getByRole('checkbox', { name: 'Test', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Build', exact: true }).uncheck();
    await page.getByRole('textbox', { name: 'Answer: Choose reviewed checks', exact: true }).fill(' Extra check ');
    await page.getByRole('textbox', { name: 'Answer: Explain the next step', exact: true }).fill(' Continue with evidence ');
    await page.getByRole('button', { name: 'Send answers', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.chat-request-card button[type=submit]')?.disabled === false);
    const answer = commandCalls().at(-1)[2];
    assert.equal(answer.operation, 'respond'); assert.equal(answer.payload.requestId, question.requestId);
    assert.deepEqual(answer.payload.answers, [{ questionId: 'single', answers: ['Beta'] }, { questionId: 'multiple', answers: ['Test', 'Extra check'] }, { questionId: 'free', answers: ['Continue with evidence'] }]);
    requests.splice(0); append('request.resolved', { requestId: question.requestId, state: 'resolved', decision: 'answered' }); session.state = 'idle'; await publish();
    await page.getByText('User question · Answered', { exact: true }).waitFor();

    const submitted = { requestId: 'submitted-approval', turnId: 'fixture-turn', itemId: 'approval-item', state: 'submitted', type: 'approval.requested', data: { requestId: 'submitted-approval', action: 'Reviewed action already sent', detail: '' } };
    requests.push(submitted); append('approval.requested', submitted.data, submitted.itemId); await publish();
    await page.getByText('Decision sent; waiting for the provider.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Allow once', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Deny', exact: true }).isDisabled(), true);
    requests.splice(0); append('request.resolved', { requestId: submitted.requestId, state: 'resolved', decision: 'allow' }); await publish();

    const draft = page.getByRole('textbox', { name: 'Message to agent', exact: true });
    let reads = 0;
    handlers.set('submit', async (_view, command) => { validateCommand(command); return { commandId: command.commandId, sessionId: id, state: 'accepted', result: {}, error: null }; });
    handlers.set('receipt', async (_view, commandId) => ({ commandId, sessionId: id, state: ++reads < 3 ? 'dispatching' : 'completed', result: {}, error: null }));
    await draft.fill('Acknowledge once, poll completion'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    assert.equal(reads, 3); assert.equal(commandCalls().filter((call) => call[2].payload.text === 'Acknowledge once, poll completion').length, 1);

    let failReceipt = true;
    handlers.set('receipt', async (_view, commandId) => { if (failReceipt) throw Error('Receipt fixture offline'); return { commandId, sessionId: id, state: 'completed', result: {}, error: null }; });
    await draft.fill('Do not resend after lost receipt'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Receipt fixture offline' }).waitFor();
    const before = commandCalls().length;
    failReceipt = false; await page.getByRole('button', { name: 'Check action status', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor(); assert.equal(commandCalls().length, before);

    handlers.set('receipt', async (_view, commandId) => ({ commandId, sessionId: id, state: 'failed', result: null, error: null }));
    await draft.fill('Rejected prompt is recoverable'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'The provider did not confirm this action' }).waitFor();
    assert.equal(await draft.inputValue(), 'Rejected prompt is recoverable');
    await page.getByRole('button', { name: 'Dismiss chat error', exact: true }).click();
    let completeReceipt;
    handlers.set('receipt', async (_view, commandId) => new Promise((resolve) => { completeReceipt = () => resolve({ commandId, sessionId: id, state: 'failed', result: null, error: 'New draft survives rejection' }); }));
    await draft.fill('Submitted draft before edit'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.chat-composer textarea')?.value === '');
    await draft.fill('New text typed while waiting');
    for (let tick = 0; tick < 100 && !completeReceipt; tick++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(completeReceipt); completeReceipt();
    await page.getByRole('alert').filter({ hasText: 'New draft survives rejection' }).waitFor();
    assert.equal(await draft.inputValue(), 'New text typed while waiting');
    await page.getByRole('button', { name: 'Dismiss chat error', exact: true }).click();
    handlers.set('receipt', async (_view, commandId) => ({ commandId, sessionId: id, state: 'failed', result: null, error: null }));
    session.state = 'running'; session.activeTurnId = 'active-turn'; await publish();
    await draft.fill('Steer the current turn'); await page.getByRole('button', { name: 'Send to active turn', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'The provider did not confirm this action' }).waitFor();
    assert.equal(commandCalls().at(-1)[2].operation, 'steer'); assert.equal(commandCalls().at(-1)[2].payload.expectedTurnId, 'active-turn');
    assert.equal(await draft.inputValue(), '', 'A failed steering receipt must not restore an old send draft');
    await page.getByRole('button', { name: 'Dismiss chat error', exact: true }).click();
    session.state = 'idle'; await publish();
    session.state = 'stopped';
    pendingCommands.push({ commandId: '11111111-1111-4111-8111-111111111111', sessionId: id, state: 'accepted', result: null, error: null });
    await publish(); await page.getByText('Transcript storage', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Remove managed transcript', exact: true }).isDisabled(), true);
    pendingCommands[0].state = 'dispatching'; await publish();
    assert.equal(await page.getByRole('button', { name: 'Remove managed transcript', exact: true }).isDisabled(), true);
    pendingCommands[0].state = 'completed'; await publish();
    page.once('dialog', (dialog) => dialog.dismiss()); await page.getByRole('button', { name: 'Remove managed transcript', exact: true }).click();
    assert.equal(calls.filter((call) => call[0] === 'prune').length, 0);
    handlers.set('prune', async () => { throw Error('Prune acknowledgement fixture lost'); });
    page.once('dialog', (dialog) => dialog.accept()); await page.getByRole('button', { name: 'Remove managed transcript', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Transcript removal could not be confirmed' }).waitFor();
    assert.equal(calls.filter((call) => call[0] === 'prune').length, 1);
    await page.getByRole('button', { name: 'Dismiss chat error', exact: true }).click();
    session.state = 'idle'; pendingCommands.splice(0); await publish();
    handlers.set('receipt', async (_view, commandId) => ({ commandId, sessionId: id, state: 'unknown', result: null, error: 'Inspect native history' }));
    await draft.fill('Unknown action must not replay'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'A previous action has an uncertain outcome.' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Retry same action', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(directory, 'chat-unknown-receipt.png') });
    assert.deepEqual(errors, []);
    console.log('PASS ChatView attachment recovery, single/multiple/written question semantics, real receipt polling and manual status recovery without resend, rejected draft restoration, active-turn steering, and unknown-outcome fencing');
  } catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'chat-recovery-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure-body.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable')); } throw error; }
  finally { await browser?.close(); await server?.close(); fs.rmSync(cache, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
