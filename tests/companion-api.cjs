const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileTypeScript } = require('./fixtures/ts-coverage.cjs');
const file = path.resolve(__dirname, '../src/companion/api.ts');
assert.ok(fs.existsSync(file), 'Phone workflows need a typed companion API adapter');
(async () => {
  const exports = {};
  let copied = '', clipboard = 'local clipboard';
  compileTypeScript(file, ['exports', 'require'])(exports, () => ({ readPhoneClipboard: async () => clipboard, writePhoneClipboard: async (text) => { copied = text; } }));
  const calls = [], listeners = new Map();
  const client = { request: async (...args) => { calls.push(args); return args[0] === 'state:get' ? { settings: {}, metadata: { key: { notes: 'shared' } }, attention: [] } : args; }, on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); } };
  const api = exports.createCompanionApi(client);
  const preload = fs.readFileSync(path.resolve(__dirname, '../electron/preload.cjs'), 'utf8');
  for (const [, name, parameters, channel] of preload.matchAll(/(\w+): \(([^\n]*?)\) => ipcRenderer.invoke\('([^']+)'/g)) {
    if (['getState', 'saveWorkspace', 'readClipboard', 'readClipboardForTerminal', 'writeClipboard', 'terminalMenu'].includes(name)) continue;
    const args = parameters ? parameters.split(',').map((_, index) => `arg${index}`) : [];
    assert.deepEqual(await api[name](...args), [channel, ...args], name);
  }
  assert.deepEqual(await api.getState(), { settings: {}, attention: [], workspace: { tabs: [], selectedKey: null, splitKey: null, metadata: { key: { notes: 'shared' } } } });
  assert.equal(api.platform, 'android');
  assert.equal(await api.readClipboard(), clipboard);
  assert.deepEqual(await api.readClipboardForTerminal('remote-id'), { kind: 'text', text: clipboard });
  await api.writeClipboard('phone text'); assert.equal(copied, 'phone text');
  assert.equal(await api.terminalMenu(true), null);
  const workspace = { tabs: ['phone'], metadata: {} }; assert.equal(await api.saveWorkspace(workspace), workspace);
  assert.equal(calls.some(([channel]) => channel === 'workspace:save'), false);
  const eventCases = {
    onSharedState: ['state:updated', {}, [{}]],
    onSessionsDeleted: ['sessions:deleted', ['key'], [['key']]], onSessionPinned: ['session:pinned', { key: 'key', pinned: true }, ['key', true]],
    onInventory: ['inventory:updated', 'inventory', ['inventory']], onHealth: ['health:updated', [], [[]]], onAttentionOpen: ['attention:open', 'key', ['key']],
    onChatEvents: ['chat:events', {}, [{}]], onChatState: ['chat:state', {}, [{}]], onRemoteStatus: ['remote:updated', {}, [{}]], onTerminalState: ['terminal:state', {}, [{}]],
    onTerminalData: ['terminal:data', { id: 'id', data: 'text', sequence: 1 }, ['id', 'text', 1]],
    onTerminalExit: ['terminal:exit', { id: 'id', code: 0 }, ['id', 0]], onDevUrls: ['tunnel:updated', { sessionKey: 'key', urls: [] }, ['key', []]],
  };
  for (const [name, [event, value, expected]] of Object.entries(eventCases)) {
    let received; const off = api[name]((...args) => { received = args; }); listeners.get(event)(value); assert.deepEqual(received, expected, name); off(); assert.equal(listeners.has(event), false);
  }
  console.log('PASS phone API covers every preload RPC, translates event arguments, and keeps clipboard/workspace local');
})().catch((error) => { console.error(error); process.exitCode = 1; });
