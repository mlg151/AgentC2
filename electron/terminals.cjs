const crypto = require('node:crypto');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const dimensions = (cols, rows) => ({ cols: Math.floor(Math.max(20, Math.min(Number(cols) || 100, 400))), rows: Math.floor(Math.max(3, Math.min(Number(rows) || 30, 150))) });

// One SSH PTY per remote session; handles belong to individual UI connections.
class Terminals {
  constructor({ spawn, configure, history, scroll, emit, onOutput, onDispose, platform = process.platform }) {
    Object.assign(this, { spawn, configure, history, scroll, emit, onOutput, onDispose, platform });
    this.sessions = new Map();
    this.handles = new Map();
    this.opening = new Map();
    this.epochs = new Map();
  }

  async open(client, name, hostId, cols, rows) {
    const epoch = this.epochs.get(client.id) || 0;
    const key = `${hostId}/${name}`;
    if (!this.sessions.has(key)) {
      if (!this.opening.has(key)) {
        const flight = this.create(key, name, hostId, cols, rows).finally(() => this.opening.delete(key));
        this.opening.set(key, flight);
      }
      await this.opening.get(key);
    }
    const record = this.sessions.get(key);
    if (client.closed || epoch !== (this.epochs.get(client.id) || 0)) {
      if (!record.handles.size) this.disposeRecord(record);
      throw new Error('Client disconnected');
    }
    const id = crypto.randomUUID();
    const handle = { id, client, record, ready: false };
    this.handles.set(id, handle);
    record.handles.add(id);
    if (!record.owner && client.id === 'desktop') record.owner = client;
    if (record.connection === 'reconnecting') this.reconnect(record);
    this.publish(record);
    return id;
  }

