const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, action, query, envelope } = require('./fixtures/centcom.cjs');
const { outputSchema } = require('../electron/centcom-output.cjs');
const { validate } = require('../electron/centcom-schema.cjs');
const { createMissions } = require('../electron/centcom-missions.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-missions-'));
const f = fixture(directory);
const disk = () => JSON.parse(fs.readFileSync(path.join(directory, 'centcom.json')));
let requestId = 0;
async function read(operation, input = {}) {
  const id = `mission-read-${++requestId}`;
  f.responses.push(envelope({ queries: [{ ...query(operation, input), id }] }));
  await f.engine.submit('Read mission evidence');
  const row = f.engine.outcomes({ clientRequestId: id }).entries.at(-1);
  assert.equal(row.status, 'ok', row.message);
  const schema = outputSchema(operation); validate(schema, row.result, schema.$defs);
  return row.result;
}
async function proposal(plan, expectedRevision = null, id = 'mission', decision = 'approve') {
  const [record] = await f.propose([action('mission.update', { id, expectedRevision, plan }, { id: `mission-request-${++requestId}` })]);
  if (decision) await f.engine.decideDirective(record.id, decision);
  return f.engine.state().directives.find((item) => item.id === record.id);
}

(async () => {
  try {
    await f.engine.start();
    const target = f.sessions[0];
    const plan = { title: 'Issue delivery token=private-mission-token',
      links: [{ key: 'mission', kind: 'mission', externalId: 'delivery-69' }, { key: 'issue', kind: 'issue', externalId: '69', repository: 'owner/repo' },
        { key: 'pr', kind: 'pr', externalId: '70', repository: 'owner/repo', revision: 'a'.repeat(40) }, { key: 'job', kind: 'job', externalId: 'quality-gate-12' },
        { key: 'artifact', kind: 'artifact', externalId: 'report.txt', hostId: 'alpha', repository: '/repo', revision: 'b'.repeat(64) }],
      owners: [{ sessionKey: target.key, linkKeys: ['mission', 'issue', 'pr', 'job', 'artifact'] }],
      dependencies: [{ linkKey: 'pr', requires: ['job', 'artifact'], status: 'unknown', evidenceOutcomeIds: [] }],
      acceptanceCriteria: [{ id: 'verified', text: 'The report covers all reviewed issue criteria', linkKeys: ['issue', 'artifact'], status: 'unverified', evidenceOutcomeIds: [] }],
      blockers: [{ id: 'tests', text: 'Verification has not run', linkKeys: ['job'] }],
      nextActions: [{ id: 'inspect', text: 'Inspect the report and verification receipts', linkKeys: ['artifact', 'job'] }] };
    const staged = await proposal(plan, null, 'mission', null);
    assert.equal(staged.state, 'pending'); assert.deepEqual(disk().coordination, []);
    await f.engine.decideDirective(staged.id, 'deny');
    assert.deepEqual(disk().coordination, [], 'Denial cannot create a coordination record');
    const saved = await proposal(plan);
    assert.equal(saved.state, 'completed', saved.error);
    const persisted = disk().coordination[0];
    assert.equal(persisted.id, 'mission');
    assert.match(persisted.revision, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(persisted).includes('private-mission-token'));
    assert.equal(f.calls.filter((call) => call.operation === 'create').length, 1, 'Recording coordination must not launch a worker');
    const list = await read('missions.read', { linkKind: 'issue', linkId: '69', sessionKey: target.key });
    assert.equal(list.entries.length, 1); assert.equal(list.entries[0].id, 'coordination:mission');
    assert.equal(list.entries[0].projectAcceptance, 'unverified');
    const inspect = (section, extra = {}) => read('mission.inspect', { id: 'coordination:mission', section, ...extra });
    for (const section of ['links', 'owners', 'dependencies', 'acceptanceCriteria', 'blockers', 'nextActions']) {
      const result = await inspect(section);
      assert.ok(result.entries.length); assert.equal(result.revision, persisted.revision);
      assert.equal(result.projectAcceptance, 'unverified');
    }
    const owner = (await inspect('owners')).entries[0];
    assert.equal(owner.observation.processId, target.processId);
    assert.match(owner.control, /not mutation authority/);

    // Revisions and process incarnation are rechecked at approval, including
    // proposals staged against the same previous revision.
    const a = await proposal({ ...plan, title: 'Plan A' }, persisted.revision, 'mission', null);
    const b = await proposal({ ...plan, title: 'Plan B' }, persisted.revision, 'mission', null);
    await f.engine.decideDirective(a.id, 'approve');
    await f.engine.decideDirective(b.id, 'approve');
    assert.equal(f.engine.state().directives.find((r) => r.id === b.id).state, 'failed');
    assert.equal(disk().coordination[0].plan.title, 'Plan A');
    const incarnation = await proposal(plan, disk().coordination[0].revision, 'mission', null);
    target.startedAt = '2026-02-01T00:00:00.000Z';
    await f.engine.decideDirective(incarnation.id, 'approve');
    assert.equal(f.engine.state().directives.find((r) => r.id === incarnation.id).state, 'failed');
    target.startedAt = '2026-01-01T00:00:00.000Z';

    for (const change of [
      (p) => p.links.push(p.links[0]),
      (p) => p.owners[0].linkKeys.push('missing'),
      (p) => p.dependencies.push({ linkKey: 'job', requires: ['pr'], status: 'unknown', evidenceOutcomeIds: [] }),
      (p) => p.acceptanceCriteria[0].status = 'claimed_satisfied',
      (p) => p.acceptanceCriteria[0].status = 'verified',
      (p) => p.acceptanceCriteria[0].evidenceOutcomeIds.push('unknown-outcome'),
      (p) => p.owners[0].sessionKey = f.sessions[7].key,
      (p) => p.owners[0].sessionKey = f.engine.state().session.key,
    ]) {
      const invalid = structuredClone(plan); change(invalid);
      const previous = JSON.stringify(disk().coordination);
      const rejected = await proposal(invalid, disk().coordination[0].revision);
      assert.equal(rejected.state, 'failed', rejected.error);
      assert.equal(JSON.stringify(disk().coordination), previous);
    }

    // A receipt can support a claim without upgrading it to independent project
    // acceptance. Save the source identity/facts, not arbitrary result contents.
    const [pin] = await f.propose([action('unit.pin', { sessionKey: target.key, pinned: true })]);
    await f.engine.decideDirective(pin.id, 'approve');
    const evidence = f.engine.outcomes({ collection: 'directive', serverId: pin.id }).entries.at(-1);
    const claimed = structuredClone(plan);
    claimed.acceptanceCriteria[0].status = 'claimed_satisfied'; claimed.acceptanceCriteria[0].evidenceOutcomeIds = [evidence.outcomeId];
    assert.equal((await proposal(claimed, disk().coordination[0].revision)).state, 'completed');
    const cited = (await inspect('evidence')).entries[0];
    assert.equal(cited.outcomeId, evidence.outcomeId); assert.equal(cited.serverId, pin.id);
    assert.equal(cited.facts.projectAcceptance, 'unverified');
    assert.match(cited.interpretation, /unverified/);
    assert.equal((await inspect('acceptanceCriteria')).entries[0].status, 'claimed_satisfied');
    const beforeRestart = disk().coordination[0];
    target.state = 'exited'; target.chatState = 'stopped';
    f.engine.dispose(); f.start();
    assert.deepEqual(disk().coordination[0], beforeRestart);
    assert.equal((await inspect('owners')).entries[0].observation.state, 'exited');
    assert.equal((await proposal(claimed, beforeRestart.revision)).state, 'failed', 'Historical responsibility does not authorize an inactive owner');
    target.state = 'live'; target.chatState = 'idle';

    // Native source links are read from persisted service records, never guessed
    // from titles. SPECOPS itself tests source extraction from its real run store.
    f.missions.push({ id: 'native-mission', hostId: 'alpha', repo: 'owner/repo', repository: '/repo', state: 'halted', stage: 'review', error: 'Review denied',
      sourceLinks: [{ key: 'issue-52', kind: 'issue', externalId: '52', repository: 'owner/repo' }], publication: { number: 12, headRefOid: 'a'.repeat(40) },
      workflow: { name: 'Misleading title #999', stages: [{ id: 'review', transitions: { on_approve: 'COMPLETE', on_deny: 'implement' } }] },
      visits: [{ id: 'visit-one', stage: 'review', name: target.name, sessionId: target.chatSessionId, sendId: 'send-one', outcome: 'DENY', completion: { outcome: 'completed' }, output: 'Review artifact token=private-native-token' }] });
    f.exercises.push({ id: 'exercise-one', hostId: 'alpha', repository: '/repo', title: 'Comparison', state: 'partial', testCommand: 'npm test', contestants: [{ id: 'contestant-one', provider: 'codex', name: target.name, state: 'launched', error: 'Verification pending', markedComplete: true, evidence: { revision: 'c'.repeat(64), test: { command: 'npm test', exitCode: 0 } } }] });
    const native = await read('missions.read', { linkKind: 'issue', linkId: '52' });
    assert.equal(native.entries[0].id, 'specops:native-mission');
    assert.equal((await read('missions.read', { linkKind: 'issue', linkId: '999' })).entries.length, 0);
    const nativeRead = (section, id = 'specops:native-mission') => read('mission.inspect', { id, section });
    assert.ok((await nativeRead('links')).entries.some((link) => link.kind === 'pr' && link.externalId === '12'));
    assert.equal((await nativeRead('jobs')).entries[0].providerCompletion, 'completed');
    assert.equal((await nativeRead('jobs')).entries[0].outcome, 'DENY');
    assert.equal((await nativeRead('artifacts')).entries[0].projectAcceptance, 'unverified');
    assert.equal((await nativeRead('dependencies')).entries[0].transitions.on_deny, 'implement');
    assert.equal((await nativeRead('blockers')).entries[0].text, 'Review denied');
    assert.equal((await nativeRead('nextActions')).entries[0].stage, 'review');
    assert.equal((await nativeRead('acceptanceCriteria', 'exercise:exercise-one')).entries[0].status, 'unverified');
    assert.equal((await nativeRead('artifacts', 'exercise:exercise-one')).entries[0].evidence.test.exitCode, 0);
    assert.ok((await nativeRead('links', 'exercise:exercise-one')).entries.some((link) => link.kind === 'artifact'));
    const commander = f.engine.state().session;
    f.missions[0].visits.push({ id: 'commander-visit', name: commander.name, sessionId: commander.chatSessionId, output: 'Private commander evidence' });
    const visibleJobs = await nativeRead('jobs');
    assert.ok(!JSON.stringify(visibleJobs).includes(commander.chatSessionId));
    assert.ok(!JSON.stringify(visibleJobs).includes('commander-visit'));
    assert.ok(!(await nativeRead('links')).entries.some((link) => link.externalId.includes('commander-visit')));

    // Section paging preserves identities/revisions and refuses mixing revisions.
    let page = await inspect('links', { limit: 1 });
    const keys = page.entries.map((entry) => entry.key), revision = page.revision;
    while (page.hasMore) { page = await inspect('links', { limit: 1, after: page.cursor, revision }); keys.push(...page.entries.map((entry) => entry.key)); }
    assert.equal(new Set(keys).size, 5);
    await proposal({ ...claimed, title: 'Changed after snapshot' }, revision);
    f.responses.push(envelope({ queries: [{ ...query('mission.inspect', { id: 'coordination:mission', section: 'links', revision }), id: 'stale-mission-read' }] }));
    await f.engine.submit('Reject a stale mission snapshot');
    assert.match(f.engine.outcomes({ clientRequestId: 'stale-mission-read' }).entries.at(-1).error, /revision changed/);
    await f.engine.configure({ ...f.engine.state().config, authority: 'autonomous' });
    const autonomous = await proposal({ ...plan, title: 'Autonomous operational assignment' }, null, 'autonomous', null);
    assert.equal(autonomous.state, 'completed');
    assert.ok(disk().coordination.some((record) => record.id === 'autonomous'));
    const large = structuredClone(plan);
    large.acceptanceCriteria = Array.from({ length: 30 }, (_, i) => ({ id: `criterion-${i}`, text: 'x'.repeat(1000), linkKeys: ['issue'], status: 'unverified', evidenceOutcomeIds: [] }));
    const tooLarge = await proposal(large, null, 'too-large', null);
    assert.equal(tooLarge.state, 'failed'); assert.match(tooLarge.validationError, /24,000 bytes/);

    // Direct read-only projection tests enforce byte bounds, no gaps, stale-read
    // refusal, and retained-record limits without creating more provider turns.
    const readState = { coordination: Array.from({ length: 100 }, (_, i) => ({ ...beforeRestart, id: `record-${String(i).padStart(3, '0')}` })), outcomes: [] };
    const projection = createMissions({ state: readState, service: f.service, inventory: f.service.inventory, isCommander: f.engine.isCommander, persist: () => { throw new Error('Unexpected read mutation'); } });
    assert.throws(() => projection.validate({ id: 'overflow', expectedRevision: null, plan }), /100 coordination records/);
    const manyCitations = structuredClone(plan);
    manyCitations.acceptanceCriteria = Array.from({ length: 6 }, (_, i) => ({ id: `c-${i}`, text: 'Cited evidence', linkKeys: ['issue'], status: 'unverified', evidenceOutcomeIds: Array.from({ length: 10 }, (_, j) => `citation-${i}-${j}`) }));
    assert.throws(() => projection.validate({ id: 'record-000', expectedRevision: beforeRestart.revision, plan: manyCitations }), /50 distinct outcome citations/);
    let cursor = '', seen = [];
    do {
      const result = await projection.read({ kind: 'coordination', after: cursor, limit: 50 });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 10000);
      seen.push(...result.entries.map((item) => item.id)); cursor = result.cursor;
      if (!result.hasMore) break;
    } while (true);
    assert.equal(new Set(seen).size, 100);
    const longEvidence = f.exercises[0].contestants[0].evidence;
    longEvidence.test.output = 'x'.repeat(20000);
    const partial = await projection.inspect({ id: 'exercise:exercise-one', section: 'artifacts' });
    assert.equal(partial.entries[0].partial, true); assert.ok(partial.entries[0].id);
    assert.ok(Buffer.byteLength(JSON.stringify(partial)) < 10000);
    console.log('PASS durable mission links, reviewed revision/identity binding, typed dependencies/criteria, evidence claims, native jobs/artifacts, restart, read-only paging, and authority modes');
  } finally { f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
