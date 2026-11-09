const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { centcomService } = require('./fixtures/centcom-service.cjs');
const { poll } = require('./fixtures/isolated-chat-ssh.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-c2-workflows-'));
let h;
(async () => {
  try {
    h = await centcomService(directory);
    const { service, action, query, repository } = h;
    fs.copyFileSync(path.join(__dirname, 'fixtures/github-cli.py'), path.join(h.remoteBin, 'gh')); fs.chmodSync(path.join(h.remoteBin, 'gh'), 0o700);
    fs.writeFileSync(path.join(h.home, 'github.json'), JSON.stringify({ commit: h.git('rev-parse', 'HEAD') }));
    fs.writeFileSync(path.join(h.home, 'settings.json'), JSON.stringify({ centcom: true, specopsHold: true }));
    const yaml = YAML.stringify({ version: 1, profiles: [{ id: 'worker', name: 'Fixture worker', provider: 'codex', model: 'fixture', ranks: ['officer'] }], workflows: [{ version: 1, id: 'adapter-workflow', name: 'Adapter workflow', trigger: 'github_issue', max_loop_retries: 2, max_steps: 5,
      stages: [{ id: 'implement', profile: 'worker', rank: 'officer', role: 'implementer', prompt_template: 'Hold for reviewed interruption', next: 'COMPLETE' }] }] });
    await action('specops.configure', { yaml });
    assert.ok((await query('specops.definition')).workflows.some((item) => item.id === 'adapter-workflow'));
    const mission = (await action('specops.launch', { workflowId: 'adapter-workflow', hostId: 'default', repository, repo: 'fixture/repo', issue: 69 })).result;
    await poll(() => service.specops.list().find((item) => item.id === mission.id)?.visits[0].sent, 'SPECOPS stage did not submit');
    assert.equal((await query('specops.inspect', { id: mission.id })).id, mission.id);
    const missionUnit = `default/tmux:${mission.visits[0].name}`;
    await action('unit.interrupt', { sessionKey: missionUnit });
    await poll(() => service.specops.list().find((item) => item.id === mission.id)?.state === 'halted', 'Interrupted SPECOPS stage did not halt');
    const retried = (await action('specops.control', { id: mission.id, action: 'retry' })).result;
    assert.equal(retried.visits.length, 2); assert.equal(retried.worktree.path, mission.worktree.path);
    assert.equal((await action('specops.control', { id: mission.id, action: 'cancel' })).result.state, 'cancelled');

    const exercise = (await action('exercise.create', { hostId: 'default', repository, baseRef: 'HEAD', title: 'Adapter comparison', prompt: 'write-reviewed-artifact', testCommand: "python3 -c 'print(\"EXERCISE_ADAPTER_OK\")'", contestants: [{ provider: 'codex' }, { provider: 'codex' }] })).result;
    assert.equal(exercise.state, 'running');
    const winner = exercise.contestants[0], selection = { id: exercise.id, contestantId: winner.id };
    assert.ok((await query('exercise.list')).some((item) => item.id === exercise.id));
    assert.equal((await query('exercise.inspect', selection)).active, true);
    await action('exercise.complete', selection);
    const verified = (await action('exercise.verify', selection)).result;
    assert.equal(verified.test.exitCode, 0); assert.match(verified.test.output, /EXERCISE_ADAPTER_OK/);
    const promotion = await query('exercise.preview', selection); assert.equal(promotion.ready, true);
    await action('exercise.control', { id: exercise.id, action: 'complete', contestantId: exercise.contestants[1].id });
    // Use the selected contestant as a real SitRep source before promotion.
    const source = { sessionKey: `default/tmux:${winner.name}`, operationId: winner.id, sourceHostId: 'default', targetHostId: 'default', repository, testCommand: '' };
    const inspected = await query('sitrep.inspect', source); assert.equal(inspected.ready, true);
    const preview = (await action('sitrep.preview', { ...source, testCommand: "python3 -c 'print(\"SITREP_ADAPTER_OK\")'" })).result;
    assert.equal(preview.ready, true); assert.equal(preview.test.exitCode, 0);
    const handoff = (await action('sitrep.handoff', { id: preview.id, operationId: crypto.randomBytes(16).toString('hex'), objective: 'Verify transferred artifact', summary: 'Reviewed exercise artifact', nextSteps: 'Inspect evidence.txt', title: 'Adapter handoff', slug: 'adapter-handoff', provider: 'codex' })).result;
    assert.equal(fs.readFileSync(path.join(handoff.worktree.path, 'evidence.txt'), 'utf8'), 'Reviewed bridge artifact\n');
    assert.equal(handoff.worktree.sitrepSource.operationId, winner.id);
    const promoted = (await action('exercise.promote', { ...selection, revision: verified.revision })).result;
    assert.equal(promoted.state, 'promoted');
    assert.equal(fs.readFileSync(path.join(repository, 'evidence.txt'), 'utf8'), 'Reviewed bridge artifact\n');
    h.assertCoverage('centcom-workflows.e2e');
    console.log('PASS actual SPECOPS configure/launch/inspect/retry/cancel, exercise verification/promotion, and SitRep inspect/tested preview/handoff adapters over SSH');
  } finally {
    if (h) {
      const artifacts = process.env.AGENTC2_SUITE_ARTIFACTS || path.join(os.tmpdir(), 'agentc2-centcom-workflow-evidence'); fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, 'operations.json'), JSON.stringify([...h.covered].sort(), null, 2));
      for (const file of ['sshd.log', 'home/requests.jsonl', 'home/centcom-prompts.jsonl', 'home/github-calls.jsonl', 'desktop/centcom/centcom.json']) if (fs.existsSync(path.join(directory, file))) fs.copyFileSync(path.join(directory, file), path.join(artifacts, path.basename(file)));
    }
    h?.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
