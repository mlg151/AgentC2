const assert = require('node:assert/strict');
const { phoneComponent } = require('./fixtures/phone-component.cjs');
(async () => {
  const handlers = new Map(), docHandlers = new Map(), events = new Map(), calls = [];
  const state = { settings: { hosts: [], presets: [] }, attention: [], metadata: {}, capabilities: ['state:get'] };
  let resolveBootstrap, failState = false;
  const client = { on(name, callback) { events.set(name, callback); return () => events.delete(name); }, connect() { calls.push(['connect']); }, resume() { calls.push(['resume']); }, close() { calls.push(['close']); }, setCapabilities(value) { calls.push(['capabilities', value]); }, request: async (method) => { calls.push([method]); if (method === 'state') { if (failState) throw new Error('Foreground refresh failed'); return state; } if (method === 'inventory') return { sessions: [], attention: [], faults: [] }; return []; } };
  const document = { visibilityState: 'visible', addEventListener(name, callback) { docHandlers.set(name, callback); }, removeEventListener(name) { docHandlers.delete(name); } };
  const window = { setInterval: () => 1, addEventListener(name, callback) { handlers.set(name, callback); }, removeEventListener(name) { handlers.delete(name); } };
  const view = phoneComponent('Companion.tsx', {}, { globals: { document, location: { hash: '', pathname: '/companion.html' }, history: {}, fetch: () => new Promise((resolve) => { resolveBootstrap = resolve; }) }, window, modules: {
    './client': { CompanionClient: class { constructor() { return client; } } },
    './api': { createCompanionApi: () => ({}) },
    '../workspace': { projectFor: (session) => session.cwd || '' },
  } });
  handlers.get('agentc2:foreground')(); assert.equal(calls.some(([name]) => name === 'resume'), false, 'Unpaired pages do not reconnect');
  resolveBootstrap({ ok: true, json: async () => state }); await view.flush(); assert.ok(calls.some(([name]) => name === 'connect'));
  handlers.get('agentc2:foreground')(); assert.ok(calls.some(([name]) => name === 'resume'));
  events.get('connection')('connected'); events.get('connected')(state); await view.flush();
  assert.deepEqual(calls.find(([name]) => name === 'capabilities'), ['capabilities', state.capabilities]);
  const before = calls.filter(([name]) => name === 'inventory').length; handlers.get('agentc2:foreground')(); await view.flush(); assert.equal(calls.filter(([name]) => name === 'inventory').length, before + 1);
  document.visibilityState = 'hidden'; const hiddenCount = calls.length; docHandlers.get('visibilitychange')(); assert.equal(calls.length, hiddenCount);
  document.visibilityState = 'visible'; failState = true; docHandlers.get('visibilitychange')(); await view.flush(); assert.match(view.text(view.tree), /Foreground refresh failed/);
  const tools = view.component('PhoneTools'); tools.props.onSettings({ hosts: [], presets: [], notifications: true }); view.render(); assert.equal(view.component('PhoneTools').props.state.settings.notifications, true);
  tools.props.onSelect({ key: 'missing' }); view.render(); assert.match(view.text(view.tree), /Session unavailable/); view.component('PhoneTools').props.onSelect(null); view.render(); assert.match(view.text(view.tree), /No sessions match/);
  view.close(); assert.equal(handlers.size, 0); assert.equal(docHandlers.size, 0); assert.ok(calls.some(([name]) => name === 'close'));
  const pairing = phoneComponent('Companion.tsx', {}, { globals: { document, location: { hash: '#pair=once', pathname: '/companion.html' }, history: { replaceState() {} }, fetch: async (url) => url === '/api/v1/pair' ? { ok: true, json: async () => ({}) } : { ok: false, status: 401 } }, window, modules: {
    './client': { CompanionClient: class { constructor() { return client; } } }, './api': { createCompanionApi: () => ({}) }, '../workspace': { projectFor: () => '' },
  } });
  await pairing.flush(); pairing.find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} }); await pairing.flush();
  assert.equal(pairing.all().some((node) => node.type?.name === 'PhoneTools'), false, 'New pairing waits for authoritative bootstrap before rendering workflows');
  events.get('connection')('connected'); pairing.render(); pairing.button('New').props.onClick(); pairing.render();
  assert.equal(pairing.all().some((node) => node.type?.name === 'CreateDialog'), false, 'A launch dialog waits for settings during bootstrap');
  events.get('connected')(state); await pairing.flush(); const launch = pairing.component('CreateDialog'); launch.props.onSubmit({ hostId: 'host', provider: 'codex' }); await pairing.flush(); launch.props.onClose(); pairing.render(); pairing.close();
  console.log('PASS foreground refresh/reconnect guards preserve phone state, never replay actions, and dispose listeners');
})().catch((error) => { console.error(error); process.exitCode = 1; });
