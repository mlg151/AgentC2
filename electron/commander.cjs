const crypto = require('node:crypto');
const { redact, bounded } = require('./centcom-contract.cjs');

// Internal only: never exposed through preload or the companion RPC catalog.
function commanderFacade({ chats, terminals, action, deleteSession, interruptFault, ...services }) {
  async function commanderControl(client, unit, fn) {
    const views = unit.transport === 'chat' ? chats : terminals;
    const key = unit.transport === 'chat' ? `${unit.hostId}/${unit.chatSessionId}` : `${unit.hostId}/${unit.id || unit.name}`;
    let previous = views.sessions.get(key)?.owner;
    let handle, record;
    try {
      handle = unit.transport === 'chat'
        ? await chats.open(client, unit.chatSessionId, unit.hostId)
        : await terminals.open(client, unit.id || unit.name, unit.hostId, 120, 32);
      record = views.get(client, handle).record;
      if (views === terminals && record.connection === 'connecting') await terminals.waitForConnection(client, handle);
      await views.take(client, handle, (owner) => {
        previous = owner;
        record.commanderAction = { ownerId: client.id, previousControllerId: owner?.id || null };
      });
      return await fn(handle, { key: unit.key, previousControllerId: previous?.id || null });
    } finally {
      if (record?.commanderAction?.ownerId === client.id) delete record.commanderAction;
      if (record && record.owner?.id === client.id && previous && !previous.closed &&
          [...record.handles].some((id) => views.handles.get(id)?.client.id === previous.id)) {
        record.owner = previous;
        views.publish(record);
      }
      if (handle && views.handles.has(handle)) views.close(client, handle);
    }
  }
  return {
    ...services, action, interruptFault, commanderControl,
    commanderLaunchPaths: async (hostId, cwd, paths) => {
      const result = await services.runRemote({ action: 'launch_paths', cwd: cwd || '', paths }, services.getHost(hostId).id);
      if (typeof result?.cwd !== 'string' || !result.cwd.startsWith('/') || !Array.isArray(result.paths) || result.paths.length !== paths.length || result.paths.some((p) => typeof p !== 'string' || !p.startsWith('/'))) throw new Error('Launch path identity is unavailable');
      return result;
    },
    commanderArtifact: async ({ hostId, operationId, path, revision, offset = 0, limit = 16000 }) => {
      if (!/^[a-f0-9]{32}$/.test(operationId || '') || typeof path !== 'string' || !path || path.length > 4096 || (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000) throw new Error('Invalid artifact inspection input');
      const result = await services.runRemote({ action: 'artifact_read', operationId, path, ...(revision ? { revision } : {}) }, services.getHost(hostId).id);
      if (typeof result?.text !== 'string' || result.text.length > 256000) throw new Error('Invalid artifact readback');
      const text = redact(result.text);
      return { path: result.path, revision: result.revision, sizeBytes: result.sizeBytes, text: text.slice(offset, offset + limit), offset, nextOffset: Math.min(text.length, offset + limit), truncated: offset + limit < text.length, redacted: text !== result.text, offsets: 'characters in redacted text; supply revision on continuation' };
    },
    commanderCapabilities: (hostId) => chats.capabilities(hostId),
    commanderInspection: async (unit, commandId) => {
      if (commandId !== undefined && (typeof commandId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(commandId))) throw new Error('Invalid chat command ID');
      const views = unit.transport === 'chat' ? chats : terminals;
      const key = unit.transport === 'chat' ? `${unit.hostId}/${unit.chatSessionId}` : `${unit.hostId}/${unit.id || unit.name}`;
      const owner = views.sessions.get(key)?.owner;
      const ownership = { status: 'reported', controller: owner ? { id: owner.id, name: owner.name } : null };
      if (unit.transport !== 'chat' || !unit.chatSessionId || unit.stale || unit.missing) return { ownership, status: unit.stale || unit.missing ? 'stale' : 'unsupported' };
      // Reading a journal never opens a control handle or steals ownership.
      const head = await chats.read(unit.hostId, unit.chatSessionId, 0, 1);
      const tail = await chats.read(unit.hostId, unit.chatSessionId, Math.max(head.retainedFrom - 1, head.latestCursor - 100), 100);
      const task = [...tail.events].reverse().find((e) => e.type === 'message.completed' && e.data.role === 'user');
      let command;
      if (commandId) {
        const receipt = await chats.request(unit.hostId, 'receipt', { commandId });
        if (receipt.commandId !== commandId || receipt.sessionId !== unit.chatSessionId) throw new Error('Receipt does not belong to this unit');
        const turnId = receipt.result?.turnId || null;
        const terminal = turnId && tail.events.findLast((event) => event.sessionId === unit.chatSessionId && event.turnId === turnId && event.type === 'turn.completed');
        command = { status: 'reported', receipt: bounded(receipt, 4000), facts: { submission: receipt.state, commandId, sessionId: unit.chatSessionId, providerTurnId: turnId,
          providerTurnCompletion: terminal?.data.outcome || 'unverified', projectAcceptance: 'unverified' },
          evidence: terminal ? { sequence: terminal.sequence, timestamp: terminal.timestamp } : null,
          coverage: 'Terminal evidence covers only this inspection journal window; an absent event is not proof of pending or failed execution.' };
      }
      return { ownership, capabilities: tail.session.capabilities, pendingRequests: tail.pendingRequests, sessionState: tail.session.state, sampledAt: new Date().toISOString(),
        ...(command ? { command } : {}),
        currentTask: task ? { status: 'reported', text: task.data.text, turnId: task.turnId, sourceTimestamp: task.timestamp } : { status: 'unknown', reason: 'No user task in the retained journal tail' },
        journal: { cursor: tail.cursor, latestCursor: tail.latestCursor, retainedFrom: tail.retainedFrom, truncated: tail.truncated || tail.retainedFrom > 1 || tail.latestCursor > 100, events: tail.events } };
    },
    // The private capability is checked by deleteSession; no impersonated desktop.
    commanderDelete: (client, key) => deleteSession(client, key, true),
    chatCommand: (client, handle, unit, operation, payload) => chats.submit(client, handle, {
      protocolVersion: 1, commandId: crypto.randomUUID(), operation, sessionId: unit.chatSessionId, payload,
    }),
    terminalInput: async (client, handle, value) => {
      // A temporary commander view closes immediately after dispatch. A PTY
      // write only queues bytes locally and can be truncated by that close.
      await terminals.write(client, handle, value + '\r', { confirmed: true });
      return { delivery: 'terminal_input_written', taskCompletion: 'unverified' };
    },
  };
}

function routeCommanderCommands(chats, centcom) {
  chats.commandRouter = (client, id, command, record) => {
    if (client.id === 'centcom-commander' || !centcom.isCommander(record.hostId, record.sessionId)) return null;
    return centcom.submitCommand(client, id, command, record);
  };
}

module.exports = { commanderFacade, routeCommanderCommands };
