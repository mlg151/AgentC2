// Browser plugin not available: use the repository's Playwright/Chromium path.
// Flow: mount production dialog -> edit/interact -> verify rendered result and
// exact IPC inputs, including rejected requests and callbacks after unmount.
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults, validateSettings } = require('../electron/config.cjs');
const { defaults: centcomDefaults, validateConfig } = require('../electron/centcom.cjs');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-component-ui-'));
const settings = () => ({ ...defaults(), hosts: [{ id: 'alpha', name: 'Alpha', target: 'fixture-alpha', port: 22, enabled: true }, { id: 'beta', name: 'Beta', target: 'fixture-beta', port: 22, enabled: true }], cleanup: [{ hostId: 'alpha', provider: 'codex', enabled: false, days: 30 }], roe: { version: 1, hostDefaults: { alpha: 'gated' } } });
const calls = [], errors = [], handlers = new Map();
let browser, server;
async function mount(page, name, props) { await page.evaluate(({ name, props }) => window.qaMount(name, props), { name, props }); await page.getByRole('dialog').waitFor(); }
async function until(check, label) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw Error(label); }
const last = (name) => calls.findLast((call) => call[0] === name);
async function close(page) { await page.keyboard.press('Escape'); await page.getByText('Dialog closed', { exact: true }).waitFor(); }

