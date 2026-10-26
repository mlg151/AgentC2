const assert = require('node:assert/strict');
const { serviceFixture } = require('./fixtures/service-boundaries.cjs');

async function health() {
  const fixture = serviceFixture(), { service } = fixture;
  try {
    const samples = { default: { cpuTotal: 100, cpuIdle: 80, memoryTotal: 1000, memoryUsed: 400, disks: [] }, local: { cpuTotal: 200, cpuIdle: 100, memoryTotal: 2000, memoryUsed: 600, disks: [], resources: { status: 'reported' }, gpu: { status: 'reported', sampledAt: 1, devices: [] } } };
    let release, fail = false;
    fixture.setHandler((request) => {
      const host = request.payload.localHost ? 'local' : 'default';
      if (fail) { request.fail(1, 'Host unavailable'); return; }
      if (release) { release.push(() => request.respond(samples[host])); return; }
      request.respond(samples[host]);
    });
    release = [];
    const first = service.health(), shared = service.health();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.calls.length, 2, 'Concurrent health requests must share one remote sample per host');
    for (const reply of release) reply(); release = null;
    const readings = await first; assert.deepEqual(await shared, readings);
    assert.equal(readings[0].cpuPercent, null); assert.equal(readings[0].gpu.status, 'unknown'); assert.equal(readings[0].resources.status, 'unknown');
    assert.equal(readings[1].resources.status, 'reported'); assert.equal(readings[1].gpu.status, 'reported');
    service.terminals.sessions.set('counted', { hostId: 'default', connection: 'connected', handles: new Set(['one', 'two']) });
    service.terminals.sessions.set('disposed', { hostId: 'default', disposed: true, connection: 'connected', handles: new Set(['three']) });
    service.terminals.sessions.set('reconnecting', { hostId: 'default', connection: 'reconnecting', handles: new Set(['four']) });
    samples.default.cpuTotal = 200; samples.default.cpuIdle = 100;
    samples.local.cpuTotal = 300; samples.local.cpuIdle = 90; samples.local.gpu = undefined;
    const next = await service.health();
    assert.equal(next[0].cpuPercent, 80); assert.equal(next[0].activeChannels, 2); assert.equal(next[1].cpuPercent, null);
    assert.equal(next[1].gpu.status, 'reported', 'A sparse reading retains the last known GPU evidence');
    assert.equal(fixture.calls.at(-1).payload.includeGpu, false);
    fixture.advance(30001); await service.health(); assert.equal(fixture.calls.at(-1).payload.includeGpu, true);
    fail = true; const offline = await service.health(); assert.equal(offline[0].connected, false); assert.equal(offline[0].error, 'Host unavailable');
    fail = false; assert.equal((await service.health())[0].cpuPercent, null, 'Reconnect starts a fresh CPU delta');
    service.terminals.sessions.clear();
  } finally { fixture.close(); }
}

async function transport() {
  const fixture = serviceFixture(), { service } = fixture;
  try {
    assert.equal(service.hostId(), 'default');
    for (const id of ['unknown', 'disabled']) assert.throws(() => service.hostId(id), /Host is unavailable/);
    for (const [hostId, message] of [['default', /SSH connection failed/], ['local', /Local execution failed/]]) {
      fixture.setHandler((request) => request.fail(1));
      await assert.rejects(service.worktrees(hostId), message);
    }
    fixture.setHandler((request) => request.fail(1, '  bounded helper diagnostic  '));
    await assert.rejects(service.worktrees('default'), /bounded helper diagnostic/);
    for (const data of ['not JSON', JSON.stringify({ ok: false }), JSON.stringify({ ok: false, error: 'Helper rejected operation' })]) {
      fixture.setHandler((request) => { request.child.stdout.emit('data', data); request.child.emit('close', 0); });
      await assert.rejects(service.worktrees('default'), /Invalid response|Remote action failed|Helper rejected operation/);
    }
    fixture.setHandler((request) => { request.child.emit('error', Object.assign(Error('Python missing'), { code: 'ENOENT' })); request.child.emit('close', 1); });
    await assert.rejects(service.worktrees('local'), /Local execution requires Python/);
    await assert.rejects(service.worktrees('default'), /Python missing/);
    fixture.setHandler((request) => { request.child.stdin.emit('error', Error('Broken pipe')); request.child.stdout.emit('data', 'x'.repeat(20000001)); });
    await assert.rejects(service.worktrees('default'), /SSH connection failed/); assert.equal(fixture.calls.at(-1).kills, 1);
    fixture.setHandler(() => {});
    const timed = service.worktrees('default'); await new Promise((resolve) => setImmediate(resolve));
    const timer = [...fixture.timers.values()].find((timer) => timer.delay === 40000); assert.ok(timer); timer.callback();
    await assert.rejects(timed, /SSH connection failed/); assert.equal(fixture.timers.size, 0);
    fixture.setHandler((request) => request.respond({ retained: true }));
    assert.deepEqual(await service.github({ hostId: 'default', fixture: 'x'.repeat(65000) }), { retained: true });
    assert.equal(fixture.calls.at(-1).embedded, true, 'Large request payloads travel on stdin rather than the process argument limit');
    assert.deepEqual(await service.worktrees('default'), { retained: true }); assert.equal(fixture.calls.at(-1).embedded, false);
    assert.equal(fixture.timers.size, 0, 'Every remote completion must clear its timeout');
  } finally { fixture.close(); }
}

