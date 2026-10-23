const crypto = require('node:crypto');
const { contract, sessionId, validateCommand, validateEvent, validateCapabilities } = require('./chat-protocol.cjs');

function cursor(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid chat history cursor');
  return value;
}

// Remote processes belong to the worker. These records own only client views,
// replay cursors, and input control, so disposing every view never stops work.
class Chats {
  constructor({ remote, resolveHost, emit, interval = 750, onEvents = () => {}, onDispose = () => {} }) {
    Object.assign(this, { remote, resolveHost, emit, interval, onEvents, onDispose });
    this.sessions = new Map();
    this.handles = new Map();
    this.epochs = new Map();
  }

  request(hostId, action, args = {}) {
    return this.remote(this.resolveHost(hostId), { protocolVersion: contract.version, action, ...args });
  }

  async capabilities(hostId, prepareProvider) {
    if (prepareProvider !== undefined && !contract.providers.includes(prepareProvider)) throw new Error('Invalid provider runtime');
    const result = await this.request(hostId, 'capabilities', prepareProvider ? { prepareProvider } : {});
    if (!Array.isArray(result) || result.length !== contract.providers.length || new Set(result.map((item) => item.provider)).size !== result.length) throw new Error('Invalid provider capability response');
    return result.map(validateCapabilities);
  }

  async create(hostId, command) {
    const validated = validateCommand(command);
    if (validated.operation !== 'create') throw new Error('Expected a chat creation command');
    return this.request(hostId, 'command', { command: validated });
  }

  async list(hostId) {
    const result = await this.request(hostId, 'list');
    if (!Array.isArray(result)) throw new Error('Invalid chat session inventory');
    for (const item of result) { sessionId(item.id); validateCapabilities(item.capabilities); }
    return result;
  }

  async open(client, identifier, hostId) {
    sessionId(identifier);
    const host = this.resolveHost(hostId);
    const epoch = this.epochs.get(client.id) || 0;
    const page = await this.read(host, identifier, 0, 1);
    if (client.closed || epoch !== (this.epochs.get(client.id) || 0)) throw new Error('Client disconnected');
    const key = `${host}/${identifier}`;
    let record = this.sessions.get(key);
    if (!record) {
      record = { key, hostId: host, sessionId: identifier, session: page.session, latestCursor: page.latestCursor, retainedFrom: page.retainedFrom, owner: null, connection: 'connected', handles: new Set(), timer: null, flight: null, disposed: false, queue: Promise.resolve() };
      this.sessions.set(key, record);
    }
    const id = crypto.randomUUID();
    const handle = { id, client, record, ready: false, cursor: 0 };
    this.handles.set(id, handle);
    record.handles.add(id);
    if (!record.owner && client.id === 'desktop') record.owner = client;
    this.publish(record);
    return id;
  }

  get(client, id) {
    const handle = this.handles.get(id);
    if (client.closed || !handle || handle.client.id !== client.id) throw new Error('Chat view is disconnected');
    return handle;
  }

  state(client, id) {
    const { record } = this.get(client, id);
    return { id, sessionId: record.sessionId, controller: record.owner ? { id: record.owner.id, name: record.owner.name } : null, canControl: record.owner?.id === client.id, connection: record.connection };
  }

  publish(record) {
    for (const id of record.handles) {
      const handle = this.handles.get(id);
      if (handle && !handle.client.closed) this.emit(handle.client.id, 'chat:state', this.state(handle.client, id));
    }
  }

