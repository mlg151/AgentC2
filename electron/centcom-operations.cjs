// Metadata and executable handlers live together. Both envelope dialects use
// this registry, so doctrine cannot advertise an unimplemented dispatch branch.
const { fingerprint } = require('./centcom-contract.cjs');
const { operationInput, validate: validateSchema, bundled } = require('./centcom-schema.cjs');
const { createSupport, requirements } = require('./centcom-support.cjs');
const { outputSchema } = require('./centcom-output.cjs');
const { operationExamples } = require('./centcom-examples.cjs');
function createOperations({ service: s, client, control, resolve, fleet, applyAutomation, readOutcomes, readHistory, manifest, evidence, automations, beforeMutation = async () => {} }) {
  const registry = new Map();
  const add = (operation, classification, description, parameters, target, handler, dependencies = [], aliases = [], unavailable = '') => {
    const reviewRequired = ['configuration.save', 'specops.configure', 'oporder.enroll', 'automation.apply'].includes(operation);
    const entry = { operation, classification, description, parameters, target, handler, dependencies, aliases, unavailable, reviewRequired,
      inputSchema: bundled(operationInput(operation, parameters, target)), outputSchema: outputSchema(operation) };
    entry.examples = operationExamples(entry);
    registry.set(operation, entry);
  };
  const call = (path) => path.split('.').reduce((v, k) => v?.[k], s);
  const unit = (operation, description, parameters, handler, dependencies = [], aliases = []) => add(operation, 'action', description, parameters, 'session', handler, dependencies, aliases);
  const controlled = (u, fn) => control(u, fn);
  const support = createSupport({ service: s, fleet, catalog: () => catalog(), authority: () => manifest().authority, inspectUnit: evidence?.inspect });
  add('capabilities.read', 'query', 'Read the versioned contract. Select operation or automationKind and schema (input/output); definitions can be read separately when the schema is large.', { operation: 'string?', automationKind: 'string?', schema: 'string?', definition: 'string?' }, 'none', (p) => manifest(undefined, p));
  add('capabilities.support', 'query', 'Page current host/provider/transport support, eligibility, authority, and reasons. Select sessionKey for exact target evidence; discovery grants no control.', { operation: 'string', hostId: 'string?', provider: 'string?', transport: 'string?', sessionKey: 'string?', after: 'string?', limit: 'number?' }, 'none', support);
  add('outcomes.read', 'query', 'Read durable directive, automation, approval, audit, query, and diagnostic outcomes by cursor. Project acceptance is separate from command delivery.', { after: 'number?', limit: 'number?', collection: 'string?', clientRequestId: 'string?', serverId: 'string?' }, 'none', (p) => readOutcomes(p));
  add('history.read', 'query', 'Page retained action/handoff observations or repeated-action patterns. Preserve through while paging; title-based workflow suggestions remain hypotheses.', { after: 'number?', through: 'number?', limit: 'number?', view: 'string?', operation: 'string?', hostId: 'string?', sessionKey: 'string?', handoffsOnly: 'boolean?' }, 'none', (p) => readHistory(p));
  add('fleet.inspect', 'query', 'Inspect the connected active managed fleet.', {}, 'none', async () => (await fleet()).inventory);
  add('units.list', 'query', 'Page canonical managed, external, and saved units; inspection does not grant control.', { hostId: 'string?', provider: 'string?', classification: 'string?', execution: 'string?', after: 'string?', limit: 'number?' }, 'none', (p) => evidence.units(p));
  add('unit.inspect', 'query', 'Read structured unit identity, execution evidence, task, requests, and ownership without taking control.', { sessionKey: 'string' }, 'none', (p) => evidence.inspect(p), [], ['inspect_unit']);
  add('hosts.inspect', 'query', 'Read host health, effective cgroup headroom/pressure, ROE, and provider capabilities.', { hostId: 'string?' }, 'none', (p) => evidence.hosts(p));
  add('context.read', 'query', 'Page reusable definitions, presets, OpOrders/conflicts, notes, and handoffs.', { section: 'string', after: 'string?', limit: 'number?' }, 'none', (p) => evidence.context(p));
  add('admission.check', 'query', 'Inspect exact worktree assignment conflicts and resource admission before a launch.', { hostId: 'string?', cwd: 'string?', worktree: 'object?' }, 'none', (p) => evidence.admission(p));
  add('artifact.read', 'query', 'Read bounded, redacted text and content revision from an owned worktree. No commands are executed.', { hostId: 'string', operationId: 'string', path: 'string', revision: 'string?', offset: 'number?', limit: 'number?' }, 'none', (p) => s.commanderArtifact(p), ['commanderArtifact']);
  add('unit.search', 'query', 'Search transcripts of selected active units only.', { query: 'string', keys: 'array?' }, 'sessions', (p, units) => s.searchHistory(p.query, units.map((u) => u.key)), ['searchHistory'], ['search_history']);
  add('unit.create', 'action', 'Create a fresh managed session; existing history and background-agent resume are unavailable.', { provider: 'string', hostId: 'string?', model: 'string?', transport: 'string?', title: 'string?', cwd: 'string?', instructions: 'string?', presetId: 'string?', roeProfile: 'string?', worktree: 'object?', launchId: 'string?' }, 'new', (p) => s.create(p), ['create']);
  add('unit.resume', 'action', 'Resume inactive or saved history.', {}, 'none', null, [], [], 'Inactive-session resume and saved-history discovery/cleanup are outside the active fleet boundary.');
  for (const op of ['send', 'steer']) unit(`unit.${op}`, `${op === 'send' ? 'Send input' : 'Steer an active chat turn'}; a receipt confirms delivery, not completion of the requested task.`, { text: 'string', expectedTurnId: op === 'steer' ? 'string' : 'string?' }, (p, u) => controlled(u, (handle) => {
    if (u.transport !== 'chat') {
      if (op === 'steer') throw new Error('Steering requires structured chat');
      return s.terminalInput(client, handle, p.text);
    }
    return s.chatCommand(client, handle, u, op, op === 'send' ? { text: p.text } : { text: p.text, expectedTurnId: p.expectedTurnId });
  }), ['commanderControl', 'chatCommand', 'terminalInput']);
  unit('chat.respond', 'Respond to a structured question or approval request.', { requestId: 'string', turnId: 'nullable', itemId: 'nullable', decision: 'string?', answers: 'array?' }, (p, u) => controlled(u, (handle) => {
    if (u.transport !== 'chat') throw new Error('Responses require structured chat');
    const { requestId, turnId, itemId, decision, answers } = p;
    return s.chatCommand(client, handle, u, 'respond', { requestId, turnId, itemId, ...(decision !== undefined ? { decision } : { answers }) });
  }), ['commanderControl', 'chatCommand']);
  for (const op of ['interrupt', 'stop']) unit(`unit.${op}`, `${op} an active managed session.`, {}, (_p, u) => controlled(u, () => s.action(client, op, u.id || u.name, u.hostId)), ['action', 'commanderControl']);
  unit('unit.delete', 'Stop and delete an active managed session using the validated deletion flow.', {}, (_p, u) => controlled(u, () => s.commanderDelete(client, u.key)), ['commanderDelete', 'commanderControl']);
  unit('unit.rename', 'Rename an active unit.', { title: 'string' }, (p, u) => s.renameSession(u.key, p.title), ['renameSession']);
  unit('unit.pin', 'Pin or unpin an active unit.', { pinned: 'boolean' }, (p, u) => s.setSessionPinned(u.key, p.pinned), ['setSessionPinned']);
  unit('attention.acknowledge', 'Acknowledge attention belonging to this active unit.', { id: 'string' }, async (p, u) => {
    const f = await fleet();
    if (!f.inventory.attention?.some((a) => a.id === p.id && a.sessionKey === u.key)) throw new Error('Attention target is unavailable');
    return s.acknowledge(p.id);
  }, ['acknowledge']);
  unit('fault.reset', 'Reset an active unit fault.', {}, (_p, u) => s.resetFault(u.key), ['resetFault']);
  unit('fault.interrupt', 'Interrupt one confirmed fault on an active unit.', {}, (_p, u) => controlled(u, () => s.interruptFault(client, u.key)), ['interruptFault', 'commanderControl']);
  unit('flash.decide', 'Decide a pending active-unit Flash Traffic request.', { id: 'string', decision: 'string' }, (p, u) => controlled(u, () => s.flashDecide(client, { ...p, hostId: u.hostId, name: u.id || u.name })), ['flashDecide', 'commanderControl']);
  add('flash.list', 'query', 'Read Flash Traffic for active units.', {}, 'none', async () => (await fleet()).flash(await s.flashQueue()), ['flashQueue']);
  add('specops.definition', 'query', 'Inspect SPECOPS profiles and workflow definitions.', {}, 'none', () => s.specops.definition(), ['specops.definition']);
  add('specops.configure', 'action', 'Validate and save SPECOPS workflow YAML.', { yaml: 'string' }, 'none', (p) => s.specops.configure(p.yaml), ['specops.configure']);
  add('specops.inspect', 'query', 'Inspect a mission with only active participants and their evidence.', { id: 'string' }, 'mission', (p) => s.specops.list().find((r) => r.id === p.id), ['specops.list'], ['inspect_specops']);
  add('specops.launch', 'action', 'Launch a SPECOPS workflow.', { workflowId: 'string', hostId: 'string', repository: 'string', repo: 'string', issue: 'number?', query: 'string?', baseRef: 'string?' }, 'none', (p) => s.specops.launch(p), ['specops.launch']);
  add('specops.control', 'action', 'Resume, retry, or cancel a mission with active participants.', { id: 'string', action: 'string' }, 'mission', (p) => {
    if (!['resume', 'retry', 'cancel'].includes(p.action)) throw new Error('Invalid SPECOPS control action');
    return s.specops.control(p.id, p.action);
  }, ['specops.control', 'specops.list']);
  add('exercise.list', 'query', 'List exercises with active participant evidence only.', {}, 'none', () => s.exercises.list(), ['exercises.list']);
  add('exercise.create', 'action', 'Create and launch an exercise.', { hostId: 'string', repository: 'string', baseRef: 'string', title: 'string', prompt: 'string', testCommand: 'string', contestants: 'array' }, 'none', (p) => s.exercises.create(p), ['exercises.create']);
  for (const [op, description, method, classification] of [
    ['inspect', 'Inspect without running verification commands.', 'inspect', 'query'],
    ['verify', 'Run verification commands and record evidence.', 'inspect', 'action'],
    ['preview', 'Preview a verified promotion.', 'preview', 'query'],
    ['complete', 'Mark a contestant complete.', 'markComplete', 'action'],
    ['promote', 'Promote a verified contestant revision.', 'promote', 'action'],
  ]) add(`exercise.${op}`, classification, description, { id: 'string', contestantId: 'string', ...(op === 'promote' ? { revision: 'string' } : {}) }, 'contestant', (p) => s.exercises[method](p.id, p.contestantId, op === 'inspect' ? false : op === 'verify' ? true : p.revision), [`exercises.${method}`, 'exercises.list'], op === 'inspect' ? ['inspect_exercise'] : []);
  add('exercise.control', 'action', 'Retry, cancel, complete, or promote an exercise.', { id: 'string', action: 'string', contestantId: 'string?', revision: 'string?' }, 'exercise', (p) => {
    if (p.action === 'retry') return s.exercises.launch(p.id);
    if (p.action === 'cancel') return s.exercises.cancel(p.id);
    if (p.action === 'complete') return s.exercises.markComplete(p.id, p.contestantId);
    if (p.action === 'promote') return s.exercises.promote(p.id, p.contestantId, p.revision);
    throw new Error('Invalid exercise control action');
  }, ['exercises.list', 'exercises.launch', 'exercises.cancel', 'exercises.markComplete', 'exercises.promote']);
  add('worktree.list', 'query', 'Discover managed worktrees.', { hostId: 'string' }, 'none', (p) => s.worktrees(p.hostId), ['worktrees']);
  add('worktree.archive', 'action', 'Archive a managed worktree after service validation.', { hostId: 'string', operationId: 'string' }, 'none', (p) => s.archiveWorktree(p.hostId, p.operationId), ['archiveWorktree']);
  for (const [op, method, classification] of [['files', 'diff_files', 'query'], ['detail', 'diff_detail', 'query'], ['hunk', 'diff_hunk', 'action']]) add(`diff.${op}`, classification, op === 'hunk' ? 'Stage or revert a reviewed hunk.' : 'Inspect an active unit worktree diff.', { operationId: 'string', ...(op !== 'files' ? { fileId: 'string' } : {}), ...(op === 'hunk' ? { revision: 'string', hunkId: 'string', operation: 'string' } : {}) }, 'session', (p, u) => { const inspect = () => s.diffRequest(client, { ...p, name: u.id || u.name, hostId: u.hostId }, method); return classification === 'action' ? controlled(u, inspect) : inspect(); }, ['diffRequest', 'commanderControl']);
  const sitrepParams = { operationId: 'string', sourceHostId: 'string', targetHostId: 'string', repository: 'string', testCommand: 'string' };
  for (const op of ['inspect', 'preview']) add(`sitrep.${op}`, op === 'inspect' ? 'query' : 'action', op === 'inspect' ? 'Preview a handoff without test commands.' : 'Preview a handoff, including optional test execution.', sitrepParams, 'session', (p, u) => {
    if (op === 'inspect' && p.testCommand) throw new Error('Previews with test commands require sitrep.preview as an action');
    const preview = () => s.previewSitrep(client, { ...p, name: u.id || u.name });
    return op === 'inspect' ? preview() : controlled(u, preview);
  }, ['previewSitrep', 'commanderControl'], op === 'inspect' ? ['preview_sitrep'] : []);
  add('sitrep.handoff', 'action', 'Launch a reviewed SitRep handoff from an active source.', { id: 'string', operationId: 'string', objective: 'string', summary: 'string', nextSteps: 'string', title: 'string', slug: 'string', provider: 'string', presetId: 'string?', roeProfile: 'string?' }, 'sitrep', (p, u) => controlled(u, () => s.launchSitrep(client, p)), ['launchSitrep', 'sitrepSource', 'commanderControl']);
  add('configuration.inspect', 'query', 'Read hosts, presets, ROE, and OpOrder configuration.', {}, 'none', () => Object.fromEntries(['hosts', 'presets', 'roe', 'opOrders'].map((key) => [key, s.store.data.settings[key]])), ['store.data.settings']);
  add('configuration.save', 'action', 'Validate and save hosts, presets, ROE, and OpOrders.', { settings: 'object' }, 'none', (p) => {
    if (Object.keys(p.settings).some((key) => !['hosts', 'presets', 'roe', 'opOrders'].includes(key))) throw new Error('Only hosts, presets, ROE, and OpOrders are available to CENTCOM configuration');
    const settings = s.store.data.settings;
    return s.saveSettings({ ...settings, ...p.settings }, fingerprint(settings));
  }, ['saveSettings']);
  add('oporder.preview', 'query', 'Preview validated OpOrder enrollment.', { order: 'object' }, 'none', (p) => s.previewOpOrder(p.order), ['previewOpOrder']);
  add('oporder.enroll', 'action', 'Enroll a reviewed OpOrder revision.', { order: 'object', revision: 'string' }, 'none', (p) => s.enrollOpOrder(p.order, p.revision), ['enrollOpOrder']);
  add('automation.apply', 'action', 'Apply a persisted automation proposal through validation.', { id: 'string' }, 'none', (p) => applyAutomation(p.id), []);
  add('automation.validate', 'query', 'Validate and normalize a workflow, OpOrder, preset, or trigger payload without saving.', { kind: 'string', payload: 'object' }, 'none', (p) => automations.validate(p.kind, p.payload));
  add('automation.preview', 'query', 'Preview the exact before/after artifact and revision. Save a draft using the automations envelope collection; all applications require Watch Officer review.', { kind: 'string', payload: 'object' }, 'none', (p) => automations.preview(p.kind, p.payload));
  add('automation.read', 'query', 'Read persisted configuration and enrollment evidence for a draft; compare it with the reviewed artifact.', { id: 'string' }, 'none', (p) => automations.read(p.id));
  for (const op of ['readiness', 'issue', 'issues', 'pr', 'ready', 'close']) add(`github.${op}`, ['ready', 'close'].includes(op) ? 'action' : 'query', `GitHub ${op} using existing validated integration.`, { hostId: 'string', repo: 'string', repository: 'string?', issue: 'number?', query: 'string?', number: 'number?', headCommit: 'string?', expectedBranch: 'string?', updatedAt: 'string?', evidence: 'object?' }, 'none', (p) => s.github({ ...p, operation: op }), ['github']);
  add('devurl.list', 'query', 'List detected development URLs for an active unit.', {}, 'session', (_p, u) => s.devUrls(u.key), ['devUrls']);
  unit('devurl.open', 'Open a development URL using the managed tunnel service.', { url: 'string' }, (p, u) => controlled(u, (handle) => s.openDevUrl(client, u.transport === 'chat' ? u.key : handle, p.url)), ['openDevUrl', 'commanderControl']);
  add('history.discover', 'query', 'Discover saved session histories.', {}, 'none', null, [], [], 'Saved-history discovery, inactive-session resume, and history cleanup are unavailable to CENTCOM.');
  add('history.cleanup', 'action', 'Delete saved histories.', {}, 'none', null, [], [], 'History cleanup is outside operational control.');

  const availability = (entry) => entry.unavailable || entry.dependencies.find((dep) => call(dep) == null) && 'Required service is unavailable';
  function catalog(context) {
    return [...registry.values()].map(({ handler, dependencies, unavailable, ...entry }) => {
      const needsSession = ['session', 'sessions', 'sitrep', 'mission', 'exercise', 'contestant'].includes(entry.target);
      const reason = availability(registry.get(entry.operation)) || (context && needsSession && !context.sessions.length ? 'No connected active managed sessions are currently eligible' : '');
      const parameters = { ...(entry.target === 'session' ? { sessionKey: 'string?', key: 'string?', name: 'string?', hostId: 'string?', chatSessionId: 'string?' } : {}), ...entry.parameters };
      return { ...entry, parameters, requirements: requirements(entry), available: !reason, unavailableReason: reason || null };
    });
  }
  function definition(operation) {
    return registry.get(operation) || [...registry.values()].find((e) => e.aliases.includes(operation));
  }
  function validate(operation, input, classification) {
    const entry = definition(operation);
    if (!entry) throw Object.assign(new Error(`Unknown operation: ${operation}`), { code: 'unknown_operation' });
    const reason = availability(entry);
    if (reason) throw Object.assign(new Error(`Unavailable operation ${operation}: ${reason}`), { code: 'unsupported_operation' });
    if (entry.classification !== classification) throw new Error(`${operation} is an ${entry.classification}; use agentc2.${entry.classification}`);
    validateSchema(entry.inputSchema, input, entry.inputSchema.$defs, operation);
    for (const key of ['sessionKey', 'key', 'name', 'hostId', 'chatSessionId']) {
      if (entry.target === 'session' && input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].includes('\0'))) throw new Error(`Malformed session target: ${key}`);
    }
    return entry;
  }
  async function execute(operation, input, classification, preconditions = {}, check = () => {}) {
    const entry = validate(operation, input, classification);
    if (!preconditions || typeof preconditions !== 'object' || Array.isArray(preconditions)) throw new Error('Malformed operation preconditions');
    const target = await resolve(entry, input, preconditions);
    if (classification === 'action') await beforeMutation(entry, input, target);
    check();
    let result;
    try { result = await entry.handler(input, target); }
    catch (error) {
      // Once an adapter is entered, a generic failure cannot prove it made no
      // change. Explicit pre-dispatch guard failures remain rejected actions.
      if (classification === 'action' && !error.beforeMutation) error.uncertain = true;
      throw error;
    }
    // Historical outcomes remain inspectable after a target exits the fleet.
    if (['outcomes.read', 'history.read', 'capabilities.read', 'capabilities.support', 'units.list', 'unit.inspect', 'hosts.inspect', 'context.read', 'admission.check', 'artifact.read', 'automation.validate', 'automation.preview', 'automation.read'].includes(entry.operation)) return result;
    if (classification === 'action') return result ?? null; // No-payload adapters have an explicit JSON result.
    return (await fleet()).clean(result) ?? { unavailable: 'Result belongs to an excluded session' };
  }
  return { catalog, definition, validate, execute };
}

module.exports = { createOperations };