async function previews() {
  const unit = (index, extra = {}) => ({ key: `default/tmux:hq-${String(index).padStart(12, '0')}`, id: `hq-${String(index).padStart(12, '0')}`, title: `Unit ${index}`, provider: 'codex', kind: 'managed', managed: true, state: 'live', canAttach: true, ...extra });
  const units = Array.from({ length: 10 }, (_, index) => unit(index + 1));
  units[1].canAttach = false;
  units[2].transport = 'chat'; units[2].chatSessionId = 'chat-' + 'a'.repeat(32);
  const fixture = serviceFixture((store) => store.save('cachedUnits', { default: units, ghost: [{ ...unit(11), key: 'ghost/tmux:hq-000000000011' }] })), { service } = fixture;
  try {
    let unavailable = false;
    fixture.setHandler((request) => {
      if (unavailable) { request.fail(1, 'Snapshot transport refused'); return; }
      request.respond({ text: request.payload.action === 'history' ? Array(8).fill('Prefix SEARCH fixture suffix').join('\n') : 'Read-only remote snapshot', truncated: false });
    });
    const chatReads = [];
    service.chats.read = async (_host, _id, after, limit) => {
      chatReads.push({ after, limit });
      return { retainedFrom: 20, latestCursor: 250, hasMore: true, events: [{ type: 'message.completed', data: { role: 'assistant', text: 'SEARCH chat message' } }, { type: 'tool.completed', data: { name: 'Fixture tool', output: 'SEARCH tool output' } }, { type: 'error', data: { message: 'SEARCH error evidence' } }, { type: 'provider.event', data: {} }] };
    };
    service.terminals.preview = async (name) => name === units[0].id ? 'Local mirror snapshot' : null;
    for (const keys of [null, Array(17).fill(units[0].key), [units[0].key, units[0].key]]) await assert.rejects(service.terminalPreviews(keys), /16 unique/);
    for (const key of [null, 'x'.repeat(301)]) await assert.rejects(service.terminalPreviews([key]), /Invalid session key/);
    await assert.rejects(service.terminalPreviews(['default/tmux:missing']), /Session unavailable/);
    await assert.rejects(service.terminalPreviews(['ghost/tmux:hq-000000000011']), /Host is unavailable/);
    assert.deepEqual(await service.terminalPreviews([]), []);
    const values = await service.terminalPreviews(units.slice(0, 5).map((unit) => unit.key));
    assert.equal(values[0].text, 'Local mirror snapshot'); assert.equal(values[0].error, false);
    assert.equal(values[1].sampledAt, null); assert.equal(values[1].error, true);
    assert.match(values[2].text, /assistant: SEARCH chat message\nFixture tool: SEARCH tool output\nSEARCH error evidence/);
    assert.equal(values[3].text, 'Read-only remote snapshot'); assert.equal(values.length, 5);
    assert.ok(chatReads.some((request) => request.after === 150 && request.limit === 100));
    unavailable = true; const failed = await service.terminalPreviews([units[3].key]);
    assert.equal(failed[0].error, true); assert.equal(failed[0].sampledAt, null); assert.match(failed[0].text, /Snapshot unavailable/);
    for (const query of [null, 'ab', 'x'.repeat(201), 'bad\0query']) await assert.rejects(service.searchHistory(query, []), /3–200 characters/);
    for (const keys of [null, Array(201).fill(units[0].key)]) await assert.rejects(service.searchHistory('SEARCH', keys), /200 unit keys/);
    const failures = await service.searchHistory('SEARCH', [units[3].key]); assert.deepEqual(failures.errors, [units[3].key]);
    unavailable = false;
    const search = await service.searchHistory('search', [...units.map((unit) => unit.key), units[0].key]);
    assert.equal(search.total, 9); assert.equal(search.searched, 8); assert.equal(search.truncated, true);
    assert.equal(search.matches.filter((match) => match.key === units[0].key).length, 5);
    assert.ok(search.matches.some((match) => match.excerpt.includes('SEARCH error evidence')));
    assert.deepEqual(search.errors, []);
    assert.equal((await service.searchHistory('ABSENT', [units[0].key])).matches.length, 0);
    service.store.save('deletedSessions', [units[0].key]);
    await assert.rejects(service.terminalPreviews([units[0].key]), /Session unavailable/);
    assert.equal(fixture.calls.some((request) => !['preview', 'history'].includes(request.payload.action)), false, 'Read-only preview/search must not launch, attach, resize, or take control');
  } finally { fixture.close(); }
}

