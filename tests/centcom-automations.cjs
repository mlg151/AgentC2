const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, defaults: settingsDefaults, validateSettings } = require('../electron/config.cjs');
const { createSpecops, templates } = require('../electron/specops.cjs');
const { defaults, validateConfig } = require('../electron/centcom.cjs');
const { createAutomations } = require('../electron/centcom-automations.cjs');
const { fingerprint } = require('../electron/centcom-contract.cjs');
const { fixture, envelope, query } = require('./fixtures/centcom.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-automations-'));
(async () => {
  const specops = createSpecops({ directory: path.join(directory, 'specops'), emit() {} });
  const f = fixture(path.join(directory, 'engine'));
  try {
    const store = new Store(path.join(directory, 'settings'));
    store.save('settings', validateSettings(settingsDefaults()));
    const stateFile = path.join(directory, 'centcom.json');
    const state = { config: defaults() };
    const persist = () => fs.writeFileSync(stateFile, JSON.stringify(state));
    persist();
    const service = { store, specops, saveSettings: async (settings) => store.save('settings', validateSettings(settings)) };
    const automations = createAutomations({ service, state, stateFile, persist, validateConfig });
    const preset = { id: 'fixture', name: 'Fixture', provider: 'codex', command: 'codex', args: '--model fixture', fullPermissions: false };
    const workflow = { ...structuredClone(templates[0]), id: 'fixture', name: 'Fixture workflow' };
    const cases = [['preset', preset], ['specops_workflow', workflow], ['centcom_trigger', { onFlashTraffic: false, fallbackSeconds: 0 }]];
    for (const [kind, payload] of cases) {
      const filesBefore = fs.readFileSync(store.file, 'utf8');
      const definitionBefore = specops.definition();
      const preview = await automations.preview(kind, payload);
      assert.equal(preview.reviewRequired, true);
      assert.equal(fs.readFileSync(store.file, 'utf8'), filesBefore, 'Preview never saves settings');
      assert.deepEqual(specops.definition(), definitionBefore, 'Preview never configures SPECOPS');
      const draft = { id: kind, kind, payload: preview.payload, preview, state: 'proposed' };
      await automations.apply(draft);
      assert.equal(draft.state, 'applied');
      assert.equal(draft.result.matchesDraft, true);
      assert.equal(draft.result.revision, fingerprint(preview.after));
      const persisted = await automations.read(draft);
      assert.equal(persisted.matchesDraft, true);
      await assert.rejects(automations.apply(draft), /already resolved/);
    }
    assert.throws(() => automations.validate('specops', {}), /Unsupported/);
    assert.throws(() => automations.validate('preset', { ...preset, provider: 'invented' }), /Invalid launch preset/);
    assert.throws(() => automations.validate('specops_workflow', { ...workflow, stages: [] }), /Invalid workflow/);
    assert.throws(() => automations.validate('centcom_trigger', { onFlashTraffic: 'yes' }), /Invalid event/);
    assert.throws(() => automations.validate('centcom_trigger', { invented: true }), /Unknown/);

    const preview = await automations.preview('preset', { ...preset, name: 'Replacement' });
    const draft = { id: 'stale', kind: 'preset', payload: preview.payload, preview, state: 'proposed' };
    service.saveSettings({ ...store.data.settings, presets: store.data.settings.presets.map((p) => p.id === preset.id ? { ...p, name: 'Concurrent edit' } : p) });
    await assert.rejects(automations.apply(draft), /changed since preview/);
    assert.equal(draft.state, 'proposed');
    assert.equal(store.data.settings.presets.find((p) => p.id === preset.id).name, 'Concurrent edit');

    // An adapter returning successfully without persisting the replacement must
    // not accept an older artifact merely because it has the same ID.
    const fresh = await automations.preview('preset', { ...preset, name: 'Not persisted' });
    service.saveSettings = async () => {};
    const ignored = { id: 'ignored', kind: 'preset', payload: fresh.payload, preview: fresh, state: 'proposed' };
    await assert.rejects(automations.apply(ignored), /readback does not match/);
    assert.equal(ignored.state, 'uncertain');
    const file = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    file.settings.presets = file.settings.presets.filter((p) => p.id !== preset.id);
    fs.writeFileSync(store.file, JSON.stringify(file));
    assert.equal((await automations.read(ignored)).artifact, null, 'Readback reads persisted bytes, not the stale in-memory store');

    // Exercise the production envelope, registry, durable drafts, and both C2
    // authority modes using the real persistence validators and adapters.
    f.service.store.file = store.file;
    f.service.store.data.settings = store.data.settings;
    f.service.specops = specops;
    let writes = 0;
    f.service.saveSettings = async (settings) => { writes++; const saved = validateSettings(settings); store.save('settings', saved); f.service.store.data.settings = saved; };
    for (const authority of ['gated', 'autonomous']) {
      f.engine.configure({ ...f.engine.state().config, authority });
      f.responses.push(envelope({ queries: [query('automation.validate', { kind: 'preset', payload: preset }), query('automation.preview', { kind: 'specops_workflow', payload: workflow })] }));
      await f.engine.submit('Inspect automation contract');
      assert.match(f.submitted.at(-1).payload.text, /reviewRequired/);
      for (const [kind, original] of cases) {
        const count = writes, beforeWorkflow = specops.definition(), beforeConfig = f.engine.state().config;
        const payload = kind === 'centcom_trigger' ? original : { ...original, id: `${authority}-${kind}` };
        f.responses.push(envelope({ automations: [{ id: `${authority}-${kind}`, kind, title: 'Reviewed fixture', rationale: 'Observed actions', payload }] }));
        await f.engine.submit('Save draft only');
        const draft = f.engine.state().automations[0];
        assert.equal(draft.state, 'proposed'); assert.equal(writes, count);
        assert.deepEqual(specops.definition(), beforeWorkflow); assert.deepEqual(f.engine.state().config, beforeConfig);
        assert.match(draft.preview.revision, /^[a-f0-9]{64}$/);
        f.engine.dispose(); f.start();
        assert.equal(f.engine.state().automations[0].preview.revision, draft.preview.revision);
        if (authority === 'gated' && kind === 'preset') {
          const decisions = await Promise.allSettled([f.engine.applyAutomation(draft.id, 'apply'), f.engine.applyAutomation(draft.id, 'dismiss')]);
          assert.equal(decisions[0].status, 'fulfilled'); assert.equal(decisions[1].status, 'rejected');
          assert.match(decisions[1].reason.message, /already resolved/);
        } else await f.engine.applyAutomation(draft.id, 'apply');
        assert.equal(f.engine.state().automations[0].state, 'applied');
        f.responses.push(envelope({ queries: [query('automation.read', { id: draft.id })] }));
        await f.engine.submit('Verify persisted artifact');
        assert.match(f.submitted.at(-1).payload.text, /"matchesDraft":true/);
      }
    }
    console.log('PASS automation validation, read-only previews, revision-bound durable drafts, reviewed application in both modes, and exact disk readback');
  } finally { f.dispose(); specops.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
