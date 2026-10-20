const crypto = require('node:crypto');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const dimensions = (cols, rows) => ({ cols: Math.floor(Math.max(20, Math.min(Number(cols) || 100, 400))), rows: Math.floor(Math.max(3, Math.min(Number(rows) || 30, 150))) });

// One SSH PTY per remote session; handles belong to individual UI connections.
class Terminals {
  constructor({ spawn, configure, history, scroll, emit }) {
    Object.assign(this, { spawn, configure, history, scroll, emit });
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
    const record = { key, name, hostId, terminal, mirror, serializer, ...size, handles: new Set(), owner: null, queue: Promise.resolve(), sequence: 0, exitCode: null, scrollQueue: Promise.resolve(), disposed: false };
    this.sessions.set(key, record);
    terminal.onData((data) => {
      record.queue = record.queue.then(() => new Promise((resolve) => {
        if (record.disposed) return resolve();
        mirror.write(data, () => {
          record.sequence++;
          for (const id of record.handles) {
            const handle = this.handles.get(id);
            if (handle?.ready) this.emit(handle.client.id, 'terminal:data', { id, data, sequence: record.sequence });
          }
          resolve();
        });
      }));
    });
    terminal.onExit(({ exitCode }) => {
      record.exitCode = exitCode;
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

  get(client, id) {
    const handle = this.handles.get(id);
    if (!handle || handle.client.id !== client.id) throw new Error('Terminal is disconnected');
    return handle;
  }

  state(client, id) {
    const { record } = this.get(client, id);
    return { id, cols: record.cols, rows: record.rows, controller: record.owner ? { id: record.owner.id, name: record.owner.name } : null, canControl: record.owner?.id === client.id, exitCode: record.exitCode };
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

  async take(client, id) {
    const { record } = this.get(client, id);
    if (record.exitCode !== null) throw new Error('Terminal has exited');
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
    if (record.owner?.id !== client.id || record.exitCode !== null) return;
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
    record.control?.close();
    if (record.exitCode === null) record.terminal.kill();
    void record.queue.then(() => record.mirror.dispose());
  }

  closeAll() {
    for (const handle of [...this.handles.values()]) this.close(handle.client, handle.id);
  }
}

module.exports = { Terminals };
