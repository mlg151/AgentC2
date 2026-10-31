const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTurnLifecycle } = require('../electron/centcom-turn.cjs');
const { fixture, desktop, phone, until, tick } = require('./fixtures/centcom.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-turn-'));
const fixtures = [];
async function setup(label) {
  const f = fixture(path.join(directory, label)); fixtures.push(f);
  const session = f.sessions[0];
  const handle = await f.chats.open(desktop, session.chatSessionId, 'alpha');
  await f.chats.take(desktop, handle);
  const client = { id: 'centcom-commander', name: 'CENTCOM' };
  const state = { config: { turnDeadlineSeconds: 1, cancellationDeadlineSeconds: 0.05 }, providerTurn: null, costUsd: 0, costKnown: true };
  const outcomes = [], persisted = [];
  const create = () => createTurnLifecycle({ chats: f.chats, client, state, persist: () => persisted.push(structuredClone(state)), outcome: (value) => outcomes.push(value) });
  let lifecycle = create();
  function append(type, data, turnId) {
    const events = f.journals.get(session.chatSessionId) || [];
    events.push({ protocolVersion: 1, sessionId: session.chatSessionId, sequence: events.length + 1, timestamp: new Date().toISOString(), provider: 'codex', providerSessionId: null, turnId, itemId: null, type, data });
    f.journals.set(session.chatSessionId, events);
  }
  const run = (abort = new AbortController()) => {
    const commandId = crypto.randomUUID();
    const promise = lifecycle.run({ session, commandId, text: 'Inspect', signal: abort.signal, logicalTurnId: crypto.randomUUID() });
    promise.catch(() => {});
    return { commandId, promise, abort };
  };
  return { f, session, handle, state, outcomes, persisted, append, run, get lifecycle() { return lifecycle; },
    restart() { lifecycle.dispose(); lifecycle = create(); },
    close() { lifecycle.dispose(); f.dispose(); },
  };
}

async function pagedCorrelation() {
  const t = await setup('pages');
  for (let i = 0; i < 700; i++) t.append('message.completed', { role: 'assistant', text: 'Old evidence' }, 'old-turn');
  const reads = [], original = t.f.chats.read.bind(t.f.chats);
  t.f.chats.read = async (...args) => { reads.push(args[2]); return original(...args); };
  const run = t.run();
  await until(() => t.state.providerTurn?.receiptState === 'completed');
  for (let i = 0; i < 700; i++) t.append('message.completed', { role: 'assistant', text: 'Other evidence' }, 'wrong-turn');
  t.append('turn.completed', { outcome: 'completed', detail: '' }, 'wrong-turn');
  t.append('message.completed', { role: 'assistant', text: 'Correlated answer' }, run.commandId);
  t.append('turn.completed', { outcome: 'completed', detail: '' }, run.commandId);
  assert.equal(await run.promise, 'Correlated answer');
  assert.ok(reads.some((cursor) => cursor >= 1200), 'Must consume more than one 500-event page');
  assert.equal(t.state.providerTurn, null);
  assert.equal(t.f.chats.get(desktop, t.handle).record.owner.id, desktop.id);
  assert.equal(t.outcomes.at(-1).facts.projectAcceptance, 'unverified');
  assert.equal(t.outcomes.at(-1).facts.providerTurnCompletion, 'completed');
  t.close();
}

async function uncertainCancellationAndRestart() {
  const t = await setup('uncertain');
  const competitor = await t.f.chats.open(phone, t.session.chatSessionId, 'alpha');
  const run = t.run();
  await until(() => t.state.providerTurn?.receiptState === 'completed');
  run.abort.abort();
  await assert.rejects(run.promise, /interrupted/);
  assert.equal(t.state.providerTurn.status, 'uncertain');
  assert.equal(t.state.providerTurn.cancelReceipt.state, 'completed', 'Cancellation acknowledgement is deliberately insufficient');
  await assert.rejects(t.f.chats.take(phone, competitor), /still owns/);
  const before = t.f.submitted.filter((c) => c.operation === 'send').length;
  await assert.rejects(t.run().promise, /remains uncertain/);
  assert.equal(t.f.submitted.filter((c) => c.operation === 'send').length, before);
  const cursor = t.state.providerTurn.cursor;
  t.restart();
  assert.equal(t.state.providerTurn.cursor, cursor);
  t.append('turn.completed', { outcome: 'interrupted', detail: 'Provider confirmed interruption' }, run.commandId);
  assert.equal(await t.lifecycle.reconcile(), true);
  assert.equal(t.state.providerTurn, null);
  assert.equal(t.f.submitted.filter((c) => c.operation === 'send').length, before, 'Restart recovery never replays a submission');
  assert.ok(t.persisted.some((s) => s.providerTurn?.status === 'uncertain'));
  await t.f.chats.take(phone, competitor);
  t.close();
}

