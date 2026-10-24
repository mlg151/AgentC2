const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, envelope, query, action, unit } = require('./fixtures/centcom.cjs');
const { validate, automationSchema } = require('../electron/centcom-schema.cjs');
const { templates } = require('../electron/specops.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-schema-'));
const f = fixture(directory);
(async () => {
  try {
    await f.engine.start();
    const manifest = JSON.parse(f.syncs[0].files['CAPABILITIES.json']);
    const index = f.engine.manifest();
    assert.ok(Buffer.byteLength(JSON.stringify(index)) < 12000, 'The discoverable index must survive the outcome read limit');
    assert.equal(manifest.operations.length, index.operations.length);
    for (const operation of manifest.operations) {
      assert.equal(operation.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      const schema = f.engine.manifest(undefined, { operation: operation.operation });
      assert.deepEqual(schema.operations[0].inputSchema, operation.inputSchema);
      assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 12000, operation.operation);
      const output = f.engine.manifest(undefined, { operation: operation.operation, schema: 'output' });
      assert.deepEqual(output.operations[0].outputSchema, operation.outputSchema);
      assert.ok(Buffer.byteLength(JSON.stringify(output)) < 12000, `${operation.operation} output`);
    }
    const get = (operation) => manifest.operations.find((entry) => entry.operation === operation).inputSchema;
    const check = (operation, input) => validate(get(operation), input, get(operation).$defs);
    const rejects = (operation, input) => assert.throws(() => check(operation, input), { code: 'invalid_schema' });
    check('unit.create', { provider: 'codex', worktree: { operationId: 'a'.repeat(32), repository: '/repo', baseRef: 'main', slug: 'task' } });
    rejects('unit.create', { provider: 'codex', worktree: { repository: '/repo' } });
    rejects('unit.create', { provider: 'codex', worktree: { operationId: 'a'.repeat(32), repository: '/repo', baseRef: 'main', slug: 'task', unknown: true } });
    rejects('exercise.create', { hostId: 'alpha', repository: '/repo', baseRef: 'main', title: 'Test', prompt: 'Test', testCommand: '', contestants: [{ provider: 'codex' }, { provider: 'unknown' }] });
    rejects('chat.respond', { requestId: 'r', turnId: null, itemId: null, decision: 'allow', answers: [{ questionId: 'q', answers: ['a'] }] });
    rejects('chat.respond', { requestId: 'r', turnId: null, itemId: null, answers: [{ questionId: 'q', answers: [42] }] });
    check('chat.respond', { requestId: 'r', turnId: null, itemId: null, answers: [{ questionId: 'q', answers: ['a'] }] });
    rejects('outcomes.read', { after: 0.5 });
    rejects('outcomes.read', { limit: 51 });
    rejects('exercise.control', { id: 'fixture', action: 'promote' });
    rejects('github.close', { hostId: 'alpha', repo: 'fixture/repo', number: 1 });
    rejects('configuration.save', JSON.parse('{"settings":{"toString":true}}'));
    rejects('configuration.save', JSON.parse('{"settings":{"__proto__":{}}}'));
    rejects('unit.rename', { title: '\ud800' });

    const payloads = { preset: { id: 'fixture', name: 'Fixture', provider: 'codex', command: 'codex' }, specops_workflow: templates[0],
      oporder: { order: { version: 1, id: 'fixture', hostId: 'alpha', repository: '/repo' } }, centcom_trigger: { cooldownSeconds: 10, maxAutoTurnsPerHour: 100, fallbackSeconds: 600 } };
    for (const [kind, payload] of Object.entries(payloads)) {
      const schema = automationSchema(kind);
      const request = { id: 'fixture', kind, title: 'Fixture', rationale: 'Observed evidence', evidence: [], payload };
      validate(schema, request, schema.$defs);
      assert.throws(() => validate(schema, { ...request, payload: { ...payload, invented: true } }, schema.$defs), { code: 'invalid_schema' });
      assert.deepEqual(f.engine.manifest(undefined, { automationKind: kind }).automations[0].inputSchema, schema);
      const output = f.engine.manifest(undefined, { automationKind: kind, schema: 'output' });
      assert.ok(output.automations[0].outputSchema);
      assert.ok(Buffer.byteLength(JSON.stringify(output)) < 12000);
    }

    // Before this boundary existed, validateSettings silently removed this typo
    // and CENTCOM saved a draft without the intended instructions.
    f.responses.push(envelope({ automations: [{ id: 'misspelled-preset', kind: 'preset', title: 'Fixture', rationale: 'Observed fixture', payload: { ...payloads.preset, instructons: 'Preserve this requirement' } }] }));
    await f.engine.submit('Reject unknown nested field');
    assert.equal(f.engine.state().automations.length, 0);
    const invalid = f.engine.outcomes({ clientRequestId: 'misspelled-preset' }).entries.at(-1);
    assert.equal(invalid.code, 'invalid_automation');
    assert.match(invalid.message, /unknown field instructons/);
    const [draft] = await f.propose([action('unit.create', { provider: 'codex', worktree: { repository: '/repo', unexpected: true } }, { id: 'invalid-worktree' })]);
    assert.equal(draft.validationCode, 'invalid_schema');
    const creates = f.calls.filter((call) => call.operation === 'create').length;
    await f.engine.decideDirective(draft.id, 'approve');
    assert.equal(f.calls.filter((call) => call.operation === 'create').length, creates, 'Malformed input never reaches the launch adapter');

    f.responses.push(envelope({ queries: [{ ...query('capabilities.read', { operation: 'automation.preview' }), id: 'full-schema' }] }));
    await f.engine.submit('Inspect the full schema through the production envelope');
    const result = f.engine.outcomes({ clientRequestId: 'full-schema', collection: 'query' }).entries.at(-1);
    assert.equal(result.status, 'ok');
    assert.ok(result.result.operations[0].inputSchema.$defs.workflow.properties.stages);
    assert.equal(result.result.truncated, undefined);
    f.engine.dispose(); f.start();
    assert.deepEqual(f.engine.outcomes({ clientRequestId: 'full-schema', collection: 'query' }).entries.at(-1), result);
    for (const operation of ['fleet.inspect', 'units.list', 'unit.inspect', 'hosts.inspect', 'context.read', 'admission.check', 'outcomes.read', 'capabilities.read']) {
      const input = operation === 'unit.inspect' ? { sessionKey: f.sessions[0].key } : operation === 'context.read' ? { section: 'presets' } : {};
      f.responses.push(envelope({ queries: [{ ...query(operation, input), id: `output-${operation}` }] }));
      await f.engine.submit('Validate a real inspection result against its published output schema');
      const observed = f.engine.outcomes({ clientRequestId: `output-${operation}`, collection: 'query' }).entries.at(-1);
      assert.equal(observed.status, 'ok', operation);
      const schema = f.engine.manifest(undefined, { operation, schema: 'output' }).operations[0].outputSchema;
      validate(schema, observed.result, schema.$defs, operation);
    }
    f.responses.push(envelope({ queries: [{ ...query('capabilities.read', { operation: 'automation.apply', schema: 'output' }), id: 'output-discovery' }] }));
    await f.engine.submit('Retrieve the largest output schema');
    const largest = f.engine.outcomes({ clientRequestId: 'output-discovery', collection: 'query' }).entries.at(-1).result;
    assert.ok(largest.operations[0].outputSchema.$defs.automationRecord);
    f.state.workspace = { metadata: {} };
    for (let i = 300; i < 330; i++) {
      const item = unit(i); f.sessions.push(item);
      f.state.workspace.metadata[item.key] = { notes: 'Large observed evidence. '.repeat(200) };
    }
    f.responses.push(envelope({ queries: [{ ...query('units.list', { limit: 50 }), id: 'large-unit-page' }] }));
    await f.engine.submit('Keep a usable cursor for large evidence pages');
    const unitPage = f.engine.outcomes({ clientRequestId: 'large-unit-page', collection: 'query' }).entries.at(-1).result;
    assert.ok(unitPage.entries.length);
    assert.equal(unitPage.hasMore, true);
    assert.equal(unitPage.cursor, unitPage.entries.at(-1).id);
    assert.ok(Buffer.byteLength(JSON.stringify(unitPage)) < 12000);
    console.log('PASS nested executable schemas, conditional input validation, unknown-field regression, complete per-operation discovery, bounded envelope readback, and restart');
  } finally { f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
