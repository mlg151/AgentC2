const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { centcomService } = require('./fixtures/centcom-service.cjs');
const { poll } = require('./fixtures/isolated-chat-ssh.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-c2-adapters-'));
let h, server;
(async () => {
  try {
    h = await centcomService(directory);
    const { service, query, action, repository } = h;
    server = http.createServer((_request, response) => response.end('Reviewed development fixture'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const devUrl = `http://127.0.0.1:${server.address().port}/fixture`;
    fs.writeFileSync(path.join(h.home, 'settings.json'), JSON.stringify({ centcom: true, devUrl }));
    fs.copyFileSync(path.join(__dirname, 'fixtures/github-cli.py'), path.join(h.remoteBin, 'gh'));
    fs.chmodSync(path.join(h.remoteBin, 'gh'), 0o700);
    fs.writeFileSync(path.join(h.home, 'github.json'), JSON.stringify({ commit: h.git('rev-parse', 'HEAD') }));

    const operationId = crypto.randomBytes(16).toString('hex');
    const launch = await action('unit.create', { hostId: 'default', provider: 'codex', transport: 'chat', title: 'Actual adapter worker', worktree: { operationId, repository, baseRef: 'HEAD', slug: 'adapters' } });
    const worker = launch.result, sessionKey = `default/tmux:${worker.name}`, target = { sessionKey }, tree = worker.worktree.path;
    await poll(async () => (await service.inventory()).sessions.find((item) => item.key === sessionKey && item.chatState === 'idle'), 'Worker readiness');
    // URL detection follows attached view events; keep a read-only observer
    // alive while the commander acquires and releases its action handle.
    const observer = { id: 'adapter-observer', name: 'Adapter observer', closed: false };
    const observerHandle = await service.chats.open(observer, worker.chatSessionId, 'default');
    await service.chats.ready(observer, observerHandle);
    await action('unit.send', { ...target, text: 'dev-server' });
    await poll(() => service.devUrls(sessionKey).some((item) => item.url === devUrl), 'Attached view did not detect the development URL');
    const urls = await query('devurl.list', target); assert.ok(urls.some((item) => item.url === devUrl));
    const opened = await action('devurl.open', { ...target, url: devUrl });
    assert.equal(await (await fetch(opened.result)).text(), 'Reviewed development fixture');
    service.chats.close(observer, observerHandle);

    const manifest = await query('capabilities.read', { operation: 'unit.send', schema: 'input' });
    assert.equal(manifest.version, 1);
    assert.equal((await query('capabilities.support', { operation: 'unit.send', sessionKey, provider: 'codex', transport: 'chat', hostId: 'default' })).entries[0].status, 'supported');
    assert.ok((await query('fleet.inspect')).sessions.some((item) => item.key === sessionKey));
    assert.ok((await query('units.list', { classification: 'managed' })).entries.some((item) => item.key === sessionKey));
    assert.equal((await query('unit.inspect', target)).control.eligible, true);
    assert.equal((await query('hosts.inspect', { hostId: 'default' })).hosts[0].connected, true);
    for (const section of ['definitions', 'presets', 'oporders', 'notes', 'handoffs']) assert.ok(Array.isArray((await query('context.read', { section })).entries));
    assert.equal((await query('admission.check', { hostId: 'default', cwd: tree })).status, 'blocked');
    assert.ok((await query('worktree.list', { hostId: 'default' })).some((item) => item.operationId === operationId));

    await action('unit.rename', { ...target, title: 'Reviewed adapter title' });
    assert.equal((await service.inventory()).sessions.find((item) => item.key === sessionKey).title, 'Reviewed adapter title');
    await action('unit.pin', { ...target, pinned: true });
    assert.equal(service.store.data.workspace.metadata[sessionKey].pinned, true);
    await action('unit.send', { ...target, text: 'write-reviewed-artifact' });
    assert.equal((await query('artifact.read', { hostId: 'default', operationId, path: 'evidence.txt' })).text, 'Reviewed bridge artifact\n');
    assert.ok((await query('unit.search', { keys: [sessionKey], query: 'Fixture wrote' })).matches.some((item) => item.key === sessionKey));
    const files = await query('diff.files', { ...target, operationId });
    const file = files.find((item) => item.path === 'evidence.txt'); assert.ok(file);
    let detail = await query('diff.detail', { ...target, operationId, fileId: file.id });
    await action('diff.hunk', { ...target, operationId, fileId: file.id, revision: detail.revision, hunkId: detail.unstaged[0].id, operation: 'stage' });
    assert.match(execFileSync('git', ['-C', tree, 'diff', '--cached'], { encoding: 'utf8' }), /Reviewed bridge artifact/);

    await action('unit.send', { ...target, text: 'question' });
    let inspected = await query('unit.inspect', target);
    let pending = inspected.pendingRequests[0]; assert.equal(pending.type, 'question.requested');
    await action('chat.respond', { ...target, requestId: pending.requestId, turnId: pending.turnId, itemId: pending.itemId, answers: [{ questionId: 'choice', answers: ['Two'] }] });
    assert.match(fs.readFileSync(path.join(h.home, 'answers.json'), 'utf8'), /Two/);
    await action('unit.send', { ...target, text: 'approval' });
    pending = (await query('unit.inspect', target)).pendingRequests[0]; assert.equal(pending.type, 'approval.requested');
    const stale = await h.stage('chat.respond', { ...target, requestId: pending.requestId, turnId: pending.turnId, itemId: pending.itemId, decision: 'allow' });
    await action('chat.respond', { ...target, requestId: pending.requestId, turnId: pending.turnId, itemId: pending.itemId, decision: 'deny' });
    assert.equal(fs.existsSync(path.join(h.home, 'approved.txt')), false);
    assert.equal((await h.decide(stale)).state, 'failed', 'Resolved native approval must invalidate earlier review');
    await action('unit.send', { ...target, text: 'hold' });
    inspected = await query('unit.inspect', target);
    await action('unit.steer', { ...target, text: 'Reviewed steering', expectedTurnId: inspected.currentTask.turnId });
    await action('unit.interrupt', target);
    assert.equal((await query('unit.inspect', target)).runtime.state, 'idle');


    const order = { version: 1, id: 'adapter-order', hostId: 'default', repository, instructions: 'Reviewed adapter instructions', mcp: [] };
    let preview = await query('oporder.preview', { order }); assert.equal(preview.ready, true);
    const staleOrder = await h.stage('oporder.enroll', { order, revision: preview.revision });
    fs.writeFileSync(path.join(repository, 'AGENTS.md'), 'Concurrent repository guidance\n');
    assert.equal((await h.decide(staleOrder)).state, 'failed');
    assert.equal(service.store.data.settings.opOrders.length, 0);
    preview = await query('oporder.preview', { order });
    await action('oporder.enroll', { order, revision: preview.revision });
    assert.match(fs.readFileSync(path.join(repository, 'AGENTS.md'), 'utf8'), /Reviewed adapter instructions/);
    const settings = await query('configuration.inspect');
    await action('configuration.save', { settings: { presets: settings.presets } });
    const payload = { id: 'adapter-preset', name: 'Adapter preset', provider: 'codex', command: 'codex', args: '', fullPermissions: false };
    assert.ok(await query('automation.validate', { kind: 'preset', payload }));
    assert.ok((await query('automation.preview', { kind: 'preset', payload })).revision);
    const draftState = await h.submit({ automations: [{ id: 'adapter-draft', kind: 'preset', title: 'Reviewed adapter preset', rationale: 'Verified operation evidence', evidence: [], payload }] });
    const draft = draftState.automations.find((item) => item.clientRequestId === 'adapter-draft');
    await action('automation.apply', { id: draft.id });
    assert.equal((await query('automation.read', { id: draft.id })).matchesDraft, true);

    const github = { hostId: 'default', repo: 'fixture/repo', repository };
    assert.equal((await query('github.readiness', github)).login, 'fixture');
    assert.equal((await query('github.issue', { ...github, issue: 69 })).number, 69);
    assert.equal((await query('github.issues', { ...github, query: 'is:open' }))[0].number, 69);
    const pr = await query('github.pr', { ...github, number: 70 });
    await action('github.ready', { ...github, number: 70, headCommit: pr.headRefOid, expectedBranch: pr.headRefName });
    await action('github.close', { ...github, number: 69, updatedAt: '2026-01-01T00:00:00Z', evidence: { commit: h.git('rev-parse', 'HEAD'), summary: 'Fixture artifact and isolated regressions verified.' } });
    assert.ok(fs.existsSync(path.join(h.home, 'github-ready.json')) && fs.existsSync(path.join(h.home, 'github-close.json')));
    const plan = structuredClone(service.centcom.capabilities().find((item) => item.operation === 'mission.update').examples[0].request.params.input);
    plan.plan.owners[0].sessionKey = sessionKey;
    await action('mission.update', plan);
    assert.ok((await query('missions.read')).entries.length);
    assert.ok((await query('mission.inspect', { id: `coordination:${plan.id}`, section: 'links' })).entries.length);
    assert.ok((await query('history.read', { operation: 'unit.send' })).entries.length);
    assert.ok((await query('outcomes.read', { collection: 'directive' })).entries.length);

    // The worktree fixture's known edit is discarded only after all mutation
    // adapters have been verified, then the real stop/archive/delete paths run.
    execFileSync('git', ['-C', tree, 'reset', '--hard', 'HEAD']);
    await action('unit.stop', target);
    await action('worktree.archive', { hostId: 'default', operationId });
    assert.equal(fs.existsSync(tree), false);
    const deletionDirectory = path.join(h.home, 'delete-fixture'); fs.mkdirSync(deletionDirectory);
    const removable = (await action('unit.create', { hostId: 'default', provider: 'codex', transport: 'chat', cwd: deletionDirectory, title: 'Deletion fixture' })).result;
    await poll(async () => (await service.inventory()).sessions.some((item) => item.id === removable.name && item.chatState === 'idle'), 'Deletion fixture readiness');
    await action('unit.delete', { sessionKey: `default/tmux:${removable.name}` });
    assert.ok(service.store.data.deletedSessions.includes(`default/tmux:${removable.name}`));
    const evidence = [...h.covered].sort();
    h.assertCoverage('centcom-adapters.e2e');
    const artifacts = process.env.AGENTC2_SUITE_ARTIFACTS || path.join(os.tmpdir(), 'agentc2-centcom-adapter-evidence'); fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, 'operations.json'), JSON.stringify(evidence, null, 2));
    console.log(`PASS ${evidence.length} actual production CENTCOM adapters over isolated SSH`);
  } finally {
    if (h) {
      const artifacts = process.env.AGENTC2_SUITE_ARTIFACTS || path.join(os.tmpdir(), 'agentc2-centcom-adapter-evidence'); fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, 'operations.json'), JSON.stringify([...h.covered].sort(), null, 2));
      for (const file of ['sshd.log', 'home/requests.jsonl', 'home/centcom-prompts.jsonl', 'home/github-calls.jsonl', 'desktop/centcom/centcom.json']) {
        if (fs.existsSync(path.join(directory, file))) fs.copyFileSync(path.join(directory, file), path.join(artifacts, path.basename(file)));
      }
    }
    h?.close(); server?.closeAllConnections(); if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