async function blockedDispatchAndLateCancel() {
  const t = await setup('blocked');
  const request = t.f.chats.request.bind(t.f.chats);
  let releaseSend, releaseCancel;
  const sendGate = new Promise((r) => { releaseSend = r; });
  const cancelGate = new Promise((r) => { releaseCancel = r; });
  t.f.chats.request = async (host, operation, args) => {
    if (operation === 'command' && args.command.operation === 'send') {
      const receipt = await request(host, operation, args); await sendGate; return receipt;
    }
    if (operation === 'command' && args.command.operation === 'interrupt') {
      await cancelGate; return request(host, operation, args);
    }
    return request(host, operation, args);
  };
  const run = t.run();
  await until(() => t.f.receipts.has(run.commandId));
  run.abort.abort();
  t.append('turn.completed', { outcome: 'interrupted', detail: '' }, run.commandId);
  await assert.rejects(run.promise, /interrupted/);
  assert.equal(t.state.providerTurn.status, 'uncertain', 'A late cancellation must not interrupt the next turn');
  releaseCancel(); releaseSend(); await tick();
  assert.equal(await t.lifecycle.reconcile(), true);
  t.close();
}

async function missingAndWrongIdentity() {
  const t = await setup('identity');
  t.state.config.turnDeadlineSeconds = 0.03;
  const request = t.f.chats.request.bind(t.f.chats);
  let missing = true;
  t.f.chats.request = async (...args) => {
    const receipt = await request(...args);
    return missing && receipt?.result && args[1] !== 'history' ? { ...receipt, result: {} } : receipt;
  };
  const run = t.run();
  await until(() => t.f.receipts.has(run.commandId));
  t.append('turn.completed', { outcome: 'completed', detail: '' }, run.commandId);
  await assert.rejects(run.promise, /timed out/);
  assert.equal(t.state.providerTurn.status, 'uncertain', 'Command ID is not a substitute for explicit provider turn identity');
  missing = false;
  t.f.receipts.get(run.commandId).sessionId = 'chat-' + 'f'.repeat(32);
  assert.equal(await t.lifecycle.reconcile(), false);
  assert.match(t.state.providerTurn.error, /identity mismatch/);
  t.f.receipts.get(run.commandId).sessionId = t.session.chatSessionId;
  assert.equal(await t.lifecycle.reconcile(), true);
  t.close();
}

async function resetUnacceptedSubmission() {
  const t = await setup('unaccepted-submission');
  const request = t.f.chats.request.bind(t.f.chats);
  const attempts = [];
  let stopState = 'accepted';
  t.f.chats.request = async (host, operation, args) => {
    if (operation === 'command' && args.command.operation === 'send') throw new Error('Chat session is not ready; inspect its current state');
    if (operation === 'command' && args.command.operation === 'stop') {
      attempts.push(structuredClone(args.command));
      const receipt = await request(host, operation, args);
      receipt.state = stopState;
      return receipt;
    }
    if (operation === 'receipt' && attempts.some((command) => command.commandId === args.commandId)) {
      const receipt = await request(host, operation, args);
      return { ...receipt, state: stopState };
    }
    return request(host, operation, args);
  };
  const run = t.run();
  await assert.rejects(run.promise, /not ready/);
  assert.equal(t.state.providerTurn.status, 'uncertain');
  assert.equal(t.f.receipts.has(run.commandId), false, 'Original startup rejection has no durable send receipt');
  assert.equal(await t.lifecycle.reconcile(), false);
  assert.equal(await t.lifecycle.stop(), false, 'Stop acceptance is not shutdown proof');
  assert.equal(t.state.providerTurn.status, 'uncertain');
  const competitor = await t.f.chats.open(phone, t.session.chatSessionId, 'alpha');
  await assert.rejects(t.f.chats.take(phone, competitor), /still owns/);
  const stopCommand = structuredClone(t.state.providerTurn.stopCommand);
  t.restart();
  stopState = 'completed';
  assert.equal(await t.lifecycle.stop(), true, 'Explicit reset recovers only after confirmed provider shutdown');
  assert.equal(t.state.providerTurn, null);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0], stopCommand, 'Reset recovery queries the original receipt without replaying its command');
  assert.equal(t.f.submitted.filter((command) => command.operation === 'send').length, 0, 'Recovery must never replay the provider prompt');
  assert.equal(t.outcomes.at(-1).facts.providerTurnCompletion, 'provider_stopped');
  await t.f.chats.take(phone, competitor);
  t.close();
}

