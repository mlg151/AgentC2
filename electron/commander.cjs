const crypto = require('node:crypto');

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
      await views.take(client, handle, (owner) => { previous = owner; });
      return await fn(handle);
    } finally {
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
    // The private capability is checked by deleteSession; no impersonated desktop.
    commanderDelete: (client, key) => deleteSession(client, key, true),
    chatCommand: (client, handle, unit, operation, payload) => chats.submit(client, handle, {
      protocolVersion: 1, commandId: crypto.randomUUID(), operation, sessionId: unit.chatSessionId, payload,
    }),
    terminalInput: async (client, handle, value) => {
      await terminals.write(client, handle, value + '\r');
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
