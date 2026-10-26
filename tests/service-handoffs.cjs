const assert = require('node:assert/strict');
const { serviceFixture } = require('./fixtures/service-boundaries.cjs');

(async () => {
  const fixture = serviceFixture(), { service, adapters } = fixture;
  const desktop = { id: 'desktop' }, observer = { id: 'phone' };
  const name = 'hq-111111111111', operationId = 'a'.repeat(32);
  let source = { source: { repository: '/fixture/source', path: '/fixture/worktree', name, branch: 'fixture-branch', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40) }, revision: 'c'.repeat(64), patchBase64: Buffer.from('Reviewed fixture patch\n').toString('base64'), patchBytes: 23, patchPreview: 'Reviewed fixture patch', patchPreviewTruncated: false, untracked: [], warnings: [], test: null };
  let target = { ready: true };
  fixture.setHandler((request) => {
    const action = request.payload.action;
    request.respond(action === 'sitrep_source_preview' ? source : action === 'sitrep_target_preview' ? target : action === 'inventory' ? { user: 'fixture', sessions: [] } : { name: 'hq-222222222222' });
  });
  service.chats.capabilities = async () => [{ provider: 'codex', status: 'supported' }];
  const previewInput = { sourceHostId: 'default', targetHostId: 'default', name, operationId, repository: '', testCommand: '' };
  const launchInput = { operationId: 'd'.repeat(32), objective: 'Reviewed objective', summary: 'Reviewed source changes', nextSteps: '', title: 'Recipient fixture', slug: 'recipient', provider: 'codex' };
  try {
    for (const input of [null, {}, { ...previewInput, name: '' }, { ...previewInput, operationId: '' }, { ...previewInput, repository: null }, { ...previewInput, repository: 'relative/path' }, { ...previewInput, repository: 'x'.repeat(4097) }, { ...previewInput, testCommand: null }, { ...previewInput, testCommand: 'x'.repeat(501) }]) await assert.rejects(service.previewSitrep(desktop, input), /Invalid SitRep preview/);
    for (const input of [null, {}, { id: 'missing', ...launchInput }]) await assert.rejects(service.launchSitrep(desktop, input), /preview expired or operation changed/);
    assert.equal(fixture.calls.length, 0, 'Malformed handoffs must reject before remote execution');
    await assert.rejects(service.previewSitrep(observer, { ...previewInput, testCommand: 'fixture test' }), /take control/i);
    await assert.rejects(service.previewSitrep(desktop, { ...previewInput, targetHostId: 'local' }), /primary Git checkout/);
    const first = await service.previewSitrep(desktop, previewInput);
    assert.equal(first.ready, true);
    assert.equal(fixture.calls.at(-1).payload.repository, '/fixture/source', 'Same-host preview may use its verified source repository');
    const crossHost = await service.previewSitrep(desktop, { ...previewInput, targetHostId: 'local', repository: '/fixture/target' });
    assert.equal(crossHost.ready, true); assert.equal(fixture.calls.at(-1).payload.repository, '/fixture/target');
    for (const patch of [{ operationId: '' }, { objective: null }, { objective: 'x'.repeat(2001) }, { summary: 'bad\0text' }, { objective: '' }, { summary: '' }, { slug: '' }, { slug: 'UpperCase' }, { provider: 'unknown' }]) await assert.rejects(service.launchSitrep(desktop, { id: first.id, ...launchInput, ...patch }), /Invalid SitRep text|SitRep needs|preview expired or operation changed/);
    source.revision = 'e'.repeat(64);
    await assert.rejects(service.launchSitrep(desktop, { id: first.id, ...launchInput }), /Source changed/);
    source.revision = first.revision; source.warnings = ['Fixture source became unsafe'];
    await assert.rejects(service.launchSitrep(desktop, { id: first.id, ...launchInput }), /Source changed/);
    source.warnings = [];
    for (const reason of [undefined, 'Target fixture base changed']) {
      target = { ready: false, reason };
      await assert.rejects(service.launchSitrep(desktop, { id: first.id, ...launchInput }), reason ? /Target fixture base changed/ : /Target base changed/);
    }
    target = { ready: true };
    fixture.advance(15 * 60000 + 1);
    await assert.rejects(service.launchSitrep(desktop, { id: first.id, ...launchInput }), /preview expired/);
    const current = await service.previewSitrep(desktop, previewInput);
    assert.equal(adapters.sitrepSource(first.id), undefined, 'A fresh preview must evict expired source evidence');
    assert.ok(adapters.commanderHandoffs().some((item) => item.id === current.id));
    for (const test of [null, { command: 'fixture test', ranAt: Date.now(), exitCode: 7, timedOut: true, outputTruncated: true, output: 'Fixture deadline exceeded' }, { command: 'fixture test', ranAt: Date.now(), exitCode: 0, timedOut: false, outputTruncated: false, output: 'Fixture checks passed' }]) {
      source.test = test;
      const reviewed = await service.previewSitrep(desktop, previewInput);
      const result = await service.launchSitrep(desktop, { id: reviewed.id, ...launchInput });
      assert.equal(result.hostId, 'default');
      const payload = fixture.calls.findLast((request) => request.payload.action === 'worktree_launch').payload;
      assert.equal(payload.operationId, launchInput.operationId); assert.equal(payload.sitrep.source.operationId, operationId);
      assert.equal(payload.sitrep.digest, require('node:crypto').createHash('sha256').update(Buffer.from(source.patchBase64, 'base64')).digest('hex'));
      assert.match(payload.instructions, /Next steps: Review the applied changes and continue the objective/);
      assert.match(payload.instructions, test ? test.timedOut ? /Exit: timed out\nOutput \(tail, truncated\)/ : /Exit: 0\nOutput:/ : /No test command was run/);
      await assert.rejects(service.launchSitrep(desktop, { id: reviewed.id, ...launchInput, operationId: 'f'.repeat(32) }), /operation changed/);
      await service.inventory();
    }
    source.test = { command: 'fixture test', ranAt: Date.now(), exitCode: 0, timedOut: false, outputTruncated: false, output: 'x'.repeat(20001) };
    const oversized = await service.previewSitrep(desktop, previewInput);
    const launches = fixture.calls.filter((request) => request.payload.action === 'worktree_launch').length;
    await assert.rejects(service.launchSitrep(desktop, { id: oversized.id, ...launchInput }), /exceeds provider input limit/);
    assert.equal(fixture.calls.filter((request) => request.payload.action === 'worktree_launch').length, launches, 'Oversized handoff must not partially launch a recipient');
    console.log('PASS service SitRep preview admission, host repository evidence, stale/changed source and target rejection, exact text bounds, expiry/eviction, reviewed digest/permission-preserving launch, test-result provenance, stable operation identity, and pre-launch input limits');
  } finally { fixture.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
