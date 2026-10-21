const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHQ', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  previewOpOrder: (order) => ipcRenderer.invoke('oporder:preview', order),
  enrollOpOrder: (order, revision) => ipcRenderer.invoke('oporder:enroll', order, revision),
  previewSitrep: (input) => ipcRenderer.invoke('sitrep:preview', input),
  launchSitrep: (input) => ipcRenderer.invoke('sitrep:launch', input),
  listExercises: () => ipcRenderer.invoke('exercise:list'),
  exerciseCapabilities: (hostId) => ipcRenderer.invoke('exercise:capabilities', hostId),
  createExercise: (input) => ipcRenderer.invoke('exercise:create', input),
  retryExercise: (id) => ipcRenderer.invoke('exercise:retry', id),
  cancelExercise: (id) => ipcRenderer.invoke('exercise:cancel', id),
  markExerciseComplete: (id, contestantId) => ipcRenderer.invoke('exercise:complete', id, contestantId),
  inspectExercise: (id, contestantId, verify) => ipcRenderer.invoke('exercise:inspect', id, contestantId, verify),
  previewExercisePromotion: (id, contestantId) => ipcRenderer.invoke('exercise:preview', id, contestantId),
  promoteExercise: (id, contestantId, revision) => ipcRenderer.invoke('exercise:promote', id, contestantId, revision),
  saveWorkspace: (workspace) => ipcRenderer.invoke('workspace:save', workspace),
  setSessionPinned: (key, pinned) => ipcRenderer.invoke('session:pin', key, pinned),
  previewCleanup: (input) => ipcRenderer.invoke('cleanup:preview', input),
  executeCleanup: (token, keys) => ipcRenderer.invoke('cleanup:execute', token, keys),
  cleanupState: () => ipcRenderer.invoke('cleanup:state'),
  terminalPreviews: (keys) => ipcRenderer.invoke('terminal:previews', keys),
  searchHistory: (query, keys) => ipcRenderer.invoke('terminal:search', query, keys),
  onSessionsDeleted: (callback) => {
    const listener = (_event, keys) => callback(keys);
    ipcRenderer.on('sessions:deleted', listener);
    return () => ipcRenderer.removeListener('sessions:deleted', listener);
  },
  onSessionPinned: (callback) => {
    const listener = (_event, key, pinned) => callback(key, pinned);
    ipcRenderer.on('session:pinned', listener);
    return () => ipcRenderer.removeListener('session:pinned', listener);
  },
  acknowledge: (id) => ipcRenderer.invoke('attention:ack', id),
  inventory: () => ipcRenderer.invoke('inventory'),
  health: () => ipcRenderer.invoke('health'),
  onHealth: (callback) => {
    const listener = (_event, readings) => callback(readings);
    ipcRenderer.on('health:updated', listener);
    return () => ipcRenderer.removeListener('health:updated', listener);
  },
  create: (input) => ipcRenderer.invoke('create', input),
  listWorktrees: (hostId) => ipcRenderer.invoke('worktrees:list', hostId),
  archiveWorktree: (hostId, operationId) => ipcRenderer.invoke('worktrees:archive', hostId, operationId),
  diffFiles: (input) => ipcRenderer.invoke('diff:files', input),
  diffDetail: (input) => ipcRenderer.invoke('diff:detail', input),
  diffHunk: (input) => ipcRenderer.invoke('diff:hunk', input),
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
  readClipboardForTerminal: (id) => ipcRenderer.invoke('clipboard:for-terminal', id),
  devUrls: (sessionKey) => ipcRenderer.invoke('tunnel:list', sessionKey),
  openDevUrl: (id, url) => ipcRenderer.invoke('tunnel:open', id, url),
  onDevUrls: (callback) => {
    const listener = (_event, sessionKey, urls) => callback(sessionKey, urls);
    ipcRenderer.on('tunnel:updated', listener);
    return () => ipcRenderer.removeListener('tunnel:updated', listener);
  },
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
