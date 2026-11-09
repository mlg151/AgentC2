const crypto = require('node:crypto');

// A transport timeout/abort stops waiting, not the remote provider. The durable
// turn reservation and controller lease survive until correlated terminal proof.
function createTurnLifecycle({ chats, client, state, persist, outcome, now = () => Date.now() }) {
  let lease = null;
  let disposed = false;
  let cancelFlight = null;
  let acquireFlight = null;
  function wait(promise, deadline, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => finish(reject, new Error('CENTCOM turn interrupted by Watch Officer'));
      const timer = setTimeout(() => finish(reject, new Error('CENTCOM turn timed out waiting for provider completion')), Math.max(0, deadline - now()));
      let settled = false;
      function finish(fn, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value);
      }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }
  function acquire(turn) {
    if (acquireFlight) return acquireFlight;
    acquireFlight = acquireInner(turn).finally(() => { acquireFlight = null; });
    return acquireFlight;
  }
  async function acquireInner(turn) {
    if (lease) return lease;
    const handle = await chats.open(client, turn.sessionId, turn.hostId);
    const record = chats.handles?.get(handle)?.record;
    let previousOwner;
    try {
      await chats.take(client, handle, (owner) => { previousOwner = owner; });
      if (record) {
        record.commanderPreviousOwner = previousOwner;
        record.commanderTurn = { commandId: turn.commandId, ownerId: client.id };
      }
      lease = { handle, record, previousOwner };
      if (disposed || state.providerTurn !== turn) { release(); throw new Error('CENTCOM turn acquisition was cancelled'); }
      return lease;
    } catch (error) { if (!chats.handles || chats.handles.has(handle)) chats.close?.(client, handle); throw error; }
  }
  function release() {
    if (!lease) return;
    const { handle, record, previousOwner } = lease;
    if (record) {
      delete record.commanderTurn;
      if (record.owner?.id === client.id && previousOwner && !previousOwner.closed && [...record.handles].some((id) => chats.handles.get(id)?.client.id === previousOwner.id)) record.owner = previousOwner;
      delete record.commanderPreviousOwner;
      chats.publish?.(record);
    }
    lease = null;
    if (!chats.handles || chats.handles.has(handle)) chats.close?.(client, handle);
  }
  function report(turn, phase) {
    if (disposed) return;
    outcome({ collection: 'provider', serverId: turn.commandId, turnId: turn.logicalTurnId, phase, hostId: turn.hostId, sessionId: turn.sessionId,
      facts: { submission: turn.receiptState || 'unknown', providerTurnId: turn.turnId || null, providerTurnCompletion: turn.terminal || 'unverified', projectAcceptance: 'unverified' }, cancellation: turn.cancelReceipt || null });
    persist();
  }
  function observeReceipt(turn, receipt) {
    if (!receipt || receipt.commandId !== turn.commandId || (receipt.sessionId && receipt.sessionId !== turn.sessionId)) throw new Error('CENTCOM receipt identity mismatch');
    turn.receiptState = receipt.state;
    const target = receipt.result?.turnId || receipt.turnId;
    if (target) {
      if (typeof target !== 'string' || (turn.turnId && turn.turnId !== target)) throw new Error('CENTCOM provider turn identity changed');
      turn.turnId = target;
    }
    if (receipt.state === 'failed' && !turn.turnId) turn.terminal = 'command_failed';
  }
  function cancel(command) {
    const turn = state.providerTurn;
    if (!turn || disposed) return Promise.resolve(null);
    turn.cancelRequested = true;
    if ((!turn.dispatchStarted || turn.terminal) && !command) return Promise.resolve(null);
    if (cancelFlight && !command) return cancelFlight;
    // Re-send cancellation with a new ID if an earlier cancellation raced the
    // send acknowledgement and was not yet bound to this provider turn.
    if (!command && turn.cancelCommand && turn.cancelForTurn === (turn.turnId || null)) return Promise.resolve(turn.cancelReceipt || null);
    turn.cancelCommand = command || { protocolVersion: 1, commandId: crypto.randomUUID(), operation: 'interrupt', sessionId: turn.sessionId, payload: {} };
    turn.cancelForTurn = turn.turnId || null;
    turn.status = 'cancelling'; persist();
    const submitted = turn.cancelCommand;
    const cancellation = { commandId: submitted.commandId, state: 'unknown' };
    (turn.cancellations ||= []).push(cancellation); persist();
    // Use the existing worker command boundary directly: an interrupt must not
    // sit behind a blocked send on the local ownership queue.
    const flight = chats.request(turn.hostId, 'command', { command: submitted }).then((receipt) => {
      if (receipt?.commandId !== submitted.commandId || receipt.sessionId !== turn.sessionId) throw new Error('CENTCOM cancellation receipt identity mismatch');
      cancellation.state = receipt.state;
      if (!disposed && state.providerTurn === turn) { turn.cancelReceipt = receipt; report(turn, 'cancellation_submitted'); }
      return receipt;
    }).finally(() => { if (cancelFlight === flight) cancelFlight = null; });
    cancelFlight = flight;
    cancelFlight.catch(() => {});
    return cancelFlight;
  }
  async function settleCancellations(turn, deadline) {
    for (const cancellation of turn.cancellations || []) {
      while (!['completed', 'failed'].includes(cancellation.state)) {
        const receipt = await wait(chats.request(turn.hostId, 'receipt', { commandId: cancellation.commandId }), deadline);
        if (receipt?.commandId !== cancellation.commandId || receipt.sessionId !== turn.sessionId) throw new Error('CENTCOM cancellation receipt identity mismatch');
        cancellation.state = receipt.state; persist();
        if (!['completed', 'failed'].includes(cancellation.state)) await wait(new Promise((r) => setTimeout(r, 100)), deadline);
      }
    }
  }
  async function consume(turn, deadline, signal) {
    const receipt = await wait(chats.request(turn.hostId, 'receipt', { commandId: turn.commandId }), deadline, signal);
    observeReceipt(turn, receipt);
    if (turn.terminal) return;
    if (!turn.turnId) return; // Never guess that command ID equals provider turn ID.
    if (turn.cancelRequested && turn.cancelForTurn !== turn.turnId) void cancel().catch(() => {});
    let page;
    do {
      page = await wait(chats.read(turn.hostId, turn.sessionId, turn.cursor, 500), deadline, signal);
      if (page.truncated) turn.historyTruncated = true;
      for (const event of page.events) {
        if (event.turnId !== turn.turnId || (event.sessionId && event.sessionId !== turn.sessionId)) continue;
        if (event.type === 'message.completed' && event.data.role === 'assistant') turn.text = event.data.text;
        if (event.type === 'usage.updated' && Number.isFinite(event.data.costUsd)) turn.costUsd = event.data.costUsd;
        if (event.type === 'turn.completed' && ['completed', 'interrupted', 'failed', 'denied'].includes(event.data.outcome)) { turn.terminal = event.data.outcome; turn.terminalDetail = event.data.detail; }
      }
      const next = page.cursor || page.events.at(-1)?.sequence || turn.cursor;
      if (page.hasMore && next <= turn.cursor) throw new Error('CENTCOM journal cursor did not advance');
      turn.cursor = next;
      persist();
    } while (page.hasMore && !turn.terminal);
  }
  function finish(turn) {
    if (!turn.terminal || disposed) return;
    state.costUsd = (state.costUsd || 0) + (turn.costUsd || 0);
    if (turn.dispatchStarted && turn.costUsd == null) state.costKnown = false;
    report(turn, 'terminal');
    state.providerTurn = null; persist(); release();
  }
  async function reconcile() {
    const turn = state.providerTurn;
    if (!turn) { release(); return true; }
    if (turn.stopCommand) return stop();
    const deadline = now() + (state.config.cancellationDeadlineSeconds || 10) * 1000;
    try {
      await wait(acquire(turn), deadline);
      if (!turn.dispatchStarted) turn.terminal = 'not_submitted';
      turn.cancelRequested = true;
      void cancel().catch(() => {});
      do {
        if (!turn.terminal) await consume(turn, deadline);
        if (turn.terminal) { await settleCancellations(turn, deadline); finish(turn); return true; }
        await wait(new Promise((r) => setTimeout(r, 100)), deadline);
      } while (!disposed && now() < deadline);
    } catch (error) { turn.error = error.message; }
    turn.status = 'uncertain';
    if (turn.dispatchStarted && turn.costUsd == null) state.costKnown = false;
    report(turn, 'uncertain');
    return false;
  }
  async function run({ session, commandId, text, signal, logicalTurnId, dispatched }) {
    if (state.providerTurn && !await reconcile()) throw new Error('Previous CENTCOM provider turn remains uncertain; retry reconciliation before starting another turn');
    if (disposed || signal.aborted) throw new Error('CENTCOM turn interrupted by Watch Officer');
    const deadline = now() + state.config.turnDeadlineSeconds * 1000;
    const turn = { hostId: session.hostId, sessionId: session.chatSessionId, commandId, logicalTurnId, status: 'submitting', cursor: 0, turnId: null, terminal: null, costUsd: null, startedAt: now() };
    state.providerTurn = turn; persist();
    try {
      const held = await wait(acquire(turn), deadline, signal);
      turn.cursor = held.record?.latestCursor || 0;
      persist();
      // Creation acknowledges acceptance before the provider is ready. Older
      // commander sessions may also still be processing bootstrap instructions.
      // Neither case is a submitted assessment or grounds for cancelling it.
      while (true) {
        const page = await wait(chats.read(turn.hostId, turn.sessionId, 0, 1), deadline, signal);
        const status = page.session?.state;
        if (status === 'idle') break;
        if (!['starting', 'running', 'waiting'].includes(status)) throw new Error(`CENTCOM provider session is ${status || 'unavailable'}; restart the session before sending`);
        await wait(new Promise((r) => setTimeout(r, 100)), deadline, signal);
      }
      if (signal.aborted) throw new Error('CENTCOM turn interrupted by Watch Officer');
      turn.dispatchStarted = true; persist();
      const receipt = await wait(chats.submit(client, held.handle, { protocolVersion: 1, commandId, operation: 'send', sessionId: turn.sessionId, payload: { text } }), deadline, signal);
      observeReceipt(turn, receipt);
      turn.status = 'running'; report(turn, 'submission'); dispatched?.(receipt);
      while (!turn.terminal) {
        await consume(turn, deadline, signal);
        if (!turn.terminal) await wait(new Promise((r) => setTimeout(r, 100)), deadline, signal);
      }
      if (turn.terminal !== 'completed') throw new Error(`Turn ended with outcome ${turn.terminal}: ${turn.terminalDetail || ''}`);
      return turn.text || '';
    } finally {
      if (!turn.dispatchStarted) turn.terminal = 'not_submitted';
      if (turn.terminal && !(turn.cancellations || []).some((c) => !['completed', 'failed'].includes(c.state))) finish(turn);
      else if (!disposed) {
        turn.cancelRequested = true;
        await reconcile();
      }
    }
  }
  async function stop(session) {
    // Reset also owns an idle session after its last turn reservation cleared.
    if (!state.providerTurn && session?.chatSessionId) {
      state.providerTurn = { hostId: session.hostId, sessionId: session.chatSessionId, commandId: crypto.randomUUID(), status: 'cancelling', cursor: 0, startedAt: now() };
      persist();
    }
    const turn = state.providerTurn;
    if (!turn) { release(); return true; }
    const deadline = now() + (state.config.cancellationDeadlineSeconds || 10) * 1000;
    try {
      await wait(acquire(turn), deadline);
      // Explicit reset retires this session permanently. A confirmed worker
      // stop fences even a send rejected before acceptance (with no receipt),
      // and late cancellations cannot affect the replacement session.
      const pendingStop = Boolean(turn.stopCommand);
      turn.stopCommand ||= { protocolVersion: 1, commandId: crypto.randomUUID(), operation: 'stop', sessionId: turn.sessionId, payload: {} };
      turn.status = 'cancelling'; persist();
      let receipt = await wait(pendingStop ? chats.request(turn.hostId, 'receipt', { commandId: turn.stopCommand.commandId }) : chats.request(turn.hostId, 'command', { command: turn.stopCommand }), deadline);
      while (true) {
        if (receipt?.commandId !== turn.stopCommand.commandId || receipt.sessionId !== turn.sessionId) throw new Error('CENTCOM stop receipt identity mismatch');
        turn.stopReceipt = receipt; persist();
        if (receipt.state === 'completed') break;
        if (receipt.state === 'failed') throw new Error(receipt.error || 'CENTCOM provider stop failed');
        await wait(new Promise((r) => setTimeout(r, 100)), deadline);
        receipt = await wait(chats.request(turn.hostId, 'receipt', { commandId: turn.stopCommand.commandId }), deadline);
      }
      turn.terminal = 'provider_stopped';
      finish(turn);
      return true;
    } catch (error) { turn.error = error.message; }
    turn.status = 'uncertain';
    report(turn, 'uncertain');
    return false;
  }
  return { run, cancel, reconcile, stop,
    dispose() {
      if (state.providerTurn) { state.providerTurn.status = 'uncertain'; state.providerTurn.cancelRequested = true; persist(); void cancel().catch(() => {}); }
      disposed = true; release();
    },
  };
}

module.exports = { createTurnLifecycle };
