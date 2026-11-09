const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const file = path.resolve(__dirname, '../electron/preload.cjs');
const calls = [], listeners = new Map();
let api;
const bridge = new Module(file, module);
bridge.require = (name) => {
  assert.equal(name, 'electron');
  return {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'agentHQ'); api = value; } },
    ipcRenderer: {
      invoke: (...args) => { calls.push(args); return Promise.resolve('receipt'); },
      on: (event, callback) => listeners.set(event, callback),
      removeListener: (event, callback) => { assert.equal(listeners.get(event), callback); listeners.delete(event); },
    },
  };
};
bridge._compile(fs.readFileSync(file, 'utf8'), file);
(async () => {
  assert.equal(await api.updateSessionMetadata('session', { notes: 'Narrow edit' }), 'receipt');
  assert.deepEqual(calls.pop(), ['metadata:update', 'session', { notes: 'Narrow edit' }]);
  let received;
  const off = api.onSharedState((state) => { received = state; });
  const state = { settings: {}, metadata: { session: { notes: 'Other device' } }, attention: [] };
  listeners.get('state:updated')({}, state);
  assert.equal(received, state);
  off(); assert.equal(listeners.has('state:updated'), false);
  console.log('PASS isolated preload metadata patch and shared-state event subscription/unsubscription');
})().catch((error) => { console.error(error); process.exitCode = 1; });
