const { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, Tray, nativeImage, powerMonitor, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { tailscaleStatus, closeAction } = require('./platform.cjs');
const { createService } = require('./service.cjs');
const { createUpdates, createMainCheck } = require('./updates.cjs');
const { Gateway } = require('./gateway.cjs');
const { readClipboardPng } = require('./clipboard-image.cjs');

const desktop = { id: 'desktop', name: 'Desktop' };
let mainWindow, service, gateway, tray, monitor, healthMonitor, cleanupMonitor;
let quitting = false;
let startupError = '';
const icon = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png');
function send(event, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, ...args);
}
function showWindow() { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
function assertSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Untrusted window');
  if (startupError) throw new Error(startupError);
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 940, minHeight: 650, backgroundColor: '#0c151b', title: 'AgentC2', icon, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (['http:', 'https:'].includes(target.protocol)) void shell.openExternal(target.href).catch((error) => console.error('Could not open browser link:', error.message));
    } catch { /* Reject malformed URLs from terminal output. */ }
    return { action: 'deny' };
  });
  // Let Chromium and xterm handle editing shortcuts instead of menu accelerators.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    mainWindow.webContents.setIgnoreMenuShortcuts(Boolean((input.meta || input.control) && ['c', 'v', 'f', 'k'].includes(input.key.toLowerCase())));
  });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { service?.terminals.disconnect('desktop'); service?.chats.disconnect('desktop'); } });
  if (process.env.NODE_ENV === 'development') mainWindow.loadURL('http://127.0.0.1:5173');
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.on('close', (event) => {
    const action = closeAction({ quitting, remoteEnabled: gateway?.data.enabled, hasTray: Boolean(tray) });
    if (action !== 'close') { event.preventDefault(); if (action === 'minimize') mainWindow.minimize(); else mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; service?.terminals.disconnect('desktop'); service?.chats.disconnect('desktop'); });
}
function updateTray() {
  if (!gateway?.data.enabled) { tray?.destroy(); tray = null; return; }
  if (!tray) {
    try {
      const image = nativeImage.createFromPath(process.platform === 'darwin' ? path.join(__dirname, '..', 'assets', 'trayTemplate.png') : icon);
      if (process.platform === 'darwin') image.setTemplateImage(true);
      tray = new Tray(process.platform === 'linux' ? image.resize({ width: 22, height: 22 }) : image);
      tray.setToolTip('AgentC2 — remote access enabled');
      if (process.platform !== 'darwin') { tray.on('click', showWindow); tray.on('double-click', showWindow); }
    } catch (error) {
      tray?.destroy(); tray = null;
      console.warn('Tray unavailable; use the taskbar or Dock to reopen AgentC2:', error.message);
      return;
    }
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AgentC2', click: showWindow },
    { label: 'Disable remote access', click: () => { void gateway.configure({ ...gateway.data, enabled: false }).then(() => { updateTray(); showWindow(); send('remote:updated', gateway.status()); }).catch((error) => { gateway.error = error.message; showWindow(); }); } },
    { type: 'separator' }, { label: 'Quit AgentC2', click: () => app.quit() },
  ]));
}
function installMenu() {
  const mac = process.platform === 'darwin';
  const shortcut = (key) => {
    showWindow();
    for (const type of ['keyDown', 'keyUp']) mainWindow.webContents.sendInputEvent({ type, keyCode: key, modifiers: [mac ? 'meta' : 'control'] });
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open AgentC2', click: showWindow },
      { label: 'Quick switch', accelerator: 'CommandOrControl+K', click: () => shortcut('K') },
      { label: 'Find in terminal history', accelerator: 'CommandOrControl+F', click: () => shortcut('F') },
      { type: 'separator' }, { role: mac ? 'close' : 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.agentc2.desktop');
  installMenu();
  if (process.platform === 'darwin') app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'Open AgentC2', click: showWindow }]));
  // Keep existing desktop settings and paired devices after the product rename.
  const legacyDirectories = ['agent-hq', 'Agent HQ'].map((name) => path.join(app.getPath('appData'), name));
  const legacyDirectory = legacyDirectories.find((candidate) => fs.existsSync(path.join(candidate, 'workspace.json')));
  const directory = process.env.AGENTC2_DATA_DIR || process.env.AGENT_HQ_DATA_DIR || (fs.existsSync(path.join(app.getPath('userData'), 'workspace.json')) ? app.getPath('userData') : legacyDirectory || app.getPath('userData'));
  let buildInfo = {};
  try { buildInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'build-info.json'), 'utf8')); } catch { /* Source archive without build metadata. */ }
  if (!app.isPackaged && process.env.NODE_ENV !== 'development' && !process.argv.includes('--no-source-update') && require('./source-updater.cjs').resumeSourceUpdate({ directory: path.join(directory, 'source-updates'), revision: buildInfo.revision, app })) return;
  try {
    service = createService({ directory, home: app.getPath('home'), specopsDirectory: process.env.AGENTC2_DATA_DIR || process.env.AGENT_HQ_DATA_DIR ? undefined : path.join(app.getPath('home'), '.agentc2', 'specops'), centcomDirectory: process.env.AGENTC2_DATA_DIR || process.env.AGENT_HQ_DATA_DIR ? undefined : path.join(app.getPath('home'), '.agentc2', 'centcom') });
    gateway = new Gateway({ directory, assets: path.join(__dirname, '..', 'dist'), service });
    service.events.on('client', (clientId, event, value) => {
      if (clientId !== 'desktop') return;
      if (event === 'terminal:data') send(event, value.id, value.data, value.sequence);
      else if (event === 'terminal:exit') send(event, value.id, value.code);
      else send(event, value);
    });
    service.events.on('tunnel:updated', ({ sessionKey, urls }) => send('tunnel:updated', sessionKey, urls));
    service.events.on('inventory:updated', (value) => {
      send('inventory:updated', value);
      const unread = value.attention.filter((item) => !item.acknowledged);
      if (service.store.data.settings.notifications && Notification.isSupported()) {
        for (const item of unread) {
          if (notified.has(item.id)) continue;
          notified.add(item.id);
          const notification = new Notification({ title: `AgentC2: ${item.kind === 'input' ? 'Input may be needed' : item.kind}`, body: item.title });
          notification.on('click', () => { showWindow(); send('attention:open', item.sessionKey); }); notification.show();
        }
      }
    });
    service.events.on('health:updated', (value) => send('health:updated', value));
    service.events.on('session:pinned', (key, pinned) => send('session:pinned', key, pinned));
    service.events.on('sessions:deleted', (keys) => send('sessions:deleted', keys));
    service.events.on('centcom:updated', (value) => send('centcom:updated', value));
    for (const item of service.store.data.attention) notified.add(item.id);
    if (gateway.data.enabled) await gateway.start().catch((error) => { gateway.error = error.message; });
    updateTray();
  } catch (error) { startupError = `Could not open saved configuration in ${directory}: ${error.message}`; }
  function handle(name, fn) { ipcMain.handle(name, (event, ...args) => { assertSender(event); return fn(...args); }); }
  handle('state:get', () => service.store.data);
  handle('settings:save', (input) => service.saveSettings(input));
  handle('oporder:preview', (order) => service.previewOpOrder(order));
  handle('oporder:enroll', (order, revision) => service.enrollOpOrder(order, revision));
  handle('sitrep:preview', (input) => service.previewSitrep(desktop, input));
  handle('sitrep:launch', (input) => service.launchSitrep(desktop, input));
  handle('github:request', (input) => service.github(input));
  handle('specops:list', () => service.specops.list());
  handle('specops:definition', () => service.specops.definition());
  handle('specops:configure', (yaml) => service.specops.configure(yaml));
  handle('specops:launch', (input) => service.specops.launch(input));
  handle('specops:control', (id, action) => service.specops.control(id, action));
  handle('centcom:state', () => service.centcom.state());
  handle('centcom:configure', (input) => service.centcom.configure(input));
  handle('centcom:start', (prompt) => service.centcom.start(prompt));
  handle('centcom:submit', (text) => service.centcom.submit(text));
  handle('centcom:interrupt', () => service.centcom.interrupt());
  handle('centcom:pause', (paused) => service.centcom.pause(paused));
  handle('centcom:reset', () => service.centcom.resetSession());
  handle('centcom:decide-directive', (id, decision) => service.centcom.decideDirective(id, decision));
  handle('centcom:decide-all-directives', (decision) => service.centcom.decideAllDirectives(decision));
  handle('centcom:apply-automation', (id, decision) => service.centcom.applyAutomation(id, decision));
  handle('exercise:list', () => service.exercises.list());
  handle('exercise:capabilities', (hostId) => service.exercises.capabilities(hostId));
  handle('exercise:create', (input) => service.exercises.create(input));
  handle('exercise:retry', (id) => service.exercises.launch(id));
  handle('exercise:cancel', (id) => service.exercises.cancel(id));
  handle('exercise:complete', (id, contestantId) => service.exercises.markComplete(id, contestantId));
  handle('exercise:inspect', (id, contestantId, verify) => service.exercises.inspect(id, contestantId, verify));
  handle('exercise:preview', (id, contestantId) => service.exercises.preview(id, contestantId));
  handle('exercise:promote', (id, contestantId, revision) => service.exercises.promote(id, contestantId, revision));
  handle('flash:list', () => service.flashQueue());
  handle('flash:decide', (input) => service.flashDecide(desktop, input));
  handle('fault:interrupt-all', () => service.interruptFaults(desktop));
  handle('fault:reset', (key) => service.resetFault(key));
  handle('workspace:save', (input) => service.saveWorkspace(input));
  handle('session:pin', (key, pinned) => service.setSessionPinned(key, pinned));
  const updater = !app.isPackaged
    ? new (require('./source-updater.cjs').SourceUpdater)({ revision: buildInfo.revision, directory: path.join(directory, 'source-updates'), app })
    : process.platform === 'darwin' ? require('./mac-update.cjs').createMacUpdater(app) : require('electron-updater').autoUpdater;
  const updates = createUpdates({ updater, version: app.getVersion(), source: !app.isPackaged, checkMain: app.isPackaged ? createMainCheck(buildInfo.revision) : undefined, notify: (state) => send('updates:state', state) });
  handle('updates:state', () => updates.state());
  handle('updates:check', () => updates.check());
  handle('updates:download', () => updates.download());
  handle('updates:install', () => updates.install());
  handle('session:rename', (key, title) => service.renameSession(key, title));
  handle('session:delete', (key) => service.deleteSession(desktop, key));
  handle('cleanup:preview', (input) => service.cleanup.preview(input));
  handle('cleanup:execute', (token, keys) => service.cleanup.execute(token, keys));
  handle('cleanup:state', () => service.cleanup.state());
  handle('terminal:previews', (keys) => service.terminalPreviews(keys));
  handle('terminal:search', (query, keys) => service.searchHistory(query, keys));
  handle('attention:ack', (id) => service.acknowledge(id));
  handle('inventory', () => service.inventory());
  handle('health', () => service.health());
  handle('create', (input) => service.create(input));
  handle('chat:capabilities', (hostId) => service.chats.capabilities(hostId));
  handle('chat:open', (id, hostId) => service.chats.open(desktop, id, hostId));
  handle('chat:ready', (id, after) => service.chats.ready(desktop, id, after));
  handle('chat:history', (id, after, limit) => service.chats.history(desktop, id, after, limit));
  handle('chat:take', (id) => service.chats.take(desktop, id));
  handle('chat:submit', (id, command) => service.chats.submit(desktop, id, command));
  handle('chat:receipt', (id, commandId) => service.chats.receipt(desktop, id, commandId));
  handle('chat:prune', (id) => service.chats.prune(desktop, id));
  handle('chat:close', (id) => { if (service.chats.handles.has(id)) service.chats.close(desktop, id); });
  handle('worktrees:list', (hostId) => service.worktrees(hostId));
  handle('worktrees:archive', (hostId, operationId) => service.archiveWorktree(hostId, operationId));
  handle('diff:files', (input) => service.diffRequest(desktop, input, 'diff_files'));
  handle('diff:detail', (input) => service.diffRequest(desktop, input, 'diff_detail'));
  handle('diff:hunk', (input) => service.diffRequest(desktop, input, 'diff_hunk'));
  for (const action of ['interrupt', 'stop']) handle(action, (name, hostId) => service.action(desktop, action, name, hostId));
  handle('terminal:open', (name, cols, rows, hostId) => service.terminals.open(desktop, name, service.hostId(hostId), cols, rows));
  handle('terminal:ready', (id) => service.terminals.ready(desktop, id));
  handle('terminal:state', (id) => service.terminals.state(desktop, id));
  handle('terminal:take', (id) => service.terminals.take(desktop, id));
  handle('terminal:write', (id, data) => service.terminals.write(desktop, id, data));
  handle('terminal:resize', (id, cols, rows) => service.terminals.resize(desktop, id, cols, rows));
  handle('terminal:close', (id) => { if (service.terminals.handles.has(id)) service.terminals.close(desktop, id); });
  handle('terminal:history', (id) => service.terminals.retained(desktop, id));
  handle('terminal:scroll', (id, direction, lines) => service.terminals.scrollRemote(desktop, id, direction, lines));
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:for-terminal', async (id) => {
    const { record } = service.terminals.get(desktop, id);
    service.terminals.assertOwner(desktop, record);
    const png = await readClipboardPng(clipboard, nativeImage);
    if (png) return { kind: 'image', path: await service.uploadClipboardImage(desktop, id, png) };
    return { kind: 'text', text: await clipboard.readText() };
  });
  handle('tunnel:list', (sessionKey) => service.devUrls(sessionKey));
  handle('tunnel:open', async (id, url) => {
    const localUrl = await service.openDevUrl(desktop, id, url);
    await shell.openExternal(localUrl);
    return localUrl;
  });
  handle('clipboard:write', (text) => { if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid clipboard text'); return clipboard.writeText(text); });
  handle('terminal:menu', (hasSelection) => new Promise((resolve) => {
    Menu.buildFromTemplate([
      { label: 'Copy', accelerator: 'CommandOrControl+Shift+C', enabled: Boolean(hasSelection), click: () => resolve('copy') },
      { label: 'Paste', accelerator: 'CommandOrControl+Shift+V', click: () => resolve('paste') },
      { type: 'separator' }, { label: 'Back to latest', click: () => resolve('latest') },
    ]).popup({ window: mainWindow, callback: () => resolve(null) });
  }));
  handle('remote:status', () => gateway.status());
  handle('remote:save', async (input) => { const result = await gateway.configure(input); updateTray(); send('remote:updated', result); return result; });
  handle('remote:pair', () => gateway.pair());
  handle('remote:revoke', (id) => gateway.revoke(id));
  handle('remote:tailscale', tailscaleStatus);
  createWindow();
  if (!startupError) {
    monitor = setInterval(() => { void service.inventory().catch(() => {}); }, 15000);
    healthMonitor = setInterval(() => { void service.health().catch(() => {}); }, 5000);
    cleanupMonitor = setInterval(() => { void service.cleanup.runDue().catch(() => {}); }, 60000);
    void service.cleanup.runDue().catch(() => {});
    powerMonitor.on('resume', () => { void service.inventory().catch(() => {}); void service.health().catch(() => {}); });
    powerMonitor.on('suspend', () => { for (const record of [...gateway.sockets.values()]) gateway.drop(record, 4004, 'Desktop sleeping'); });
  }
  app.on('activate', showWindow);
});
const notified = new Set();
app.on('before-quit', () => {
  quitting = true;
  clearInterval(monitor); clearInterval(healthMonitor); clearInterval(cleanupMonitor);
  service?.specops.dispose(); service?.centcom.dispose(); void gateway?.dispose(); service?.terminals.closeAll(); service?.chats.closeAll(); tray?.destroy(); tray = null;
  service?.tunnels.closeAll();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