  async read(hostId, identifier, after = 0, limit = 200) {
    cursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > contract.limits.page) throw new Error('Invalid chat history page size');
    const page = await this.request(hostId, 'history', { sessionId: identifier, after, limit });
    if (!page || page.session?.id !== identifier || !Array.isArray(page.events) || page.events.length > limit || typeof page.hasMore !== 'boolean' || typeof page.truncated !== 'boolean' || !Number.isSafeInteger(page.retainedFrom) || page.retainedFrom < 1) throw new Error('Invalid chat history response');
    validateCapabilities(page.session.capabilities);
    let previous = after;
    for (const value of page.events) {
      validateEvent(value);
      if (value.sessionId !== identifier || value.sequence <= previous) throw new Error('Chat history sequence or session mismatch');
      previous = value.sequence;
    }
    if (cursor(page.cursor) < previous || (page.events.length && page.cursor !== previous)) throw new Error('Invalid chat replay cursor');
    if (cursor(page.latestCursor) < page.cursor || !Array.isArray(page.pendingCommands) || !Array.isArray(page.pendingRequests)) throw new Error('Invalid chat recovery metadata');
    return page;
  }

  async ready(client, id, after) {
    const handle = this.get(client, id);
    const initial = after === undefined ? Math.max(handle.record.retainedFrom - 1, handle.record.latestCursor - 200) : after;
    const page = await this.read(handle.record.hostId, handle.record.sessionId, initial);
    this.get(client, id);
    handle.cursor = page.cursor;
    handle.ready = true;
    handle.record.session = page.session;
    this.onEvents(handle.record, page.events);
    handle.record.connection = 'connected';
    this.schedule(handle.record, page.hasMore ? 0 : this.interval);
    return { ...page, state: this.state(client, id) };
  }

  history(client, id, after = 0, limit = 200) {
    const { record } = this.get(client, id);
    return this.read(record.hostId, record.sessionId, after, limit);
  }

  schedule(record, delay) {
    if (record.disposed || record.timer || record.flight || ![...record.handles].some((id) => this.handles.get(id)?.ready)) return;
    record.timer = setTimeout(() => {
      record.timer = null;
      let more = false;
      record.flight = this.poll(record).then((value) => { more = Boolean(value); }).finally(() => { record.flight = null; this.schedule(record, record.connection === 'connected' ? more ? 0 : this.interval : 2000); });
    }, delay);
    record.timer.unref?.();
  }

  async poll(record) {
    const handles = [...record.handles].map((id) => this.handles.get(id)).filter((handle) => handle?.ready);
    if (!handles.length || record.disposed) return;
    try {
      const page = await this.read(record.hostId, record.sessionId, Math.min(...handles.map((handle) => handle.cursor)));
      if (record.disposed) return;
      const restored = record.connection !== 'connected';
      record.connection = 'connected';
      record.session = page.session;
      record.latestCursor = page.latestCursor;
      record.retainedFrom = page.retainedFrom;
      this.onEvents(record, page.events);
      for (const handle of handles) {
        if (!this.handles.has(handle.id) || handle.client.closed) continue;
        const events = page.events.filter((event) => event.sequence > handle.cursor);
        const next = Math.max(handle.cursor, page.cursor);
        this.emit(handle.client.id, 'chat:events', { id: handle.id, ...page, events, cursor: next, state: this.state(handle.client, handle.id) });
        handle.cursor = next;
      }
      if (restored) this.publish(record);
      return page.hasMore;
    } catch {
      if (!record.disposed && record.connection !== 'reconnecting') { record.connection = 'reconnecting'; this.publish(record); }
    }
  }

  exclusive(record, action) {
    const flight = record.queue.then(action);
    record.queue = flight.catch(() => {});
    return flight;
  }

  take(client, id, captureOwner) {
    const { record } = this.get(client, id);
    if (record.commanderTurn && record.commanderTurn.ownerId !== client.id) return Promise.reject(new Error('CENTCOM provider turn still owns this session; reconcile cancellation before taking control'));
    return this.exclusive(record, () => {
      this.get(client, id);
      if (record.connection !== 'connected') throw new Error('Chat is reconnecting');
      if (record.commanderTurn && record.commanderTurn.ownerId !== client.id) throw new Error('CENTCOM provider turn still owns this session; reconcile cancellation before taking control');
      captureOwner?.(record.owner);
      record.owner = client;
      this.publish(record);
      return this.state(client, id);
    });
  }

  assertSessionOwner(client, identifier, hostId) {
    const record = this.sessions.get(`${this.resolveHost(hostId)}/${identifier}`);
    if (client.closed || !record || record.owner?.id !== client.id || record.connection !== 'connected') throw new Error('Open the chat and take control before changing this session');
    return record;
  }

  submit(client, id, input) {
    const { record } = this.get(client, id);
    const command = validateCommand(input);
    if (command.operation === 'create' || command.sessionId !== record.sessionId) throw new Error('Command does not target this chat view');
    if (record.commanderTurn && ['interrupt', 'stop'].includes(command.operation) &&
        (record.owner?.id === client.id || record.commanderPreviousOwner?.id === client.id)) {
      const routed = this.commandRouter?.(client, id, command, record);
      if (routed) return Promise.resolve(routed);
    }
    return this.exclusive(record, async () => {
      this.get(client, id);
      if (record.connection !== 'connected') throw new Error('Chat is reconnecting; commands are not queued');
      const canRoute = record.owner?.id === client.id ||
        (record.owner?.id === 'centcom-commander' && record.commanderPreviousOwner?.id === client.id);
      const routed = canRoute ? this.commandRouter?.(client, id, command, record) : null;
      if (record.owner?.id !== client.id && !routed) throw new Error('Take control before changing this chat');
      // Release the ownership queue before the commander acquires its temporary
      // control handle. The routed promise resolves to the real worker receipt.
      if (routed) return { routed };
      try { return await this.request(record.hostId, 'command', { command }); }
      catch (error) {
        // An SSH failure after dispatch cannot prove that the worker rejected
        // the command. Keep its identity so callers can inspect the receipt.
        Object.assign(error, { uncertain: true, commandId: command.commandId, sessionId: command.sessionId });
        throw error;
      }
    }).then((result) => result?.routed || result);
  }

  receipt(client, id, commandId) {
    const { record } = this.get(client, id);
    if (typeof commandId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(commandId)) throw new Error('Invalid chat command ID');
    return this.request(record.hostId, 'receipt', { commandId }).then((receipt) => {
      if (receipt.sessionId !== record.sessionId || receipt.commandId !== commandId) throw new Error('Receipt does not belong to this chat');
      return receipt;
    });
  }

  prune(client, id) {
    const { record } = this.get(client, id);
    return this.exclusive(record, async () => {
      this.get(client, id);
      if (record.owner?.id !== client.id || record.connection !== 'connected') throw new Error('Take control of the connected chat before removing its transcript');
      await this.request(record.hostId, 'prune', { sessionId: record.sessionId });
      // Keep view cursors monotonic; the retention boundary tells every viewer
      // to discard removed content on its next snapshot.
      const page = await this.read(record.hostId, record.sessionId);
      record.retainedFrom = page.retainedFrom;
      await this.poll(record);
      return page;
    });
  }

  close(client, id) {
    const handle = this.get(client, id);
    this.handles.delete(id);
    const record = handle.record;
    record.handles.delete(id);
    if (record.owner?.id === client.id && ![...record.handles].some((key) => this.handles.get(key)?.client.id === client.id)) record.owner = null;
    if (!record.handles.size) {
      record.disposed = true;
      clearTimeout(record.timer);
      this.sessions.delete(record.key);
      this.onDispose(record);
    } else this.publish(record);
  }

  disconnect(clientId) {
    this.epochs.set(clientId, (this.epochs.get(clientId) || 0) + 1);
    for (const handle of [...this.handles.values()]) if (handle.client.id === clientId) this.close({ id: clientId }, handle.id);
  }

  closeAll() {
    for (const clientId of new Set([...this.handles.values()].map((handle) => handle.client.id))) this.disconnect(clientId);
  }
}

module.exports = { Chats };
