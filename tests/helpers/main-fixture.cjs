const { EventEmitter } = require('node:events');
const { loadCommonJs } = require('./load-commonjs.cjs');

async function mainFixture(options = {}) {
  const state = { calls: [], windows: [], menus: [], notifications: [], trays: [], timers: [], handlers: new Map(), png: null, ...options };
  const background = new Set(['service.inventory', 'service.health', 'service.cleanup.runDue', 'peer.start', 'gateway.start', 'gateway.configure']);
  function record(name, args) {
    state.calls.push([name, ...args]);
    if (state.failPath === name) throw state.failure;
    if (state.rejectBackground && background.has(name)) return Promise.reject(Error('Fixture unavailable'));
    if (name === 'service.inventory') return Promise.resolve({ sessions: [{ key: 'host/tmux:managed', kind: 'managed' }, { key: 'host/tmux:external', kind: 'external-tmux' }] });
    if (name === 'service.openDevUrl') return 'http://127.0.0.1:32123/fixture';
    if (name === 'service.uploadClipboardImage') return '/private/fixture.png';
    if (name === 'service.hostId') return 'resolved-host';
    if (name === 'service.terminals.get') return { record: state.record };
    const value = { method: name, args };
    return background.has(name) ? Promise.resolve(value) : value;
  }
  function methods(prefix, properties = {}) {
    return new Proxy(properties, { get(target, key) {
      if (typeof key !== 'string' || key in target) return target[key];
      return target[key] = (...args) => record(prefix + '.' + key, args);
    } });
  }
  const data = { settings: { notifications: true }, attention: [{ id: 'old' }] };
  state.record = {};
  const service = methods('service', { events: new EventEmitter(), store: { data }, ...Object.fromEntries(['terminals', 'chats', 'cleanup', 'specops', 'centcom', 'exercises', 'tunnels'].map((key) => [key, methods('service.' + key, { handles: new Map() })])) });
  state.service = service;
  const peer = methods('peer', new EventEmitter());
  const gateway = methods('gateway', { data: { enabled: Boolean(options.remoteEnabled) }, sockets: new Map([[1, 'socket-one'], [2, 'socket-two']]) });
  state.peer = peer; state.gateway = gateway;
  gateway.configure = async (input) => { record('gateway.configure', [input]); if (state.gatewayFailure) throw Error('Configuration unavailable'); gateway.data = input; return input; };
  class Window extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.destroyed = false; this.minimized = false;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {},
        send: (...args) => record('window.send', args),
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
        setIgnoreMenuShortcuts: (ignore) => { this.ignoreShortcuts = ignore; },
        sendInputEvent: (input) => { record('window.input', [input]); },
      });
      state.windows.push(this);
    }
    getSize() { return [1440, 900]; }
    getContentSize() { return [1420, 860]; }
    setMinimumSize(...size) { this.minimumSize = size; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.restored = true; }
    minimize() { this.minimized = true; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadFile(...args) { this.loaded = ['file', ...args]; return Promise.resolve(); }
    loadURL(...args) { this.loaded = ['url', ...args]; return Promise.resolve(); }
  }
  class FixtureNotification extends EventEmitter {
    static isSupported() { return state.notificationsSupported !== false; }
    constructor(input) { super(); this.input = input; state.notifications.push(this); }
    show() { this.shown = true; }
  }
  class FixtureTray extends EventEmitter {
    constructor(image) { super(); if (state.trayFailure) throw Error('No tray host'); this.image = image; state.trays.push(this); }
    destroy() { this.destroyed = true; }
    setToolTip(text) { if (state.tooltipFailure) throw Error('Tray initialization unavailable'); this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
  }
  let ready;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: Boolean(options.packaged),
    getPath: (name) => '/fixture/' + name,
    getVersion: () => '0.4.11',
    quit: () => { state.quit = true; },
    setAppUserModelId: (id) => { state.appId = id; },
    dock: { setMenu: (menu) => { state.dock = menu; } },
    whenReady: () => ({ then: (callback) => { ready = Promise.resolve().then(callback); } }),
  });
  const powerMonitor = new EventEmitter();
  const Menu = {
    buildFromTemplate: (template) => {
      const menu = { template, popup: ({ callback }) => { if (state.menuChoice === undefined) callback(); else template[state.menuChoice].click(); } };
      state.menus.push(menu); return menu;
    },
    setApplicationMenu: (menu) => { state.appMenu = menu; },
  };
  const nativeImage = { createFromPath: (file) => ({ file, resize: (size) => ({ file, size }), setTemplateImage: (value) => { state.templateImage = value; } }) };
  const shell = { openExternal: async (url) => { record('shell.openExternal', [url]); if (state.linkFailure) throw Error('Browser unavailable'); } };
  const clipboard = { readText: () => 'fixture text', writeText: (text) => { state.clipboard = text; } };
  const updates = methods('updates');
  let createOptions;
  loadCommonJs('electron/main.cjs', {
    electron: { app, BrowserWindow: Window, clipboard, ipcMain: { handle: (name, handler) => state.handlers.set(name, handler) }, Menu, Notification: FixtureNotification, Tray: FixtureTray, nativeImage, powerMonitor, shell },
    'node:fs': { existsSync: (file) => (options.existing || []).includes(file), readFileSync: () => { if (options.missingBuild) throw Error('No build metadata'); return '{"revision":"fixture-revision"}'; } },
    './service.cjs': { createService: (input) => { state.serviceOptions = input; if (options.startupFailure) throw Error('Invalid saved settings'); return service; } },
    './platform.cjs': { closeAction: () => state.closeAction || 'close', tailscaleStatus: () => ({ installed: true }) },
    './updates.cjs': { createMainCheck: (revision) => ({ revision }), createUpdates: (input) => { createOptions = input; return updates; } },
    './gateway.cjs': { Gateway: function () { return gateway; } },
    './peer-sync.cjs': { PeerSync: function () { return peer; } },
    './clipboard-image.cjs': { readClipboardPng: async () => state.png },
    './source-updater.cjs': { resumeSourceUpdate: () => Boolean(options.resumeUpdate), SourceUpdater: function (input) { state.sourceUpdater = input; } },
    './mac-update.cjs': { createMacUpdater: () => ({ mac: true }) },
    'electron-updater': { autoUpdater: { native: true } },
  }, {
    process: { platform: options.platform || 'linux', env: { NODE_ENV: options.development ? 'development' : 'production', ...options.env }, argv: options.allowResume ? [] : ['--no-source-update'] },
    setInterval: (callback, delay) => { const timer = { callback, delay }; state.timers.push(timer); return timer; },
    clearInterval: (timer) => { if (timer) timer.cleared = true; },
    console: { warn: (...args) => { record('console.warn', args); }, error: (...args) => { record('console.error', args); } },
  });
  await ready;
  await Promise.resolve();
  state.app = app; state.power = powerMonitor; state.updateOptions = createOptions;
  state.event = (window = state.windows.find((candidate) => candidate.settings.title === 'AgentC2' && !candidate.destroyed) || state.windows[0]) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  state.invoke = (name, ...args) => state.handlers.get(name)(state.event(), ...args);
  state.flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  return state;
}
module.exports = { mainFixture };
