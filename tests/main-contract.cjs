const assert = require('node:assert/strict');
const { mainFixture } = require('./helpers/main-fixture.cjs');
const desktop = { id: 'desktop', name: 'Desktop' };
const a = { argument: 'a' }, b = { argument: 'b' }, c = { argument: 'c' };

// Public IPC contract independent of the implementation's registration loop.
const routes = [
  ['peer-sync:status', 'peer.status', []], ['peer-sync:save', 'peer.configure', [a]], ['peer-sync:pair', 'peer.pair', []], ['peer-sync:connect', 'peer.connect', [a]], ['peer-sync:revoke', 'peer.revoke', [a]], ['peer-sync:pull-tabs', 'peer.pullTabs', [a]],
  ['oporder:preview', 'service.previewOpOrder', [a]], ['oporder:enroll', 'service.enrollOpOrder', [a, b]], ['sitrep:preview', 'service.previewSitrep', [a], [desktop, a]], ['sitrep:launch', 'service.launchSitrep', [a], [desktop, a]], ['github:request', 'service.github', [a]],
  ['specops:list', 'service.specops.list', []], ['specops:definition', 'service.specops.definition', []], ['specops:configure', 'service.specops.configure', [a]], ['specops:launch', 'service.specops.launch', [a]], ['specops:control', 'service.specops.control', [a, b]],
  ['centcom:state', 'service.centcom.state', []], ['centcom:configure', 'service.centcom.configure', [a]], ['centcom:start', 'service.centcom.start', [a]], ['centcom:submit', 'service.centcom.submit', [a]], ['centcom:interrupt', 'service.centcom.interrupt', []], ['centcom:pause', 'service.centcom.pause', [a]], ['centcom:reset', 'service.centcom.resetSession', []], ['centcom:decide-directive', 'service.centcom.decideDirective', [a, b]], ['centcom:decide-all-directives', 'service.centcom.decideAllDirectives', [a]], ['centcom:apply-automation', 'service.centcom.applyAutomation', [a, b]],
  ['exercise:list', 'service.exercises.list', []], ['exercise:capabilities', 'service.exercises.capabilities', [a]], ['exercise:create', 'service.exercises.create', [a]], ['exercise:retry', 'service.exercises.launch', [a]], ['exercise:cancel', 'service.exercises.cancel', [a]], ['exercise:complete', 'service.exercises.markComplete', [a, b]], ['exercise:inspect', 'service.exercises.inspect', [a, b, c]], ['exercise:preview', 'service.exercises.preview', [a, b]], ['exercise:promote', 'service.exercises.promote', [a, b, c]],
  ['flash:list', 'service.flashQueue', []], ['flash:decide', 'service.flashDecide', [a], [desktop, a]], ['fault:interrupt-all', 'service.interruptFaults', [], [desktop]], ['fault:reset', 'service.resetFault', [a]], ['session:pin', 'service.setSessionPinned', [a, b]],
  ...['state', 'check', 'download', 'install'].map((method) => ['updates:' + method, 'updates.' + method, []]),
  ['session:rename', 'service.renameSession', [a, b]], ['session:delete', 'service.deleteSession', [a], [desktop, a]], ['cleanup:preview', 'service.cleanup.preview', [a]], ['cleanup:execute', 'service.cleanup.execute', [a, b]], ['cleanup:state', 'service.cleanup.state', []], ['terminal:previews', 'service.terminalPreviews', [a]], ['terminal:search', 'service.searchHistory', [a, b]], ['attention:ack', 'service.acknowledge', [a]], ['inventory', 'service.inventory', []], ['health', 'service.health', []], ['create', 'service.create', [a]],
  ['chat:capabilities', 'service.chats.capabilities', [a]], ['chat:open', 'service.chats.open', [a, b], [desktop, a, b]], ['chat:ready', 'service.chats.ready', [a, b], [desktop, a, b]], ['chat:history', 'service.chats.history', [a, b, c], [desktop, a, b, c]], ['chat:take', 'service.chats.take', [a], [desktop, a]], ['chat:submit', 'service.chats.submit', [a, b], [desktop, a, b]], ['chat:receipt', 'service.chats.receipt', [a, b], [desktop, a, b]], ['chat:prune', 'service.chats.prune', [a], [desktop, a]],
  ['worktrees:list', 'service.worktrees', [a]], ['worktrees:archive', 'service.archiveWorktree', [a, b]],
  ...['files', 'detail', 'hunk'].map((action) => ['diff:' + action, 'service.diffRequest', [a], [desktop, a, 'diff_' + action]]),
  ...['interrupt', 'stop'].map((action) => [action, 'service.action', [a, b], [desktop, action, a, b]]),
  ['terminal:open', 'service.terminals.open', [a, b, c, 'host'], [desktop, a, 'resolved-host', b, c]],
  ...['ready', 'state', 'take', 'write', 'resize'].map((method) => ['terminal:' + method, 'service.terminals.' + method, [a, b, c].slice(0, method === 'resize' ? 3 : method === 'write' ? 2 : 1), [desktop, ...[a, b, c].slice(0, method === 'resize' ? 3 : method === 'write' ? 2 : 1)]]),
  ['terminal:history', 'service.terminals.retained', [a], [desktop, a]], ['terminal:scroll', 'service.terminals.scrollRemote', [a, b, c], [desktop, a, b, c]],
  ['tunnel:list', 'service.devUrls', [a]], ['remote:status', 'gateway.status', []], ['remote:pair', 'gateway.pair', []], ['remote:revoke', 'gateway.revoke', [a]],
];

