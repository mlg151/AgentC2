const assert = require('node:assert/strict');
const { automationOutputSchema } = require('../electron/centcom-output.cjs');
const { validate: validateSchema } = require('../electron/centcom-schema.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Store, defaults: settingsDefaults, validateSettings } = require('../electron/config.cjs');
const { defaults, validateConfig } = require('../electron/centcom.cjs');
const { createAutomations } = require('../electron/centcom-automations.cjs');
const { createOpOrders } = require('../electron/oporders.cjs');
const { fixture, envelope, query } = require('./fixtures/centcom.cjs');

(async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-oporders-')));
  let f;
  try {
    const repository = path.join(directory, 'repository'); fs.mkdirSync(repository);
    execFileSync('git', ['init', '-q', repository]);
    fs.writeFileSync(path.join(repository, 'AGENTS.md'), 'Unrelated repository guidance\n');
    const store = new Store(path.join(directory, 'settings'));
    const settings = settingsDefaults(); settings.hosts[0].id = 'alpha';
    store.save('settings', validateSettings(settings));
    const calls = [];
    let changeSettingsDuringEnrollment = false;
    const runRemote = async (payload) => {
      calls.push(payload.action);
      const result = JSON.parse(execFileSync('python3', [path.join(__dirname, 'fixtures/oporder-runner.py')], { input: JSON.stringify({ ...payload, fixtureHome: directory }), encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }));
      if (changeSettingsDuringEnrollment && payload.action === 'oporder_sync') store.save('settings', { ...store.data.settings, notifications: !store.data.settings.notifications });
      return result;
    };
    const service = { store, ...createOpOrders({ store, runRemote, getHost: (id) => store.data.settings.hosts.find((h) => h.id === id), opOrderSynced: new Map(), events: new EventEmitter() }) };
    const state = { config: defaults() }, stateFile = path.join(directory, 'centcom.json');
    const automations = createAutomations({ service, state, stateFile, validateConfig, persist() {} });
    const order = { version: 1, id: 'fixture', hostId: 'alpha', repository, instructions: 'Reviewed fixture guidance', mcp: [] };
    const preview = await automations.preview('oporder', { order });
    assert.ok(preview.enrollment.ready);
    assert.ok(!calls.includes('oporder_sync'));
    assert.equal(fs.readFileSync(path.join(repository, 'AGENTS.md'), 'utf8'), 'Unrelated repository guidance\n');
    const draft = { id: 'fixture', kind: 'oporder', payload: preview.payload, preview, state: 'proposed' };
    // Remote bytes changing after review must reject enrollment before mutation.
    fs.appendFileSync(path.join(repository, 'AGENTS.md'), 'Concurrent edit\n');
    await assert.rejects(automations.apply(draft), /Stale OpOrder/);
    assert.ok(!calls.includes('oporder_sync'));
    assert.equal(store.data.settings.opOrders.length, 0);
    const fresh = await automations.preview('oporder', { order });
    draft.payload = fresh.payload; draft.preview = fresh;
    await automations.apply(draft);
    assert.equal(draft.state, 'applied'); assert.equal(draft.result.matchesDraft, true);
    assert.equal(store.data.settings.opOrders[0].enabled, true);
    const text = fs.readFileSync(path.join(repository, 'AGENTS.md'), 'utf8');
    assert.match(text, /Reviewed fixture guidance/); assert.match(text, /Concurrent edit/);
    assert.ok(draft.result.enrollment.changes.every((c) => c.status === 'unchanged'));
    fs.writeFileSync(path.join(repository, 'AGENTS.md'), text.replace('Reviewed fixture guidance', 'Conflicting edit'));
    assert.equal((await automations.read(draft)).matchesDraft, false);
    await assert.rejects(automations.preview('oporder', { order }), /not ready/);
    fs.writeFileSync(path.join(repository, 'AGENTS.md'), text);
    f = fixture(path.join(directory, 'engine'));
    Object.assign(f.service, service);
    for (const authority of ['gated', 'autonomous']) {
      f.engine.configure({ ...f.engine.state().config, authority });
      const before = fs.readFileSync(path.join(repository, 'AGENTS.md'), 'utf8');
      const prior = JSON.parse(fs.readFileSync(store.file, 'utf8'));
      f.responses.push(envelope({ automations: [{ id: authority, kind: 'oporder', title: 'Reviewed enrollment', rationale: 'Observed configuration reuse', payload: { order: { ...order, instructions: `Reviewed ${authority} guidance` } } }] }));
      await f.engine.submit('Save enrollment draft');
      const proposed = f.engine.state().automations[0];
      assert.equal(proposed.state, 'proposed');
      assert.equal(fs.readFileSync(path.join(repository, 'AGENTS.md'), 'utf8'), before);
      assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), prior);
      await f.engine.applyAutomation(proposed.id, 'apply');
      assert.equal(f.engine.state().automations[0].state, 'applied');
      const schema = automationOutputSchema('oporder');
      validateSchema(schema, f.engine.state().automations[0], schema.$defs, 'enrolled.oporder');
      f.responses.push(envelope({ queries: [query('automation.read', { id: proposed.id })] }));
      await f.engine.submit('Verify enrollment readback');
      assert.match(f.submitted.at(-1).payload.text, /"matchesDraft":true/);
    }
    const racing = await automations.preview('oporder', { order: { ...order, instructions: 'Concurrent enrollment fixture' } });
    const uncertain = { id: 'race', kind: 'oporder', payload: racing.payload, preview: racing, state: 'proposed' };
    changeSettingsDuringEnrollment = true;
    await assert.rejects(automations.apply(uncertain), /changed during enrollment/);
    assert.equal(uncertain.state, 'uncertain');
    assert.notEqual(store.data.settings.opOrders[0].instructions, racing.after.instructions);
    console.log('PASS production OpOrder preview/enrollment adapter, stale revision rejection, exact persisted readback, and conflict detection in an isolated repository');
  } finally { f?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
