const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, action, until } = require('./fixtures/centcom.cjs');
const { fingerprint } = require('../electron/centcom-contract.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-persisted-'));
const identity = (unit) => ({ key: unit.key, hostId: unit.hostId, name: unit.id || unit.name, chatSessionId: unit.chatSessionId });
async function savedPrecondition(name, operation, setup, change, expected) {
  const root = path.join(directory, name), f = fixture(root);
  try {
    f.engine.pause(true); await f.engine.start();
    const input = setup(f);
    const [proposal] = await f.propose([action(operation, input)]);
    assert.equal(proposal.state, 'pending'); assert.equal(proposal.validationError, undefined);
    f.dispose();
    const file = path.join(root, 'centcom.json'), saved = JSON.parse(fs.readFileSync(file));
    const pending = saved.directives.find((record) => record.id === proposal.id);
    change(pending.preconditions, f);
    // Exercise saved-state identity checks even if the obsolete request fields
    // have a self-consistent digest. No worker fixture or protocol is changed.
    pending.binding.requestHash = fingerprint({ operation, input: pending.params.input, preconditions: pending.preconditions });
    fs.writeFileSync(file, JSON.stringify(saved));
    f.start(); await f.engine.decideDirective(proposal.id, 'approve');
    const refused = f.engine.state().directives.find((record) => record.id === proposal.id);
    assert.equal(refused.state, 'failed', JSON.stringify(refused)); assert.match(refused.error, expected);
    assert.equal(f.calls.filter((call) => call.operation === operation || call.operation === 'exercise.cancel').length, 0, 'Persisted target changes must fail before mutation');
  } finally { f.dispose(); }
}
async function identities() {
  for (const field of ['name', 'hostId', 'chatSessionId']) await savedPrecondition('unit-' + field, 'unit.pin', (f) => ({ sessionKey: f.sessions[0].key, pinned: true }), (pre, f) => { pre.identity = { ...identity(f.sessions[0]), [field]: 'changed-fixture' }; }, /Session identity changed since proposal/);
  const exercise = (f) => {
    f.exercises.push({ id: 'persisted-exercise', hostId: 'alpha', state: 'running', contestants: [{ id: 'first', name: f.sessions[0].name, state: 'launched' }, { id: 'second', name: f.sessions[1].name, state: 'launched' }] });
    return { id: 'persisted-exercise', action: 'cancel' };
  };
  for (const field of ['length', 'key', 'hostId', 'name', 'chatSessionId']) await savedPrecondition('participants-' + field, 'exercise.control', exercise, (pre, f) => {
    pre.identities = f.sessions.slice(0, 2).map(identity);
    if (field === 'length') pre.identities.pop(); else pre.identities[1][field] = 'changed-fixture';
  }, /Operation participant identity changed since proposal/);
}
async function failedInterrupt() {
  const f = fixture(path.join(directory, 'interrupt'));
  let cancellations = 0;
  try {
    f.engine.pause(true); await f.engine.start();
    f.engine.configure({ ...f.engine.state().config, cancellationDeadlineSeconds: 1 });
    const remote = f.chats.remote;
    f.chats.remote = async (host, request) => {
      if (request.action === 'command' && request.command.operation === 'interrupt') { cancellations++; throw Error('Cancellation transport fixture unavailable'); }
      const result = await remote(host, request);
      if (request.action === 'history' && f.submitted.length) {
        const events = result.events.filter((event) => event.type !== 'turn.completed');
        return { ...result, events, cursor: events.at(-1)?.sequence || request.after, latestCursor: events.at(-1)?.sequence || request.after, hasMore: false };
      }
      return result;
    };
    const sendsBefore = f.submitted.filter((command) => command.operation === 'send').length;
    const running = f.engine.submit('Retain uncertain cancellation ownership');
    const rejected = assert.rejects(running, /interrupted/);
    await until(() => f.engine.state().providerTurn?.turnId);
    f.engine.interrupt(); await rejected;
    assert.equal(cancellations, 1, 'A known provider turn must not replay an uncertain cancellation');
    assert.equal(f.engine.state().status, 'halted'); assert.equal(f.engine.state().providerTurn.status, 'uncertain');
    assert.equal(f.submitted.filter((command) => command.operation === 'send').length - sendsBefore, 1, 'Cancellation failure must not replay the assessment');
  } finally { f.dispose(); }
}
(async () => {
  try { await identities(); await failedInterrupt(); console.log('PASS persisted unit/participant precondition identity refusals before mutation, and failed explicit interruption retaining uncertain ownership without replay'); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
