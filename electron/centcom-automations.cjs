const fs = require('node:fs');
const YAML = require('yaml');
const { validateSettings } = require('./config.cjs');
const { validateConfig: validateSpecops } = require('./specops.cjs');
const { AUTOMATION_KINDS, object, fingerprint } = require('./centcom-contract.cjs');

// Reuse the persistence adapters' validators. Preview is read-only; saving a
// draft never applies its configuration, regardless of C2 authority.
function createAutomations({ service, state, validateConfig, persist, stateFile }) {
  function validate(kind, payload) {
    if (!AUTOMATION_KINDS.includes(kind)) throw new Error(`Unsupported automation kind: ${kind}`);
    if (!object(payload)) throw new Error('Automation payload must be an object');
    const settings = service.store.data.settings;
    let artifact, before, scope;
    if (kind === 'preset') {
      const candidate = { args: '', cwd: '', instructions: '', ...payload };
      const normalized = validateSettings({ ...settings, presets: [...settings.presets.filter((p) => p.id !== payload.id), candidate] });
      artifact = normalized.presets.find((p) => p.id === payload.id);
      before = settings.presets.find((p) => p.id === payload.id) || null;
      scope = { hosts: settings.hosts, roe: settings.roe, before };
      payload = artifact;
    } else if (kind === 'specops_workflow') {
      const definition = service.specops.definition();
      const normalized = validateSpecops({ profiles: definition.profiles, workflows: [...definition.workflows.filter((w) => w.id !== payload.id), payload] });
      artifact = normalized.workflows.find((w) => w.id === payload.id);
      before = definition.workflows.find((w) => w.id === payload.id) || null;
      scope = { profiles: definition.profiles, before };
      payload = artifact;
    } else if (kind === 'centcom_trigger') {
      if (Object.keys(payload).some((k) => !Object.hasOwn(state.config.triggers, k))) throw new Error('Unknown CENTCOM trigger field');
      artifact = validateConfig({ ...state.config, triggers: { ...state.config.triggers, ...payload } }).triggers;
      before = state.config.triggers;
      scope = state.config;
      payload = artifact;
    } else {
      if (!object(payload.order) || Object.keys(payload).some((k) => !['order', 'revision'].includes(k))) throw new Error('OpOrder payload requires order and optional preview revision');
      if (payload.revision !== undefined && !/^[a-f0-9]{64}$/.test(payload.revision)) throw new Error('Invalid OpOrder preview revision');
      const order = { ...payload.order, enabled: true };
      const normalized = validateSettings({ ...settings, opOrders: [...(settings.opOrders || []).filter((o) => o.id !== order.id), order] });
      artifact = normalized.opOrders.find((o) => o.id === order.id);
      before = settings.opOrders?.find((o) => o.id === order.id) || null;
      scope = { hosts: settings.hosts, orders: settings.opOrders || [] };
      payload = { order: artifact, ...(payload.revision ? { revision: payload.revision } : {}) };
    }
    return { kind, payload: structuredClone(payload), artifact: structuredClone(artifact), before: structuredClone(before), baseRevision: fingerprint(scope) };
  }
  async function preview(kind, payload) {
    const validated = validate(kind, payload);
    let enrollment = null;
    if (kind === 'oporder') {
      enrollment = await service.previewOpOrder(validated.artifact);
      if (!enrollment?.ready || !/^[a-f0-9]{64}$/.test(enrollment.revision)) throw new Error('OpOrder preview is not ready; resolve enrollment conflicts before saving a draft');
      if (payload.revision && payload.revision !== enrollment.revision) throw new Error('Stale OpOrder preview revision');
      validated.payload.revision = enrollment.revision;
    }
    if (validate(kind, validated.payload).baseRevision !== validated.baseRevision) throw new Error('Automation configuration changed during preview');
    const result = { kind, payload: validated.payload, before: validated.before, after: validated.artifact, baseRevision: validated.baseRevision, enrollment };
    return { ...result, revision: fingerprint(result), reviewRequired: true };
  }
  function savedSettings() {
    if (!service.store.file) throw new Error('Persisted settings readback is unavailable');
    return validateSettings(JSON.parse(fs.readFileSync(service.store.file, 'utf8')).settings);
  }
  async function read(auto) {
    if (!auto || !AUTOMATION_KINDS.includes(auto.kind)) throw new Error('Unknown automation draft');
    let artifact, enrollment;
    if (auto.kind === 'preset') artifact = savedSettings().presets.find((p) => p.id === auto.payload.id);
    if (auto.kind === 'specops_workflow') artifact = service.specops.readback().workflows.find((w) => w.id === auto.payload.id);
    if (auto.kind === 'centcom_trigger') artifact = validateConfig(JSON.parse(fs.readFileSync(stateFile, 'utf8')).config).triggers;
    if (auto.kind === 'oporder') {
      artifact = savedSettings().opOrders.find((o) => o.id === auto.payload.order.id);
      enrollment = await service.previewOpOrder(auto.payload.order);
    }
    return { id: auto.id, state: auto.state, artifact: artifact || null, revision: artifact ? fingerprint(artifact) : null,
      matchesDraft: Boolean(artifact && auto.preview && fingerprint(artifact) === fingerprint(auto.preview.after) &&
        (auto.kind !== 'oporder' || (enrollment?.ready && Array.isArray(enrollment.changes) && enrollment.changes.every((c) => c.status === 'unchanged')))),
      ...(enrollment ? { enrollment } : {}) };
  }
  async function apply(auto) {
    if (!auto || auto.state !== 'proposed') throw new Error('Automation proposal not found or already resolved');
    if (!auto.preview) throw new Error('This draft predates revision-bound previews; propose it again before applying');
    const current = await preview(auto.kind, auto.payload);
    if (current.revision !== auto.preview.revision || validate(auto.kind, auto.payload).baseRevision !== current.baseRevision) throw new Error('Automation configuration changed since preview; propose and review a fresh draft');
    auto.state = 'applying'; persist();
    try {
      if (auto.kind === 'preset') {
        const settings = service.store.data.settings;
        await service.saveSettings({ ...settings, presets: [...settings.presets.filter((p) => p.id !== auto.payload.id), auto.payload] }, fingerprint(settings));
      } else if (auto.kind === 'specops_workflow') {
        const definition = service.specops.definition();
        await service.specops.configure(YAML.stringify({ profiles: definition.profiles, workflows: [...definition.workflows.filter((w) => w.id !== auto.payload.id), auto.payload] }));
      } else if (auto.kind === 'centcom_trigger') {
        state.config = validateConfig({ ...state.config, triggers: auto.payload }); persist();
      } else await service.enrollOpOrder(auto.payload.order, auto.payload.revision, fingerprint(service.store.data.settings));
      const result = await read(auto);
      if (!result.matchesDraft) throw new Error('Saved automation readback does not match the reviewed artifact');
      const { id: _id, state: _state, ...saved } = result;
      auto.result = saved;
      auto.state = 'applied'; auto.appliedAt = Date.now(); delete auto.error; persist();
      return auto;
    } catch (error) {
      auto.state = 'uncertain'; auto.error = error.message; persist(); throw error;
    }
  }
  return { validate, preview, read, apply };
}

module.exports = { createAutomations };
