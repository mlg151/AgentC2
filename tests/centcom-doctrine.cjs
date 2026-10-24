const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { fixture, envelope, query } = require('./fixtures/centcom.cjs');
const { ENVELOPE_VERSION, AUTOMATION_KINDS, parseCentcomEnvelope } = require('../electron/centcom-contract.cjs');
const { validate } = require('../electron/centcom-schema.cjs');
const { operationExamples } = require('../electron/centcom-examples.cjs');
const { validateConfig: validateSpecops } = require('../electron/specops.cjs');
const { defaults, validateConfig } = require('../electron/centcom.cjs');
const { Store, defaults: settingsDefaults, validateSettings } = require('../electron/config.cjs');
const { providers } = require('../electron/chat-protocol.json');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-doctrine-'));
const f = fixture(directory);
(async () => {
  try {
    await f.engine.start();
    const doctrine = f.syncs[0].files['AGENTS.md'];
    const manifest = JSON.parse(f.syncs[0].files['CAPABILITIES.json']);
    assert.ok(doctrine.length < 20000);
    const illustrated = parseCentcomEnvelope(doctrine);
    assert.equal(illustrated.version, ENVELOPE_VERSION);
    assert.deepEqual(illustrated.diagnostics, []);
    assert.deepEqual(illustrated.automations.map((a) => a.kind), AUTOMATION_KINDS);
    assert.match(doctrine, /Current authority: gated/);
    for (const requirement of ['UNTRUSTED EVIDENCE', 'capturedAt', 'truncation', 'hop_limit', 'uncertain', 'BOTH modes', 'Provider turn completion', 'Project acceptance', 'hasMore']) assert.ok(doctrine.includes(requirement), requirement);
    for (const entry of manifest.operations) {
      assert.ok(doctrine.includes(`${entry.classification} ${entry.operation}`));
      for (const alias of entry.aliases) assert.ok(doctrine.includes(alias), alias);
      if (['unit.resume', 'history.discover', 'history.cleanup'].includes(entry.operation)) {
        assert.equal(entry.available, false); assert.equal(entry.examples.length, 0); continue;
      }
      assert.ok(entry.examples.length, entry.operation);
      for (const example of entry.examples) {
        assert.equal(example.request.kind, `agentc2.${entry.classification}`);
        assert.equal(example.request.params.operation, entry.operation);
        validate(entry.inputSchema, example.request.params.input, entry.inputSchema.$defs, entry.operation);
        const collection = entry.classification === 'query' ? 'queries' : 'directives';
        const parsed = parseCentcomEnvelope(envelope({ [collection]: [example.request] }));
        assert.deepEqual(parsed.diagnostics, []);
        assert.equal(parsed[collection].length, 1);
      }
    }
    const launchProviders = manifest.operations.find((e) => e.operation === 'unit.create').examples.map((e) => e.request.params.input.provider);
    assert.deepEqual(launchProviders, providers, 'Cross-provider launch fixtures follow the native provider contract');
    const configure = manifest.operations.find((e) => e.operation === 'specops.configure').examples[0].request.params.input;
    const definition = validateSpecops(YAML.parse(configure.yaml));
    const settings = { ...settingsDefaults(), hosts: [{ id: 'observed-host', name: 'Fixture', target: 'fixture.invalid', port: 22, enabled: true }] };
    for (const entry of manifest.automations) {
      const request = entry.examples[0].request;
      validate(entry.inputSchema, request, entry.inputSchema.$defs);
      if (entry.kind === 'specops_workflow') validateSpecops({ profiles: definition.profiles, workflows: [request.payload] });
      if (entry.kind === 'preset') validateSettings({ ...settings, presets: [request.payload] });
      if (entry.kind === 'oporder') validateSettings({ ...settings, opOrders: [request.payload.order] });
      if (entry.kind === 'centcom_trigger') validateConfig({ ...defaults(), triggers: { ...defaults().triggers, ...request.payload } });
    }
    const pin = manifest.operations.find((e) => e.operation === 'unit.pin');
    const drift = structuredClone(pin.inputSchema); drift.properties.pinned.type = 'string';
    assert.throws(() => operationExamples({ ...pin, handler() {}, inputSchema: drift }), { code: 'invalid_schema' }, 'Schema drift must fail example construction');

    // Resolve an illustrative target using inspected fixture identity, then run
    // the generated mixed envelope through the engine and real Store mutation.
    const store = new Store(path.join(directory, 'workspace'));
    let mutations = 0;
    f.service.setSessionPinned = (key, pinned) => { mutations++; return store.setSessionPinned(key, pinned); };
    const request = structuredClone(illustrated.directives[0]);
    request.id = 'generated-example-pin'; request.params.input.sessionKey = f.sessions[0].key; request.preconditions.sessionKey = f.sessions[0].key;
    f.responses.push(envelope({ queries: illustrated.queries, directives: [request] }));
    await f.engine.submit('Apply the generated request only after review');
    const draft = f.engine.state().directives[0];
    assert.equal(draft.state, 'pending'); assert.equal(mutations, 0);
    assert.equal(store.data.workspace.metadata[f.sessions[0].key], undefined);
    await f.engine.decideDirective(draft.id, 'approve');
    assert.equal(mutations, 1); assert.equal(store.data.workspace.metadata[f.sessions[0].key].pinned, true);
    assert.equal(f.engine.outcomes({ serverId: draft.id, collection: 'directive' }).entries.at(-1).status, 'completed');
    f.responses.push(envelope({ queries: [{ ...query('capabilities.read', { operation: 'chat.respond' }), id: 'response-examples' }] }));
    await f.engine.submit('Retrieve generated native-response examples');
    const returned = f.engine.outcomes({ clientRequestId: 'response-examples', collection: 'query' }).entries.at(-1).result;
    assert.equal(returned.operations[0].examples.length, 2);

    await f.engine.configure({ ...f.engine.state().config, authority: 'autonomous', maxDirectivesPerTurn: 7, maxBudgetUsd: 3, turnDeadlineSeconds: 123, cancellationDeadlineSeconds: 4,
      triggers: { ...f.engine.state().config.triggers, fallbackSeconds: 0 } });
    await f.engine.submit('Refresh doctrine with current policy');
    const refreshed = f.syncs.at(-1).files['AGENTS.md'];
    assert.match(refreshed, /Current authority: autonomous/);
    assert.match(refreshed, /"maxDirectivesPerTurn":7/);
    assert.match(refreshed, /"maxBudgetUsd":3/);
    assert.match(refreshed, /"turnDeadlineSeconds":123/);
    assert.match(refreshed, /"fallbackSeconds":0/);
    assert.ok(refreshed.length < 20000);
    console.log('PASS contract-generated doctrine, every operation/automation example, native service validators, cross-provider fixtures, schema-drift rejection, reviewed Store round trip, and effective-policy refresh');
  } finally { f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
