const assert = require('node:assert/strict');
const { mutationContext, assertDispatchScope } = require('../electron/centcom-dispatch.cjs');

function fixture() {
  const host = { id: 'alpha', target: 'fixture.invalid', port: 22, enabled: true };
  const preset = { id: 'worker', command: 'codex', roeProfile: 'gated' };
  const settings = { roe: { version: 1, hostDefaults: { alpha: 'gated' } }, presets: [preset] };
  const authority = { mode: 'gated', commander: 'commander-session' };
  const scope = { hosts: [structuredClone(host)], roe: structuredClone(settings.roe), ...authority };
  const context = { directive: { binding: { evidence: { authority: scope, operationEvidence: { status: { headCommit: 'a'.repeat(40) } } } } }, authority: () => authority };
  const dispatch = (payload, route = host) => mutationContext.run(context, () => assertDispatchScope(route, payload, settings));
  return { host, preset, settings, authority, scope, context, dispatch };
}
const rejects = (invoke, message) => assert.throws(invoke, (error) => error.beforeMutation === true && message.test(error.message));

async function main() {
  const f = fixture(), payload = { action: 'create', provider: 'terminal' };
  assert.equal(assertDispatchScope({}, payload, {}), payload, 'Ordinary service calls do not inherit an unrelated approval fence');
  assert.equal(f.dispatch(payload), payload);
  assert.equal(f.dispatch(payload, { enabled: true, port: 22, target: 'fixture.invalid', id: 'alpha' }), payload, 'Equivalent host fields are independent of JSON key order');
  rejects(() => f.dispatch(payload, { ...f.host, target: 'different.invalid' }), /Reviewed host route changed/);
  rejects(() => mutationContext.run({ authority: f.context.authority }, () => assertDispatchScope(f.host, payload, f.settings)), /Reviewed host route changed/);
  delete f.settings.roe;
  rejects(() => f.dispatch(payload), /Rules of Engagement changed/);
  f.scope.roe = null;
  assert.equal(f.dispatch(payload), payload);
  f.scope.preset = structuredClone(f.preset);
  assert.equal(f.dispatch(payload), payload);
  f.settings.presets = [];
  rejects(() => f.dispatch(payload), /Reviewed launch preset changed/);
  delete f.scope.preset;
  f.scope.presets = [{ id: f.preset.id, value: structuredClone(f.preset) }];
  rejects(() => f.dispatch(payload), /Reviewed contestant preset changed/);
  f.settings.presets = [f.preset];
  assert.equal(f.dispatch(payload), payload);
  f.preset.roeProfile = 'provider-default';
  rejects(() => f.dispatch(payload), /Reviewed contestant preset changed/);
  delete f.scope.presets;
  f.authority.mode = 'autonomous';
  rejects(() => f.dispatch(payload), /CENTCOM authorization changed/);
  f.authority.mode = 'gated'; f.authority.commander = 'new-session';
  rejects(() => f.dispatch(payload), /CENTCOM authorization changed/);

  const actions = ['create', 'configure', 'rename', 'worktree_launch', 'worktree_archive', 'oporder_sync', 'exercise_promote', 'flash_decide', 'diff_hunk', 'interrupt', 'stop'];
  for (const action of actions) {
    const scope = fixture();
    rejects(() => scope.dispatch({ action }, { ...scope.host, port: 2222 }), /Reviewed host route changed/);
  }
  for (const action of ['sitrep_source_preview', 'exercise_inspect']) {
    const scope = fixture(), route = { ...scope.host, port: 2222 };
    const readonly = { action, testCommand: '' };
    assert.equal(scope.dispatch(readonly, route), readonly);
    rejects(() => scope.dispatch({ action, testCommand: 'fixture-test' }, route), /Reviewed host route changed/);
  }
  for (const request of [undefined, { action: 'history' }, { action: 'command' }]) {
    const scope = fixture(), value = { action: 'chat', request }, route = { ...scope.host, port: 2222 };
    if (request?.action === 'command') rejects(() => scope.dispatch(value, route), /Reviewed host route changed/);
    else assert.equal(scope.dispatch(value, route), value);
  }
  for (const operation of ['issue', 'ready', 'close']) {
    const scope = fixture(), value = { action: 'github', operation }, route = { ...scope.host, port: 2222 };
    if (operation === 'issue') assert.equal(scope.dispatch(value, route), value);
    else rejects(() => scope.dispatch(value, route), /Reviewed host route changed/);
  }
  const tree = fixture();
  assert.equal(tree.dispatch({ action: 'worktree_archive', expectedHeadCommit: 'unreviewed' }).expectedHeadCommit, 'a'.repeat(40));
  tree.context.worktreeRecovery = { operationId: 'reviewed', revision: 'b'.repeat(64) };
  rejects(() => tree.dispatch({ action: 'worktree_launch', operationId: 'different' }), /Worktree recovery target changed/);
  assert.equal(tree.dispatch({ action: 'worktree_launch', operationId: 'reviewed', expectedWorktreeRevision: 'unreviewed' }).expectedWorktreeRevision, 'b'.repeat(64));
  const concurrent = fixture();
  const fenced = mutationContext.run(concurrent.context, async () => {
    await Promise.resolve();
    concurrent.authority.mode = 'autonomous';
    rejects(() => assertDispatchScope(concurrent.host, payload, concurrent.settings), /CENTCOM authorization changed/);
  });
  assert.equal(assertDispatchScope({ id: 'other' }, payload, {}), payload);
  await fenced;
  assert.equal(mutationContext.getStore(), undefined);
  console.log('PASS async approval scope isolation, all mutation routes, fresh host/ROE/preset/commander fences, read-only exceptions, and server-bound archive/recovery revisions');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
