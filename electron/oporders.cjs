const { validateSettings } = require('./config.cjs');

// Shared by the desktop service and isolated enrollment regressions.
function createOpOrders({ store, getHost, runRemote, opOrderSynced, events }) {
  function validatedOpOrder(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid OpOrder');
    const existing = store.data.settings.opOrders || [];
    const opOrders = [...existing.filter((item) => item.id !== input?.id), input];
    return validateSettings({ ...store.data.settings, opOrders }).opOrders.find((item) => item.id === input.id);
  }
  async function previewOpOrder(input) {
    const order = { ...validatedOpOrder(input), enabled: true };
    getHost(order.hostId);
    return runRemote({ action: 'oporder_preview', order }, order.hostId);
  }
  async function enrollOpOrder(input, revision) {
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Preview this OpOrder before enrollment');
    const order = { ...validatedOpOrder(input), enabled: true };
    getHost(order.hostId);
    await runRemote({ action: 'oporder_sync', order, revision }, order.hostId);
    // A separate SSH read must observe every managed file before we advertise
    // this order as enabled. This also catches a partial or delayed sync.
    let observed;
    for (let attempt = 0; attempt < 4; attempt++) {
      observed = await runRemote({ action: 'oporder_preview', order }, order.hostId);
      if (observed.ready && observed.changes.every((change) => change.status === 'unchanged')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!observed?.ready || observed.changes.some((change) => change.status !== 'unchanged')) throw new Error('OpOrder sync is not visible on the SSH host; review before enabling it');
    const settings = validateSettings({ ...store.data.settings, opOrders: [...(store.data.settings.opOrders || []).filter((item) => item.id !== order.id), order] });
    store.save('settings', settings);
    opOrderSynced.set(order.id, JSON.stringify(order));
    events.emit('state:updated');
    return settings;
  }

  return { previewOpOrder, enrollOpOrder };
}

module.exports = { createOpOrders };
