const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEvidence } = require('../electron/centcom-evidence.cjs');
const { activeFleet } = require('../electron/centcom-fleet.cjs');
const { fixture, action, query, envelope, desktop } = require('./fixtures/centcom.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-evidence-'));
const f = fixture(directory);
const evidence = createEvidence({ service: f.service, isCommander: (...args) => f.engine.isCommander(...args), activeKeys: async (inv) => activeFleet(inv, f.state.deletedSessions).keys });
const health = () => [{ hostId: 'alpha', connected: true, sampledAt: Date.now(), cpuPercent: 25, memoryTotal: 8 * 1024 ** 3, memoryUsed: 2 * 1024 ** 3,
  resources: { status: 'reported', memoryLimitStatus: 'limited', memoryLimitBytes: 2 * 1024 ** 3, memoryHeadroomBytes: 1024 ** 3, cpuLimitStatus: 'limited', cpuLimitCores: 2, pressure: { memory: { some: { avg10: 0 } } } } }];

(async () => {
  try {
    f.service.health = async () => health();
    f.service.worktrees = async () => [];
    await f.engine.start();
    const first = f.sessions[0];
    for (const unit of f.sessions) unit.cwd = `/isolated/${unit.id}`;
    first.providerSessionId = 'shared-native'; first.cwd = '/one/project'; first.headCommit = 'a'.repeat(40); first.roeProfile = 'gated';
    f.sessions[6].id = 'shared-native'; f.sessions[6].key = 'alpha/codex:shared-native';
    f.sessions[8].providerSessionId = 'shared-native';
    f.state.workspace = { metadata: { [first.key]: { notes: 'handoff token=private-value', project: 'Issue 69' } } };
    let listed = await evidence.units({ limit: 50 });
    const canonical = listed.entries.find((u) => u.key === first.key);
    assert.equal(canonical.relationship.representations.length, 2);
    assert.equal(listed.entries.filter((u) => u.relationship.providerSessionId === 'shared-native').length, 2, 'Native IDs on different hosts are separate identities');
    assert.deepEqual(new Set(canonical.classifications), new Set(['managed', 'saved']));
    assert.equal(canonical.execution, 'idle');
    assert.ok(!JSON.stringify(listed).includes('private-value'));
    assert.ok(!JSON.stringify(listed).includes(f.engine.state().session.chatSessionId));
    assert.ok(!JSON.stringify(listed).includes(f.state.deletedSessions[0]));
    assert.ok(listed.entries.some((u) => u.classification === 'external'));
    assert.ok(listed.entries.some((u) => u.classification === 'saved'));
    assert.ok(listed.entries.some((u) => u.freshness.status === 'stale' && u.execution === 'unknown'));
    const p1 = await evidence.units({ limit: 1 });
    const p2 = await evidence.units({ limit: 1, after: p1.cursor });
    assert.notEqual(p1.entries[0].id, p2.entries[0].id);
    assert.ok(p1.hasMore);
    assert.equal((await evidence.units({ classification: 'external' })).entries.length, 1);
    await assert.rejects(evidence.units({ limit: 100 }), /page limit/);
    await assert.rejects(evidence.units({ execution: 'live' }), /execution filter/);
    first.chatState = undefined; first.activity = undefined;
    assert.equal((await evidence.inspect({ sessionKey: first.key })).execution, 'unknown', 'Process liveness must not imply progress');
    first.chatState = 'idle';

    const handle = await f.chats.open(desktop, first.chatSessionId, 'alpha');
    await f.chats.take(desktop, handle);
    const beforeHandles = f.chats.handles.size;
    const detail = await evidence.inspect({ sessionKey: first.key });
    assert.equal(detail.control.ownership.controller.id, desktop.id);
    assert.equal(detail.capabilities.status, 'supported');
    assert.deepEqual(detail.pendingRequests, []);
    assert.equal(f.chats.handles.size, beforeHandles, 'Inspection cannot create a control handle');
    assert.equal(f.chats.state(desktop, handle).controller.id, desktop.id);
    assert.equal(detail.headCommit, 'a'.repeat(40));
    const sourceTimestamp = new Date().toISOString();
    f.journals.set(first.chatSessionId, [{ protocolVersion: 1, sessionId: first.chatSessionId, sequence: 1, timestamp: sourceTimestamp, provider: 'codex', providerSessionId: 'shared-native', turnId: 'task-turn', itemId: null, type: 'message.completed', data: { role: 'user', text: 'Verify the acceptance artifact' } }]);
    const transport = f.chats.remote;
    f.chats.remote = async (...args) => {
      const result = await transport(...args);
      if (args[1].action === 'history' && args[1].sessionId === first.chatSessionId) result.pendingRequests = [{ requestId: 'question-one', turnId: 'task-turn', itemId: 'question-item', type: 'question', state: 'pending', questions: [{ id: 'choice', question: 'Select the target', options: ['A', 'B'], multiple: false }] }];
      return result;
    };
    const task = await evidence.inspect({ sessionKey: first.key });
    assert.equal(task.currentTask.text, 'Verify the acceptance artifact');
    assert.equal(task.currentTask.sourceTimestamp, sourceTimestamp);
    assert.equal(task.pendingRequests[0].requestId, 'question-one');
    assert.equal(f.chats.state(desktop, handle).controller.id, desktop.id);
    f.chats.remote = transport;
    const stopped = await evidence.inspect({ sessionKey: f.sessions[2].key });
    assert.equal(stopped.execution, 'stopped');
    assert.equal(stopped.control.eligible, false);
    await assert.rejects(evidence.inspect({ sessionKey: f.engine.state().session.key }), /CENTCOM/);

    const host = (await evidence.hosts({ hostId: 'alpha' })).hosts[0];
    assert.equal(host.headroom.memoryBytes, 1024 ** 3);
    assert.equal(host.health.resources.cpuLimitCores, 2);
    assert.equal(host.capabilities.length, 4);
    f.service.health = async () => { throw new Error('offline'); };
    assert.equal((await evidence.hosts({ hostId: 'alpha' })).hosts[0].headroom.status, 'unknown');
    f.service.health = async () => health();
    f.state.settings.opOrders = [{ id: 'existing-order', enabled: true }];
    f.state.opOrderConflicts = { 'existing-order': { detail: 'Changed file' } };
    assert.equal((await evidence.context({ section: 'oporders' })).entries[0].conflict.detail, 'Changed file');
    assert.ok(!JSON.stringify(await evidence.context({ section: 'notes' })).includes('private-value'));

    assert.equal((await evidence.admission({ hostId: 'alpha', cwd: '/two/project' })).status, 'admitted', 'Matching repository basenames do not prove overlap');
    assert.equal((await evidence.admission({ hostId: 'alpha', cwd: '/one/project' })).status, 'blocked');
    const launchPaths = f.service.commanderLaunchPaths;
    f.service.commanderLaunchPaths = async (...args) => ({ ...(await launchPaths(...args)), cwd: '/one/project' });
    assert.equal((await evidence.admission({ hostId: 'alpha', cwd: '/alias/project' })).status, 'blocked', 'Canonical aliases must be recognized as the same assignment');
    f.service.commanderLaunchPaths = launchPaths;
    assert.equal((await evidence.admission({ hostId: 'offline', cwd: '/two/project' })).status, 'blocked');
    f.service.worktrees = async () => [{ operationId: 'b'.repeat(32), state: 'launched' }];
    assert.equal((await evidence.admission({ hostId: 'alpha', worktree: { operationId: 'b'.repeat(32) } })).status, 'blocked');
    f.service.worktrees = async () => [];

    const count = () => f.calls.filter((c) => c.operation === 'create').length;
    const before = count();
    const [proposal] = await f.propose([action('unit.create', { hostId: 'alpha', provider: 'codex', cwd: '/two/project' })]);
    assert.equal(proposal.admission.status, 'admitted');
    assert.equal(count(), before, 'Gated inspection and staging must not launch');
    f.service.health = async () => [{ ...health()[0], resources: { ...health()[0].resources, memoryHeadroomBytes: 1024 } }];
    await f.engine.decideDirective(proposal.id, 'approve');
    assert.equal(count(), before, 'Admission must revalidate memory immediately before dispatch');
    assert.equal(f.engine.state().directives.find((d) => d.id === proposal.id).state, 'failed');
    await f.engine.configure({ ...f.engine.state().config, authority: 'autonomous' });
    f.service.health = async () => { throw new Error('Health unavailable'); };
    const [unknown] = await f.propose([action('unit.create', { hostId: 'alpha', provider: 'codex', cwd: '/three/project' })]);
    assert.equal(unknown.state, 'pending', 'Incomplete headroom requires review even in Autonomous C2');
    assert.equal(count(), before);
    await f.engine.decideDirective(unknown.id, 'approve');
    assert.equal(count(), before + 1);

    // Bounded artifact pages redact before slicing, so a credential crossing a
    // page boundary cannot leak in the following page.
    const remote = f.service.runRemote;
    f.service.runRemote = async (payload, hostId) => payload.action === 'artifact_read' ? { path: payload.path, revision: 'b'.repeat(64), sizeBytes: 50, text: 'prefix token=private-value end of artifact' } : remote(payload, hostId);
    // The facade closes over the original transport; exercise it independently.
    const { commanderFacade } = require('../electron/commander.cjs');
    const facade = commanderFacade({ chats: f.chats, terminals: {}, runRemote: f.service.runRemote, getHost: (id) => ({ id }) });
    const artifact = await facade.commanderArtifact({ hostId: 'alpha', operationId: 'c'.repeat(32), path: 'result.txt', limit: 10 });
    const continuation = await facade.commanderArtifact({ hostId: 'alpha', operationId: 'c'.repeat(32), path: 'result.txt', revision: artifact.revision, offset: artifact.nextOffset });
    assert.ok(!JSON.stringify([artifact, continuation]).includes('private-value'));
    assert.ok(artifact.truncated); assert.ok(artifact.redacted);
    assert.match(artifact.revision, /^[a-f0-9]{64}$/);
    f.service.runRemote = remote;
    f.responses.push(envelope({ queries: [query('units.list', { classification: 'saved' }), query('hosts.inspect', { hostId: 'alpha' }), query('context.read', { section: 'oporders' })] }));
    await f.engine.submit('Inspect operational evidence');
    assert.match(f.submitted.at(-1).payload.text, /existing-order/);
    assert.match(f.submitted.at(-1).payload.text, /shared-native/);
    console.log('PASS canonical inspection, pagination, stale/unknown evidence, read-only ownership, headroom, reusable context, admission revalidation, artifact bounds/redaction, and commander query delivery');
  } finally { f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
