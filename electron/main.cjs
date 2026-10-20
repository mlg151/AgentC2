const { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, Tray, powerMonitor, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { createService } = require('./service.cjs');
const { Gateway } = require('./gateway.cjs');

const desktop = { id: 'desktop', name: 'Desktop' };
let mainWindow, service, gateway, tray, monitor, healthMonitor;
let quitting = false;
let startupError = '';
const icon = path.join(__dirname, '..', 'assets', 'app-icon.ico');
function send(event, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, ...args);
}
function showWindow() { if (!mainWindow) createWindow(); mainWindow.show(); mainWindow.focus(); }
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
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) service?.terminals.disconnect('desktop'); });
  if (process.env.NODE_ENV === 'development') mainWindow.loadURL('http://127.0.0.1:5173');
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.on('close', (event) => {
    if (!quitting && gateway?.data.enabled && tray) { event.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; service?.terminals.disconnect('desktop'); });
}
function updateTray() {
  if (!gateway?.data.enabled) { tray?.destroy(); tray = null; return; }
  if (!tray) { tray = new Tray(icon); tray.setToolTip('AgentC2 — remote access enabled'); tray.on('double-click', showWindow); }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AgentC2', click: showWindow },
    { label: 'Disable remote access', click: () => { void gateway.configure({ ...gateway.data, enabled: false }).then(() => { updateTray(); showWindow(); send('remote:updated', gateway.status()); }).catch((error) => { gateway.error = error.message; showWindow(); }); } },
    { type: 'separator' }, { label: 'Quit AgentC2', click: () => app.quit() },
  ]));
}
function tailscaleStatus() {
  const binary = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe') : 'tailscale';
  return new Promise((resolve) => {
    execFile(binary, ['status', '--json'], { windowsHide: true, timeout: 8000, maxBuffer: 2_000_000 }, (error, stdout) => {
      try {
        const state = JSON.parse(stdout);
        resolve({ installed: true, state: state.BackendState, url: state.Self?.DNSName ? `https://${state.Self.DNSName.replace(/\.$/, '')}` : '', error: error ? 'Tailscale needs attention' : '' });
      } catch { resolve({ installed: error?.code !== 'ENOENT', state: 'Unavailable', url: '', error: 'Install Tailscale and sign in on your PC and phone.' }); }
    });
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.agentc2.desktop');
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
    for (const item of service.store.data.attention) notified.add(item.id);
    if (gateway.data.enabled) await gateway.start().catch((error) => { gateway.error = error.message; });
    updateTray();
  } catch (error) { startupError = `Could not open saved configuration in ${directory}: ${error.message}`; }
  function handle(name, fn) { ipcMain.handle(name, (event, ...args) => { assertSender(event); return fn(...args); }); }
  handle('state:get', () => service.store.data);
  handle('settings:save', (input) => service.saveSettings(input));
  handle('workspace:save', (input) => service.saveWorkspace(input));
  handle('attention:ack', (id) => service.acknowledge(id));
  handle('inventory', () => service.inventory());
  handle('health', () => service.health());
  handle('create', (input) => service.create(input));
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
    powerMonitor.on('resume', () => { void service.inventory().catch(() => {}); void service.health().catch(() => {}); });
    powerMonitor.on('suspend', () => { for (const record of [...gateway.sockets.values()]) gateway.drop(record, 4004, 'Desktop sleeping'); });
  }
  app.on('activate', showWindow);
});
const notified = new Set();
app.on('before-quit', () => {
  quitting = true;
  clearInterval(monitor); clearInterval(healthMonitor);
  void gateway?.dispose(); service?.terminals.closeAll(); tray?.destroy(); tray = null;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !gateway?.data.enabled) app.quit(); });