async function launchAdmission() {
  const fixture = serviceFixture(), { service } = fixture;
  try {
    service.chats.capabilities = async () => [{ provider: 'codex', status: 'supported' }];
    const valid = { provider: 'codex', transport: 'terminal', hostId: 'default' };
    const cases = [[null, /Invalid provider/], [{ provider: 'unknown' }, /Invalid provider/], [{ ...valid, transport: 'unknown' }, /Invalid session transport/], [{ ...valid, launchId: 'invalid' }, /Invalid launch ID/], [{ ...valid, presetId: 'missing' }, /Launch preset is unavailable/], [{ ...valid, agentId: 'saved', roeProfile: 'full' }, /keeps its original permission/], [{ ...valid, agentId: 'saved', transport: 'chat' }, /requires terminal mode/], [{ ...valid, recoverSitrep: false }, /Invalid SitRep recovery/], [{ ...valid, recoverSitrep: true }, /requires an owned worktree/]];
    for (const field of ['presetId', 'conversationId', 'agentId', 'instructions']) cases.push([{ provider: 'terminal', [field]: 'invalid' }, /do not accept agent launch options/]);
    const worktree = { operationId: 'a'.repeat(32), repository: '/fixture/repository', baseRef: 'main', slug: 'fixture' };
    for (const patch of [{ operationId: '' }, { slug: '' }, { slug: 'UpperCase' }, { repository: null }, { repository: 'x'.repeat(4097) }, { baseRef: null }, { baseRef: 'x'.repeat(201) }]) cases.push([{ ...valid, worktree: { ...worktree, ...patch } }, /Invalid isolated task/]);
    for (const input of [{ provider: 'terminal' }, { ...valid, conversationId: 'saved' }, { ...valid, agentId: 'saved' }]) cases.push([{ ...input, worktree }, /Invalid isolated task/]);
    for (const [input, message] of cases) await assert.rejects(service.create(input), message);
    await assert.rejects(service.create(valid, true), /Launch preset is unavailable/);
    assert.equal(fixture.calls.length, 0, 'Rejected admission must precede process creation');
    service.store.save('deletedSessions', ['default/codex:saved']);
    await assert.rejects(service.create({ ...valid, conversationId: 'saved', hostId: undefined }), /saved history has been deleted/);
    service.chats.capabilities = async () => [];
    await assert.rejects(service.create({ provider: 'codex', transport: 'chat' }), /Structured chat is unavailable/);
    assert.equal(fixture.calls.length, 0);
    fixture.setHandler((request) => request.respond(request.payload.action === 'inventory' ? { user: 'fixture', sessions: [] } : { name: 'hq-111111111111' }));
    for (const input of [{ ...valid, presetId: 'codex' }, { provider: 'antigravity', transport: 'terminal', presetId: 'antigravity' }, { ...valid, conversationId: 'fresh-saved-history' }, { ...valid, agentId: 'background-fixture' }, { ...valid, worktree, recoverSitrep: true }]) {
      assert.equal((await service.create(input)).name, 'hq-111111111111'); await service.inventory();
      const payload = fixture.calls.findLast((request) => ['create', 'worktree_launch'].includes(request.payload.action)).payload;
      assert.equal(payload.transport, 'terminal');
      if (input.conversationId) assert.equal(payload.conversationId, input.conversationId);
      if (input.agentId) assert.equal(payload.agentId, input.agentId);
      if (input.recoverSitrep) assert.equal(payload.recoverSitrep, true);
    }
    await assert.rejects(service.cleanup.preview({ provider: 'codex', hostId: 'disabled', days: 30 }), /Host is unavailable/);
  } finally { fixture.close(); }
}

