// Real built companion and authenticated gateway; deterministic inventory only.
const { chromium } = require('playwright-core');
const { Gateway } = require('../electron/gateway.cjs');
const { Store } = require('../electron/config.cjs');
const { EventEmitter, once } = require('node:events');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-companion-filters-'));
  const store = new Store(directory), events = new EventEmitter();
  const unit = (id, title, extra = {}) => ({ key: `default/tmux:${id}`, id, title, provider: 'codex', hostId: 'default', hostName: 'Alpha host', cwd: '/workspace', kind: 'managed', managed: true, state: 'live', updatedAt: null, ...extra });
  const sessions = [unit('hq-111111111111', 'Alpha managed'), unit('hq-222222222222', 'Beta managed', { key: 'beta/tmux:hq-222222222222', hostId: 'beta', hostName: 'Beta host', provider: 'claude' }), unit('hq-333333333333', 'Unknown managed', { state: 'unknown', stale: true }), unit('external', 'External session', { kind: 'external-tmux', managed: false }), unit('saved', 'Saved history', { key: 'default/codex:saved', kind: 'conversation', managed: false })];
  store.data.settings.hosts = [{ id: 'default', name: 'Alpha host', target: 'fixture.invalid', port: 22, enabled: true }, { id: 'beta', name: 'Beta host', target: 'fixture.invalid', port: 22, enabled: true }];
  store.data.workspace.metadata = { [sessions[0].key]: { pinned: true, project: 'Managed project', notes: '' }, [sessions[3].key]: { pinned: false, project: 'External project', notes: '' } };
  store.data.attention = [0, 3].map((index) => ({ id: String(index), sessionKey: sessions[index].key, hostId: 'default', title: sessions[index].title, provider: 'codex', createdAt: new Date().toISOString(), acknowledged: false, signature: 'fixture', kind: 'input', confidence: 'confirmed', detail: 'Fixture input request' }));
  const service = { events, store, terminals: { handles: new Map(), disconnect() {} }, chats: { disconnect() {} }, inventory: async () => ({ hosts: [], sessions, attention: store.data.attention, faults: [] }), health: async () => [] };
  const gateway = new Gateway({ directory, assets: path.resolve(__dirname, '../dist'), service, secure: false });
  let browser;
  try {
    const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
    const url = `http://127.0.0.1:${port}`; await gateway.configure({ enabled: true, port, url });
    const secret = crypto.randomBytes(32).toString('base64url'); gateway.data.devices.push({ id: crypto.randomUUID(), name: 'Filter QA phone', secretHash: crypto.createHash('sha256').update(secret).digest('hex'), expiresAt: Date.now() + 60000 });
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); await context.addCookies([{ name: 'agenthq-test', value: secret, url, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = []; page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url); await page.locator('.phone-session-row').filter({ hasText: 'Alpha managed' }).waitFor();
    const rows = page.locator('.phone-session-row'), search = page.getByRole('textbox', { name: 'Search sessions', exact: true });
    assert.equal(await rows.count(), 3); assert.equal(await page.getByRole('button', { name: 'Managed only', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('combobox', { name: 'Filter project' }).getByRole('option', { name: 'External project', exact: true }).count(), 0);
    await search.fill('Beta'); assert.equal(await rows.count(), 1); await search.fill('NO_MATCH'); assert.equal(await rows.count(), 0); await search.fill('');
    await page.getByRole('combobox', { name: 'Filter provider' }).selectOption('claude'); assert.equal(await rows.count(), 1);
    await page.getByRole('combobox', { name: 'Filter SSH host' }).selectOption('default'); assert.equal(await rows.count(), 0);
    await page.getByRole('combobox', { name: 'Filter provider' }).selectOption(''); assert.equal(await rows.count(), 2);
    await page.getByRole('combobox', { name: 'Filter SSH host' }).selectOption('');
    await page.getByRole('button', { name: 'Pinned', exact: true }).click(); assert.equal(await rows.count(), 1); await page.getByRole('button', { name: 'Pinned', exact: true }).click();
    await page.getByRole('button', { name: 'Managed only', exact: true }).click(); assert.equal(await rows.count(), 5);
    await page.getByRole('combobox', { name: 'Filter project' }).selectOption('External project'); assert.equal(await rows.count(), 1);
    await page.getByRole('combobox', { name: 'Filter project' }).selectOption(''); await page.getByRole('button', { name: 'Managed only', exact: true }).click();
    await page.getByRole('button', { name: /^Attention/ }).click(); assert.equal(await page.locator('.phone-attention').count(), 1); assert.equal(await page.locator('.phone-attention').filter({ hasText: 'External session' }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
    console.log('PASS built companion managed defaults, opt-in external inventory, search, combined host/provider/project/pin filters, unknown entries, scoped attention, and phone layout');
  } finally { await browser?.close(); await gateway.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
