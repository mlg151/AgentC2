const assert = require('node:assert/strict');
const { phoneComponent } = require('./fixtures/phone-component.cjs');
(async () => {
  const calls = [];
  const api = { openTerminal: async () => new Promise(() => {}), closeTerminal: async () => {}, devUrls: async () => [], onTerminalExit: () => () => {}, onDevUrls: () => () => {} };
  const base = { session: { key: 'host/tmux:hq-111111111111', id: 'hq-111111111111', title: 'Alpha', hostId: 'host', hostName: 'Host', provider: 'terminal', kind: 'managed', cwd: '/project' }, visible: true, primary: true, focused: true, slot: 'anchor', callsign: '01', diffOpen: false, onToggleDiff() {}, onFocus: () => calls.push('focus'), onAnchor: () => calls.push('anchor'), onCycle: (value) => calls.push(value), onResume() {}, onRefresh() {}, onDeleteHistory() {}, onDeleteSession() {}, onCloseView: () => calls.push('close') };
  const environment = { window: { agentHQ: api }, modules: { '../workspace': { isManagedSession: (session) => session.kind === 'managed' } } };
  function pane(patch = {}) { return phoneComponent('../components/SessionPane.tsx', { ...base, ...patch, session: { ...base.session, ...patch.session } }, environment); }
  let view = pane();
  assert.match(view.text(view.tree), /PINNED ANCHOR01/); assert.equal(view.tree.props.style.order, 0);
  view.button('Close view').props.onClick(); view.button('Unpin anchor').props.onClick(); view.tree.props.onFocusCapture(); view.tree.props.onPointerDownCapture(); assert.deepEqual(calls, ['close', 'anchor', 'focus', 'focus']);
  assert.equal(view.button('Unpin anchor').props.title, 'Release the pinned anchor'); view.close();
  view = pane({ primary: false, focused: false, visible: false, slot: 'target', callsign: '' });
  assert.match(view.text(view.tree), /CYCLING TARGET—/); assert.equal(view.tree.props.style.order, 1); assert.match(view.tree.props.className, /pane-hidden/);
  assert.equal(view.button('Pin to A').props.title, 'Swap this target into Pane A');
  view.find((node) => node.props?.['aria-label'] === 'Previous target unit').props.onClick(); view.find((node) => node.props?.['aria-label'] === 'Next target unit').props.onClick(); view.button('Pin to A').props.onClick(); assert.deepEqual(calls.slice(-3), [-1, 1, 'anchor']); view.close();
  const cases = [
    [{ canAttach: true, provider: 'terminal' }, 'Attaching to terminal…', 'Attach to continue. Remote sessions stay available after disconnecting.'],
    [{ canAttach: true, provider: 'codex' }, 'Attaching to chat…', 'Attach to continue. Remote sessions stay available after disconnecting.'],
    [{ missing: true }, 'Session unavailable', 'Its notes remain saved; close the view or refresh to check again.'],
    [{ stale: true }, 'Host unavailable', 'The last known session state is shown. Reconnect the host to continue.'],
    [{ kind: 'unmanaged' }, 'Unmanaged process', 'This process was started outside tmux. Find its saved conversation and resume a managed copy.'],
    [{ canResume: true, kind: 'conversation' }, 'Conversation saved', 'Resume this conversation with a launch preset.'],
    [{}, 'Session ready', 'Attach to continue. Remote sessions stay available after disconnecting.'],
  ];
  for (const [session, heading, explanation] of cases) {
    view = pane({ session });
    assert.equal(view.text(view.find((node) => node.type === 'h2')), heading);
    assert.ok(view.text(view.tree).includes(explanation), heading);
    await view.flush(); view.close();
  }
  api.openTerminal = async () => 'terminal-handle'; view = pane({ session: { canAttach: true } }); await view.flush(); assert.equal(view.all().some((node) => node.type === 'h2'), false); assert.equal(view.component('TerminalView').props.terminalId, 'terminal-handle'); view.close();
  console.log('PASS desktop pane anchor/target controls, callbacks, callsigns, and every detached/attaching placeholder');
})().catch((error) => { console.error(error); process.exitCode = 1; });