async function providerReadiness() {
  const t = await setup('readiness');
  const read = t.f.chats.read.bind(t.f.chats);
  let status = 'starting', reads = 0;
  t.f.chats.read = async (...args) => {
    const page = await read(...args);
    page.session.state = status;
    reads++;
    return page;
  };
  const run = t.run();
  await until(() => reads >= 2);
  assert.equal(t.f.submitted.length, 0, 'Initialization must not submit or interrupt a provider turn');
  status = 'idle';
  await until(() => t.state.providerTurn?.receiptState === 'completed');
  t.append('turn.completed', { outcome: 'completed', detail: '' }, run.commandId);
  await run.promise;
  assert.equal(t.state.providerTurn, null);

  status = 'starting';
  t.state.config.turnDeadlineSeconds = 0.03;
  const before = t.f.submitted.length;
  await assert.rejects(t.run().promise, /timed out/);
  assert.equal(t.state.providerTurn, null, 'Timeout before submission must not strand ownership');
  assert.equal(t.f.submitted.length, before);
  status = 'failed';
  await assert.rejects(t.run().promise, /provider session is failed/);
  assert.equal(t.state.providerTurn, null);
  assert.equal(t.f.chats.get(desktop, t.handle).record.owner.id, desktop.id);
  t.close();
}

async function engineBridgeRestart() {
  const f = fixture(path.join(directory, 'engine-restart')); fixtures.push(f);
  await f.engine.start();
  f.engine.configure({ ...f.engine.state().config, cancellationDeadlineSeconds: 1 });
  const session = f.engine.state().session;
  const handle = await f.chats.open(desktop, session.chatSessionId, 'alpha');
  await f.chats.take(desktop, handle);
  const release = f.gate();
  const command = { protocolVersion: 1, commandId: crypto.randomUUID(), sessionId: session.chatSessionId, operation: 'send', payload: { text: 'Wait for provider' } };
  const send = f.chats.submit(desktop, handle, command);
  const rejected = assert.rejects(send, /interrupted/);
  await until(() => f.submitted.some((c) => c.commandId === command.commandId));
  const cancel = { ...command, commandId: crypto.randomUUID(), operation: 'interrupt', payload: {} };
  const receipt = await f.chats.submit(desktop, handle, cancel);
  assert.equal(receipt.commandId, cancel.commandId, 'Desktop interruption bypasses a blocked provider send');
  await rejected;
  assert.equal(f.engine.state().providerTurn.status, 'uncertain');
  const competitor = await f.chats.open(phone, session.chatSessionId, 'alpha');
  await assert.rejects(f.chats.take(phone, competitor), /still owns/);
  f.engine.dispose();
  f.start();
  assert.equal(f.engine.state().providerTurn.commandId, command.commandId, 'Reservation survives loading the actual persisted engine state');
  release(); await tick();
  await f.engine.reconcile();
  assert.equal(f.engine.state().providerTurn, null);
  assert.equal(f.submitted.filter((c) => c.commandId === command.commandId).length, 1);
  assert.equal(f.engine.outcomes({ collection: 'provider', serverId: command.commandId }).entries.at(-1).facts.providerTurnCompletion, 'completed');
  f.dispose();
}

async function resetIdleCommander() {
  const f = fixture(path.join(directory, 'reset-idle')); fixtures.push(f);
  await f.engine.start();
  const previous = f.engine.state().session;
  assert.equal(f.engine.state().providerTurn, null);
  await f.engine.resetSession();
  assert.ok(f.submitted.some((command) => command.operation === 'stop' && command.sessionId === previous.chatSessionId), 'Reset must stop the idle provider, even without a tracked turn');
  assert.notEqual(f.engine.state().session.chatSessionId, previous.chatSessionId);
  f.dispose();
}

