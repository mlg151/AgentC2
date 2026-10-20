const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHQ', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveWorkspace: (workspace) => ipcRenderer.invoke('workspace:save', workspace),
  acknowledge: (id) => ipcRenderer.invoke('attention:ack', id),
  inventory: () => ipcRenderer.invoke('inventory'),
  health: () => ipcRenderer.invoke('health'),
  onHealth: (callback) => {
    const listener = (_event, readings) => callback(readings);
    ipcRenderer.on('health:updated', listener);
    return () => ipcRenderer.removeListener('health:updated', listener);
  },
  create: (input) => ipcRenderer.invoke('create', input),
  interrupt: (name, hostId) => ipcRenderer.invoke('interrupt', name, hostId),
  stop: (name, hostId) => ipcRenderer.invoke('stop', name, hostId),
  openTerminal: (name, cols, rows, hostId) => ipcRenderer.invoke('terminal:open', name, cols, rows, hostId),
  terminalHistory: (id) => ipcRenderer.invoke('terminal:history', id),
  readyTerminal: (id) => ipcRenderer.invoke('terminal:ready', id),
  terminalState: (id) => ipcRenderer.invoke('terminal:state', id),
  takeTerminal: (id) => ipcRenderer.invoke('terminal:take', id),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  saveRemote: (input) => ipcRenderer.invoke('remote:save', input),
  pairRemote: () => ipcRenderer.invoke('remote:pair'),
  revokeRemote: (id) => ipcRenderer.invoke('remote:revoke', id),
  tailscaleStatus: () => ipcRenderer.invoke('remote:tailscale'),
  onRemoteStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('remote:updated', listener);
    return () => ipcRenderer.removeListener('remote:updated', listener);
  },
  onTerminalState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('terminal:state', listener);
    return () => ipcRenderer.removeListener('terminal:state', listener);
  },
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.invoke('terminal:close', id),
  scrollTerminal: (id, direction, lines) => ipcRenderer.invoke('terminal:scroll', id, direction, lines),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  terminalMenu: (hasSelection) => ipcRenderer.invoke('terminal:menu', hasSelection),
  onInventory: (callback) => {
    const listener = (_event, inventory) => callback(inventory);
    ipcRenderer.on('inventory:updated', listener);
    return () => ipcRenderer.removeListener('inventory:updated', listener);
  },
  onAttentionOpen: (callback) => {
    const listener = (_event, key) => callback(key);
    ipcRenderer.on('attention:open', listener);
    return () => ipcRenderer.removeListener('attention:open', listener);
  },
  onTerminalData: (callback) => {
    const listener = (_event, id, data, sequence) => callback(id, data, sequence);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, id, code) => callback(id, code);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
});