async function history(page) {
  let outcome = { text: 'zero\nAlpha alpha ALPHA\nlast', truncated: false }, pending;
  handlers.set('terminalHistory', async () => { if (outcome === 'pending') return new Promise((resolve, reject) => { pending = { resolve, reject }; }); if (outcome instanceof Error) throw outcome; return outcome; });
  await page.locator('#launch').focus();
  await mount(page, 'history', { terminalId: 'retained-view' });
  await page.getByText('Snapshot of up to 50,000 retained lines.', { exact: true }).waitFor();
  assert.deepEqual(last('terminalHistory'), ['terminalHistory', 'retained-view']);
  await page.getByRole('status').filter({ hasText: 'Enter text to search' }).waitFor();
  const input = page.getByRole('textbox', { name: 'Find in history' });
  await input.fill('aLpHa'); await page.getByRole('status').filter({ hasText: '1 of 3 matches' }).waitFor();
  assert.equal(await page.locator('mark').innerText(), 'Alpha');
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.getByRole('status').filter({ hasText: '2 of 3 matches' }).waitFor();
  await input.press('Enter'); await page.getByRole('status').filter({ hasText: '3 of 3 matches' }).waitFor();
  await input.press('Enter'); await page.getByRole('status').filter({ hasText: '1 of 3 matches' }).waitFor();
  await input.press('Shift+Enter'); await page.getByRole('status').filter({ hasText: '3 of 3 matches' }).waitFor();
  await page.getByRole('button', { name: 'Previous', exact: true }).click(); await page.getByRole('status').filter({ hasText: '2 of 3 matches' }).waitFor();
  await input.press('ArrowLeft');
  await input.fill('absent'); await input.press('Enter'); await page.getByRole('status').filter({ hasText: 'No matches' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
  outcome = { text: 'x'.repeat(20005), truncated: true }; await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('Showing the most recent 4 million characters.', { exact: true }).waitFor();
  assert.equal((await page.locator('.history-output').innerText()).length, 20000);
  outcome = Error('History transport unavailable'); await page.getByRole('button', { name: 'Reload', exact: true }).click(); await page.getByText('Error: History transport unavailable', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(directory, 'history-error.png') });
  await page.getByRole('button', { name: 'Close history search' }).click(); await page.getByText('Dialog closed', { exact: true }).waitFor();
  assert.equal(await page.locator('#launch').evaluate((element) => element === document.activeElement), true, 'Dialog restores launch focus');
  for (const reject of [false, true]) {
    outcome = 'pending'; pending = null; await mount(page, 'history', { terminalId: 'pending-view' }); await until(() => pending, 'History request missing');
    await close(page); if (reject) pending.reject(Error('Late failure')); else pending.resolve({ text: 'Late history', truncated: false });
    await page.getByText('Dialog closed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
  }
}

async function configuration(page) {
  let saved, fail = false;
  handlers.set('saveSettings', async (input) => { if (fail) throw Error('Settings write refused'); saved = validateSettings(input); });
  const original = settings(); original.presets[0].hostId = 'alpha';
  await mount(page, 'settings', { settings: original });
  const alpha = page.locator('fieldset.host-editor').first();
  await alpha.getByLabel('Name', { exact: true }).fill('Renamed Alpha');
  await alpha.getByLabel('SSH target', { exact: true }).fill('updated-fixture');
  await alpha.getByLabel('Port', { exact: true }).fill('2200');
  await alpha.getByLabel('Enabled', { exact: true }).uncheck(); await alpha.getByLabel('Enabled', { exact: true }).check();
  await alpha.getByLabel('Auto-forward detected localhost URLs', { exact: true }).check();
  await alpha.getByLabel('Default Rules of Engagement').selectOption('full'); await alpha.getByLabel('Default Rules of Engagement').selectOption('');
  await page.getByRole('button', { name: 'Add this computer', exact: true }).click(); assert.equal(await page.getByRole('button', { name: 'Add this computer', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Add SSH host', exact: true }).click();
  const fresh = page.locator('fieldset.host-editor').filter({ has: page.locator('legend', { hasText: /^New host$/ }) });
  await fresh.getByLabel('SSH target', { exact: true }).fill('new-fixture');
  await page.getByLabel('Desktop notifications for new attention items').check();
  fail = true; await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Settings write refused' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).isEnabled(), true);
  fail = false; await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await page.getByText('Dialog closed', { exact: true }).waitFor();
  assert.deepEqual(saved.hosts[0], { id: 'alpha', name: 'Renamed Alpha', target: 'updated-fixture', port: 2200, enabled: true, autoForward: true }); assert.equal(saved.hosts[1].name, 'Beta'); assert.equal(saved.hosts.length, 4); assert.equal(saved.roe.hostDefaults.alpha, undefined); assert.equal(saved.notifications, true);
  await mount(page, 'settings', { settings: original });
  await page.locator('fieldset.host-editor').first().getByRole('button', { name: 'Remove host', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await page.getByText('Dialog closed', { exact: true }).waitFor();
  assert.deepEqual(saved.hosts.map((host) => host.id), ['beta']); assert.equal(saved.presets[0].hostId, ''); assert.deepEqual(saved.cleanup, []); assert.deepEqual(saved.roe.hostDefaults, {});
  await mount(page, 'settings', { settings: original }); await page.getByRole('button', { name: 'Launch presets', exact: true }).click();
  await page.getByRole('button', { name: 'Add preset', exact: true }).click();
  await page.getByLabel('Preset name', { exact: true }).fill('UI fixture');
  await page.getByLabel('Launch command', { exact: true }).fill('claude');
  await page.getByLabel('Additional arguments', { exact: true }).fill('--model fixture');
  await page.getByLabel(/^Default host/).selectOption('beta');
  await page.getByLabel('Working directory', { exact: true }).fill('/fixture');
  await page.getByLabel('Starting instructions', { exact: true }).fill('No provider calls');
  await page.getByLabel(/^Rules of Engagement profile/).selectOption('gated');
  await page.getByLabel('Detect repeated confirmed tool or API failures', { exact: true }).check();
  await page.getByLabel('Automatically send one Ctrl+C to the faulted managed unit', { exact: true }).check();
  await page.getByLabel('Matching failures', { exact: true }).fill('7'); await page.getByLabel('Window (minutes)', { exact: true }).fill('9'); await page.getByLabel('Cooldown (minutes)', { exact: true }).fill('11');
  await page.screenshot({ path: path.join(directory, 'settings-preset.png') });
  await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await page.getByText('Dialog closed', { exact: true }).waitFor();
  const preset = saved.presets.at(-1); assert.equal(preset.name, 'UI fixture'); assert.equal(preset.hostId, 'beta'); assert.equal(preset.cwd, '/fixture'); assert.equal(preset.instructions, 'No provider calls'); assert.deepEqual(preset.loopBreaker, { enabled: true, autoInterrupt: true, threshold: 7, windowMinutes: 9, cooldownMinutes: 11 });
  await mount(page, 'settings', { settings: saved }); await page.getByRole('button', { name: 'Launch presets', exact: true }).click(); await page.getByLabel('Edit preset', { exact: true }).selectOption(preset.id);
  await page.getByLabel('Report provider turn events to the attention inbox', { exact: true }).uncheck(); await page.getByLabel('Report provider turn events to the attention inbox', { exact: true }).check();
  for (const provider of ['codex', 'claude', 'antigravity', 'opencode']) await page.getByLabel(/^Provider/).selectOption(provider);
  await page.getByRole('button', { name: 'Remove preset', exact: true }).click();
  await page.getByRole('button', { name: 'SPECOPS ranks and workflows', exact: true }).click(); assert.deepEqual(last('specops'), ['specops']);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByText('Dialog closed', { exact: true }).waitFor();
  await mount(page, 'settings', { settings: { ...settings(), presets: [] }, specops: false }); await page.getByRole('button', { name: 'Launch presets', exact: true }).click(); await page.getByText('Add a preset to save a launch command.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add preset', exact: true }).click(); await page.getByRole('button', { name: 'Remove preset', exact: true }).click(); await page.getByText('Add a preset to save a launch command.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await page.getByText('Dialog closed', { exact: true }).waitFor();
}

async function remoteAccess(page) {
  let remote = { enabled: false, running: false, port: 43127, transport: 'https', url: '', devices: [], error: '' };
  let failure = '', expiry = 60000;
  handlers.set('remoteStatus', async () => { if (failure === 'refresh') throw Error('Device refresh refused'); return remote; });
  handlers.set('tailscaleStatus', async () => ({ state: 'Running', url: 'https://fixture.tailnet.ts.net' }));
  handlers.set('saveRemote', async (input) => { if (failure === 'save') throw Error('Remote configuration refused'); return remote = { ...remote, ...input, running: input.enabled }; });
  handlers.set('pairRemote', async () => { if (failure === 'pair') throw Error('Pairing refused'); return { url: 'https://fixture.tailnet.ts.net/pair?token=fixture-only', expiresAt: Date.now() + expiry }; });
  handlers.set('writeClipboard', async () => {});
  handlers.set('revokeRemote', async (id) => { if (failure === 'revoke') throw Error('Revocation refused'); remote = { ...remote, devices: remote.devices.filter((device) => device.id !== id) }; return remote; });
  await mount(page, 'settings', { settings: settings() }); await page.getByRole('button', { name: 'Remote access', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Tailscale is connected.' }).waitFor();
  await page.getByLabel('Enable remote access and tray operation', { exact: true }).check();
  await page.getByLabel(/^Connection method/).selectOption('tailnet-http');
  await page.getByLabel('Companion origin', { exact: true }).fill('http://100.64.0.2:8080');
  await page.getByLabel('Local gateway port', { exact: true }).fill('43200');
  failure = 'save'; await page.getByRole('button', { name: 'Apply remote access', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Remote configuration refused' }).waitFor();
  failure = ''; await page.getByRole('button', { name: 'Apply remote access', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Gateway running' }).waitFor();
  assert.deepEqual(last('saveRemote'), ['saveRemote', { enabled: true, port: 43200, url: 'http://100.64.0.2:8080', transport: 'tailnet-http' }]);
  failure = 'pair'; await page.getByRole('button', { name: 'Pair a device', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Pairing refused' }).waitFor();
  failure = ''; await page.getByRole('button', { name: 'Pair a device', exact: true }).click(); await page.getByRole('img', { name: 'Scan to pair your phone', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Copy pairing link', exact: true }).click(); await until(() => last('writeClipboard'), 'Pairing link was not copied');
  assert.deepEqual(last('writeClipboard'), ['writeClipboard', 'https://fixture.tailnet.ts.net/pair?token=fixture-only']);
  await page.screenshot({ path: path.join(directory, 'remote-pairing.png') });
  remote = { ...remote, devices: [{ id: 'fixture-phone', name: 'Fixture phone', createdAt: Date.now(), expiresAt: Date.now() + 60000 }] };
  await page.getByRole('button', { name: 'Refresh devices', exact: true }).click(); await page.getByText('Fixture phone', { exact: true }).waitFor();
  failure = 'revoke'; await page.getByRole('button', { name: 'Revoke', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Revocation refused' }).waitFor();
  failure = ''; await page.getByRole('button', { name: 'Revoke', exact: true }).click(); await page.getByText('No paired devices.', { exact: true }).waitFor(); assert.deepEqual(last('revokeRemote'), ['revokeRemote', 'fixture-phone']);
  failure = 'refresh'; await page.getByRole('button', { name: 'Refresh devices', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Device refresh refused' }).waitFor(); failure = '';
  expiry = -1; await page.getByRole('button', { name: 'Pair a device', exact: true }).click(); await page.getByText('Pairing link expired. Generate a new one.', { exact: true }).waitFor();
  await page.evaluate((state) => window.qaEmit('onRemoteStatus', state), { ...remote, enabled: false, running: false, error: 'Gateway stopped externally' });
  await page.getByRole('alert').filter({ hasText: 'Gateway stopped externally' }).waitFor(); assert.equal(await page.getByRole('img').count(), 0);
  await page.getByRole('button', { name: 'Hosts', exact: true }).click();
  handlers.set('tailscaleStatus', async () => ({ state: 'Stopped', url: '' }));
  await page.getByRole('button', { name: 'Remote access', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Sign in on your computer and phone.' }).waitFor();
  await close(page);
}

async function commander(page) {
  let state = { config: centcomDefaults('alpha'), session: null, status: 'idle', error: '', costUsd: 0, costKnown: false, autoTurnsLastHour: 0, directives: [], automations: [], auditLog: [] }, failure = '';
  const publish = async () => { await page.evaluate((state) => window.qaEmit('onCentcomState', state), state); };
  handlers.set('centcomState', async () => state);
  handlers.set('submitCentcom', async () => { if (failure) throw Error('Commander request refused'); return state; });
  for (const method of ['startCentcom', 'interruptCentcom', 'resetCentcomSession', 'decideAllCentcomDirectives', 'decideCentcomDirective', 'applyCentcomAutomation']) handlers.set(method, async () => state);
  handlers.set('configureCentcom', async (config) => { state = { ...state, config: validateConfig(config) }; return state; });
  await mount(page, 'centcom', { settings: settings() }); await page.getByRole('button', { name: 'Initialize Commander Session', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Initialize Commander Session', exact: true }).click(); await until(() => last('startCentcom'), 'Commander startup missing'); assert.deepEqual(last('startCentcom'), ['startCentcom']);
  failure = 'submit'; await page.getByRole('button', { name: 'Fleet SitRep & Readiness Brief', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Commander request refused' }).waitFor(); failure = '';
  for (const [button, text] of [['Fleet SitRep & Readiness Brief', 'Conduct a full fleet situation assessment.'], ['Arbitrate Halts & Faults', 'Analyze all active SPECOPS missions'], ['Suggest Automations', 'Analyze recurring manual developer workflows']]) { await page.getByRole('button', { name: button, exact: true }).click(); assert.ok(last('submitCentcom')[1].startsWith(text)); }
  state = { ...state, status: 'running', providerTurn: { status: 'uncertain' } }; await publish(); await page.getByRole('status').filter({ hasText: 'Provider shutdown is unconfirmed.' }).waitFor();
  await page.getByRole('button', { name: 'Halt Turn', exact: true }).click(); await until(() => last('interruptCentcom'), 'Turn interrupt missing');
  await page.getByRole('button', { name: 'Directives', exact: true }).click(); await page.getByText('No directives recorded yet.', { exact: true }).waitFor();
  const now = Date.now();
  state = { ...state, status: 'awaiting_approval', providerTurn: null, directives: [{ id: 'approve-one', summary: 'First reviewed directive', kind: 'unit.stop', state: 'pending', rationale: 'Fixture rationale', params: {}, preconditions: {}, createdAt: now, trigger: 'manual', binding: { revision: 'fixture' } }, { id: 'deny-two', summary: 'Second reviewed directive', kind: 'unit.send', state: 'pending', rationale: '', params: {}, preconditions: {}, createdAt: now, resolvedAt: now, trigger: 'manual', error: 'Fixture error' }], auditLog: [{ id: 'audit', at: now, outcome: 'failed', summary: 'Fixture audit', kind: 'unit.stop', trigger: 'manual', error: 'Fixture audit error' }] }; await publish();
  await page.getByRole('button', { name: 'Approve All Pending (2)', exact: true }).click(); assert.deepEqual(last('decideAllCentcomDirectives'), ['decideAllCentcomDirectives', 'approve']);
  await page.getByRole('button', { name: 'Deny All', exact: true }).click(); assert.deepEqual(last('decideAllCentcomDirectives'), ['decideAllCentcomDirectives', 'deny']);
  const first = page.locator('article.centcom-directive-card').first(); await first.getByRole('button', { name: 'Deny', exact: true }).click(); assert.deepEqual(last('decideCentcomDirective'), ['decideCentcomDirective', 'approve-one', 'deny']);
  await first.getByRole('button', { name: 'Approve & Execute', exact: true }).click(); assert.deepEqual(last('decideCentcomDirective'), ['decideCentcomDirective', 'approve-one', 'approve']);
  for (const summary of ['Directive Parameters & Preconditions', 'Reviewed targets and authorization']) await first.locator('summary').filter({ hasText: summary }).click();
  await page.getByRole('button', { name: 'Automations', exact: true }).click(); await page.getByText(/No automation suggestions generated yet/).waitFor();
  state = { ...state, automations: [{ id: 'draft', kind: 'preset', state: 'proposed', title: 'Reviewed automation', rationale: 'Fixture', evidence: ['Reviewed evidence'], payload: {}, preview: { revision: 'fixture' }, createdAt: now }, { id: 'uncertain', kind: 'preset', state: 'uncertain', title: 'Uncertain automation', rationale: '', error: 'Readback unavailable', result: { matchesDraft: false }, createdAt: now }] }; await publish();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click(); assert.deepEqual(last('applyCentcomAutomation'), ['applyCentcomAutomation', 'draft', 'dismiss']);
  await page.getByRole('button', { name: 'Apply Configuration', exact: true }).click(); assert.deepEqual(last('applyCentcomAutomation'), ['applyCentcomAutomation', 'draft', 'apply']);
  for (const text of ['Configuration Payload', 'Reviewed change and revision', 'Saved artifact and revision']) await page.locator('summary').filter({ hasText: text }).first().click();
  await page.getByRole('button', { name: 'Configuration & ROE', exact: true }).click();
  await page.getByLabel(/^Command Execution Host/).selectOption('beta');
  for (const provider of ['claude', 'antigravity', 'opencode', 'codex']) await page.getByLabel(/^AI Model Provider/).selectOption(provider);
  await page.getByRole('button', { name: 'gpt-6.1-sol', exact: true }).click(); await page.getByLabel('Model ID', { exact: true }).fill('fixture-model');
  await page.getByLabel(/^Autonomous C2/).check(); await page.getByLabel(/^Gated C2/).check();
  const checkboxes = page.locator('.checkbox-group input'); for (let index = 0; index < await checkboxes.count(); index++) await checkboxes.nth(index).uncheck();
  for (const [label, value] of [['Fallback status interval (seconds)', '0'], ['Provider turn deadline (seconds)', '60'], ['Cancellation reconciliation deadline (seconds)', '5'], ['Trigger Cooldown (seconds)', '20'], ['Max Auto-Turns per Hour', '3'], ['Max Directives per Turn', '2'], ['Max Cumulative Budget ($ USD)', '7.5']]) await page.getByLabel(label).fill(value);
  await page.getByRole('button', { name: 'Save Configuration', exact: true }).click(); await until(() => last('configureCentcom'), 'Commander config missing');
  const draft = last('configureCentcom')[1]; assert.equal(draft.hostId, 'beta'); assert.equal(draft.model, 'fixture-model'); assert.equal(draft.maxBudgetUsd, 7.5); assert.equal(draft.maxDirectivesPerTurn, 2); assert.equal(draft.triggers.onUnitCompleted, false); assert.equal(draft.triggers.fallbackSeconds, 0);
  await page.getByLabel(/^Max Cumulative Budget/).fill(''); await page.getByRole('button', { name: 'Save Configuration', exact: true }).click(); await until(() => last('configureCentcom')[1].maxBudgetUsd === null, 'Unlimited budget not preserved');
  let acceptReset = false; page.on('dialog', async (dialog) => { if (acceptReset) await dialog.accept(); else await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Reset Commander Session', exact: true }).click(); assert.equal(last('resetCentcomSession'), undefined);
  acceptReset = true; await page.getByRole('button', { name: 'Reset Commander Session', exact: true }).click(); await until(() => last('resetCentcomSession'), 'Accepted reset not dispatched');
  await page.screenshot({ path: path.join(directory, 'centcom-config.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await page.getByText('Dialog closed', { exact: true }).waitFor();
}

async function commanderDraft(page) {
  const initial = { config: centcomDefaults('alpha'), session: null, status: 'idle', costUsd: 0, costKnown: true, directives: [], automations: [], auditLog: [] };
  let pending;
  handlers.set('centcomState', () => new Promise((resolve, reject) => { pending = { resolve, reject }; }));
  handlers.set('configureCentcom', async (config) => ({ ...initial, config: validateConfig(config) }));
  await mount(page, 'centcom', { settings: settings() }); await until(() => pending, 'Initial commander request missing');
  const live = { ...initial, config: { ...initial.config, model: 'event-model' }, status: 'running', costUsd: 3 };
  await page.evaluate((state) => window.qaEmit('onCentcomState', state), live);
  await page.getByRole('button', { name: 'Configuration & ROE', exact: true }).click();
  await page.getByLabel('Model ID', { exact: true }).fill('unsaved-reviewed-model');
  await page.getByLabel(/^Command Execution Host/).selectOption('beta');
  await page.getByLabel(/^Autonomous C2/).check(); await page.getByLabel(/^Max Cumulative Budget/).fill('2');
  await page.evaluate((state) => window.qaEmit('onCentcomState', state), { ...live, costUsd: 4 });
  assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'unsaved-reviewed-model', 'Live status cannot overwrite unsaved configuration');
  pending.resolve(initial);
  await page.locator('.centcom-badge.status-running').waitFor();
  assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'unsaved-reviewed-model', 'Late initial response cannot overwrite the draft');
  await page.getByText('SPEND: $4.00', { exact: true }).waitFor();
  await page.getByLabel('Model ID', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, 'centcom-draft-preserved.png') });
  await page.getByRole('button', { name: 'Save Configuration', exact: true }).click(); await until(() => last('configureCentcom')[1].model === 'unsaved-reviewed-model', 'Edited commander config was not saved');
  const saved = last('configureCentcom')[1]; assert.equal(saved.hostId, 'beta'); assert.equal(saved.authority, 'autonomous'); assert.equal(saved.maxBudgetUsd, 2);
  await page.screenshot({ path: path.join(directory, 'centcom-draft-saved.png') }); await close(page);
  handlers.set('centcomState', async () => { throw Error('Initial commander state unavailable'); });
  await mount(page, 'centcom', { settings: settings() }); await page.getByRole('alert').filter({ hasText: 'Initial commander state unavailable' }).waitFor(); await close(page);
  for (const reject of [false, true]) {
    pending = null; handlers.set('centcomState', () => new Promise((resolve, reject) => { pending = { resolve, reject }; }));
    await mount(page, 'centcom', { settings: settings() }); await until(() => pending, 'Pending commander request missing'); await close(page);
    if (reject) pending.reject(Error('Late commander failure')); else pending.resolve(initial);
    await page.getByText('Dialog closed', { exact: true }).waitFor();
  }
}

async function peerSettings(page) {
  let state = { id: 'desktop', enabled: false, running: false, deviceName: 'Fixture', bindAddress: '127.0.0.1', port: 43128, address: '', error: '', peers: [] }, failure = '', expiry = 60000;
  handlers.set('peerSyncStatus', async () => state);
  handlers.set('savePeerSync', async (input) => { if (failure) throw Error('Sync configuration refused'); return state = { ...state, ...input, running: input.enabled, address: 'ws://127.0.0.1:43201' }; });
  handlers.set('issuePeerPairing', async () => ({ code: 'fixture-pairing-code', url: 'ws://127.0.0.1:43201', expiresAt: Date.now() + expiry }));
  handlers.set('connectPeer', async () => state = { ...state, peers: [{ id: 'peer', name: 'Connected fixture', connected: true, remoteTabs: ['alpha/tmux:one'], lastSyncedAt: new Date().toISOString(), error: '' }, { id: 'offline', name: 'Offline fixture', connected: false, remoteTabs: [], lastSyncedAt: null, error: 'Fixture offline' }] });
  handlers.set('pullPeerTabs', async () => ({ tabs: ['alpha/tmux:one'] }));
  handlers.set('revokePeer', async (id) => state = { ...state, peers: state.peers.filter((peer) => peer.id !== id) });
  await mount(page, 'settings', { settings: settings() }); await page.getByRole('button', { name: 'Desktop sync', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Desktop sync is off' }).waitFor();
  await page.getByLabel('Enable desktop sync', { exact: true }).check(); await page.getByLabel('Device name', { exact: true }).fill('Edited desktop'); await page.getByLabel('LAN / VPN bind address', { exact: true }).fill('127.0.0.1'); await page.getByLabel('Sync port', { exact: true }).fill('43201');
  failure = 'save'; await page.getByRole('button', { name: 'Apply desktop sync', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Sync configuration refused' }).waitFor(); failure = '';
  await page.getByRole('button', { name: 'Apply desktop sync', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Listening at ws://127.0.0.1:43201' }).waitFor();
  assert.deepEqual(last('savePeerSync')[1], { ...state, id: 'desktop', running: false, address: '', error: '', peers: [] }, 'The editor preserves the loaded configuration fields');
  await page.getByRole('button', { name: 'Generate pairing code', exact: true }).click(); await page.getByLabel('Pairing code', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Pairing code', { exact: true }).inputValue(), 'fixture-pairing-code');
  await page.getByLabel('Peer address', { exact: true }).fill(' ws://127.0.0.1:43202 '); await page.getByLabel('Peer pairing code', { exact: true }).fill(' fixture-code ');
  await page.getByRole('button', { name: 'Connect desktop', exact: true }).click(); await page.getByText('Connected fixture', { exact: true }).waitFor();
  assert.deepEqual(last('connectPeer'), ['connectPeer', { url: 'ws://127.0.0.1:43202', code: 'fixture-code' }]); assert.equal(await page.getByLabel('Peer pairing code', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: 'Pull open tabs (1)', exact: true }).click(); await until(() => last('pullPeerTabs'), 'Peer tabs not requested'); assert.deepEqual(last('pullPeerTabs'), ['pullPeerTabs', 'peer']);
  await page.locator('.host-editor').filter({ has: page.getByText('Connected fixture', { exact: true }) }).getByRole('button', { name: 'Revoke desktop', exact: true }).click(); await until(() => last('revokePeer'), 'Peer revocation missing'); assert.deepEqual(last('revokePeer'), ['revokePeer', 'peer']);
  expiry = -1; await page.getByRole('button', { name: 'Generate pairing code', exact: true }).click(); await page.getByText('Pairing code expired. Generate a new one.', { exact: true }).waitFor();
  await page.evaluate((state) => window.qaEmit('onPeerSyncStatus', state), { ...state, error: 'External sync error' }); await page.getByRole('alert').filter({ hasText: 'External sync error' }).waitFor(); assert.equal(await page.getByText('Pairing code expired. Generate a new one.', { exact: true }).count(), 0);
  await close(page);
}

async function projectOrders(page) {
  let current = settings(), failure = '', ready = false;
  const revision = 'b'.repeat(64);
  handlers.set('saveSettings', async (input) => { if (failure === 'save') throw Error('Order save refused'); current = validateSettings(input); });
  handlers.set('previewOpOrder', async () => ({ ready, revision, unsupported: ready ? [] : ['Provider conversion requires review'], changes: [{ path: 'AGENTS.md', status: ready ? 'changed' : 'conflict', diff: 'Reviewed fixture diff', reason: ready ? '' : 'Fixture conflict' }] }));
  handlers.set('enrollOpOrder', async (order, reviewed) => { assert.equal(reviewed, revision); if (failure === 'apply') throw Error('Reviewed order changed'); return current = validateSettings({ ...current, opOrders: [...(current.opOrders || []).filter((item) => item.id !== order.id), { ...order, enabled: true }] }); });
  await mount(page, 'settings', { settings: current }); await page.getByRole('button', { name: 'OpOrders', exact: true }).click(); await page.getByText('Create an OpOrder to enroll a project.', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Add OpOrder', exact: true }).click();
  await page.getByLabel(/^Host/).selectOption('beta'); await page.getByLabel('Remote Git worktree root', { exact: true }).fill('/fixture/repository'); await page.getByLabel(/^Shared instructions/).fill('Shared fixture guidance');
  await page.getByLabel(/^Claude override/).fill('Claude fixture'); await page.getByLabel(/^Antigravity override/).fill('Antigravity fixture'); await page.getByLabel(/^Codex-only override/).fill('Unsupported override');
  await page.getByLabel(/^MCP servers/).fill('{}'); await page.getByRole('button', { name: 'Preview remote changes', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'MCP servers must be a JSON array' }).waitFor();
  await page.getByLabel(/^MCP servers/).fill('['); await page.getByRole('button', { name: 'Preview remote changes', exact: true }).click(); await page.getByRole('alert').waitFor();
  await page.getByLabel(/^MCP servers/).fill('[]'); await page.getByRole('button', { name: 'Preview remote changes', exact: true }).click(); await page.getByText('Review required', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Apply and enable sync', exact: true }).isDisabled(), true);
  await page.getByLabel(/^Codex-only override/).fill(''); ready = true;
  await page.getByRole('button', { name: 'Preview remote changes', exact: true }).click(); await page.getByText('Ready to apply', { exact: true }).waitFor();
  failure = 'apply'; await page.getByRole('button', { name: 'Apply and enable sync', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Reviewed order changed' }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Apply and enable sync', exact: true }).isDisabled(), true);
  failure = ''; await page.getByRole('button', { name: 'Preview remote changes', exact: true }).click(); await page.getByRole('button', { name: 'Apply and enable sync', exact: true }).click(); await page.getByRole('button', { name: 'Apply update', exact: true }).waitFor();
  await until(() => last('externalSettings'), 'Applied settings callback missing'); assert.equal(last('externalSettings')[1].opOrders[0].enabled, true); assert.equal(current.opOrders[0].hostId, 'beta'); assert.equal(current.opOrders[0].instructions, 'Shared fixture guidance');
  failure = 'save'; await page.getByRole('button', { name: 'Pause sync', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Order save refused' }).waitFor();
  failure = ''; await page.getByRole('button', { name: 'Pause sync', exact: true }).click(); await page.getByRole('button', { name: 'Apply and enable sync', exact: true }).waitFor(); assert.equal(current.opOrders[0].enabled, false);
  await page.getByRole('button', { name: 'Remove', exact: true }).click(); await page.getByText('Create an OpOrder to enroll a project.', { exact: true }).waitFor(); assert.deepEqual(current.opOrders, []); await close(page);
}

(async () => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    server = await createServer({ root: path.resolve(__dirname, '..'), server: { port: 0, host: '127.0.0.1' } }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
    page.setDefaultTimeout(5000); page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.exposeFunction('invokeBridge', async (name, ...args) => { calls.push([name, ...args]); if (['closed', 'specops', 'externalSettings'].includes(name)) return; if (!handlers.has(name)) throw Error('Unexpected IPC ' + name); return handlers.get(name)(...args); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/component-ui.html`);
    assert.equal(await page.title(), 'AgentC2 Component QA'); await page.getByRole('button', { name: 'Fixture focus anchor', exact: true }).waitFor();
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await history(page); await configuration(page); await remoteAccess(page); await peerSettings(page); await projectOrders(page); await commander(page); await commanderDraft(page);
    await page.setViewportSize({ width: 960, height: 800 }); await mount(page, 'settings', { settings: settings() }); await page.screenshot({ path: path.join(directory, 'settings-narrow.png') }); await close(page);
    assert.deepEqual(errors, []);
    console.log('PASS rendered history/search cancellation, settings persistence/error recovery, pairing/revocation, exact CENTCOM decisions/configuration/reset confirmation, focus restoration, and narrow layout');
  } finally { await browser?.close(); await server?.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