async function routing() {
  const f = await mainFixture();
  assert.deepEqual(f.windows[0].minimumSize, [960, 690], 'Native border area is added to the renderer minimum');
  assert.deepEqual(f.windows[0].settings.webPreferences, { preload: require('node:path').resolve(__dirname, '../electron/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true });
  for (const [channel, target, args, expected = args] of routes) {
    f.calls.length = 0;
    await f.invoke(channel, ...args);
    assert.deepEqual(f.calls.find(([method]) => method === target), [target, ...expected], channel + ' argument order and identity');
    f.failPath = target; f.failure = Error('Rejected ' + channel);
    await assert.rejects(Promise.resolve().then(() => f.invoke(channel, ...args)), (error) => error === f.failure, channel + ' preserves rejection');
    f.failPath = undefined;
  }
  for (const kind of ['terminals', 'chats']) {
    const channel = kind === 'terminals' ? 'terminal:close' : 'chat:close';
    f.calls.length = 0; f.invoke(channel, 'missing'); assert.equal(f.calls.length, 0);
    f.service[kind].handles.set('handle', {}); f.invoke(channel, 'handle');
    assert.deepEqual(f.calls.pop(), ['service.' + kind + '.close', desktop, 'handle']);
  }
  assert.equal(f.invoke('clipboard:read'), 'fixture text');
  f.invoke('clipboard:write', 'written'); assert.equal(f.clipboard, 'written');
  for (const value of [a, 'x'.repeat(1000001)]) assert.throws(() => f.invoke('clipboard:write', value), /Invalid clipboard/);
  assert.deepEqual(await f.invoke('clipboard:for-terminal', 'handle'), { kind: 'text', text: 'fixture text' });
  f.png = Buffer.from('fixture PNG');
  assert.deepEqual(await f.invoke('clipboard:for-terminal', 'handle'), { kind: 'image', path: '/private/fixture.png' });
  assert.deepEqual(f.calls.find((call) => call[0] === 'service.uploadClipboardImage').slice(1), [desktop, 'handle', f.png]);
  f.failPath = 'service.terminals.assertOwner'; f.failure = Error('Observer cannot paste');
  await assert.rejects(f.invoke('clipboard:for-terminal', 'handle'), /Observer cannot paste/); f.failPath = undefined;
  assert.equal(await f.invoke('tunnel:open', 'handle', 'http://localhost:3000'), 'http://127.0.0.1:32123/fixture');
  assert.deepEqual(f.calls.at(-1), ['shell.openExternal', 'http://127.0.0.1:32123/fixture']);
  assert.deepEqual(f.invoke('remote:tailscale'), { installed: true });
  for (const [choice, result] of [[undefined, null], [0, 'copy'], [1, 'paste'], [3, 'latest']]) { f.menuChoice = choice; assert.equal(await f.invoke('terminal:menu', true), result); }
  assert.equal(f.invoke('state:get').peerEpoch, 0);
  f.invoke('settings:save', a, 0); f.invoke('workspace:save', a, 0);
  f.peer.emit('applied', { workspace: b });
  assert.equal(f.invoke('state:get').peerEpoch, 1);
  for (const channel of ['settings:save', 'workspace:save']) { assert.throws(() => f.invoke(channel, a, 0), /Review the latest state/); f.invoke(channel, a, 1); }
  for (const [name, handler] of f.handlers) assert.throws(() => handler({ sender: {}, senderFrame: {} }), /Untrusted window/, name);
  f.app.emit('before-quit');
}

async function windowsAndEvents() {
  const f = await mainFixture({ remoteEnabled: true });
  const main = f.windows[0];
  f.invoke('overwatch:undock'); const watch = f.windows[1];
  watch.minimized = true; f.invoke('overwatch:undock'); assert.equal(f.windows.length, 2); assert.equal(watch.restored, true);
  assert.equal(watch.openHandler({ url: 'https://example.invalid' }).action, 'deny');
  let prevented = false; watch.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  const reads = new Set(['state:get', 'inventory', 'terminal:previews', 'overwatch:state', 'overwatch:dock', 'overwatch:select']);
  for (const [name, handler] of f.handlers) if (!reads.has(name)) assert.throws(() => handler(f.event(watch)), /Untrusted window/, name);
  assert.deepEqual(f.handlers.get('overwatch:state')(f.event(watch)), { undocked: true });
  await f.handlers.get('overwatch:select')(f.event(watch), 'host/tmux:managed'); assert.equal(main.focused, true);
  for (const key of [a, 'x'.repeat(257)]) await assert.rejects(f.invoke('overwatch:select', key), /Invalid unit key/);
  await assert.rejects(f.invoke('overwatch:select', 'host/tmux:external'), /no longer available/);
  for (const input of [{ control: true, key: 'C' }, { meta: true, key: 'v' }, { key: 'x' }]) { main.webContents.emit('before-input-event', {}, input); assert.equal(main.ignoreShortcuts, input.key !== 'x'); }
  for (const url of ['bad URL', 'file:///private/file', 'https://example.invalid/path', 'http://example.invalid/']) assert.deepEqual(main.openHandler({ url }), { action: 'deny' });
  f.linkFailure = true; main.openHandler({ url: 'https://example.invalid/' }); await f.flush(); assert.ok(f.calls.some(([name]) => name === 'console.error'));
  main.webContents.emit('did-start-navigation', {}, '', false, false);
  main.webContents.emit('did-start-navigation', {}, '', false, true);
  for (const [event, value] of [['terminal:data', { id: 'h', data: 'text', sequence: 3 }], ['terminal:exit', { id: 'h', code: 1 }], ['chat:events', a]]) f.service.events.emit('client', 'desktop', event, value);
  const length = f.calls.length; f.service.events.emit('client', 'phone', 'terminal:data', {}); assert.equal(f.calls.length, length);
  f.service.events.emit('tunnel:updated', { sessionKey: 'unit', urls: ['url'] });
  f.peer.emit('status', a); f.updateOptions.notify(a);
  for (const event of ['health:updated', 'session:pinned', 'sessions:deleted', 'centcom:updated']) f.service.events.emit(event, a, b);
  const inventory = { attention: [{ id: 'old', kind: 'input', title: 'Old', sessionKey: 'old' }, { id: 'new', kind: 'input', title: 'New', sessionKey: 'new' }, { id: 'failed', kind: 'failed', title: 'Failed' }, { id: 'ack', acknowledged: true }] };
  f.service.events.emit('inventory:updated', inventory); f.service.events.emit('inventory:updated', inventory);
  assert.equal(f.notifications.length, 2); assert.equal(f.notifications[0].input.title, 'AgentC2: Input may be needed'); assert.equal(f.notifications[1].input.title, 'AgentC2: failed');
  f.notifications[0].emit('click'); assert.deepEqual(f.calls.at(-1), ['window.send', 'attention:open', 'new']);
  f.notificationsSupported = false; f.service.events.emit('inventory:updated', { attention: [{ id: 'unsupported' }] });
  f.service.store.data.settings.notifications = false; f.service.events.emit('inventory:updated', { attention: [{ id: 'disabled' }] }); assert.equal(f.notifications.length, 2);
  f.rejectBackground = true; for (const timer of f.timers) timer.callback(); f.power.emit('resume'); f.power.emit('suspend'); await f.flush();
  assert.ok(f.calls.some((call) => call[0] === 'gateway.drop' && call[2] === 4004 && call[3] === 'Desktop sleeping'));
  f.rejectBackground = false;
  main.minimized = true; f.app.emit('activate'); assert.equal(main.restored, true);
  assert.equal(f.invoke('overwatch:dock').undocked, false); assert.equal(watch.destroyed, true);
  for (const action of ['minimize', 'hide', 'close']) { f.closeAction = action; let prevented = false; main.emit('close', { preventDefault() { prevented = true; } }); assert.equal(prevented, action !== 'close'); }
  main.destroy(); assert.throws(() => f.invoke('overwatch:select', 'host/tmux:managed'), /Untrusted window/);
  f.app.emit('activate'); assert.equal(f.windows.length, 3);
  f.invoke('overwatch:undock'); f.app.emit('before-quit'); assert.equal(f.windows.at(-1).destroyed, true); assert.ok(f.timers.every((timer) => timer.cleared));
  await assert.rejects(f.invoke('overwatch:select', 'host/tmux:managed'), /Main window is unavailable/);
  f.app.emit('window-all-closed'); assert.equal(f.quit, true);
}

async function platformStartup() {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const f = await mainFixture({ platform, packaged: true, remoteEnabled: true, development: platform === 'linux' });
    assert.equal(f.updateOptions.updater.mac || f.updateOptions.updater.native, true);
    assert.equal(f.updateOptions.source, false); assert.deepEqual(f.updateOptions.checkMain, { revision: 'fixture-revision' });
    if (platform === 'darwin') { assert.equal(f.templateImage, true); f.dock.template[0].click(); }
    if (platform === 'win32') assert.equal(f.appId, 'com.agentc2.desktop');
    for (const menu of f.appMenu.template.flatMap((item) => item.submenu || [])) if (menu.click) menu.click();
    if (platform !== 'darwin') { f.trays[0].emit('click'); f.trays[0].emit('double-click'); }
    const tray = f.trays[0]; tray.menu.template[0].click(); tray.menu.template[3].click(); assert.equal(f.quit, true);
    f.gatewayFailure = true; tray.menu.template[1].click(); await f.flush(); assert.equal(f.gateway.error, 'Configuration unavailable');
    f.gatewayFailure = false; tray.menu.template[1].click(); await f.flush(); assert.equal(tray.destroyed, true);
    f.invoke('overwatch:undock'); assert.equal(f.windows[1].loaded[0], platform === 'linux' ? 'url' : 'file');
    await f.invoke('remote:save', { enabled: true }); assert.equal(f.trays.length, 2);
    f.app.emit('before-quit'); f.quit = false; f.app.emit('window-all-closed'); assert.equal(f.quit, platform !== 'darwin');
  }
  const unavailableTray = await mainFixture({ remoteEnabled: true, trayFailure: true }); assert.equal(unavailableTray.trays.length, 0); assert.ok(unavailableTray.calls.some(([name]) => name === 'console.warn')); unavailableTray.app.emit('before-quit');
  const partialTray = await mainFixture({ remoteEnabled: true, tooltipFailure: true }); assert.equal(partialTray.trays[0].destroyed, true); partialTray.app.emit('before-quit');
  const failedStart = await mainFixture({ rejectBackground: true, remoteEnabled: true }); assert.equal(failedStart.peer.error, 'Fixture unavailable'); assert.equal(failedStart.gateway.error, 'Fixture unavailable'); failedStart.app.emit('before-quit');
  const broken = await mainFixture({ startupFailure: true, missingBuild: true }); assert.throws(() => broken.invoke('state:get'), /Could not open saved configuration.*Invalid saved settings/); assert.equal(broken.timers.length, 0); broken.app.emit('before-quit');
  const resumed = await mainFixture({ resumeUpdate: true, allowResume: true }); assert.equal(resumed.windows.length, 0); resumed.app.emit('before-quit');
  for (const [env, existing, directory] of [[{ AGENTC2_DATA_DIR: '/explicit' }, [], '/explicit'], [{ AGENT_HQ_DATA_DIR: '/legacy-env' }, [], '/legacy-env'], [{}, ['/fixture/userData/workspace.json'], '/fixture/userData'], [{}, ['/fixture/appData/agent-hq/workspace.json'], '/fixture/appData/agent-hq']]) {
    const f = await mainFixture({ env, existing }); assert.equal(require('node:path').normalize(f.serviceOptions.directory), require('node:path').normalize(directory)); f.app.emit('before-quit');
  }
}

(async () => { await routing(); await windowsAndEvents(); await platformStartup(); console.log('PASS every main-process IPC delegation, desktop identity/epoch fences, observer restrictions, native window lifecycle, notifications, suspend, and platform startup'); })().catch((error) => { console.error(error); process.exitCode = 1; });
