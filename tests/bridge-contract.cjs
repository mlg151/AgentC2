const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

// Independent public wire contract. Every renderer method must reach a registered
// main-process handler with its arguments in order. Epochs stay inside preload.
const commands = {
  peerSyncStatus: 'peer-sync:status', savePeerSync: 'peer-sync:save', issuePeerPairing: 'peer-sync:pair',
  connectPeer: 'peer-sync:connect', revokePeer: 'peer-sync:revoke', pullPeerTabs: 'peer-sync:pull-tabs',
  checkForUpdates: 'updates:check', updateState: 'updates:state', downloadUpdate: 'updates:download', installUpdate: 'updates:install',
  overwatchWindowState: 'overwatch:state', undockOverwatch: 'overwatch:undock', dockOverwatch: 'overwatch:dock', selectOverwatchUnit: 'overwatch:select',
  getState: 'state:get', saveSettings: 'settings:save', previewOpOrder: 'oporder:preview', enrollOpOrder: 'oporder:enroll',
  previewSitrep: 'sitrep:preview', launchSitrep: 'sitrep:launch', githubRequest: 'github:request',
  listSpecops: 'specops:list', specopsDefinition: 'specops:definition', configureSpecops: 'specops:configure', launchSpecops: 'specops:launch', controlSpecops: 'specops:control',
  centcomState: 'centcom:state', configureCentcom: 'centcom:configure', startCentcom: 'centcom:start', submitCentcom: 'centcom:submit', interruptCentcom: 'centcom:interrupt',
  pauseCentcom: 'centcom:pause', resetCentcomSession: 'centcom:reset', decideCentcomDirective: 'centcom:decide-directive', decideAllCentcomDirectives: 'centcom:decide-all-directives', applyCentcomAutomation: 'centcom:apply-automation',
  listExercises: 'exercise:list', exerciseCapabilities: 'exercise:capabilities', createExercise: 'exercise:create', retryExercise: 'exercise:retry', cancelExercise: 'exercise:cancel',
  markExerciseComplete: 'exercise:complete', inspectExercise: 'exercise:inspect', previewExercisePromotion: 'exercise:preview', promoteExercise: 'exercise:promote',
  listFlashTraffic: 'flash:list', decideFlashTraffic: 'flash:decide', interruptFaults: 'fault:interrupt-all', resetFault: 'fault:reset',
  saveWorkspace: 'workspace:save', setSessionPinned: 'session:pin', previewCleanup: 'cleanup:preview', executeCleanup: 'cleanup:execute', cleanupState: 'cleanup:state',
  terminalPreviews: 'terminal:previews', searchHistory: 'terminal:search', renameSession: 'session:rename', acknowledge: 'attention:ack', inventory: 'inventory', health: 'health', create: 'create',
  chatCapabilities: 'chat:capabilities', openChat: 'chat:open', readyChat: 'chat:ready', chatHistory: 'chat:history', takeChat: 'chat:take', submitChat: 'chat:submit',
  chatReceipt: 'chat:receipt', pruneChat: 'chat:prune', closeChat: 'chat:close', listWorktrees: 'worktrees:list', archiveWorktree: 'worktrees:archive',
  diffFiles: 'diff:files', diffDetail: 'diff:detail', diffHunk: 'diff:hunk', interrupt: 'interrupt', stop: 'stop', deleteSession: 'session:delete',
  openTerminal: 'terminal:open', terminalHistory: 'terminal:history', readyTerminal: 'terminal:ready', terminalState: 'terminal:state', takeTerminal: 'terminal:take',
  remoteStatus: 'remote:status', saveRemote: 'remote:save', pairRemote: 'remote:pair', revokeRemote: 'remote:revoke', tailscaleStatus: 'remote:tailscale',
  writeTerminal: 'terminal:write', resizeTerminal: 'terminal:resize', closeTerminal: 'terminal:close', scrollTerminal: 'terminal:scroll',
  readClipboard: 'clipboard:read', readClipboardForTerminal: 'clipboard:for-terminal', devUrls: 'tunnel:list', openDevUrl: 'tunnel:open', writeClipboard: 'clipboard:write', terminalMenu: 'terminal:menu',
};
const events = {
  onPeerSyncStatus: ['peer-sync:status', 1], onPeerSyncApplied: ['peer-sync:applied', 1], onUpdateState: ['updates:state', 1],
  onOverwatchWindowState: ['overwatch:window-state', 1], onOverwatchSelect: ['overwatch:selected', 1], onOverwatchWorkspace: ['overwatch:workspace', 1],
  onCentcomState: ['centcom:updated', 1], onSessionsDeleted: ['sessions:deleted', 1], onSessionPinned: ['session:pinned', 2], onHealth: ['health:updated', 1],
  onChatEvents: ['chat:events', 1], onChatState: ['chat:state', 1], onRemoteStatus: ['remote:updated', 1], onTerminalState: ['terminal:state', 1],
  onDevUrls: ['tunnel:updated', 2], onInventory: ['inventory:updated', 1], onAttentionOpen: ['attention:open', 1], onTerminalData: ['terminal:data', 3], onTerminalExit: ['terminal:exit', 2],
};
const root = path.resolve(__dirname, '..');
function parse(file) { return ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true); }
const declaration = parse('src/types.ts').statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'AgentHQApi');
const members = new Map(declaration.members.map((node) => [node.name.text, node]));
assert.deepEqual([...members.keys()].sort(), ['platform', ...Object.keys(commands), ...Object.keys(events)].sort(), 'Every bridge member needs an explicit contract case');
const handlers = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText() === 'handle') {
    const name = node.arguments[0];
    if (ts.isStringLiteral(name)) handlers.push(name.text);
    else {
      let parent = node.parent;
      while (parent && !ts.isForOfStatement(parent)) parent = parent.parent;
      assert.ok(parent && ts.isArrayLiteralExpression(parent.expression), 'Dynamic IPC registrations need explicit contract review');
      assert.equal(parent.initializer.declarations[0].name.getText(), name.getText());
      handlers.push(...parent.expression.elements.map((element) => { assert.ok(ts.isStringLiteral(element)); return element.text; }));
    }
  }
  ts.forEachChild(node, visit);
}
visit(parse('electron/main.cjs'));
assert.deepEqual(handlers.sort(), Object.values(commands).sort(), 'Main-process handlers and renderer requests must match exactly');

