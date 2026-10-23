const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, action, query, envelope } = require('./fixtures/centcom.cjs');
const { Store } = require('../electron/config.cjs');
const { readHistory, summarizeAction } = require('../electron/centcom-history.cjs');
const { validate } = require('../electron/centcom-schema.cjs');
const { outputSchema } = require('../electron/centcom-output.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-history-'));
const f = fixture(directory);
const contract = outputSchema('history.read');
let queryId = 0;
async function read(input = {}) {
  const id = `history-query-${++queryId}`;
  f.responses.push(envelope({ queries: [{ ...query('history.read', input), id }] }));
  await f.engine.submit('Inspect observed actions without changing the fleet');
  const result = f.engine.outcomes({ collection: 'query', clientRequestId: id }).entries.at(-1).result;
  validate(contract, result, contract.$defs);
  return result;
}
async function propose(request, decision) {
  const [record] = await f.propose([request]);
  if (decision) await f.engine.decideDirective(record.id, decision);
  return record;
}

(async () => {
  try {
    await f.engine.start();
    const target = f.sessions[0];
    const store = new Store(path.join(directory, 'workspace'));
    let mutations = 0;
    f.service.setSessionPinned = (key, pinned) => { mutations++; return store.setSessionPinned(key, pinned); };
    const pin = (id, summary = 'Review recurring reports') => action('unit.pin', { sessionKey: target.key, pinned: true }, { id, summary });
    const first = await propose(pin('first', 'Report token=private-history-token'), 'approve');
    const second = await propose(pin('second', 'A completely different title'), 'approve');
    const denied = await propose(pin('denied'), 'deny');
    const pending = await propose(pin('pending'));
    const originalPin = f.service.setSessionPinned;
    f.service.setSessionPinned = () => { throw new Error('Receipt lost token=private-history-token'); };
    const uncertain = await propose(pin('uncertain'), 'approve');
    f.service.setSessionPinned = originalPin;
    // Replaying a client request cannot inflate the observed repetition count.
    f.responses.push(envelope({ directives: [pin('first', 'Report token=private-history-token')] }));
    await f.engine.submit('Retry the same request');
    assert.equal(mutations, 2);
    const rows = await read({ sessionKey: target.key });
    assert.equal(rows.entries.length, 5);
    assert.equal(rows.entries.find((r) => r.serverId === pending.id).status, 'pending');
    assert.equal(rows.entries.find((r) => r.serverId === denied.id).status, 'denied');
    assert.equal(rows.entries.find((r) => r.serverId === uncertain.id).status, 'uncertain');
    const completed = rows.entries.find((r) => r.serverId === first.id);
    assert.equal(completed.action.operation, 'unit.pin');
    assert.equal(completed.action.coverage, 'bound');
    assert.equal(completed.action.targets[0].processId, target.processId);
    assert.equal(completed.action.description.evidence, 'commander_supplied_unverified');
    assert.equal(completed.action.description.titleBasedSuggestions, 'hypotheses_only');
    assert.equal(completed.facts.projectAcceptance, 'unverified');
    assert.ok(!JSON.stringify(rows).includes('private-history-token'));
    assert.equal(mutations, 2, 'History inspection is read-only');
    const patterns = await read({ view: 'patterns', operation: 'unit.pin', hostId: 'alpha' });
    assert.equal(patterns.entries.length, 1);
    assert.equal(patterns.entries[0].count, 2, 'Count distinct completed requests, not approvals, audit copies, or retries');
    assert.deepEqual(new Set(patterns.entries[0].sourceServerIds), new Set([first.id, second.id]));
    assert.match(patterns.entries[0].inference, /hypothesis/);
    for (const id of patterns.entries[0].sourceOutcomeIds) assert.ok(f.engine.outcomes({ collection: 'directive', limit: 50 }).entries.some((r) => r.outcomeId === id && r.status === 'completed'));

    // Pin pagination to the first page's outcome snapshot while further actions
    // change state. A pending row at that snapshot must stay pending on page two.
    let page = await read({ limit: 1 });
    const through = page.through, seen = [...page.entries];
    await f.engine.decideDirective(pending.id, 'approve');
    const later = await propose(pin('later'), 'approve');
    while (page.hasMore) {
      page = await read({ limit: 1, through, after: page.cursor });
      assert.equal(page.through, through);
      seen.push(...page.entries);
    }
    assert.equal(new Set(seen.map((r) => r.serverId)).size, 5);
    assert.ok(!seen.some((r) => r.serverId === later.id));
    assert.equal(seen.find((r) => r.serverId === pending.id).status, 'pending');

    // Real Chats/commander adapter receipt survives even when the full directive
    // exceeds the general outcome-record bound. Prompt contents are not indexed.
    const send = await propose(action('unit.send', { sessionKey: target.key, text: 'private prompt '.repeat(8000) }, { id: 'long-send' }), 'approve');
    assert.equal(f.engine.outcomes({ serverId: send.id, collection: 'directive' }).entries.at(-1).record.truncated, true);
    const sent = (await read({ operation: 'unit.send' })).entries[0];
    assert.equal(sent.status, 'completed');
    assert.equal(sent.facts.providerTurnCompletion, 'unverified');
    assert.ok(sent.facts.commandId);
    assert.ok(!JSON.stringify(sent).includes('private prompt'));

    // Handoff metadata is captured from the reviewed preview and adapter result,
    // then remains inspectable after preview expiry and source-unit exit.
    const preview = { name: target.name, sourceHostId: 'alpha', targetHostId: 'alpha', operationId: 'a'.repeat(32), repository: '/repo', revision: 'b'.repeat(64) };
    f.service.sitrepSource = () => preview;
    f.service.worktrees = async () => [];
    f.service.launchSitrep = async () => ({ hostId: 'alpha', name: 'hq-123123123123', chatSessionId: 'chat-recipient', worktree: { repository: '/repo', branch: 'handoff', path: '/repo/handoff' } });
    const handoff = await propose(action('sitrep.handoff', { id: 'preview', operationId: 'c'.repeat(32), objective: 'Verify the report', summary: 'Claim token=private-handoff-token', nextSteps: 'Run the reviewed tests', title: 'Report follow-up', slug: 'report', provider: 'codex' }, { id: 'handoff' }), 'approve');
    assert.equal(f.engine.state().directives.find((r) => r.id === handoff.id).state, 'completed');
    f.service.sitrepSource = () => null;
    target.state = 'exited'; target.chatState = 'stopped';
    f.engine.dispose(); f.start();
    const handoffs = await read({ handoffsOnly: true, hostId: 'alpha' });
    assert.equal(handoffs.entries.length, 1);
    const saved = handoffs.entries[0];
    assert.equal(saved.action.handoff.preview.revision, preview.revision);
    assert.equal(saved.action.handoff.preview.operationId, preview.operationId);
    assert.equal(saved.action.handoff.destination.operationId, 'c'.repeat(32));
    assert.equal(saved.action.handoff.destination.chatSessionId, 'chat-recipient');
    assert.equal(saved.action.handoff.claims.evidence, 'commander_supplied_unverified');
    assert.equal(saved.facts.projectAcceptance, 'unverified');
    assert.ok(!JSON.stringify(saved).includes('private-handoff-token'));
    assert.equal((await read({ sessionKey: 'alpha/tmux:hq-123123123123' })).entries[0].serverId, handoff.id);
    assert.equal((await read({ operation: 'unit.pin', view: 'patterns' })).entries[0].count, 4, 'Restart and target exit preserve observed history');

    // Partial/legacy history, byte bounds, and retained-window pagination are
    // tested independently with durable journal-shaped rows, not native calls.
    const legacy = { outcomes: [{ sequence: 2, collection: 'directive', serverId: 'legacy', outcomeId: 'legacy-outcome', status: 'completed', record: { kind: 'unit.send', summary: 'Same report title' } }], outcomeSequence: 2 };
    assert.equal(readHistory(legacy).unknownMetadata, 1);
    assert.equal(readHistory(legacy).truncated, true);
    assert.deepEqual(readHistory(legacy, { view: 'patterns' }).entries, []);
    assert.throws(() => readHistory(legacy, { through: 3 }), /Invalid history/);
    assert.throws(() => readHistory(legacy, { after: 2, through: 1 }), /Invalid history/);
    const large = { outcomes: [], outcomeSequence: 300 };
    for (let i = 101; i <= 200; i++) large.outcomes.push({ sequence: i, collection: 'directive', serverId: `server-${i}`, outcomeId: `outcome-${i}`, status: 'completed', recordedAt: i,
      action: { ...completed.action, scope: { repository: '/repo/' + 'x'.repeat(2000) }, scopeFingerprint: String(i) } });
    let cursor = 0; const ids = [];
    do {
      const result = readHistory(large, { after: cursor, limit: 50 });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 10000);
      validate(contract, result, contract.$defs);
      assert.equal(result.truncated, true);
      ids.push(...result.entries.map((r) => r.serverId)); cursor = result.cursor;
      if (!result.hasMore) break;
    } while (true);
    assert.equal(new Set(ids).size, 100);
    const repeated = structuredClone(large);
    for (const row of repeated.outcomes) row.action = completed.action;
    const group = readHistory(repeated, { view: 'patterns' }).entries[0];
    assert.equal(group.count, 100); assert.equal(group.sourceOutcomeIds.length, 10); assert.equal(group.sourcesTruncated, true);
    const huge = structuredClone(large);
    huge.outcomes[0].action.scope.repository = 'x'.repeat(10000);
    const compacted = readHistory(huge, { limit: 1 });
    assert.equal(compacted.entries[0].partial, true);
    assert.equal(compacted.entries[0].outcomeId, huge.outcomes[0].outcomeId);
    assert.equal(compacted.cursor, huge.outcomes[0].sequence);
    assert.equal(compacted.hasMore, true);
    validate(contract, compacted, contract.$defs);
    const indexed = (repository) => summarizeAction({ kind: 'agentc2.action', canonicalOperation: 'unit.create', params: { input: { repository } }, binding: { evidence: { targets: [] } } });
    const prefix = '/repo/' + 'x'.repeat(400);
    assert.notEqual(indexed(prefix + '/one').scopeFingerprint, indexed(prefix + '/two').scopeFingerprint, 'Truncated display paths must not merge distinct scopes');
    assert.equal(indexed(prefix).displayTruncated, true);
    assert.equal(indexed('/repo').displayTruncated, false);
    const partial = structuredClone(legacy); partial.outcomes[0].action = { truncated: true, preview: 'partial' };
    assert.equal(readHistory(partial).unknownMetadata, 1, 'A previously bounded index has explicitly unknown coverage');
    console.log('PASS durable redacted action/handoff history, real Store/Chats receipts, deduplicated evidence patterns, snapshot pagination, restart, legacy gaps, retention and byte bounds');
  } finally { f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
