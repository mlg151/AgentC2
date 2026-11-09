const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Store } = require('../electron/config.cjs');
const { fingerprint } = require('../electron/centcom-contract.cjs');
const { loadCommonJs } = require('./helpers/load-commonjs.cjs');

const revision = 'a'.repeat(64);
const order = { version: 1, id: 'project', hostId: 'default', repository: '/fixture/repo', enabled: false, instructions: 'Reviewed guidance' };
const visible = { ready: true, changes: [{ status: 'unchanged' }], revision };
function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-order-unit-'));
  const store = new Store(directory), calls = [], opOrderSynced = new Map(), events = new EventEmitter(), notifications = [];
  if (options.legacy) delete store.data.settings.opOrders;
  if (options.existing) store.data.settings.opOrders = options.existing;
  events.on('state:updated', () => notifications.push('updated'));
  let reads = 0;
  const { createOpOrders } = loadCommonJs('electron/oporders.cjs', {}, { setTimeout: (callback) => { queueMicrotask(callback); return 0; } });
  const api = createOpOrders({ store, opOrderSynced, events,
    getHost(id) { assert.equal(id, 'default'); return store.data.settings.hosts[0]; },
    runRemote: async (payload, hostId) => {
      calls.push({ payload, hostId });
      if (payload.action === options.failAction) throw options.failure;
      if (payload.action === 'oporder_sync') return { written: true };
      const result = options.observations?.[reads++] || options.observation || visible;
      options.onRead?.(store);
      return result;
    },
  });
  return { ...api, directory, store, calls, opOrderSynced, notifications, close() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

async function main() {
  const initial = fixture({ legacy: true });
  try {
    const before = fingerprint(initial.store.data.settings);
    for (const input of [undefined, null, 42, 'invalid']) await assert.rejects(initial.previewOpOrder(input), /Invalid OpOrder/);
    const preview = await initial.previewOpOrder(order);
    assert.equal(preview, visible);
    assert.equal(initial.calls[0].payload.action, 'oporder_preview');
    assert.equal(initial.calls[0].payload.order.enabled, true);
    assert.equal(fingerprint(initial.store.data.settings), before, 'Preview is read-only');
    initial.calls.length = 0;
    await assert.rejects(initial.enrollOpOrder(order, revision, 'stale'), (error) => error.beforeMutation === true);
    for (const input of [undefined, '', 42, 'G'.repeat(64)]) await assert.rejects(initial.enrollOpOrder(order, input), /Preview this OpOrder/);
    assert.deepEqual(initial.calls, [], 'Stale configuration and invalid review revisions must fail before contacting the host');
    await initial.enrollOpOrder(order, revision);
    assert.equal(initial.store.data.settings.opOrders[0].enabled, true);
    assert.equal(new Store(initial.directory).data.settings.opOrders[0].enabled, true);
    assert.deepEqual(initial.notifications, ['updated']);
    assert.equal(initial.opOrderSynced.get(order.id), JSON.stringify(initial.store.data.settings.opOrders[0]));
  } finally { initial.close(); }
  const neighbor = { ...order, id: 'neighbor', repository: '/fixture/neighbor' };
  const delayed = fixture({ existing: [order, neighbor], observations: [
    { ready: false, changes: [] }, { ready: true, changes: [{ status: 'create' }] }, visible,
  ] });
  try {
    await delayed.enrollOpOrder({ ...order, instructions: 'Updated reviewed guidance' }, revision);
    assert.equal(delayed.calls.filter((call) => call.payload.action === 'oporder_sync').length, 1, 'Readback polling must never replay the write');
    assert.equal(delayed.calls.filter((call) => call.payload.action === 'oporder_preview').length, 3);
    assert.deepEqual(delayed.store.data.settings.opOrders.map((item) => item.id), ['neighbor', 'project']);
    assert.equal(delayed.store.data.settings.opOrders[1].instructions, 'Updated reviewed guidance');
  } finally { delayed.close(); }
  for (const observation of [{ ready: false, changes: [] }, { ready: true, changes: [{ status: 'conflict' }] }]) {
    const f = fixture({ observation });
    try {
      await assert.rejects(f.enrollOpOrder(order, revision), /sync is not visible/);
      assert.equal(f.calls.filter((call) => call.payload.action === 'oporder_preview').length, 4);
      assert.equal(f.calls.filter((call) => call.payload.action === 'oporder_sync').length, 1);
      assert.deepEqual(f.notifications, []); assert.equal(f.opOrderSynced.size, 0);
      assert.equal(f.store.data.settings.opOrders.some((item) => item.enabled), false);
    } finally { f.close(); }
  }
  const changed = fixture({ onRead: (store) => store.save('settings', { ...store.data.settings, notifications: !store.data.settings.notifications }) });
  try {
    await assert.rejects(changed.enrollOpOrder(order, revision), /changed during enrollment; inspect remote state/);
    assert.equal(changed.calls.filter((call) => call.payload.action === 'oporder_sync').length, 1);
    assert.equal(changed.opOrderSynced.size, 0); assert.deepEqual(changed.notifications, []);
  } finally { changed.close(); }
  const failure = new Error('SSH outcome unknown');
  const disconnected = fixture({ failAction: 'oporder_sync', failure });
  try {
    await assert.rejects(disconnected.enrollOpOrder(order, revision), (error) => error === failure);
    assert.equal(disconnected.calls.length, 1); assert.equal(disconnected.opOrderSynced.size, 0);
  } finally { disconnected.close(); }
  console.log('PASS read-only OpOrder preview, preflight revision fencing, eventual/readback bounds, no uncertain write replay, persisted enrollment, neighbor isolation, and concurrent settings changes');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