async function main() {
  const ipc = new EventEmitter();
  let bridge, outcome = { result: 'fixture' }, failure;
  const calls = [];
  ipc.invoke = (...args) => { calls.push(args); return failure ? Promise.reject(failure) : Promise.resolve(outcome); };
  const filename = path.join(root, 'electron/preload.cjs');
  const execute = vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'process'], { filename });
  execute((id) => {
    assert.equal(id, 'electron', 'Preload must not import additional privileged modules');
    return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'agentHQ'); assert.equal(bridge, undefined); bridge = value; } } };
  }, { platform: 'fixture-platform' });
  assert.equal(bridge.platform, 'fixture-platform');
  assert.deepEqual(Object.keys(bridge).sort(), [...members.keys()].sort(), 'No undeclared privileged API may be exposed');
  for (const [method, channel] of Object.entries(commands)) {
    const parameters = members.get(method).parameters;
    const args = parameters.map((parameter, index) => ({ parameter: parameter.name.getText(), index }));
    const epoch = ['saveSettings', 'saveWorkspace'].includes(method) ? [0] : [];
    const result = await bridge[method](...args);
    assert.equal(result, outcome, `${method} must preserve the IPC result`);
    assert.deepEqual(calls.pop(), [channel, ...args, ...epoch], `${method} argument order`);
    const required = parameters.filter((parameter) => !parameter.questionToken).length;
    if (required < args.length) {
      await bridge[method](...args.slice(0, required));
      assert.deepEqual(calls.pop(), [channel, ...args.map((arg, index) => index < required ? arg : undefined), ...epoch], `${method} omitted optional arguments`);
    }
    failure = new Error(`Rejected ${method}`);
    await assert.rejects(bridge[method](...args), (error) => error === failure);
    calls.pop(); failure = undefined;
  }
  for (const [method, [channel, count]] of Object.entries(events)) {
    const before = ipc.listenerCount(channel);
    const received = [], other = [];
    const unsubscribe = bridge[method]((...args) => received.push(args));
    const unsubscribeOther = bridge[method]((...args) => other.push(args));
    const payload = Array.from({ length: count }, (_, index) => ({ index, peerEpoch: 0 }));
    const privilegedEvent = { sender: 'must never cross the isolation boundary' };
    ipc.emit(channel, privilegedEvent, ...payload);
    assert.deepEqual(received, [payload], `${method} must strip the Electron event and retain every payload argument`);
    assert.deepEqual(other, [payload]);
    unsubscribe(); unsubscribe();
    ipc.emit(channel, privilegedEvent, ...payload);
    assert.equal(received.length, 1, `${method} unsubscribe must detach only its own listener`);
    assert.equal(other.length, 2);
    unsubscribeOther();
    assert.equal(ipc.listenerCount(channel), before, `${method} must not leak listeners`);
  }
  // Delayed state snapshots and older peer events must never roll back the epoch
  // used to reject stale settings/workspace writes in the main process.
  for (const [snapshot, pushed, expected] of [
    [{}, 0, 0], [{ peerEpoch: 5 }, 2, 5], [{ peerEpoch: 1 }, 8, 8], [{ peerEpoch: 0 }, 3, 8],
  ]) {
    outcome = snapshot;
    await bridge.getState();
    ipc.emit('peer-sync:applied', {}, { peerEpoch: pushed });
    for (const method of ['saveSettings', 'saveWorkspace']) {
      const value = { fixture: method };
      await bridge[method](value);
      assert.deepEqual(calls.pop(), [commands[method], value, expected]);
    }
  }
  console.log(`PASS ${Object.keys(commands).length} IPC commands, ${Object.keys(events).length} subscriptions, exact renderer/main contract parity, error propagation, listener isolation, and monotonic peer epochs`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