async function uncertainIdleReset() {
  const t = await setup('uncertain-idle-reset');
  const request = t.f.chats.request.bind(t.f.chats);
  let allowReceipt = false, stopAttempts = 0;
  t.f.chats.request = async (host, action, args) => {
    if (action === 'command' && args.command.operation === 'stop') { stopAttempts++; await request(host, action, args); throw Error('Lost reset acknowledgement'); }
    if (action === 'receipt' && !allowReceipt) throw Error('Receipt unavailable');
    return request(host, action, args);
  };
  assert.equal(await t.lifecycle.stop(t.session), false);
  t.restart();
  assert.equal(await t.lifecycle.reconcile(), false, 'An idle reset is still uncertain after restart without its stop receipt');
  await assert.rejects(t.run().promise, /remains uncertain/);
  assert.equal(stopAttempts, 1);
  allowReceipt = true;
  assert.equal(await t.lifecycle.reconcile(), true);
  assert.equal(stopAttempts, 1);
  assert.equal(t.state.providerTurn, null);
  t.close();
}

async function retireConfiguredCommander() {
  const f = fixture(path.join(directory, 'retire-config')); fixtures.push(f);
  await f.engine.start();
  const previous = f.engine.state().session;
  await f.engine.reconcileRetiredSessions();
  assert.equal(f.submitted.filter((c) => c.operation === 'stop').length, 0, 'The current idle commander must survive');
  f.engine.configure({ ...f.engine.state().config, model: 'new-fixture-model' });
  const read = f.chats.read.bind(f.chats);
  let status = 'running', pendingCommands = [];
  f.chats.read = async (...args) => { const page = await read(...args); page.session.state = status; page.pendingCommands = pendingCommands; return page; };
  await f.engine.reconcileRetiredSessions();
  assert.equal(f.submitted.filter((c) => c.operation === 'stop').length, 0, 'Active retired providers must be preserved until idle');
  const stateFile = path.join(directory, 'retire-config', 'centcom.json');
  function restart() {
    f.engine.dispose();
    const saved = JSON.parse(fs.readFileSync(stateFile));
    for (const identity of saved.commanderIdentities) if (identity.retirement) identity.retirement.checkedAt = 0;
    fs.writeFileSync(stateFile, JSON.stringify(saved)); f.start();
  }
  status = 'idle'; pendingCommands = [{ state: 'accepted' }]; restart();
  await f.engine.reconcileRetiredSessions();
  assert.equal(f.submitted.filter((c) => c.operation === 'stop').length, 0, 'An idle provider with pending work must survive');
  pendingCommands = []; restart();
  const request = f.chats.request.bind(f.chats);
  f.chats.request = async (...args) => {
    const result = await request(...args);
    if (args[1] === 'command' && args[2].command.operation === 'stop') throw Error('Lost stop acknowledgement');
    return result;
  };
  await f.engine.reconcileRetiredSessions();
  assert.equal(f.submitted.filter((c) => c.operation === 'stop').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).commanderIdentities[0].retirement.status, 'uncertain');
  restart();
  await f.engine.reconcileRetiredSessions();
  assert.equal(f.submitted.filter((c) => c.operation === 'stop').length, 1, 'A lost acknowledgement must be reconciled, never replayed');
  const retired = JSON.parse(fs.readFileSync(stateFile)).commanderIdentities[0];
  assert.equal(retired.retirement.status, 'stopped');
  assert.equal(retired.chatSessionId, previous.chatSessionId);
  assert.ok(f.sessions.some((s) => s.chatSessionId === previous.chatSessionId), 'Retirement preserves history');
  assert.ok(!f.submitted.some((c) => c.operation === 'stop' && c.sessionId === f.sessions[0].chatSessionId), 'Ordinary units are never retirement targets');
  f.dispose();
}

(async () => {
  try {
    await retireConfiguredCommander();
    await uncertainIdleReset();
    for (const test of [resetIdleCommander, pagedCorrelation, uncertainCancellationAndRestart, blockedDispatchAndLateCancel, missingAndWrongIdentity, resetUnacceptedSubmission, providerReadiness, engineBridgeRestart]) await test();
    console.log('PASS CENTCOM cursor correlation, bounded readiness/deadlines, retained cancellation ownership, late cancellation fencing, confirmed reset, and durable reconciliation');
  } finally { for (const f of fixtures) f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
