const assert = require('node:assert/strict');
const { serviceFixture } = require('./fixtures/service-boundaries.cjs');

async function faults() {
  const name = 'hq-111111111111', key = `default/tmux:${name}`, sessionId = 'chat-' + 'a'.repeat(32);
  const unit = { key, id: name, provider: 'claude', kind: 'managed', managed: true, state: 'live', canAttach: true, canInterrupt: true, presetId: 'claude', transport: 'chat', chatSessionId: sessionId };
  const savedFault = (status) => ({ fault: { id: 'b'.repeat(32), at: new Date().toISOString(), status, label: 'Confirmed fixture failure', count: 3, autoInterrupt: false } });
  const fixture = serviceFixture((store) => { store.save('cachedUnits', { default: [unit] }); store.save('loopState', { [key]: savedFault('pending'), 'default/tmux:hq-222222222222': savedFault('review') }); });
  const { service, adapters } = fixture, desktop = { id: 'desktop' }, observer = { id: 'phone' };
  let fresh = { ...unit, key: `tmux:${name}` }, held, failInventory = false;
  fixture.setHandler((request) => {
    if (failInventory) { request.fail(1, 'Fixture host is offline'); return; }
    if (held && request.payload.action === 'inventory' && !request.payload.localHost) { held.push(request); return; }
    request.respond(request.payload.action === 'inventory' ? { user: 'fixture', sessions: request.payload.localHost ? [] : [fresh] } : {});
  });
  const record = { owner: desktop, hostId: 'default', sessionId, connection: 'connected', handles: new Set(['observer-view', 'desktop-view']) };
  service.chats.sessions.set(`default/${sessionId}`, record);
  service.chats.handles.set('observer-view', { client: observer, record }); service.chats.handles.set('desktop-view', { client: desktop, record });
  let response = { state: 'completed', commandId: 'fixture-command' }, receipt = response;
  const sent = [];
  service.chats.submit = async (_client, _handle, command) => { sent.push(command); return response; };
  service.chats.receipt = async () => { if (receipt instanceof Error) throw receipt; return receipt; };
  const reset = () => service.store.save('loopState', { [key]: savedFault('review') });
  async function settleTimer(promise, advance = 0) {
    await new Promise((resolve) => setImmediate(resolve));
    const timer = [...fixture.timers.values()].find((timer) => timer.delay === 100); assert.ok(timer, 'An accepted interrupt must wait for its receipt');
    fixture.timers.delete(timer); fixture.advance(advance); timer.callback();
    return promise;
  }
  try {
    assert.equal(service.loopBreaker.faults().find((fault) => fault.sessionKey === key).status, 'unknown', 'Restart cannot assume an in-flight interrupt was accepted');
    assert.equal(service.loopBreaker.faults().find((fault) => fault.sessionKey !== key).status, 'review');
    service.store.save('loopState', {}); await assert.rejects(adapters.interruptFault(desktop, key), /No eligible confirmed fault/);
    service.store.save('loopState', { [key]: savedFault('interrupted') }); await assert.rejects(adapters.interruptFault(desktop, key), /No eligible/);
    service.store.save('loopState', { malformed: savedFault('review') }); await assert.rejects(adapters.interruptFault(desktop, 'malformed'), /Invalid fault target/);
    reset(); await assert.rejects(adapters.interruptFault(observer, key), /take control/i); await service.inventory();
    assert.equal(sent.length, 0, 'An observer must never interrupt an owned chat');
    for (const patch of [{ kind: 'external-tmux' }, { provider: 'codex' }, { state: 'saved' }, { canInterrupt: false }, { presetId: '' }, { presetId: 'changed-preset' }]) {
      fresh = { ...unit, key: `tmux:${name}` }; await service.inventory(); reset();
      fresh = { ...fresh, ...patch };
      await assert.rejects(adapters.interruptFault(desktop, key), /changed or exited/); await service.inventory();
      assert.equal(service.loopBreaker.faults()[0].status, 'failed');
    }
    fresh = { ...unit, key: `tmux:${name}` }; await service.inventory(); reset();
    held = []; const first = adapters.interruptFault(desktop, key); await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(adapters.interruptFault(desktop, key), /already in progress/);
    const replies = held; held = null; for (const request of replies) request.respond({ user: 'fixture', sessions: [fresh] });
    assert.equal((await first).status, 'interrupted'); await service.inventory();
    assert.equal(sent.at(-1).operation, 'interrupt'); assert.equal(sent.at(-1).sessionId, sessionId);
    for (const outcome of [{ state: 'failed', error: 'Provider refused' }, { state: 'unknown' }, { state: 'failed' }]) {
      reset(); response = outcome;
      const before = sent.length, result = await adapters.interruptFault(desktop, key); await service.inventory();
      assert.equal(result.status, outcome.state); assert.equal(sent.length, before + 1, 'Uncertain/failed receipts must never resend the interrupt');
    }
    for (const next of [{ state: 'completed' }, Error('Receipt transport failed'), { state: 'accepted' }]) {
      reset(); response = { state: 'accepted', commandId: 'fixture-command' }; receipt = next;
      const before = sent.length;
      const result = await settleTimer(adapters.interruptFault(desktop, key), next.state === 'accepted' ? 20001 : 0); await service.inventory();
      assert.equal(result.status, next.state === 'completed' ? 'interrupted' : 'unknown'); assert.equal(sent.length, before + 1);
    }
    reset(); service.chats.handles.delete('desktop-view');
    await assert.rejects(service.action(desktop, 'interrupt', name, 'default'), /Open the chat and take control/);
    service.chats.handles.set('desktop-view', { client: desktop, record });
    await assert.rejects(service.action(desktop, 'unknown', name, 'default'), /Invalid session name/);
    await assert.rejects(service.action(desktop, 'stop', 'external', 'default'), /Invalid session name/);
    reset(); failInventory = true;
    await assert.rejects(adapters.interruptFault(desktop, key), /Fixture host is offline/); await service.inventory();
    failInventory = false; reset(); let firstFailure = true;
    fixture.setHandler((request) => {
      if (firstFailure) { firstFailure = false; service.resetFault(key); request.fail(1, 'Lost transport after fault reset'); }
      else request.respond({});
    });
    await assert.rejects(adapters.interruptFault(desktop, key), /Lost transport after fault reset/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(service.loopBreaker.faults(), [], 'An in-flight failure must not recreate a fault explicitly reset during dispatch');
    const uncached = serviceFixture((store) => store.save('loopState', { [key]: savedFault('review') }));
    try {
      uncached.setHandler((request) => request.respond(request.payload.action === 'flash_list' ? [] : { user: 'fixture', sessions: request.payload.localHost ? [] : [fresh] }));
      await assert.rejects(uncached.adapters.interruptFault(desktop, key), /changed or exited/);
      await uncached.service.inventory();
      assert.equal(uncached.calls.every((request) => ['inventory', 'flash_list'].includes(request.payload.action)), true, 'Missing cached identity must reject interruption before provider dispatch: ' + JSON.stringify(uncached.calls.map((request) => [request.payload.action, request.payload.request?.action])));
    } finally { uncached.close(); }
    service.chats.handles.clear(); service.chats.sessions.clear();
    console.log('PASS service fault restart uncertainty, eligibility and fresh managed-unit checks, observer and concurrent interrupt denial, native receipt completion/failure/deadline/read loss without resend, and failed refresh recovery');
  } finally { service.chats.handles.clear(); service.chats.sessions.clear(); fixture.close(); }
}

faults().catch((error) => { console.error(error); process.exitCode = 1; });
