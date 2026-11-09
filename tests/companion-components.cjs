const assert = require('node:assert/strict');
const { phoneComponent } = require('./fixtures/phone-component.cjs');
(async () => {
  const calls = [], responses = new Map(), selected = [], settingsApplied = [];
  const session = { key: 'default/tmux:hq-111111111111', id: 'hq-111111111111', hostId: 'default', title: 'Alpha', canAttach: true, worktreeOperation: 'op' };
  const state = { settings: { hosts: [], presets: [] }, metadata: { [session.key]: { project: 'Project', notes: 'Handoff' } }, attention: [] };
  const inventory = { sessions: [session], faults: [{ sessionKey: session.key, id: 'fault', label: 'Loop', detail: 'Repeated', status: 'review' }] };
  function request(name, ...args) { calls.push([name, ...args]); const response = responses.get(name); return response instanceof Error ? Promise.reject(response) : Promise.resolve(typeof response === 'function' ? response(...args) : response); }
  const api = new Proxy({}, { get: (_, name) => (...args) => request(name, ...args) });
  const props = { client: { request }, state, inventory, selected: session, connected: true, onSettings: (value) => settingsApplied.push(value), onSelect: (value) => selected.push(value), onRefresh: () => calls.push(['refresh']) };
  const view = phoneComponent('PhoneTools.tsx', props, { window: { agentHQ: api, confirm: () => true } });
  async function click(label) { const button = view.button(label); button.props.onClick(); await view.flush(); }
  async function open(label, name) { await click('Tools'); await click(label); return view.component(name); }
  for (const [label, component] of [['CENTCOM', 'CentcomDialog'], ['SPECOPS', 'SpecopsDialog']]) { const dialog = await open(label, component); dialog.props.onClose(); view.render(); }
  assert.equal(view.button('Session tools').props['aria-expanded'], false);
  await click('Session tools');
  const inputs = view.all().filter((node) => ['input', 'textarea'].includes(node.type));
  assert.deepEqual(inputs.map((node) => node.props.value), ['Project', 'Handoff']);
  inputs[0].props.onChange({ target: { value: 'Updated' } }); view.render();
  const external = { ...state, metadata: { [session.key]: { project: 'External project', notes: 'External handoff' } } };
  view.render({ ...props, state: external });
  assert.deepEqual(view.all().filter((node) => ['input', 'textarea'].includes(node.type)).map((node) => node.props.value), ['Updated', 'External handoff'], 'External updates refresh untouched fields and preserve dirty drafts');
  await click('Save notes & project'); assert.deepEqual(calls.find(([name]) => name === 'metadata:update'), ['metadata:update', session.key, { project: 'Updated' }]); assert.match(view.text(view.tree), /Saved notes and project/);
  view.all().find((node) => node.type === 'textarea').props.onChange({ target: { value: 'New handoff' } }); view.render();
  const newer = { ...state, metadata: { [session.key]: { project: 'New external project', notes: 'Another external note' } } };
  view.render({ ...props, state: newer });
  assert.deepEqual(view.all().filter((node) => ['input', 'textarea'].includes(node.type)).map((node) => node.props.value), ['New external project', 'New handoff']);
  responses.set('metadata:update', new Error('Lost connection')); await click('Save notes & project'); assert.match(view.text(view.tree), /Lost connection/);
  await click('Reset fault baseline'); assert.ok(calls.some(([name, key]) => name === 'resetFault' && key === session.key));
  let dialog = await open('Settings & remote access', 'SettingsDialog'); responses.set('saveSettings', { updated: true }); await dialog.props.onSave({ draft: true }); assert.deepEqual(settingsApplied.pop(), { updated: true }); dialog.props.onSpecops(); view.render(); view.component('SpecopsDialog').props.onClose(); view.render(); dialog.props.onExternalSettings({ external: true }); assert.deepEqual(settingsApplied.pop(), { external: true }); dialog.props.onClose(); view.render();
  dialog = await open('Joint Exercises', 'ExerciseDialog'); assert.equal(dialog.props.hostId, 'default'); dialog.props.onLaunched(); dialog.props.onClose(); view.render();
  dialog = await open('Search history', 'PhoneHistory'); dialog.props.onSelect(session); assert.equal(selected.pop(), session); view.render();
  dialog = await open('Clean up history', 'SessionCleanupDialog'); assert.equal(dialog.props.target, session); await dialog.props.onSave({ cleanup: true }); dialog.props.onClose(); view.render();
  dialog = await open('Overwatch', 'Overwatch'); dialog.props.onSelect(session); assert.equal(selected.pop(), session); view.render();
  await click('Tools'); view.window.confirm = () => false; await click('Interrupt faulty sessions'); assert.equal(calls.some(([name]) => name === 'interruptFaults'), false);
  view.window.confirm = () => true; await click('Interrupt faulty sessions'); assert.ok(calls.some(([name]) => name === 'interruptFaults')); await click('Tools');
  await click('Send SitRep'); dialog = view.component('SitRepDialog'); assert.equal(dialog.props.initialSummary, 'New handoff'); await dialog.props.onLaunched(); view.render();
  await click('Review diff'); dialog = view.component('DiffDrawer'); assert.equal(dialog.props.session, session); dialog.props.onClose(); view.render();
  await click('Clean up this history'); view.component('SessionCleanupDialog').props.onClose(); view.render();
  await click('Delete session'); view.component('DeleteSessionDialog').props.onDeleted(); view.render(); assert.equal(selected.pop(), null);
  const item = { id: 'request', hostId: session.hostId, name: session.id };
  responses.set('flash:list', [item]); responses.set('listFlashTraffic', [item]); dialog = await open('Flash Traffic', 'FlashTraffic'); await view.flush(); dialog = view.component('FlashTraffic'); assert.deepEqual(dialog.props.requests, [item]); dialog.props.onSelect('request'); view.render();
  dialog = view.component('FlashTraffic'); dialog.props.onDecide('allow'); await view.flush(); assert.deepEqual(calls.find(([name]) => name === 'decideFlashTraffic'), ['decideFlashTraffic', { hostId: session.hostId, name: session.id, id: 'request', decision: 'allow' }]);
  view.component('FlashTraffic').props.onJump(); view.render(); assert.equal(selected.pop(), session);
  responses.set('flash:list', []); await open('Flash Traffic', 'FlashTraffic'); await view.flush(); view.component('FlashTraffic').props.onDecide('deny'); view.component('FlashTraffic').props.onJump();
  responses.set('flash:list', new Error('Queue offline')); [...view.intervals.values()][0](); await view.flush(); assert.match(view.text(view.tree), /Queue offline/);
  view.component('FlashTraffic').props.onClose(); view.render();
  // No selection/inventory/metadata, disconnected panel, and changing selection all stay usable.
  view.render({ ...props, selected: { ...session, key: 'other', worktreeOperation: undefined }, inventory: null, state: { ...state, metadata: {} } }); await click('Session tools'); assert.equal(view.all().some((node) => node.type === 'button' && view.text(node) === 'Send SitRep'), false);
  view.render({ ...props, selected: null, connected: false, inventory: null }); await click('Tools'); assert.equal(view.button('Joint Exercises').props.disabled, true); view.button('Joint Exercises').props.onClick(); view.render(); assert.equal(view.component('ExerciseDialog').props.hostId, '');
  view.close();
  const empty = phoneComponent('PhoneTools.tsx', { ...props, selected: null, inventory: null, state: { ...state, metadata: {} } }, { window: { agentHQ: api } }); empty.close();
  console.log('PASS phone workflow component contracts, all panel navigation, metadata receipts/failures, fault confirmation, and permission decisions');
})().catch((error) => { console.error(error); process.exitCode = 1; });
