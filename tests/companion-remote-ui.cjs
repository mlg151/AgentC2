const assert = require('node:assert/strict');
const { phoneComponent } = require('./fixtures/phone-component.cjs');
(async () => {
  const remote = { enabled: true, running: true, port: 43127, url: 'https://desktop.ts.net', transport: 'https', devices: [], error: '' };
  let failStatus = false, failSave = true;
  const unhandled = [];
  const reject = (error) => unhandled.push(error);
  process.on('unhandledRejection', reject);
  const api = { remoteStatus: async () => { if (failStatus) throw new Error('Gateway reconfigured'); return remote; }, tailscaleStatus: async () => ({ state: 'Running', url: remote.url }), onRemoteStatus: () => () => {}, saveRemote: async () => { if (failSave) throw new Error('Connection closed'); return { ...remote, running: false }; } };
  const view = phoneComponent('../components/RemoteAccess.tsx', {}, { window: { agentHQ: api, setInterval: () => 1 }, modules: { '../platform': { isMac: false } } });
  try {
    await view.flush(); failStatus = true; view.button('Apply remote access').props.onClick(); await view.flush();
    assert.match(view.text(view.tree), /Connection closed.*Reconnect after changing remote access settings/);
    assert.equal(view.button('Apply remote access').props.disabled, false); assert.deepEqual(unhandled, []);
    failStatus = false; view.button('Apply remote access').props.onClick(); await view.flush(); assert.match(view.text(view.tree), /Reconnect/); assert.deepEqual(unhandled, []);
    failSave = false; view.button('Apply remote access').props.onClick(); await view.flush(); assert.match(view.text(view.tree), /Gateway stopped/); assert.doesNotMatch(view.text(view.tree), /Reconnect/); assert.deepEqual(unhandled, []);
  } finally { view.close(); process.removeListener('unhandledRejection', reject); }
  console.log('PASS remote reconfiguration failure retains reconnect guidance when follow-up status also rejects');
})().catch((error) => { console.error(error); process.exitCode = 1; });
