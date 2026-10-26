const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults, validateConfig, AUTOMATION_KINDS } = require('../electron/centcom.cjs');
const { fixture, unit } = require('./fixtures/centcom.cjs');

function config() {
  const valid = defaults('alpha');
  for (const input of [null, false, 1, {}, { ...valid, version: 2 }]) assert.throws(() => validateConfig(input), /Invalid CENTCOM configuration/);
  assert.throws(() => validateConfig({ ...valid, triggers: undefined }), /Invalid event trigger/);
  for (const [field, high, message] of [['turnDeadlineSeconds', 86400, /Invalid turn deadline/], ['cancellationDeadlineSeconds', 120, /Invalid cancellation deadline/]]) {
    for (const value of [0, high + 1, 1.5, null]) assert.throws(() => validateConfig({ ...valid, [field]: value }), message);
    for (const value of [1, high]) assert.equal(validateConfig({ ...valid, [field]: value })[field], value);
  }
  for (const value of [1, 599, 86401, null, 1.5]) assert.throws(() => validateConfig({ ...valid, triggers: { ...valid.triggers, fallbackSeconds: value } }), /Fallback must be disabled/);
  for (const value of [0, 600, 86400]) assert.equal(validateConfig({ ...valid, triggers: { ...valid.triggers, fallbackSeconds: value } }).triggers.fallbackSeconds, value);
  for (const key of ['onUnitCompleted', 'onDependencyChange']) assert.throws(() => validateConfig({ ...valid, triggers: { ...valid.triggers, [key]: 'true' } }), /Invalid event trigger/);
  const legacy = { ...valid, turnDeadlineSeconds: undefined, cancellationDeadlineSeconds: undefined, triggers: { ...valid.triggers, fallbackSeconds: undefined, onUnitCompleted: undefined, onDependencyChange: undefined } };
  const migrated = validateConfig(legacy);
  assert.equal(migrated.turnDeadlineSeconds, 600); assert.equal(migrated.cancellationDeadlineSeconds, 10); assert.equal(migrated.triggers.fallbackSeconds, 600);
  assert.equal(migrated.triggers.onUnitCompleted, true); assert.equal(migrated.triggers.onDependencyChange, true);
}

function manifests(f) {
  const index = f.engine.manifest();
  const operation = index.operations[0].operation;
  for (const options of [{ operation, automationKind: 'preset' }, { schema: 'unknown' }, { operation: 'missing' }, { automationKind: 'missing' }, { definition: 'missing' }, { operation, definition: 'missing' }, { automationKind: 'preset', definition: 'missing' }]) assert.throws(() => f.engine.manifest(undefined, options), /Select either|Choose input|Unknown capability|Unknown automation|Unknown schema/);
  for (const entry of index.operations.slice(0, 1)) for (const schema of ['input', 'output']) {
    const document = f.engine.manifest(undefined, { operation: entry.operation, schema }).operations[0][schema + 'Schema'];
    for (const definition of Object.keys(document.$defs || {}).slice(0, 1)) {
      const value = f.engine.manifest(undefined, { operation: entry.operation, schema, definition });
      assert.deepEqual(value.value, document.$defs[definition]);
      assert.equal(value.operation, entry.operation); assert.equal(value.schema, schema);
    }
  }
  for (const kind of AUTOMATION_KINDS) for (const schema of ['input', 'output']) {
    const document = f.engine.manifest(undefined, { automationKind: kind, schema }).automations[0][schema + 'Schema'];
    for (const definition of Object.keys(document.$defs || {}).slice(0, 1)) assert.deepEqual(f.engine.manifest(undefined, { automationKind: kind, schema, definition }).value, document.$defs[definition]);
  }
  assert.throws(() => f.engine.outcomes({ collection: 'missing' }), /Invalid outcome collection/);
}

