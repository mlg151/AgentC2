const { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, Tray, nativeImage, powerMonitor, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { tailscaleStatus, closeAction } = require('./platform.cjs');
const { createService } = require('./service.cjs');
const { Gateway } = require('./gateway.cjs');

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
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) service?.terminals.disconnect('desktop'); });
  if (process.env.NODE_ENV === 'development') mainWindow.loadURL('http://127.0.0.1:5173');
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.on('close', (event) => {
    const action = closeAction({ quitting, remoteEnabled: gateway?.data.enabled, hasTray: Boolean(tray) });
    if (action !== 'close') { event.preventDefault(); if (action === 'minimize') mainWindow.minimize(); else mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; service?.terminals.disconnect('desktop'); });
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
  try {
    service = createService({ directory, home: app.getPath('home') });
    gateway = new Gateway({ directory, assets: path.join(__dirname, '..', 'dist'), service });
    service.events.on('client', (clientId, event, value) => {
      if (clientId !== 'desktop') return;
      if (event === 'terminal:data') send(event, value.id, value.data, value.sequence);
      else if (event === 'terminal:exit') send(event, value.id, value.code);
      else send(event, value);
    });
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
    for (const item of service.store.data.attention) notified.add(item.id);
    if (gateway.data.enabled) await gateway.start().catch((error) => { gateway.error = error.message; });
    updateTray();
  } catch (error) { startupError = `Could not open saved configuration in ${directory}: ${error.message}`; }
  function handle(name, fn) { ipcMain.handle(name, (event, ...args) => { assertSender(event); return fn(...args); }); }
  handle('state:get', () => service.store.data);
  handle('settings:save', (input) => service.saveSettings(input));
  handle('workspace:save', (input) => service.saveWorkspace(input));
  handle('session:pin', (key, pinned) => service.setSessionPinned(key, pinned));
  handle('cleanup:preview', (input) => service.cleanup.preview(input));
  handle('cleanup:execute', (token, keys) => service.cleanup.execute(token, keys));
  handle('cleanup:state', () => service.cleanup.state());
  handle('terminal:previews', (keys) => service.terminalPreviews(keys));
  handle('terminal:search', (query, keys) => service.searchHistory(query, keys));
  handle('attention:ack', (id) => service.acknowledge(id));
  handle('inventory', () => service.inventory());
  handle('health', () => service.health());
  handle('create', (input) => service.create(input));
  handle('worktrees:list', (hostId) => service.worktrees(hostId));
  handle('worktrees:archive', (hostId, operationId) => service.archiveWorktree(hostId, operationId));
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
  handle('clipboard:write', (text) => { if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid clipboard text'); clipboard.writeText(text); });
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
  void gateway?.dispose(); service?.terminals.closeAll(); tray?.destroy(); tray = null;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
