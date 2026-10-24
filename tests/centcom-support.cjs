const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, envelope, query } = require('./fixtures/centcom.cjs');
const { contract } = require('../electron/chat-protocol.cjs');
const { validate } = require('../electron/centcom-schema.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-support-'));
const f = fixture(directory);
let counter = 0;
async function inspect(input) {
  const id = `support-${++counter}`;
  f.responses.push(envelope({ queries: [{ ...query('capabilities.support', input), id }] }));
  await f.engine.submit('Inspect support without taking control');
  const row = f.engine.outcomes({ collection: 'query', clientRequestId: id }).entries.at(-1);
  assert.equal(row.status, 'ok');
  const schema = f.engine.manifest(undefined, { operation: 'capabilities.support', schema: 'output' }).operations[0].outputSchema;
  validate(schema, row.result, schema.$defs);
  return row.result;
}
(async () => {
  try {
    await f.engine.start();
    let pending = false, unavailable = false, questionUnsupported = false;
    const remote = f.chats.remote;
    f.chats.remote = async (host, request) => {
      if (request.action === 'capabilities') assert.equal(request.prepareProvider, undefined, 'Discovery must not install or prepare provider runtimes');
      if (request.action === 'capabilities' && unavailable) throw new Error('No capability observation');
      const value = await remote(host, request);
      if (request.action === 'capabilities') return value.map((cap) => cap.provider === 'claude' || cap.provider === 'antigravity'
        ? { ...cap, status: cap.provider === 'claude' ? 'unsupported' : 'unverified', reason: 'Fixture runtime unavailable', ...Object.fromEntries(contract.capabilities.map((key) => [key, false])) }
        : { ...cap, steering: cap.provider !== 'codex' });
      if (request.action === 'history' && request.sessionId === f.sessions[1].chatSessionId && pending) {
        value.pendingRequests = [{ requestId: 'r', turnId: 't', itemId: 'i', state: 'pending', type: questionUnsupported ? 'question' : 'approval', data: questionUnsupported ? { questions: [{ id: 'q', question: 'Choose', options: ['A'], multiple: false }] } : { action: 'Read', detail: 'Fixture' } }];
        value.session.capabilities = { ...value.session.capabilities, questions: !questionUnsupported };
      }
      return value;
    };
    const initial = await inspect({ operation: 'unit.create', hostId: 'alpha', transport: 'chat' });
    const byProvider = Object.fromEntries(initial.entries.map((r) => [r.provider, r]));
    assert.equal(byProvider.codex.status, 'supported');
    assert.equal(byProvider.claude.status, 'unsupported');
    assert.equal(byProvider.antigravity.status, 'unknown');
    assert.equal(byProvider.opencode.status, 'supported');
    assert.equal(byProvider.terminal.status, 'unsupported');
    assert.ok(initial.entries.every((r) => r.reason && r.approval === 'watch_officer'));
    assert.equal((await inspect({ operation: 'unit.steer', provider: 'codex', transport: 'chat' })).entries[0].status, 'unsupported');
    assert.equal((await inspect({ operation: 'unit.create', provider: 'codex', transport: 'terminal' })).entries[0].status, 'unknown');
    assert.equal((await inspect({ operation: 'unit.resume', provider: 'codex' })).entries[0].status, 'unsupported');
    assert.equal((await inspect({ operation: 'specops.launch', provider: 'opencode' })).entries[0].status, 'unsupported');
    assert.equal((await inspect({ operation: 'specops.launch', provider: 'codex', transport: 'terminal' })).entries[0].status, 'unsupported');
    assert.equal((await inspect({ operation: 'exercise.create', provider: 'terminal' })).entries[0].status, 'unsupported');
    assert.equal((await inspect({ operation: 'unit.stop', sessionKey: f.sessions[2].key })).status, 'unavailable');
    assert.equal((await inspect({ operation: 'unit.inspect', sessionKey: f.sessions[7].key })).entries[0].status, 'supported');
    assert.equal((await inspect({ operation: 'unit.inspect', sessionKey: f.engine.state().session.key })).status, 'unavailable');
    assert.equal((await inspect({ operation: 'chat.respond', sessionKey: f.sessions[1].key })).entries[0].status, 'unavailable');
    pending = true;
    assert.equal((await inspect({ operation: 'chat.respond', sessionKey: f.sessions[1].key })).entries[0].status, 'supported');
    questionUnsupported = true;
    assert.equal((await inspect({ operation: 'chat.respond', sessionKey: f.sessions[1].key })).entries[0].status, 'unsupported');
    assert.equal(f.chats.handles.size, 0, 'Support discovery must never acquire a control handle');
    unavailable = true;
    assert.equal((await inspect({ operation: 'unit.create', provider: 'codex', transport: 'chat' })).entries[0].status, 'unknown');
    unavailable = false;
    f.state.settings.hosts.push({ id: 'offline', name: 'Offline', enabled: true, target: 'offline.invalid', port: 22 });
    assert.equal((await inspect({ operation: 'unit.create', hostId: 'offline', provider: 'codex' })).entries[0].status, 'unavailable');
    await f.engine.configure({ ...f.engine.state().config, authority: 'autonomous' });
    const autonomous = await inspect({ operation: 'unit.create', hostId: 'alpha', provider: 'codex', transport: 'chat' });
    assert.equal(autonomous.authority, 'autonomous');
    assert.equal(autonomous.entries[0].approval, 'fresh_binding_and_admission');
    assert.equal((await inspect({ operation: 'configuration.save', hostId: 'alpha', provider: 'codex' })).entries[0].approval, 'watch_officer');

    for (let i = 0; i < 12; i++) {
      const id = `host-${String(i).padStart(2, '0')}`;
      f.state.settings.hosts.push({ id, name: id, enabled: true, target: `${id}.invalid`, port: 22 });
      f.hosts.push({ id, connected: true });
    }
    let after = '', hasMore = true;
    const ids = [];
    while (hasMore) {
      const result = await inspect({ operation: 'unit.create', after, limit: 50 });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 12000);
      assert.ok(result.entries.length);
      assert.equal(result.cursor, result.entries.at(-1).id, 'Truncation must retain a usable string cursor');
      ids.push(...result.entries.map((r) => r.id));
      after = result.cursor; hasMore = result.hasMore;
    }
    assert.equal(ids.length, f.state.settings.hosts.length * 10);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(f.calls.filter((c) => c.operation === 'create').length, 1, 'Discovery launches only the fixture commander');
    assert.ok(!f.submitted.some((c) => ['respond', 'steer', 'interrupt', 'stop'].includes(c.operation)));
    console.log('PASS host/provider/transport support, native feature evidence, inactive/commander exclusions, pending requests, both authorities, no control acquisition, and bounded multi-page discovery');
  } finally { f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