async function pauseAndWake(directory) {
  const pending = new Map(); let now = Date.now(), sequence = 0;
  const timers = { now: () => now, setTimeout(callback, delay) { const id = ++sequence; pending.set(id, { callback, delay }); return id; }, clearTimeout(id) { pending.delete(id); } };
  const f = fixture(directory, { timers });
  try {
    manifests(f); console.log('PASS CENTCOM schema-definition selector boundaries');
    const config = f.engine.state().config; config.triggers.fallbackSeconds = 0; f.engine.configure(config);
    assert.equal(f.engine.pause(true).paused, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'centcom.json'))).paused, true);
    f.state.attention.push({ id: 'pending-fixture', sessionKey: f.sessions[0].key, kind: 'input', confidence: 'confirmed', acknowledged: false });
    await f.engine.observe(await f.service.inventory());
    assert.equal(f.submitted.length, 0); assert.equal(pending.size, 0);
    assert.equal(f.engine.pause(false).paused, false); assert.equal(pending.size, 1);
    const timer = [...pending.values()][0]; pending.clear(); now += timer.delay;
    const inventory = f.service.inventory;
    f.service.inventory = async () => { throw Error('Wake inventory fixture unavailable'); };
    const errors = [], originalError = console.error;
    try {
      console.error = (...args) => errors.push(args.join(' '));
      timer.callback();
      for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setImmediate(resolve));
      assert.ok(errors.some((error) => error.includes('CENTCOM wake failed: Wake inventory fixture unavailable')));
      assert.equal(f.submitted.length, 0, 'A failed wake cannot send a stale assessment');
    } finally { console.error = originalError; f.service.inventory = inventory; }
    f.engine.pause(true); assert.equal(pending.size, 0);
    f.dispose(); f.start(); assert.equal(f.engine.state().paused, true, 'Pause must survive an engine restart');
  } finally { f.dispose(); }
}

async function boundedFleet(directory) {
  const f = fixture(directory);
  try {
    f.engine.pause(true);
    console.log('RUN bounded metadata fleet snapshot');
    // No transcripts: metadata alone must exceed the workspace byte bound.
    f.sessions.splice(0, f.sessions.length, unit(20, { state: 'live', title: 'active-fixture' }), unit(21, { state: 'waiting', title: 'waiting-fixture' }), unit(22, { state: 'blocked', title: 'faulted-fixture', branch: 'x'.repeat(600000) }));
    f.faults.push({ sessionKey: f.sessions[2].key, status: 'review' });
    f.missions.push({ id: 'quiet', state: 'completed', error: 'x'.repeat(600000) }, { id: 'urgent', state: 'halted', error: 'x'.repeat(600000) });
    await f.engine.submit('Inspect bounded metadata evidence');
    const snapshot = f.snapshot();
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 1000000);
    assert.equal(snapshot.truncation.totals.units, 3); assert.equal(snapshot.truncation.outputTailsOmitted, 0);
    assert.ok(snapshot.truncation.omitted.units || snapshot.truncation.omitted.specops);
    assert.equal(f.sessions[2].branch.length, 600000, 'Bounding must not truncate the live fleet source');
    if (snapshot.specops.length === 1) assert.equal(snapshot.specops[0].id, 'urgent', 'The bounded snapshot must retain urgent mission metadata first');
    assert.equal(f.calls.filter((call) => call.operation === 'create').length, 1, 'Only the commander conversation may be initialized');
    assert.ok(f.calls.filter((call) => call.operation === 'create').every((call) => call.args[0].title.startsWith('CENTCOM //')));
    assert.ok(f.calls.every((call) => !['unit.stop', 'unit.interrupt'].includes(call.operation)), 'Snapshot reduction must not stop or interrupt managed units');
  } finally { f.dispose(); }
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-state-boundaries-'));
  try { config(); console.log('PASS CENTCOM configuration boundaries'); await pauseAndWake(path.join(directory, 'pause')); console.log('PASS CENTCOM pause/wake boundaries'); await boundedFleet(path.join(directory, 'fleet')); console.log('PASS CENTCOM config bounds/legacy defaults, operation/automation schema-definition selectors, persisted pause and failed wake without stale dispatch, and bounded urgent fleet metadata without source mutation'); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