async function permissionsAndDiffs() {
  const name = 'hq-111111111111', key = `default/tmux:${name}`, operationId = 'a'.repeat(32), fileId = 'b'.repeat(64);
  const fixture = serviceFixture((store) => store.save('cachedUnits', { default: [{ key, id: name, provider: 'claude', kind: 'managed', managed: true, canAttach: true, branch: 'cached-branch' }] })), { service, adapters } = fixture;
  const desktop = { id: 'desktop' }, observer = { id: 'phone' };
  let requests = [{ id: '1'.repeat(32), name, provider: 'claude', createdAt: 3, state: 'pending' }, { id: '2'.repeat(32), name: 'hq-222222222222', provider: 'claude', createdAt: 2, state: 'resolved', branch: 'reported-branch' }, { id: '3'.repeat(32), name: 'hq-333333333333', provider: 'claude', createdAt: 1, state: 'expired' }, null, { provider: 'codex' }, { provider: 'claude' }, { provider: 'claude', id: '4'.repeat(32) }];
  let offline = false;
  fixture.setHandler((request) => {
    if (offline) { request.fail(1, 'Host unavailable'); return; }
    request.respond(request.payload.action === 'flash_list' ? request.payload.localHost ? [] : requests : { accepted: true });
  });
  try {
    const first = service.flashQueue(), joined = service.flashQueue();
    const queue = await first; assert.deepEqual(await joined, queue);
    assert.deepEqual(queue.map((item) => item.createdAt), [1, 2, 3]);
    assert.deepEqual(queue.map((item) => item.branch), ['', 'reported-branch', 'cached-branch']);
    offline = true; assert.ok((await service.flashQueue()).every((item) => item.connected === false)); offline = false;
    const input = { hostId: 'default', name, id: '1'.repeat(32), decision: 'allow' };
    for (const value of [null, {}, { ...input, decision: 'unknown' }, { ...input, name: '' }, { ...input, id: '' }]) await assert.rejects(service.flashDecide(desktop, value), /Invalid Flash Traffic decision/);
    await assert.rejects(service.flashDecide(observer, input), /take control/i);
    const record = { owner: desktop, connection: 'reconnecting', exitCode: null };
    service.terminals.sessions.set(`default/${name}`, record);
    await assert.rejects(service.flashDecide(desktop, input), /disconnected or exited/);
    record.connection = 'connected'; record.exitCode = 1;
    await assert.rejects(service.flashDecide(desktop, input), /disconnected or exited/);
    record.exitCode = null;
    requests = []; await assert.rejects(service.flashDecide(desktop, input), /unavailable or expired/);
    requests = [{ ...input, state: 'expired' }]; await assert.rejects(service.flashDecide(desktop, input), /unavailable or expired/);
    requests = [{ ...input, state: 'pending', decision: 'deny' }]; await assert.rejects(service.flashDecide(desktop, input), /different decision/);
    requests = [{ ...input, provider: 'claude', createdAt: 1, state: 'pending', decision: null }];
    assert.deepEqual(await service.flashDecide(desktop, input), { accepted: true }); await service.flashQueue();
    requests[0].state = 'resolved'; requests[0].decision = 'allow';
    assert.deepEqual(await service.flashDecide(desktop, input), { accepted: true }); await service.flashQueue();
    for (const operation of [null, '', 'g'.repeat(32)]) assert.throws(() => service.archiveWorktree('default', operation), /Invalid worktree operation ID/);
    assert.deepEqual(await service.archiveWorktree('default', operationId), { accepted: true });
    const diff = { hostId: 'default', name, operationId, fileId, revision: 'c'.repeat(64), hunkId: 'd'.repeat(64), operation: 'stage' };
    for (const value of [null, {}, { ...diff, name: '' }, { ...diff, operationId: '' }]) assert.throws(() => adapters.diffRequest(desktop, value, 'diff_files'), /Invalid worktree diff request/);
    assert.throws(() => adapters.diffRequest(desktop, diff, 'unknown'), /Invalid worktree diff request/);
    for (const action of ['diff_detail', 'diff_hunk']) assert.throws(() => adapters.diffRequest(desktop, { ...diff, fileId: '' }, action), /Invalid changed file/);
    for (const patch of [{ revision: '' }, { hunkId: '' }, { operation: 'unknown' }]) assert.throws(() => adapters.diffRequest(desktop, { ...diff, ...patch }, 'diff_hunk'), /Invalid hunk action/);
    assert.throws(() => adapters.diffRequest(observer, diff, 'diff_hunk'), /Take control/);
    for (const action of ['diff_files', 'diff_detail', 'diff_hunk']) {
      assert.deepEqual(await adapters.diffRequest(desktop, diff, action), { accepted: true });
      const payload = fixture.calls.at(-1).payload; assert.equal(payload.action, action);
      assert.equal(Object.hasOwn(payload, 'fileId'), action !== 'diff_files');
      assert.equal(Object.hasOwn(payload, 'revision'), action === 'diff_hunk');
    }
    for (const key of [null, 'x'.repeat(301)]) assert.throws(() => service.devUrls(key), /Invalid session key/);
    for (const key of [null, 'default/tmux:external']) assert.throws(() => service.resetFault(key), /Invalid fault target/);
    service.terminals.sessions.clear();
  } finally { fixture.close(); }
}

