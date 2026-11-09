const assert = require('node:assert/strict');
const { createLaunchGuard, withLaunchPolicy } = require('../electron/centcom-launch.cjs');
const { mutationContext, assertDispatchScope } = require('../electron/centcom-dispatch.cjs');

function fixture() {
  const host = { id: 'alpha', target: 'fixture.invalid', port: 22, enabled: true };
  const settings = { hosts: [host], presets: [], roe: null };
  const scope = { hosts: structuredClone(settings.hosts), roe: null, mode: 'gated', commander: 'commander' };
  const authority = () => ({ mode: scope.mode, commander: scope.commander });
  const service = { store: { data: { settings } }, inventory: async () => {} };
  let admission = async () => ({ status: 'admitted', unknowns: [], blockers: [] });
  const evidence = { admission: (...args) => admission(...args) };
  const guard = createLaunchGuard({ service, evidence, authority });
  const policy = { version: 1, authority: scope };
  const context = { directive: { id: 'reviewed', approvedAt: Date.now(), binding: { evidence: { authority: scope } } }, authority };
  const run = (input, dispatch) => withLaunchPolicy(policy, {}, () => guard.run(input, dispatch));
  return { host, settings, scope, service, evidence, guard, authority, policy, context, run, admission: (callback) => { admission = callback; } };
}
const beforeMutation = (message) => (error) => error.beforeMutation === true && message.test(error.message);

async function main() {
  const ordinary = fixture();
  let dispatched = 0;
  assert.equal(await ordinary.guard.run({}, () => ++dispatched), 1, 'Ordinary non-C2 launches keep their existing dispatch path');
  const firstEnabled = fixture();
  firstEnabled.settings.hosts.unshift({ id: 'disabled', enabled: false });
  firstEnabled.admission(async (input) => { assert.equal(input.hostId, 'alpha'); return { status: 'admitted', unknowns: [], blockers: [] }; });
  assert.equal(await firstEnabled.run({ cwd: '/fixture' }, () => 'first enabled'), 'first enabled');
  for (const hosts of [[], [{ id: 'alpha', enabled: false }]]) {
    const unavailable = fixture(); unavailable.settings.hosts = hosts;
    await assert.rejects(unavailable.run({}, () => assert.fail('Unavailable host dispatched')), beforeMutation(/host is unavailable/));
  }
  const invalid = fixture();
  await assert.rejects(withLaunchPolicy({ ...invalid.policy, version: 2 }, {}, () => invalid.guard.run({}, () => assert.fail('Unknown policy dispatched'))), beforeMutation(/Unknown workflow launch authorization/));

  for (const change of ['removed', 'retargeted']) {
    const stale = fixture();
    stale.admission(async () => {
      if (change === 'removed') stale.settings.hosts = [];
      else stale.host.target = 'changed.invalid';
      return { status: 'admitted', unknowns: [], blockers: [] };
    });
    await assert.rejects(stale.run({ hostId: 'alpha' }, () => assert.fail('Stale approval dispatched')), beforeMutation(/host route changed/));
  }
  const recovery = fixture();
  const record = { operationId: 'a'.repeat(32), revision: 'b'.repeat(64) };
  recovery.admission(async () => ({ status: 'admitted', unknowns: [], blockers: [], recovery: record }));
  await assert.rejects(recovery.run({ hostId: 'alpha' }, () => assert.fail('Persisted workflow policy authorized a new recovery')), beforeMutation(/recovery revision changed/));
  recovery.context.directive.binding.evidence.worktreeRecoveries = [{ ...record, revision: 'c'.repeat(64) }];
  await assert.rejects(mutationContext.run(recovery.context, () => recovery.run({ hostId: 'alpha' }, () => assert.fail('Changed revision dispatched'))), beforeMutation(/recovery revision changed/));
  recovery.context.directive.binding.evidence.worktreeRecoveries = [record];
  assert.equal(await mutationContext.run(recovery.context, () => recovery.run({ hostId: 'alpha' }, () => {
    assert.deepEqual(mutationContext.getStore().worktreeRecovery, record);
    return assertDispatchScope(recovery.host, { action: 'worktree_launch', operationId: record.operationId }, recovery.settings).expectedWorktreeRevision;
  })), record.revision);

  const serial = fixture(), order = [];
  let releaseFirst;
  const waiting = new Promise((resolve) => { releaseFirst = resolve; });
  let inventoryCalls = 0;
  serial.service.inventory = async () => { order.push('inventory'); if (++inventoryCalls === 1) throw Error('Inventory refresh unavailable'); };
  const first = serial.run({ hostId: 'alpha' }, async () => { order.push('first'); await waiting; throw Error('First dispatch outcome uncertain'); });
  const second = serial.run({ hostId: 'alpha' }, () => { order.push('second'); return 'second completed'; });
  const settled = Promise.allSettled([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first'], 'The next launch waits until dispatch and inventory refresh finish');
  releaseFirst();
  const results = await settled;
  assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /outcome uncertain/);
  assert.deepEqual(results[1], { status: 'fulfilled', value: 'second completed' });
  assert.deepEqual(order, ['first', 'inventory', 'second', 'inventory'], 'Neither a failed dispatch nor failed readback poisons the private release barrier');
  assert.equal(mutationContext.getStore(), undefined);
  console.log('PASS ordinary/default-host launch, unavailable routes, persisted versus freshly reviewed recovery, async route changes, and serialized recovery after dispatch/readback failures');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