  async create(key, name, hostId, cols, rows) {
    await this.configure(name, hostId);
    const size = dimensions(cols, rows);
    const terminal = this.spawn(name, hostId, size);
    const mirror = new Terminal({ ...size, scrollback: 5000, allowProposedApi: true });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);
    const record = { key, name, hostId, terminal, mirror, serializer, ...size, handles: new Set(), owner: null, queue: Promise.resolve(), sequence: 0, exitCode: null, connection: 'connecting', reconnectAttempts: 0, reconnectTimer: null, scrollQueue: Promise.resolve(), disposed: false, activityBuckets: new Map() };
    this.sessions.set(key, record);
    this.bind(record, terminal);
  }

  bind(record, terminal) {
    // TERM is fixed to xterm-256color. tmux emits smcup (alternate screen)
    // or smkx (application keypad, also with clear-on-attach disabled) only
    // after putting its client tty into raw mode. SSH banners/PTY creation
    // are not readiness: input sent then can be flushed by tmux startup.
    // Windows ConPTY consumes both sequences while re-rendering the screen.
    // It passes through DA2 (CSI > [0] c), which tmux's tty_send_requests emits
    // after tty_start_tty. Use that boundary on Windows, including reattach;
    // console setup, titles, banners and arbitrary output still cannot unlock input.
    let startupTail = '', initialized = false, ended = false;
    terminal.onData((data) => {
      if (record.disposed || record.terminal !== terminal) return;
      this.onOutput?.(record, data);
      let becameReady = false;
      if (!initialized) {
        const startup = startupTail + data;
        initialized = startup.includes('\x1b[?1049h') || startup.includes('\x1b[?1h\x1b=') ||
          this.platform === 'win32' && /\x1b\[>0?c/.test(startup);
        startupTail = initialized ? '' : startup.slice(-16);
        becameReady = initialized;
      }
      const bucket = Math.floor(Date.now() / 10000);
      record.activityBuckets.set(bucket, (record.activityBuckets.get(bucket) || 0) + Buffer.byteLength(data));
      for (const key of record.activityBuckets.keys()) if (key < bucket - 4) record.activityBuckets.delete(key);
      record.queue = record.queue.then(() => new Promise((resolve) => {
        if (record.disposed) return resolve();
        record.mirror.write(data, () => {
          if (becameReady && !ended && !record.disposed && record.terminal === terminal && record.exitCode === null && record.connection !== 'exited') {
            record.connection = 'connected'; record.reconnectAttempts = 0;
            this.publish(record);
          }
          record.sequence++;
          for (const id of record.handles) {
            const handle = this.handles.get(id);
            if (handle?.ready) this.emit(handle.client.id, 'terminal:data', { id, data, sequence: record.sequence });
          }
          resolve();
        });
      }));
    });
    terminal.onExit(({ exitCode, signal }) => {
      ended = true;
      if (record.disposed || record.terminal !== terminal) return;
      if (exitCode === 255 || signal === 9) {
        record.connection = 'reconnecting';
        record.control?.close(); record.control = null;
        this.publish(record);
        this.reconnect(record);
        return;
      }
      record.exitCode = exitCode;
      record.connection = 'exited';
      void record.queue.then(() => {
        if (record.disposed) return;
        this.publish(record);
        for (const id of record.handles) {
          const handle = this.handles.get(id);
          if (handle?.ready) this.emit(handle.client.id, 'terminal:exit', { id, code: exitCode });
        }
      });
    });
  }

  reconnect(record) {
    if (record.disposed || !record.handles.size || record.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(record.reconnectAttempts++, 5));
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = null;
      if (record.disposed || !record.handles.size) return;
      try {
        const terminal = this.spawn(record.name, record.hostId, { cols: record.cols, rows: record.rows });
        record.terminal = terminal;
        this.bind(record, terminal);
      } catch {
        this.reconnect(record);
      }
    }, delay);
  }

  get(client, id) {
    const handle = this.handles.get(id);
    if (!handle || handle.client.id !== client.id) throw new Error('Terminal is disconnected');
    return handle;
  }

  state(client, id) {
    const { record } = this.get(client, id);
    return { id, cols: record.cols, rows: record.rows, controller: record.owner ? { id: record.owner.id, name: record.owner.name } : null, canControl: record.owner?.id === client.id, exitCode: record.exitCode, connection: record.connection };
  }
  activity(name, hostId) {
    const record = this.sessions.get(`${hostId}/${name}`);
    if (!record) return undefined;
    const bucket = Math.floor(Date.now() / 10000);
    return Array.from({ length: 5 }, (_, index) => record.activityBuckets.get(bucket - 4 + index) || 0);
  }
  async preview(name, hostId) {
    const record = this.sessions.get(`${hostId}/${name}`);
    if (!record) return null;
    await record.queue;
    if (record.disposed) return null;
    const buffer = record.mirror.buffer.active;
    return Array.from({ length: Math.min(record.rows, 30) }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) || '').join('\n').slice(0, 16000);
  }

  publish(record) {
    for (const id of record.handles) {
      const handle = this.handles.get(id);
      if (handle) this.emit(handle.client.id, 'terminal:state', this.state(handle.client, id));
    }
  }

  ready(client, id) {
    const handle = this.get(client, id);
    return handle.record.queue.then(() => {
      this.get(client, id);
      const snapshot = { text: handle.record.serializer.serialize(), sequence: handle.record.sequence, state: this.state(client, id) };
      handle.ready = true;
      return snapshot;
    });
  }

  // Internal callers without a rendered Connect button must observe the same
  // readiness boundary. This waits for attachment, never queues terminal input.
  async waitForConnection(client, id, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (this.state(client, id).connection === 'connecting') {
      if (Date.now() >= deadline) throw new Error('Terminal connection timed out');
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    const state = this.state(client, id);
    if (state.connection !== 'connected') throw new Error(state.exitCode !== null ? 'Terminal has exited' : 'Terminal is reconnecting');
  }

  async take(client, id, captureOwner) {
    const { record } = this.get(client, id);
    if (record.commanderAction && record.commanderAction.ownerId !== client.id) throw new Error('CENTCOM reviewed action owns this session until dispatch settles');
    if (record.exitCode !== null) throw new Error('Terminal has exited');
    if (record.connection !== 'connected') throw new Error(record.connection === 'connecting' ? 'Terminal is connecting' : 'Terminal is reconnecting');
    captureOwner?.(record.owner);
    record.owner = client;
    this.publish(record);
    // A previous desktop controller may have left tmux in copy mode. Finish
    // its scroll queue and return to live input before accepting phone typing.
    await this.scrollRemote(client, id, 'latest', 1);
    return this.state(client, id);
  }

  assertOwner(client, record) {
    if (record.owner?.id !== client.id) throw new Error('Take control of this session first');
    if (record.exitCode !== null) throw new Error('Terminal has exited');
    if (record.connection !== 'connected') throw new Error(record.connection === 'connecting' ? 'Terminal is connecting' : 'Terminal is reconnecting');
  }

  assertSessionOwner(client, name, hostId) {
    const record = this.sessions.get(`${hostId}/${name}`);
    if (record) {
      if (record.owner?.id !== client.id) throw new Error('Take control of this session first');
    } else if (client.id !== 'desktop') throw new Error('Open the session and take control first');
  }

  async write(client, id, data) {
    const { record } = this.get(client, id);
    this.assertOwner(client, record);
    if (typeof data !== 'string' || data.length > 1_000_000) throw new Error('Terminal input exceeds 1 MB');
    await record.scrollQueue;
    if (record.historyActive) await this.scrollRemote(client, id, 'latest', 1);
    this.get(client, id);
    this.assertOwner(client, record);
    record.terminal.write(data);
  }

  resize(client, id, cols, rows) {
    const { record } = this.get(client, id);
    if (record.owner?.id !== client.id || record.exitCode !== null || record.connection !== 'connected') return;
    const size = dimensions(cols, rows);
    if (size.cols === record.cols && size.rows === record.rows) return;
    Object.assign(record, size);
    record.queue = record.queue.then(() => {
      if (record.disposed) return;
      record.mirror.resize(size.cols, size.rows);
      record.terminal.resize(size.cols, size.rows);
      this.publish(record);
    });
  }

  retained(client, id) {
    const { record } = this.get(client, id);
    return this.history(record.name, record.hostId);
  }

  scrollRemote(client, id, direction, lines) {
    const { record } = this.get(client, id);
    // Phone history never invokes this method; desktop scrolls require control.
    this.assertOwner(client, record);
    if (!['up', 'down', 'latest'].includes(direction)) throw new Error('Invalid scroll direction');
    const operation = record.scrollQueue.then(() => {
      this.get(client, id);
      this.assertOwner(client, record);
      return this.scroll(record, direction, Math.max(1, Math.min(Number(lines) || 15, 300)));
    });
    record.scrollQueue = operation.catch(() => {});
    return operation;
  }

  close(client, id) {
    const handle = this.get(client, id);
    const record = handle.record;
    this.handles.delete(id);
    record.handles.delete(id);
    if (record.owner?.id === client.id && ![...record.handles].some((key) => this.handles.get(key)?.client.id === client.id)) record.owner = null;
    if (!record.handles.size) {
      this.disposeRecord(record);
    } else this.publish(record);
  }

  disconnect(clientId) {
    this.epochs.set(clientId, (this.epochs.get(clientId) || 0) + 1);
    for (const handle of [...this.handles.values()]) if (handle.client.id === clientId) this.close(handle.client, handle.id);
  }

  disposeRecord(record) {
    this.sessions.delete(record.key);
    record.disposed = true;
    this.onDispose?.(record);
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    record.control?.close();
    if (record.exitCode === null) record.terminal.kill();
    void record.queue.then(() => record.mirror.dispose());
  }

  closeAll() {
    for (const handle of [...this.handles.values()]) this.close(handle.client, handle.id);
  }
}

module.exports = { Terminals };