async function settingsGuards() {
  const fixture = serviceFixture(), { service } = fixture;
  const current = () => structuredClone(service.store.data.settings);
  try {
    const saved = current(), isBusy = service.cleanup.isBusy;
    service.cleanup.isBusy = () => true;
    await assert.rejects(service.saveSettings(saved), /Wait for history cleanup/);
    service.cleanup.isBusy = isBusy;
    await assert.rejects(service.saveSettings(saved, 'stale-review'), (error) => error.beforeMutation === true && /Configuration changed/.test(error.message));
    service.terminals.opening.set('fixture', Promise.resolve());
    await assert.rejects(service.saveSettings(saved), /Wait for terminal connections/);
    service.terminals.opening.clear();
    for (const collection of [service.terminals.sessions, service.chats.sessions]) {
      collection.set('fixture', { hostId: 'default' });
      for (const change of ['remove', 'disable', 'retarget']) {
        const next = current();
        if (change === 'remove') next.hosts = next.hosts.filter((host) => host.id !== 'default');
        else if (change === 'disable') next.hosts.find((host) => host.id === 'default').enabled = false;
        else next.hosts.find((host) => host.id === 'default').target = 'replacement.invalid';
        await assert.rejects(service.saveSettings(next), /Close this host’s .* before changing its connection/);
        assert.deepEqual(current(), saved, 'Active view guards must reject before saving any settings');
      }
      const renamed = current(); renamed.hosts[0].name = 'Renamed fixture';
      await service.saveSettings(renamed);
      assert.equal(service.store.data.settings.hosts[0].name, 'Renamed fixture');
      await service.saveSettings(saved); collection.clear();
    }
    assert.equal(fixture.calls.length, 0, 'Settings validation must not spawn remote work');
  } finally { fixture.close(); }
}

(async () => { await health(); await transport(); await previews(); await launchAdmission(); await permissionsAndDiffs(); await settingsGuards(); console.log('PASS service health coalescing/deltas/GPU freshness/channel evidence, reconnect uncertainty, scoped host/launch/permission/diff admission, active-view settings guards, child errors/exit races, bounded helper output/timeouts, embedded payloads, read-only cached previews, and bounded mixed chat/terminal history search'); })().catch((error) => { console.error(error); process.exitCode = 1; });
