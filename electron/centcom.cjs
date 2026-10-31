const { boundSituationSnapshot } = require('./centcom-snapshot.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fleetReadiness } = require('./readiness.cjs');
const { activeFleet, commanderIdentity, rosterInventory } = require('./centcom-fleet.cjs');
const { createOperations } = require('./centcom-operations.cjs');
const { createEvidence } = require('./centcom-evidence.cjs');
const { createTurnLifecycle } = require('./centcom-turn.cjs');
const { createAutomations } = require('./centcom-automations.cjs');
const { createBindings, reviewSummary } = require('./centcom-bindings.cjs');
const { mutationContext } = require('./centcom-dispatch.cjs');
const { automationSchema } = require('./centcom-schema.cjs');
const { automationOutputSchema } = require('./centcom-output.cjs');
const { automationExamples } = require('./centcom-examples.cjs');
const { renderDoctrine } = require('./centcom-doctrine.cjs');
const { summarizeAction, readHistory } = require('./centcom-history.cjs');
const { createMissions } = require('./centcom-missions.cjs');
const { createLaunchGuard, workflowReuse, exerciseRecovery, withoutLaunchContext } = require('./centcom-launch.cjs');
const { ENVELOPE_VERSION, LIMITS, AUTOMATION_KINDS, fingerprint, redact, bounded, parseCentcomEnvelope } = require('./centcom-contract.cjs');
const CONTEXT_REVISION = 2;

const PROVIDERS = ['codex', 'claude', 'antigravity', 'opencode'];
const AUTHORITIES = ['gated', 'autonomous'];
const DIRECTIVE_KINDS = [...createOperations({ service: {} }).catalog().filter((e) => e.classification === 'action').map((e) => e.operation), 'agentc2.query', 'agentc2.action'];
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

function defaults(defaultHostId = 'default') {
  return {
    version: 1,
    hostId: defaultHostId,
    provider: 'codex',
    model: 'gpt-6-astra',
    authority: 'gated',
    triggers: {
      onSpecopsHalt: true,
      onLoopFault: true,
      onFlashTraffic: true,
      onUnitFailed: true,
      onUnitCompleted: true,
      onDependencyChange: true,
      fallbackSeconds: 600,
      cooldownSeconds: 60,
      maxAutoTurnsPerHour: 12,
    },
    maxDirectivesPerTurn: 5,
    maxBudgetUsd: 10.0,
    turnDeadlineSeconds: 600,
    cancellationDeadlineSeconds: 10,
  };
}

function validateConfig(input) {
  if (!input || typeof input !== 'object' || input.version !== 1) {
    throw new Error('Invalid CENTCOM configuration');
  }
  const hostId = text(input.hostId, 80, 'host ID');
  if (!PROVIDERS.includes(input.provider)) throw new Error('Unsupported provider for CENTCOM');
  const model = text(input.model, 200, 'model ID');
  if (!AUTHORITIES.includes(input.authority)) throw new Error('Invalid authority mode');
  const t = input.triggers || {};
  if (
    typeof t.onSpecopsHalt !== 'boolean' ||
    typeof t.onLoopFault !== 'boolean' ||
    typeof t.onFlashTraffic !== 'boolean' ||
    typeof t.onUnitFailed !== 'boolean' ||
    !Number.isInteger(t.cooldownSeconds) || t.cooldownSeconds < 10 || t.cooldownSeconds > 3600 ||
    !Number.isInteger(t.maxAutoTurnsPerHour) || t.maxAutoTurnsPerHour < 1 || t.maxAutoTurnsPerHour > 100
  ) {
    throw new Error('Invalid event trigger configuration');
  }
  if (!Number.isInteger(input.maxDirectivesPerTurn) || input.maxDirectivesPerTurn < 1 || input.maxDirectivesPerTurn > 20) {
    throw new Error('maxDirectivesPerTurn must be between 1 and 20');
  }
  if (input.maxBudgetUsd != null && (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0)) {
    throw new Error('Invalid budget threshold');
  }
  if (input.turnDeadlineSeconds !== undefined && (!Number.isInteger(input.turnDeadlineSeconds) || input.turnDeadlineSeconds < 1 || input.turnDeadlineSeconds > 86400)) throw new Error('Invalid turn deadline');
  if (input.cancellationDeadlineSeconds !== undefined && (!Number.isInteger(input.cancellationDeadlineSeconds) || input.cancellationDeadlineSeconds < 1 || input.cancellationDeadlineSeconds > 120)) throw new Error('Invalid cancellation deadline');
  if (t.fallbackSeconds !== undefined && (!Number.isInteger(t.fallbackSeconds) || (t.fallbackSeconds !== 0 && (t.fallbackSeconds < 600 || t.fallbackSeconds > 86400)))) throw new Error('Fallback must be disabled or at least ten minutes');
  for (const key of ['onUnitCompleted', 'onDependencyChange']) if (t[key] !== undefined && typeof t[key] !== 'boolean') throw new Error('Invalid event trigger configuration');
  return {
    version: 1,
    hostId,
    provider: input.provider,
    model,
    authority: input.authority,
    triggers: {
      onSpecopsHalt: t.onSpecopsHalt,
      onLoopFault: t.onLoopFault,
      onFlashTraffic: t.onFlashTraffic,
      onUnitFailed: t.onUnitFailed,
      onUnitCompleted: t.onUnitCompleted !== false,
      onDependencyChange: t.onDependencyChange !== false,
      fallbackSeconds: t.fallbackSeconds ?? 600,
      cooldownSeconds: t.cooldownSeconds,
      maxAutoTurnsPerHour: t.maxAutoTurnsPerHour,
    },
    turnDeadlineSeconds: input.turnDeadlineSeconds ?? 600,
    cancellationDeadlineSeconds: input.cancellationDeadlineSeconds ?? 10,
    maxDirectivesPerTurn: input.maxDirectivesPerTurn,
    maxBudgetUsd: input.maxBudgetUsd == null ? null : Number(input.maxBudgetUsd),
  };
}

function createCentcom({ directory, service, chats, emit, timers = { setTimeout, clearTimeout, now: () => Date.now() } }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(directory, 'centcom.json');

  let defaultHost = 'default';
  try {
    defaultHost = service.store.data.settings.hosts.find((h) => h.enabled)?.id || 'default';
  } catch { /* use default */ }

  let state = {
    version: 1,
    config: defaults(defaultHost),
    session: null,
    contextRevision: CONTEXT_REVISION,
    commanderIdentities: [],
    consoleCommands: {},
    status: 'idle',
    activeLogicalTurn: null,
    providerTurn: null,
    seenEventSignatures: {},
    autoTurnsLastHour: [],
    costUsd: 0,
    costKnown: true,
    paused: false,
    directives: [],
    automations: [],
    auditLog: [],
    outcomes: [],
    outcomeSequence: 0,
    outcomeVersions: {},
    requests: {},
    pendingAlerts: [],
    inFlightAlerts: [],
    observedUnits: {},
    observedMissions: {},
    coordination: [],
    lastAutoWakeAt: 0,
    lastAssessmentAt: 0,
  };

  if (fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved && saved.version === 1) {
        state = {
          ...state,
          ...saved,
          contextRevision: saved.contextRevision || 0,
          commanderIdentities: Array.isArray(saved.commanderIdentities) ? saved.commanderIdentities : [],
          consoleCommands: saved.consoleCommands || {},
          config: validateConfig(saved.config || state.config),
          directives: Array.isArray(saved.directives) ? saved.directives : [],
          automations: Array.isArray(saved.automations) ? saved.automations : [],
          auditLog: Array.isArray(saved.auditLog) ? saved.auditLog : [],
          coordination: Array.isArray(saved.coordination) ? saved.coordination : [],
        };
      }
    } catch (e) {
      console.warn(`Could not load CENTCOM state from ${stateFile}:`, e.message);
    }
  }

  function retireSession() {
    const identity = commanderIdentity(state.session);
    if (identity && !state.commanderIdentities.some((s) => s.hostId === identity.hostId && s.key === identity.key)) state.commanderIdentities.push(identity);
    state.session = null;
  }
  const currentIdentity = commanderIdentity(state.session);
  if (currentIdentity && !state.commanderIdentities.some((s) => s.hostId === currentIdentity.hostId && s.key === currentIdentity.key)) state.commanderIdentities.push(currentIdentity);
  if (state.contextRevision !== CONTEXT_REVISION) {
    retireSession();
    state.contextRevision = CONTEXT_REVISION;
  }

  // Crash / Restart Recovery Invariants
  if (['starting', 'running'].includes(state.status)) {
    state.status = 'halted';
    state.error = 'Application restarted during CENTCOM turn. Inspect state before resuming.';
  }
  for (const d of state.directives) {
    if (d.state === 'executing') {
      d.state = 'uncertain';
      d.error = 'Application restarted during directive execution; recheck target before retrying.';
    }
  }
  // Assign legacy journal rows stable identities before the migration is saved.
  for (const entry of state.outcomes) {
    entry.outcomeId ||= crypto.randomUUID();
    entry.serverId ||= crypto.randomUUID();
    entry.status ||= entry.record?.state || entry.record?.outcome || entry.code || entry.phase || 'observed';
  }
  const interruptedQueries = new Map();
  for (const entry of state.outcomes) {
    if (entry.collection === 'query' || entry.requestCollection === 'queries') interruptedQueries.set(entry.serverId, entry);
  }
  for (const entry of interruptedQueries.values()) if (entry.status === 'running') {
    diagnostic({ code: 'query_interrupted', collection: 'queries', serverId: entry.serverId, clientRequestId: entry.clientRequestId,
      turnId: entry.turnId, kind: entry.kind, status: 'uncertain', message: 'Application restarted before query completion was persisted. Read-only queries may be submitted again.' });
  }

  function actionFacts(record) {
    const result = record.result;
    return { submission: result?.state || result?.delivery || ({ pending: 'not_submitted', denied: 'not_submitted', executing: 'dispatching', completed: 'completed' })[record.state] || 'unknown',
      commandId: result?.commandId || null, sessionId: result?.sessionId || null, providerTurnId: result?.result?.turnId || null,
      providerTurnCompletion: 'unverified', projectAcceptance: 'unverified' };
  }
  function boundOutcomePage(page, maxBytes) {
    const result = { ...page, entries: [] };
    for (const entry of page.entries) {
      let item = { ...entry, ...(entry.record !== undefined ? { record: bounded(entry.record, 2000) } : {}), ...(entry.result !== undefined ? { result: bounded(entry.result, 2000) } : {}) };
      if (Buffer.byteLength(JSON.stringify(item)) > 6000) item = { ...bounded(item, 6000), ...Object.fromEntries(
        ['id', 'key', 'hostId', 'provider', 'transport', 'classification', 'execution', 'sequence', 'outcomeId', 'serverId', 'clientRequestId', 'status', 'collection'].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])) };
      if (result.entries.length && Buffer.byteLength(JSON.stringify({ ...result, entries: [...result.entries, item] })) > maxBytes - 1000) break;
      result.entries.push(item);
    }
    if (result.entries.length < page.entries.length) {
      result.cursor = typeof page.cursor === 'string' ? result.entries.at(-1)?.id || page.after || '' : result.entries.at(-1)?.sequence || page.after || 0;
      result.hasMore = true;
      result.partial = true;
    }
    return result;
  }

  function recordOutcome(value) {
    const safe = Object.fromEntries(Object.entries(redact(value)).map(([key, item]) => [key,
      typeof item === 'string' && item.length > 4000 ? item.slice(0, 4000) + ' [truncated]' : key === 'result' && Array.isArray(item?.entries) && (Number.isSafeInteger(item.cursor) || typeof item.cursor === 'string') ? boundOutcomePage(item, 12000)
        : item && typeof item === 'object' ? bounded(item, 16000) : item]));
    const entry = { ...JSON.parse(JSON.stringify(safe)), outcomeId: crypto.randomUUID(), serverId: value.serverId || crypto.randomUUID(),
      status: value.status || value.record?.state || value.record?.outcome || value.code || value.phase || 'observed',
      sequence: ++state.outcomeSequence, recordedAt: Date.now() };
    state.outcomes.push(entry);
    // Cursor gaps are explicit when the retention window has moved.
    if (state.outcomes.length > 2000) state.outcomes.splice(0, state.outcomes.length - 2000);
    return entry;
  }
  function syncOutcomes() {
    for (const [collection, records] of [['directive', state.directives], ['automation', state.automations], ['audit', state.auditLog]]) {
      for (const record of records) {
        const key = `${collection}:${record.id}`;
        const version = fingerprint(record);
        if (state.outcomeVersions[key] === version) continue;
        state.outcomeVersions[key] = version;
        const directive = collection === 'audit' ? state.directives.find((d) => d.id === record.id) : null;
        recordOutcome({ collection, serverId: record.id, clientRequestId: record.clientRequestId || directive?.clientRequestId || null,
          turnId: record.turnId || directive?.turnId || null, kind: record.kind,
          ...(collection === 'directive' ? { action: summarizeAction(record) } : {}),
          ...(['directive', 'audit'].includes(collection) ? { facts: actionFacts(directive || record) } : {}), record });
      }
    }
  }
  function readOutcomes({ after = 0, limit = 20, collection, clientRequestId, serverId } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) throw new Error('Invalid outcome cursor or limit');
    if (collection && !['directive', 'automation', 'approval', 'audit', 'diagnostic', 'query', 'provider'].includes(collection)) throw new Error('Invalid outcome collection');
    const matches = state.outcomes.filter((r) => r.sequence > after && (!collection || r.collection === collection) && (!clientRequestId || r.clientRequestId === clientRequestId) && (!serverId || r.serverId === serverId));
    const entries = [];
    for (const entry of matches.slice(0, limit)) {
      const item = { ...entry, ...(entry.record !== undefined ? { record: bounded(entry.record, 12000) } : {}),
        ...(entry.result !== undefined ? { result: Array.isArray(entry.result?.entries) ? boundOutcomePage(entry.result, 12000) : bounded(entry.result, 12000) } : {}) };
      if (entries.length && Buffer.byteLength(JSON.stringify([...entries, item])) > LIMITS.resultBytes - 1000) break;
      entries.push(item);
    }
    return { entries, cursor: entries.at(-1)?.sequence || after, hasMore: matches.length > entries.length, retainedFrom: state.outcomes[0]?.sequence || 1, truncated: after < (state.outcomes[0]?.sequence || 1) - 1 };
  }
  function diagnostic(value) {
    const { collection: requestCollection, ...details } = value;
    return recordOutcome({ ...details, requestCollection, collection: 'diagnostic' });
  }
  function recordApproval(record, decision, targetCollection = 'directive') {
    recordOutcome({ collection: 'approval', targetCollection, serverId: record.id, clientRequestId: record.clientRequestId || null,
      turnId: record.turnId, kind: record.kind, status: ({ approve: 'approved', deny: 'denied', apply: 'approved', dismiss: 'dismissed' })[decision],
      decision, actor: 'watch_officer', bindingHash: record.binding?.evidenceHash || record.preview?.revision || null });
    writeState();
  }
  function duplicateRequest(collection, request) {
    if (!request.id) return null; // Legacy requests without IDs cannot be retried safely.
    const key = JSON.stringify([state.session?.chatSessionId, collection, request.id]);
    const previous = state.requests[key];
    const hash = fingerprint(request);
    if (previous) return { clientRequestId: request.id, serverId: previous.serverId, code: previous.fingerprint === hash ? 'duplicate_request' : 'request_id_conflict', message: previous.fingerprint === hash ? 'Original request retained; use outcomes.read for its state.' : 'Request ID was already used with different input.' };
    return null;
  }
  function rememberRequest(collection, request, serverId) {
    if (request.id) state.requests[JSON.stringify([state.session?.chatSessionId, collection, request.id])] = { fingerprint: fingerprint(request), serverId };
  }
  for (const auto of state.automations) if (auto.state === 'applying') {
    auto.state = 'uncertain'; auto.error = 'Application restarted during automation persistence; inspect the saved artifact before retrying.';
  }
  function writeState() {
    if (disposed) return;
    syncOutcomes();
    const temp = stateFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, stateFile);
    emit('centcom:updated', publicState());
  }

  function publicState() {
    return {
      config: structuredClone(state.config),
      session: state.session ? structuredClone(state.session) : null,
      status: state.status,
      providerTurn: state.providerTurn ? { commandId: state.providerTurn.commandId, turnId: state.providerTurn.turnId, status: state.providerTurn.status, hostId: state.providerTurn.hostId, sessionId: state.providerTurn.sessionId, cursor: state.providerTurn.cursor } : null,
      error: state.error || '',
      costUsd: state.costUsd || 0,
      costKnown: state.costKnown !== false,
      paused: Boolean(state.paused),
      autoTurnsLastHour: (state.autoTurnsLastHour || []).filter((t) => Date.now() - t < 3600000).length,
      directives: structuredClone((state.directives || []).map((d) => ({ ...d, binding: reviewSummary(d.binding) }))),
      automations: structuredClone(state.automations || []),
      auditLog: structuredClone((state.auditLog || []).slice(0, 100)),
    };
  }

  const client = { id: 'centcom-commander', name: 'CENTCOM Engine' };
  let queue = Promise.resolve();
  let activeTurnAbort = null;
  const consoleFlights = new Map();
  const approvalResults = new Map();
  let disposed = false;
  state.pendingAlerts.push(...state.inFlightAlerts);
  state.inFlightAlerts = [];
  let wakeTimer = null;
  let wakeFlight = null;
  const turnLifecycle = createTurnLifecycle({ chats, client, state, persist: writeState, outcome: recordOutcome });
  let retirementFlight = null;
  async function reconcileRetiredSessions() {
    if (retirementFlight) return retirementFlight;
    retirementFlight = (async () => {
      for (const identity of state.commanderIdentities) {
        if (disposed) break;
        if (!identity.chatSessionId || identity.retirement?.status === 'stopped' ||
          (state.session?.hostId === identity.hostId && state.session.chatSessionId === identity.chatSessionId) ||
          (state.providerTurn?.hostId === identity.hostId && state.providerTurn.sessionId === identity.chatSessionId)) continue;
        const retirement = identity.retirement ||= {};
        if (retirement.checkedAt && Date.now() - retirement.checkedAt < 30000) continue;
        retirement.checkedAt = Date.now();
        try {
          const page = await chats.read(identity.hostId, identity.chatSessionId, 0, 1);
          if (disposed) break;
          if (page.session?.id !== identity.chatSessionId) throw new Error('Retired commander identity mismatch');
          if (page.session.state === 'stopped') { retirement.status = 'stopped'; retirement.error = ''; writeState(); continue; }
          if (!retirement.command && (!['idle', 'failed'].includes(page.session.state) || page.pendingCommands?.length || page.pendingRequests?.length)) {
            retirement.status = 'deferred'; retirement.error = 'Provider is active or its state is unknown'; writeState(); continue;
          }
          let receipt;
          if (retirement.command) {
            // A crash/timeout may have happened after delivery. Query the saved
            // receipt; never replay an uncertain stop, even after app restart.
            receipt = await chats.request(identity.hostId, 'receipt', { commandId: retirement.command.commandId });
          } else {
            retirement.command = { protocolVersion: 1, commandId: crypto.randomUUID(), operation: 'stop', sessionId: identity.chatSessionId, payload: {} };
            retirement.status = 'stopping'; writeState();
            receipt = await chats.request(identity.hostId, 'command', { command: retirement.command });
          }
          if (receipt?.commandId !== retirement.command.commandId || receipt.sessionId !== identity.chatSessionId) throw new Error('Retired commander stop receipt is unconfirmed');
          retirement.status = receipt.state === 'completed' ? 'stopped' : 'uncertain';
          retirement.error = receipt.state === 'completed' ? '' : receipt.error || 'Provider stop is unconfirmed';
        } catch (error) { retirement.status = 'uncertain'; retirement.error = error.message; }
        writeState();
      }
    })().finally(() => { retirementFlight = null; });
    return retirementFlight;
  }

  function enqueue(action) {
    const flight = queue.then(() => withoutLaunchContext(action));
    queue = flight.catch((err) => {
      console.error('CENTCOM scheduler turn error:', err);
    });
    return flight;
  }

  async function ensureSession() {
    if (state.session && state.session.hostId === state.config.hostId && state.session.provider === state.config.provider && state.session.model === state.config.model) {
      return state.session;
    }
    retireSession();
    writeState();
    const host = service.getHost(state.config.hostId);
    const managedName = `hq-centcom-${crypto.randomBytes(3).toString('hex')}`;
    const initialDoctrine = buildDoctrinePrompt();

    // CENTCOM workspace is strictly isolated on the host
    const syncRes = await service.runRemote({
      action: 'centcom_sync',
      files: {
        'AGENTS.md': initialDoctrine,
        'SITUATION.json': JSON.stringify(await buildSituationSnapshot()),
        'CAPABILITIES.json': JSON.stringify(capabilityManifest(undefined, { full: true })),
      },
    }, host.id);

    // Provider permission enforcement: CENTCOM is strictly launched in gated / read-only roeProfile
    const roeProfile = state.config.provider === 'opencode' ? 'provider-default' : 'gated';
    const created = await service.create({
      hostId: host.id,
      provider: state.config.provider,
      model: state.config.model,
      transport: 'chat',
      managedName,
      title: `CENTCOM // ${state.config.provider.toUpperCase()} (${state.config.model})`,
      cwd: syncRes.path,
      roeProfile,
      // The lifecycle owns the first prompt. Creation instructions would start
      // a second, untracked provider turn before the assessment can be sent.
    });

    state.session = {
      name: created.name,
      chatSessionId: created.chatSessionId,
      hostId: host.id,
      provider: state.config.provider,
      model: state.config.model,
      createdAt: Date.now(),
      state: 'idle',
      key: created.key || `${host.id}/tmux:${created.name}`,
    };
    state.commanderIdentities.push(commanderIdentity(state.session));
    writeState();
    return state.session;
  }

  function buildDoctrinePrompt() {
    return renderDoctrine(capabilityManifest(), operations.catalog());
  }

  async function fleet(inventory) {
    return activeFleet(inventory || await service.inventory(), service.store.data.deletedSessions || [], state.commanderIdentities);
  }

  async function buildSituationSnapshot() {
    const f = await fleet();
    const flash = f.flash(await service.flashQueue());
    const faults = (service.loopBreaker.faults() || []).filter((item) => f.keys.has(item.sessionKey));
    const readiness = fleetReadiness({ ...f.inventory, sessions: f.sessions.map((s) => ({ ...s, state: 'live' })), faults }, flash);
    const specops = f.clean(service.specops.list());
    const exercises = f.clean(service.exercises.list());
    const units = f.sessions.map((s) => ({
      key: s.key, name: s.id || s.name, chatSessionId: s.chatSessionId,
      title: s.title, provider: s.provider, transport: s.transport,
      state: s.state, chatState: s.chatState, activity: s.activity, roeProfile: s.roeProfile,
      canInterrupt: s.canInterrupt, canStop: s.canStop,
      hostId: s.hostId, branch: s.branch, repository: s.repository,
      telemetry: s.telemetry,
      outputTail: s.outputTail ? s.outputTail.split('\n').slice(-20).join('\n') : '',
    }));
    const evidence = redact(f.clean({
      capturedAt: new Date().toISOString(),
      defcon: readiness.level, defconLabel: readiness.label, defconReasons: readiness.reasons,
      theaters: (f.inventory.hosts || []).map((h) => ({ id: h.id, name: h.name, connected: h.connected })),
      units, specops, exercises, faults, attention: f.inventory.attention || [],
      flash, flashCount: flash.filter((r) => r.state === 'pending').length,
    }));
    return boundSituationSnapshot({ ...evidence, hostEvidence: bounded(await operations.execute('hosts.inspect', {}, 'query'), 24000), inspection: { operation: 'units.list', scope: 'Includes external and saved records; mutation eligibility is separate' }, capabilities: operations.catalog(f), contract: capabilityManifest(f), outcomes: readOutcomes({ after: Math.max(0, state.outcomeSequence - 10), limit: 10 }) });
  }

  async function executeTurn(userPrompt, source = 'user', initialHop = 0, consoleCommand = null, logicalTurnId = null) {
    if (state.status === 'running') throw new Error('CENTCOM is already processing an active turn');
    const abort = new AbortController();
    activeTurnAbort = abort;
    const check = () => { if (abort.signal.aborted || disposed) throw new Error('CENTCOM turn interrupted by Watch Officer'); };
    let session;
    try {
      if (state.providerTurn && !await turnLifecycle.reconcile()) throw new Error('Previous CENTCOM provider turn remains uncertain; reconcile it before launching another session');
      check(); session = await ensureSession(); check();
    }
    catch (error) {
      if (activeTurnAbort === abort) activeTurnAbort = null;
      state.status = 'halted'; state.error = error.message; writeState();
      throw error;
    }

    state.status = 'running';
    state.error = '';
    const turnId = logicalTurnId || crypto.randomUUID();
    state.activeLogicalTurn = { turnId, source, hop: initialHop, startedAt: Date.now() };
    writeState();

    let queryHop = initialHop;
    let nextPrompt = userPrompt;

    try {
      while (queryHop <= 3) {
        check();
        // Enforce spending ceiling
        if (state.config.maxBudgetUsd != null && state.costUsd >= state.config.maxBudgetUsd) {
          state.status = 'halted';
          state.error = `CENTCOM budget limit ($${state.config.maxBudgetUsd}) reached. Further turns paused.`;
          writeState();
          throw new Error(state.error);
        }

        // Sync fresh sanitized snapshot to host workspace
        const snapshot = await buildSituationSnapshot();
        await service.runRemote({
          action: 'centcom_sync',
          files: { 'AGENTS.md': buildDoctrinePrompt(), 'SITUATION.json': JSON.stringify(snapshot), 'CAPABILITIES.json': JSON.stringify(capabilityManifest(undefined, { full: true })) },
        }, session.hostId);

        check();
        const turnCommandId = queryHop === initialHop && consoleCommand ? consoleCommand.command.commandId : crypto.randomUUID();
        const contextualPrompt = [
          `<UNTRUSTED_FLEET_EVIDENCE>`,
          `SITUATION SNAPSHOT (DEFCON ${snapshot.defcon || '—'} · ${snapshot.defconLabel}):`,
          `Observed units: ${snapshot.units.length} · Halted missions: ${snapshot.specops.filter((m) => m.state === 'halted').length} · Faults: ${snapshot.faults.length}`,
          ...(snapshot.truncation ? ['SITUATION.json is partial. Read its truncation totals and omitted counts before assessing the fleet.'] : []),
          `</UNTRUSTED_FLEET_EVIDENCE>`,
          '',
          ...(!session.doctrineDelivered ? [buildDoctrinePrompt(), ''] : []),
          redact(nextPrompt),
        ].join('\n');

        const finalAssistantText = await turnLifecycle.run({ session, commandId: turnCommandId, text: contextualPrompt, signal: abort.signal, logicalTurnId: turnId,
          dispatched: queryHop === initialHop && consoleCommand ? consoleCommand.dispatched : undefined });
        session.doctrineDelivered = true;
        writeState();
        check();

        // Parse completion-correlated agentc2-c2 envelope
        const envelope = parseCentcomEnvelope(finalAssistantText);
        if (envelope?.error) {
          const result = diagnostic({ code: 'malformed_envelope', message: envelope.error, turnId });
          writeState();
          if (queryHop < LIMITS.queryHops) { queryHop++; nextPrompt = JSON.stringify({ diagnostics: [result] }); continue; }
          break;
        }
        if (!envelope) {
          // No actionable block or syntax error: turn finishes cleanly as regular advisory
          break;
        }

        const outcomeCursor = state.outcomeSequence;
        const actionResults = [];
        for (const item of envelope.diagnostics) actionResults.push(diagnostic({ ...item, turnId }));
        // Persist proposals before any continuation; permanent changes are reviewed.
        for (const auto of envelope.automations) {
          const duplicate = duplicateRequest('automation', auto);
          if (duplicate) { actionResults.push(diagnostic({ ...duplicate, turnId })); continue; }
          try {
            const preview = await automations.preview(auto.kind, auto.payload);
            const record = {
              id: crypto.randomUUID(), clientRequestId: auto.id || null, turnId, kind: auto.kind,
              title: text(auto.title, 150, 'title'), rationale: text(auto.rationale, 2000, 'rationale'),
              evidence: Array.isArray(auto.evidence) ? auto.evidence.map(String).slice(0, 10) : [],
              payload: preview.payload, preview, state: 'proposed', createdAt: Date.now(), appliedAt: null,
            };
            state.automations.unshift(record);
            rememberRequest('automation', auto, record.id);
            actionResults.push({ id: record.id, clientRequestId: record.clientRequestId, status: 'proposed' });
          } catch (error) { actionResults.push(diagnostic({ code: 'invalid_automation', clientRequestId: auto.id || null, message: error.message, turnId })); }
        }

        // Handle directives
        for (const d of envelope.directives) {
          check();
          const duplicate = duplicateRequest('directive', d);
          if (duplicate) { actionResults.push(diagnostic({ ...duplicate, turnId })); continue; }
          const directiveRecord = {
            id: crypto.randomUUID(),
            turnId,
            clientRequestId: d.id || null,
            kind: d.kind,
            summary: String(d.summary || d.kind).slice(0, 150),
            rationale: String(d.rationale || envelope.rationale || 'Commander directive').slice(0, 2000),
            preconditions: structuredClone(d.preconditions || {}),
            params: structuredClone(d.params || {}),
            state: 'pending',
            trigger: source,
            createdAt: Date.now(),
            resolvedAt: null,
          };

          try { await bindDirective(directiveRecord); } catch (error) { directiveRecord.validationError = error.message; directiveRecord.validationCode = error.code || 'invalid_directive'; }
          rememberRequest('directive', d, directiveRecord.id);
          if (directiveRecord.validationError) actionResults.push(diagnostic({ code: directiveRecord.validationCode, serverId: directiveRecord.id, clientRequestId: d.id || null, message: directiveRecord.validationError, turnId }));
          check();
          if (state.config.authority === 'autonomous' && !directiveRecord.reviewRequired) {
            // Autonomous C2: execute immediately within directive limits
            const activeDirectivesCount = state.directives.filter((item) => item.turnId === turnId).length;
            if (activeDirectivesCount >= state.config.maxDirectivesPerTurn) {
              directiveRecord.state = 'pending';
              directiveRecord.error = `Directive limit (${state.config.maxDirectivesPerTurn}) reached for this turn; requires manual approval`;
              state.directives.unshift(directiveRecord);
            } else {
              directiveRecord.state = 'executing';
              state.directives.unshift(directiveRecord);
              writeState();
              try {
                const execResult = await executeDirective(directiveRecord, check);
                directiveRecord.state = resultState(execResult);
                directiveRecord.result = execResult;
                directiveRecord.resolvedAt = Date.now();
                actionResults.push({ id: directiveRecord.id, status: directiveRecord.state, result: execResult });
                state.auditLog.unshift({
                  id: directiveRecord.id,
                  kind: directiveRecord.kind,
                  summary: directiveRecord.summary,
                  outcome: directiveRecord.state,
                  result: execResult,
                  at: Date.now(),
                  trigger: source,
                });
              } catch (err) {
                directiveRecord.state = abort.signal.aborted || err.uncertain ? 'uncertain' : 'failed';
                if (err.commandId) directiveRecord.result = { commandId: err.commandId, sessionId: err.sessionId, delivery: 'uncertain', taskCompletion: 'unverified' };
                actionResults.push({ id: directiveRecord.id, status: directiveRecord.state, result: directiveRecord.result, error: err.message });
                directiveRecord.error = err.message;
                directiveRecord.resolvedAt = Date.now();
                state.auditLog.unshift({
                  id: directiveRecord.id,
                  kind: directiveRecord.kind,
                  summary: directiveRecord.summary,
                  outcome: directiveRecord.state,
                  result: directiveRecord.result,
                  error: err.message,
                  at: Date.now(),
                  trigger: source,
                });
              }
            }
          } else {
            // Gated C2: stage for Watch Officer review
            state.directives.unshift(directiveRecord);
          }
        }
        writeState();
        // Handle queries (bounded multi-hop)
        if (envelope.queries.length && queryHop < LIMITS.queryHops) {
          queryHop++;
          for (const q of envelope.queries) {
            check();
            const qKind = q.kind || q.type;
            const correlation = { serverId: crypto.randomUUID(), clientRequestId: q.id || null, kind: qKind, turnId };
            recordOutcome({ ...correlation, collection: 'query', status: 'running' });
            writeState();
            try {
              const res = await executeQuery(q, check);
              recordOutcome({ ...correlation, collection: 'query', status: 'ok', result: bounded(res) });
            } catch (err) {
              diagnostic({ ...correlation, collection: 'queries', code: err.code || 'query_error', status: 'failed', error: err.message });
            }
            writeState();
          }
          nextPrompt = [
            '<agentc2-c2-results>',
            JSON.stringify(readOutcomes({ after: outcomeCursor, limit: LIMITS.pageSize })),
            '</agentc2-c2-results>',
            'Based on these query results, provide your final assessment and directives. If hasMore, continue outcomes.read from cursor.',
          ].join('\n');
          continue; // Run next query hop
        }

        if (envelope.queries.length && queryHop >= LIMITS.queryHops) {
          for (const q of envelope.queries) diagnostic({ code: 'hop_limit', clientRequestId: q.id || null, kind: q.kind || q.type, message: 'Query was not executed: continuation hop limit exhausted', turnId });
          writeState();
        }
        if (actionResults.length && queryHop < LIMITS.queryHops) {
          queryHop++;
          nextPrompt = '<agentc2-c2-results>\n' + JSON.stringify(readOutcomes({ after: outcomeCursor, limit: LIMITS.pageSize })) + '\n</agentc2-c2-results>\nAssess these action receipts. Delivery does not prove task completion. If hasMore, continue outcomes.read from cursor.';
          continue;
        }
        break; // Hop loop completed
      }

      state.status = state.directives.some((d) => d.state === 'pending') ? 'awaiting_approval' : 'idle';
      state.activeLogicalTurn = null;
      writeState();
    } catch (err) {
      state.status = 'halted';
      state.error = err.message;
      state.activeLogicalTurn = null;
      writeState();
      throw err;
    } finally {
      if (activeTurnAbort === abort) activeTurnAbort = null;
      state.lastAssessmentAt = timers.now();
      writeState();
      scheduleWake();
    }
  }

  function operationRequest(request, classification) {
    const kind = request.kind || request.type;
    if (kind === 'agentc2.query' || kind === 'agentc2.action') {
      if (kind !== `agentc2.${classification}`) throw new Error(`Use agentc2.${classification} in this envelope collection`);
      const params = request.params;
      if (!params || Object.keys(params).some((k) => !['operation', 'input'].includes(k)) || typeof params.operation !== 'string') throw new Error('Malformed operation request; expected { operation, input }');
      return { operation: params.operation, input: params.input };
    }
    return { operation: kind, input: request.params || {} };
  }

  function resultState(result) {
    if (result?.state === 'failed') return 'failed';
    if (['accepted', 'dispatching', 'unknown'].includes(result?.state)) return 'uncertain';
    return 'completed';
  }

  async function resolveTarget(entry, p, pre = {}) {
    if (entry.target === 'none' && !pre.sessionKey) return null;
    const f = await fleet();
    const resolveOne = (input, conditions = {}) => {
      const refs = [input.sessionKey, input.key, conditions.sessionKey].filter(Boolean);
      if (input.name) refs.push(`${input.sourceHostId || input.hostId || state.config.hostId}/tmux:${input.name}`);
      if (!refs.length) throw new Error('Active session target is required');
      const targets = refs.map((key) => f.find(key));
      if (targets.some((u) => !u)) throw new Error('Precondition failed: target is not an eligible connected active managed session');
      const u = targets[0];
      if (targets.some((v) => v.key !== u.key) || (input.hostId && input.hostId !== u.hostId) || (input.sourceHostId && input.sourceHostId !== u.hostId) || (input.chatSessionId && input.chatSessionId !== u.chatSessionId)) throw new Error('Conflicting session target identities');
      if (conditions.state && conditions.state !== u.state) throw new Error(`Precondition failed: session is ${u.state}, expected ${conditions.state}`);
      if (conditions.identity && (conditions.identity.name !== (u.id || u.name) || conditions.identity.hostId !== u.hostId || conditions.identity.chatSessionId !== u.chatSessionId)) throw new Error('Session identity changed since proposal');
      return u;
    };
    if (entry.target === 'new') {
      if (['conversationId', 'agentId', 'providerSessionId', 'recoverSitrep'].some((k) => p[k])) throw new Error('Inactive-session resume is unavailable');
    }
    if (entry.target === 'session') {
      let input = p;
      if (entry.operation === 'flash.decide') {
        const request = f.flash(await service.flashQueue()).find((r) => r.id === p.id && r.state === 'pending');
        if (!request) throw new Error('Flash Traffic target is unavailable');
        input = { ...p, name: p.name || request.name, hostId: p.hostId || request.hostId };
        if (input.name !== request.name || input.hostId !== request.hostId) throw new Error('Conflicting Flash Traffic target identities');
      }
      return resolveOne(input, pre);
    }
    if (entry.target === 'sessions') {
      const keys = p.keys?.length ? p.keys : [...f.keys];
      return keys.map((sessionKey) => resolveOne({ sessionKey }));
    }
    if (entry.target === 'sitrep') {
      const source = service.sitrepSource(p.id);
      if (!source) throw new Error('SitRep preview is unavailable');
      return resolveOne({ name: source.name, hostId: source.sourceHostId }, pre);
    }
    if (entry.target === 'coordination') return p.plan.owners.map((owner) => resolveOne({ sessionKey: owner.sessionKey }, pre));
    if (['mission', 'exercise', 'contestant'].includes(entry.target)) {
      const mission = entry.target === 'mission';
      const record = (mission ? service.specops.list() : service.exercises.list()).find((r) => r.id === p.id);
      if (!record) throw new Error('Operation is unavailable');
      const blockedLaunch = mission ? record.visits?.at(-1)?.launchBlocked : record.contestants?.some((item) => item.launchBlocked || ['failed', 'launching'].includes(item.state));
      if (entry.classification === 'action' && p.action === 'retry' && record.launchPolicy && blockedLaunch) {
        const targets = (mission ? record.visits : record.contestants).map((item) => f.find(item.name || item.sessionId, record.hostId)).filter(Boolean);
        if (pre.sessionKey && !targets.some((unit) => unit.key === pre.sessionKey)) throw new Error('Conflicting operation precondition');
        return [...new Map(targets.map((unit) => [unit.key, unit])).values()];
      }
      const participants = mission ? record.visits || [] : record.contestants || [];
      const selected = p.contestantId ? participants.filter((c) => c.id === p.contestantId)
        : mission && entry.classification === 'action' ? participants.slice(-1) : participants;
      if (p.contestantId && !selected.length) throw new Error('Contestant is unavailable');
      if (!selected.some((c) => c.name || c.sessionId)) throw new Error('Operation has no active participants');
      const targets = selected.filter((c) => c.name || c.sessionId).map((c) => {
        const u = f.find(c.name || c.sessionId, record.hostId);
        if (!u && (entry.classification === 'action' || p.contestantId)) throw new Error('Operation participant is outside the active fleet');
        return u;
      }).filter(Boolean);
      if (!targets.length) throw new Error('Operation has no active participants');
      if (pre.identities && (pre.identities.length !== targets.length || pre.identities.some((identity) => !targets.some((u) => u.key === identity.key && u.hostId === identity.hostId && (u.id || u.name) === identity.name && u.chatSessionId === identity.chatSessionId)))) throw new Error('Operation participant identity changed since proposal');
      if (pre.sessionKey && !targets.some((u) => u.key === pre.sessionKey)) throw new Error('Conflicting operation precondition');
      return targets;
    }
    if (pre.sessionKey) resolveOne({}, pre);
    return null;
  }

  const evidence = createEvidence({ service, isCommander, activeKeys: async (inventory) => (await fleet(inventory)).keys });
  const launchGuard = createLaunchGuard({ service, evidence, authority: () => ({ mode: state.config.authority, commander: state.session?.chatSessionId || null }),
    legacyPolicy: (workflow) => {
      if (!workflow?.id || !['specops', 'exercise'].includes(workflow.kind)) return null;
      const operation = workflow.kind === 'specops' ? 'specops.launch' : 'exercise.create';
      const source = state.directives.find((directive) => {
        const kind = directive.canonicalOperation || directive.params?.operation || directive.kind;
        const input = directive.params?.input || directive.params;
        return directive.result?.id === workflow.id && (kind === operation || (kind === `${workflow.kind}.control` && ['resume', 'retry'].includes(input?.action)));
      });
      return source ? { version: 0, directiveId: source.id, legacy: true } : null;
    } });
  const missions = createMissions({ state, service, persist: writeState, inventory: () => service.inventory(), isCommander });
  const automations = createAutomations({ service, state, validateConfig, persist: writeState, stateFile });
  const operations = createOperations({ evidence, missions, readHistory: (input) => readHistory(state, input), automations: { ...automations, read: (id) => automations.read(state.automations.find((a) => a.id === id)) }, readOutcomes, manifest: capabilityManifest, service, client,
    beforeMutation: async () => { await bindings.assert(mutationContext.getStore()?.directive); },
    control: (unit, fn) => service.commanderControl(client, unit, async (handle, controlling) => {
    try {
      const current = (await fleet()).find(unit.key);
      if (!current || current.chatSessionId !== unit.chatSessionId || (current.id || current.name) !== (unit.id || unit.name)) throw new Error('Target left the active fleet while acquiring control');
      if (activeTurnAbort?.signal.aborted || disposed) throw new Error('CENTCOM turn interrupted by Watch Officer');
      await bindings.assert(mutationContext.getStore()?.directive, controlling);
    } catch (error) { error.beforeMutation = true; throw error; }
    return fn(handle);
  }), resolve: resolveTarget, fleet, applyAutomation: applyAutomationById });
  const bindings = createBindings({ service, state, resolve: resolveTarget, request: (directive, classification) => {
    const r = operationRequest(directive, classification);
    return { ...r, entry: operations.validate(r.operation, r.input, classification) };
  } });
  function capabilityManifest(context, { operation, automationKind, schema = 'input', definition, full = false } = {}) {
    if (operation && automationKind) throw new Error('Select either operation or automationKind');
    if (!['input', 'output'].includes(schema)) throw new Error('Choose input or output schema');
    const catalog = operations.catalog(context);
    if (operation && !operations.definition(operation)) throw new Error('Unknown capability operation');
    if (automationKind && !AUTOMATION_KINDS.includes(automationKind)) throw new Error('Unknown automation kind');
    if (definition) {
      const selected = operation ? operations.definition(operation)[`${schema}Schema`] : automationKind ? schema === 'input' ? automationSchema(automationKind) : automationOutputSchema(automationKind) : null;
      if (!selected?.$defs || !Object.hasOwn(selected.$defs, definition)) throw new Error('Unknown schema definition; select a capability and its schema');
      return { version: 1, operation, automationKind, schema, definition, value: selected.$defs[definition],
        references: 'Resolve remaining #/$defs references with the same capability, schema, and definition selector; CAPABILITIES.json contains complete bundled schemas.' };
    }
    const result = { version: 1, envelopeVersion: ENVELOPE_VERSION, authority: state.config.authority, limits: { ...LIMITS, maxDirectivesPerTurn: state.config.maxDirectivesPerTurn, maxBudgetUsd: state.config.maxBudgetUsd,
      turnDeadlineSeconds: state.config.turnDeadlineSeconds, cancellationDeadlineSeconds: state.config.cancellationDeadlineSeconds, fallbackSeconds: state.config.triggers.fallbackSeconds },
      spend: { knownUsd: state.costUsd, coverage: state.costKnown ? 'complete' : 'incomplete', budgetPolicy: 'Stop at known spend ceiling; unknown spend is not zero.' },
      operations: automationKind ? [] : catalog.filter((e) => !operation || e.operation === operations.definition(operation).operation).map((entry) => full ? entry
        : { operation: entry.operation, classification: entry.classification, reviewRequired: entry.reviewRequired, available: entry.available, unavailableReason: entry.unavailableReason,
          ...(operation ? { requirements: entry.requirements, [`${schema}Schema`]: entry[`${schema}Schema`], ...(schema === 'input' ? { examples: entry.examples } : {}) } : {}) }), automationKinds: AUTOMATION_KINDS,
      automations: operation ? [] : AUTOMATION_KINDS.filter((kind) => !automationKind || kind === automationKind).map((kind) => ({ kind,
        ...(full ? { inputSchema: automationSchema(kind), outputSchema: automationOutputSchema(kind), examples: automationExamples(kind) } : automationKind ? { [`${schema}Schema`]: schema === 'input' ? automationSchema(kind) : automationOutputSchema(kind), ...(schema === 'input' ? { examples: automationExamples(kind) } : {}) } : { schemaQuery: { automationKind: kind } }), reviewRequired: true })),
      support: { operation: 'capabilities.support', filters: ['operation', 'hostId', 'provider', 'transport', 'sessionKey', 'after', 'limit'], freshness: 'Live read; revalidate at dispatch. Unknown prerequisites are not support guarantees.' },
      schemaRead: 'Use capabilities.read with operation or automationKind and schema: input or output.',
      approval: { permanentChanges: 'watch_officer', nativePermissions: 'separate_from_c2', uncertain: 'inspect_before_retry' } };
    if (operation || automationKind) {
      delete result.support; delete result.schemaRead; delete result.spend; delete result.automationKinds;
    }
    return result;
  }
  async function launchAdmission(request) {
    const p = request.input;
    if (request.operation === 'unit.create') {
      const preset = service.store.data.settings.presets.find((item) => item.id === p.presetId);
      return evidence.admission({ ...p, cwd: p.cwd || preset?.cwd || '' });
    }
    if (['specops.launch', 'exercise.create'].includes(request.operation)) return evidence.admission({ hostId: p.hostId, worktree: { repository: p.repository } });
    if (['specops.control', 'exercise.control'].includes(request.operation) && p.action === 'retry') {
      const mission = request.operation === 'specops.control';
      const record = (mission ? service.specops.list() : service.exercises.list()).find((item) => item.id === p.id);
      if (!record) throw new Error('Workflow is unavailable');
      if (!mission) {
        const pending = record.contestants.filter((item) => ['queued', 'failed', 'launching'].includes(item.state));
        const reports = [];
        for (const item of pending) reports.push({ operationId: item.id, ...await evidence.admission({ hostId: record.hostId, worktree: { operationId: item.id, repository: record.repository } }, { recovery: exerciseRecovery(record, item) }) });
        if (reports.length) {
          const blockers = [...new Set(reports.flatMap((report) => report.blockers))], unknowns = [...new Set(reports.flatMap((report) => report.unknowns))];
          return { ...reports[0], status: blockers.length ? 'blocked' : unknowns.length ? 'unknown' : 'admitted', blockers, unknowns,
            owners: [...new Map(reports.flatMap((report) => report.owners).map((owner) => [owner.key, owner])).values()], recoveries: reports.flatMap((report) => report.recovery ? [report.recovery] : []), contestants: reports };
        }
      }
      return mission && record.worktree?.path ? evidence.admission({ hostId: record.hostId, cwd: record.worktree.path }, { reuse: workflowReuse(record) })
        : evidence.admission({ hostId: record.hostId, worktree: { repository: record.repository } });
    }
    if (request.operation === 'sitrep.handoff') {
      const preview = service.sitrepSource(p.id);
      if (!preview) throw new Error('SitRep preview is unavailable');
      return evidence.admission({ hostId: preview.targetHostId, worktree: { operationId: p.operationId, repository: preview.repository } });
    }
    return null;
  }
  async function bindDirective(directive) {
    const request = operationRequest(directive, 'action');
    const entry = operations.validate(request.operation, request.input, 'action');
    directive.canonicalOperation = entry.operation;
    if (entry.operation === 'mission.update') missions.validate(request.input);
    if (entry.operation === 'unit.create' && !request.input.hostId) request.input.hostId = state.config.hostId;
    directive.reviewRequired = entry.reviewRequired;
    directive.admission = await launchAdmission(request);
    if (directive.admission?.status === 'blocked') throw new Error('Launch admission blocked: ' + directive.admission.blockers.join('; '));
    if (directive.admission?.status === 'unknown') directive.reviewRequired = true;
    directive.binding = await bindings.bind(directive, entry, request.input);
  }
  async function executeQuery(query, check) {
    const r = operationRequest(query, 'query');
    return operations.execute(r.operation, r.input, 'query', {}, check);
  }
  async function executeDirective(directive, check) {
    if (directive.validationError) throw new Error(directive.validationError);
    const r = operationRequest(directive, 'action');
    const admission = await launchAdmission(r);
    if (fingerprint(admission?.recoveries || []) !== fingerprint(directive.binding?.evidence.worktreeRecoveries || [])) throw new Error('Worktree recovery revision changed; inspect and review again');
    if (admission?.status === 'blocked' || (admission?.status === 'unknown' && (!directive.approvedAt || admission.unknowns.some((reason) => !directive.binding?.evidence.admissionUnknowns?.includes(reason))))) throw new Error('Launch admission requires review: ' + [...admission.blockers, ...admission.unknowns].join('; '));
    if (admission) directive.admission = admission;
    return mutationContext.run({ directive, authority: () => ({ mode: state.config.authority, commander: state.session?.chatSessionId || null }) }, () => operations.execute(r.operation, r.input, 'action', directive.preconditions, check));
  }

  // Persist event references immediately, including events observed during a turn.
  // A timer drains the final event after cooldown without another inventory tick.
  function queueAlert(ref, signature) {
    if (state.seenEventSignatures[signature]) return;
    state.seenEventSignatures[signature] = timers.now();
    state.pendingAlerts.push({ ...ref, signature, observedAt: timers.now() });
  }
  function nextWakeDelay() {
    const now = timers.now();
    state.autoTurnsLastHour = state.autoTurnsLastHour.filter((t) => now - t < 3600000);
    const rateDue = state.autoTurnsLastHour.length >= state.config.triggers.maxAutoTurnsPerHour ? state.autoTurnsLastHour[0] + 3600000 : 0;
    const cooldownDue = state.lastAutoWakeAt ? state.lastAutoWakeAt + state.config.triggers.cooldownSeconds * 1000 : 0;
    const fallbackDue = state.config.triggers.fallbackSeconds && state.session ? (state.lastAssessmentAt || now) + state.config.triggers.fallbackSeconds * 1000 : Infinity;
    return Math.max(0, Math.max(rateDue, cooldownDue, state.pendingAlerts.length ? 0 : fallbackDue) - now);
  }
  function scheduleWake() {
    if (wakeTimer) timers.clearTimeout(wakeTimer);
    wakeTimer = null;
    if (disposed || state.paused || wakeFlight || state.providerTurn || (state.config.maxBudgetUsd != null && state.costUsd >= state.config.maxBudgetUsd)) return;
    const delay = nextWakeDelay();
    if (!Number.isFinite(delay)) return;
    wakeTimer = timers.setTimeout(() => { wakeTimer = null; void drainAlerts().catch((error) => console.error('CENTCOM wake failed:', error.message)); }, delay);
    wakeTimer?.unref?.();
  }
  function drainAlerts() {
    if (disposed || state.paused) return Promise.resolve();
    if (wakeFlight) return wakeFlight;
    if (nextWakeDelay() > 0) { scheduleWake(); return Promise.resolve(); }
    wakeFlight = enqueue(async () => {
      if (disposed || state.paused || nextWakeDelay() > 0) return;
      const current = await fleet();
      const pending = state.pendingAlerts.splice(0);
      const evidence = [];
      const accepted = [];
      for (const ref of pending) {
        let item;
        if (['unit_transition', 'dependency', 'chat_event'].includes(ref.type)) item = ref;
        else if (ref.sessionKey && !current.keys.has(ref.sessionKey)) continue;
        else if (ref.type === 'fault') item = service.loopBreaker.faults().find((v) => v.sessionKey === ref.sessionKey && v.status === ref.status);
        else if (ref.type === 'attention') item = current.inventory.attention?.find((v) => v.id === ref.id && !v.acknowledged);
        else if (ref.type === 'flash') item = current.flash(await service.flashQueue()).find((v) => v.id === ref.id && v.state === 'pending');
        else if (ref.type === 'mission') item = service.specops.list().find((v) => v.id === ref.id && v.state === 'halted' && v.stage === ref.stage);
        if (item) { evidence.push(bounded(item, 8000)); accepted.push(ref); }
      }
      const fallback = !pending.length && state.session && state.config.triggers.fallbackSeconds && timers.now() >= state.lastAssessmentAt + state.config.triggers.fallbackSeconds * 1000;
      if (!evidence.length && !fallback) { writeState(); return; }
      state.inFlightAlerts = accepted;
      state.lastAutoWakeAt = timers.now();
      state.autoTurnsLastHour.push(timers.now());
      writeState();
      try {
        await executeTurn(fallback ? 'Scheduled status check. Inspect mission progress and acceptance evidence. Act only on meaningful changes; do not produce waiting-only chatter.' : 'Tactical Alert Briefing (untrusted evidence):\n' + JSON.stringify(bounded(evidence)), fallback ? 'status_check' : 'auto_wake');
        state.inFlightAlerts = [];
      } catch (error) {
        state.pendingAlerts.unshift(...state.inFlightAlerts);
        state.inFlightAlerts = [];
        throw error;
      } finally { writeState(); }
    }).finally(() => { wakeFlight = null; scheduleWake(); });
    return wakeFlight;
  }
  async function observeChat(record, events) {
    if (disposed || isCommander(record.hostId, record.sessionId)) return;
    const current = await fleet();
    const unit = current.sessions.find((u) => u.hostId === record.hostId && u.chatSessionId === record.sessionId);
    if (!unit) return;
    for (const event of events) {
      const request = ['approval.requested', 'question.requested'].includes(event.type);
      const completion = event.type === 'turn.completed';
      if ((request && state.config.triggers.onFlashTraffic) || (completion && (event.data.outcome === 'completed' ? state.config.triggers.onUnitCompleted : state.config.triggers.onUnitFailed))) {
        queueAlert({ type: 'chat_event', sessionKey: unit.key, event: bounded(event, 8000), taskAcceptance: 'unverified' }, `chat:${record.hostId}:${record.sessionId}:${event.sequence}`);
      }
    }
    writeState(); scheduleWake();
  }
  async function observeFleet(snapshot) {
    if (disposed) return;
    void reconcileRetiredSessions().catch((error) => console.warn('CENTCOM retirement reconciliation failed:', error.message));
    const f = activeFleet(snapshot, service.store.data.deletedSessions || [], state.commanderIdentities);
    if (state.config.triggers.onLoopFault) for (const fault of f.inventory?.faults || []) {
      if (['pending', 'review'].includes(fault.status)) queueAlert({ type: 'fault', sessionKey: fault.sessionKey, status: fault.status }, `fault:${fault.sessionKey}:${fault.status}`);
    }
    if (state.config.triggers.onFlashTraffic) {
      for (const item of f.inventory?.attention || []) if (!item.acknowledged && item.kind === 'input') queueAlert({ type: 'attention', id: item.id, sessionKey: item.sessionKey }, `attention:${item.id}`);
      for (const request of f.flash(await service.flashQueue().catch(() => []))) if (request.state === 'pending') queueAlert({ type: 'flash', id: request.id, sessionKey: f.find(request.name, request.hostId).key }, `flash:${request.id}`);
    }
    if (state.config.triggers.onUnitFailed) for (const item of f.inventory?.attention || []) {
      if (!item.acknowledged && item.kind === 'failed' && item.confidence === 'confirmed') queueAlert({ type: 'attention', id: item.id, sessionKey: item.sessionKey }, `failure:${item.id}`);
    }
    if (state.config.triggers.onUnitCompleted) for (const item of f.inventory?.attention || []) {
      if (!item.acknowledged && item.kind === 'completed' && item.confidence === 'confirmed') queueAlert({ type: 'attention', id: item.id, sessionKey: item.sessionKey }, `completion:${item.id}`);
    }
    for (const unit of snapshot?.sessions || []) {
      if (!unit.managed || !unit.key || isCommander(unit.hostId, unit.chatSessionId || unit.name || unit.id)) continue;
      const previous = state.observedUnits[unit.key];
      const current = { state: unit.state, chatState: unit.chatState, turnId: unit.turnId || unit.telemetry?.turnId || null, updatedAt: unit.updatedAt || null };
      if (previous && fingerprint(previous) !== fingerprint(current)) {
        const failed = ['failed', 'blocked'].includes(unit.state) || unit.chatState === 'failed';
        const completed = unit.state === 'exited' || (previous.chatState === 'running' && unit.chatState === 'idle');
        if ((failed && state.config.triggers.onUnitFailed) || (completed && state.config.triggers.onUnitCompleted)) queueAlert({ type: 'unit_transition', sessionKey: unit.key, hostId: unit.hostId, previous, current, taskAcceptance: 'unverified' }, `transition:${unit.key}:${fingerprint({ previous, current })}`);
      }
      if (f.keys.has(unit.key) || previous) state.observedUnits[unit.key] = current;
    }
    for (const mission of service.specops.list()) {
      if (!mission.visits?.some((v) => f.find(v.name || v.sessionId, mission.hostId)) && !state.observedMissions[mission.id]) continue;
      if (mission.state === 'halted' && state.config.triggers.onSpecopsHalt) queueAlert({ type: 'mission', id: mission.id, stage: mission.stage }, `halt:${mission.id}:${mission.stage}`);
      const current = { stage: mission.stage, state: mission.state, dependencies: mission.dependencies || [], blockers: mission.blockers || [] };
      const previous = state.observedMissions[mission.id];
      if (previous && fingerprint(previous) !== fingerprint(current) && state.config.triggers.onDependencyChange) queueAlert({ type: 'dependency', id: mission.id, previous, current }, `dependency:${mission.id}:${fingerprint(current)}`);
      state.observedMissions[mission.id] = current;
    }
    writeState();
    if (activeTurnAbort) { scheduleWake(); return; }
    return drainAlerts();
  }

  async function applyAutomationById(id) {
    const result = await automations.apply(state.automations.find((item) => item.id === id));
    scheduleWake();
    return result;
  }

  function isCommander(hostId, identity) {
    return state.commanderIdentities.some((s) => s.hostId === hostId && [s.name, s.key, s.chatSessionId].includes(identity));
  }
  function interrupt(stopProvider = true) {
    activeTurnAbort?.abort();
    if (stopProvider) void turnLifecycle.cancel().catch(() => {});
    if (state.status === 'running') {
      state.status = 'halted'; state.error = 'Turn interrupted by Watch Officer'; writeState();
    }
    return publicState();
  }
  function submitCommand(_caller, _handle, command, record) {
    const current = state.session?.hostId === record.hostId && state.session?.chatSessionId === command.sessionId;
    const cancelling = ['interrupt', 'stop'].includes(command.operation);
    if (!current && !cancelling) return Promise.reject(new Error('Retired commander conversation; open the current CENTCOM session'));
    if (command.operation !== 'send' && !cancelling) return Promise.reject(new Error('Commander conversation accepts send, interrupt, or stop'));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ hostId: record.hostId, command })).digest('hex');
    const existing = state.consoleCommands[command.commandId];
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new Error('Command ID was already used with different input'));
      if (consoleFlights.has(command.commandId)) return consoleFlights.get(command.commandId);
      // Never replay an envelope after restart, even if acceptance was uncertain.
      return existing.receipt ? Promise.resolve(existing.receipt) : chats.request(record.hostId, 'receipt', { commandId: command.commandId });
    }
    const saved = state.consoleCommands[command.commandId] = { fingerprint, hostId: record.hostId, sessionId: command.sessionId };
    writeState();
    if (cancelling) {
      if (current) interrupt(false);
      const flight = (current && state.providerTurn ? turnLifecycle.cancel(command) : chats.request(record.hostId, 'command', { command })).then((receipt) => {
        saved.receipt = receipt; writeState(); return receipt;
      }).finally(() => consoleFlights.delete(command.commandId));
      consoleFlights.set(command.commandId, flight);
      return flight;
    }
    let resolve, reject;
    const accepted = new Promise((yes, no) => { resolve = yes; reject = no; });
    consoleFlights.set(command.commandId, accepted);
    void enqueue(() => executeTurn(command.payload.text, 'user', 0, { command, dispatched: (receipt) => { saved.receipt = receipt; writeState(); resolve(receipt); } }))
      .catch(reject).finally(() => consoleFlights.delete(command.commandId));
    return accepted;
  }

  async function assessActionResults(records) {
    for (const d of records) {
      const fresh = approvalResults.get(d.turnId) || [];
      fresh.push({ serverId: d.id, clientRequestId: d.clientRequestId || null, status: d.state, facts: actionFacts(d), result: bounded(d.result, 2000), error: bounded(d.error, 1000) });
      approvalResults.set(d.turnId, fresh);
    }
    for (const turnId of new Set(records.map((d) => d.turnId))) {
      if (!state.session || state.directives.some((d) => d.turnId === turnId && d.state === 'pending')) continue;
      const fresh = approvalResults.get(turnId);
      if (!fresh?.length) continue;
      approvalResults.delete(turnId);
      await executeTurn('<agentc2-c2-results>\n' + JSON.stringify(bounded(fresh, 120000)) + '\n</agentc2-c2-results>\nAssess these newly executed actions. Command delivery is separate from task completion.', 'approval_result', LIMITS.queryHops, null, turnId);
    }
  }

  // Persist migration before the first model turn. Audit/proposals/cost stay intact.
  writeState();
  scheduleWake();
  return {
    state: publicState,
    guardLaunch: launchGuard.run,
    rosterInventory: (snapshot) => rosterInventory(snapshot, state.commanderIdentities),
    reconcileRetiredSessions,
    isCommander, submitCommand,
    capabilities: operations.catalog,
    reconcile: () => enqueue(async () => { await turnLifecycle.reconcile(); return publicState(); }),
    outcomes: readOutcomes,
    manifest: capabilityManifest,
    configure: (newConfig) => {
      const config = validateConfig(newConfig);
      if (state.session && ['hostId', 'provider', 'model'].some((k) => config[k] !== state.config[k])) { interrupt(); retireSession(); }
      state.config = config;
      writeState();
      scheduleWake();
      return publicState();
    },
    start: (prompt) => {
      return enqueue(async () => {
        await executeTurn(prompt || 'Provide a fleet situation briefing, identify any bottlenecks, and suggest next actions.', 'user');
        return publicState();
      });
    },
    submit: (textPrompt) => {
      return enqueue(async () => {
        await executeTurn(textPrompt, 'user');
        return publicState();
      });
    },
    interrupt,
    pause: (paused) => {
      state.paused = Boolean(paused);
      writeState();
      scheduleWake();
      return publicState();
    },
    resetSession: () => {
      interrupt();
      return enqueue(async () => {
        if (!await turnLifecycle.stop(state.session)) throw new Error(`Previous CENTCOM provider turn remains uncertain; cannot reset its ownership: ${state.providerTurn?.error || 'Provider stop is unconfirmed'}`);
        const retired = state.commanderIdentities.find((s) => s.hostId === state.session?.hostId && s.chatSessionId === state.session?.chatSessionId);
        if (retired) retired.retirement = { status: 'stopped', checkedAt: Date.now() };
        retireSession();
        state.status = 'idle'; state.error = ''; writeState();
        await ensureSession();
        return publicState();
      });
    },
    decideDirective: (id, decision) => {
      if (!['approve', 'deny'].includes(decision)) throw new Error('Invalid directive decision');
      const d = state.directives.find((item) => item.id === id);
      if (!d || d.state !== 'pending') throw new Error('Directive not found or already resolved');
      return enqueue(async () => {
        if (d.state !== 'pending') throw new Error('Directive already resolved');
        recordApproval(d, decision);
        if (decision === 'deny') {
          d.state = 'denied';
          d.resolvedAt = Date.now();
          state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'denied', at: Date.now(), trigger: 'user' });
        } else {
          d.state = 'executing';
          d.approvedAt = Date.now();
          writeState();
          try {
            const result = await executeDirective(d);
            d.state = resultState(result);
            d.result = result;
            d.resolvedAt = Date.now();
            state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: d.state, result, at: Date.now(), trigger: 'user' });
          } catch (err) {
            d.state = err.uncertain ? 'uncertain' : 'failed';
            if (err.commandId) d.result = { commandId: err.commandId, sessionId: err.sessionId, delivery: 'uncertain', taskCompletion: 'unverified' };
            d.error = err.message;
            d.resolvedAt = Date.now();
            state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: d.state, result: d.result, error: err.message, at: Date.now(), trigger: 'user' });
          }
        }
        state.status = state.directives.some((item) => item.state === 'pending') ? 'awaiting_approval' : 'idle';
        writeState();
        await assessActionResults([d], decision === 'approve');
        return publicState();
      });
    },
    decideAllDirectives: (decision) => {
      if (!['approve', 'deny'].includes(decision)) throw new Error('Invalid directive decision');
      return enqueue(async () => {
        // Snapshot pending set to avoid race conditions with incoming directives
        const snapshotPending = state.directives.filter((d) => d.state === 'pending');
        for (const d of snapshotPending) {
          recordApproval(d, decision);
          if (decision === 'deny') {
            d.state = 'denied';
            d.resolvedAt = Date.now();
            state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'denied', at: Date.now(), trigger: 'user' });
          } else {
            d.state = 'executing';
            d.approvedAt = Date.now();
            writeState();
            try {
              const result = await executeDirective(d);
              d.state = resultState(result);
              d.result = result;
              d.resolvedAt = Date.now();
              state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: d.state, result, at: Date.now(), trigger: 'user' });
            } catch (err) {
              d.state = err.uncertain ? 'uncertain' : 'failed';
              if (err.commandId) d.result = { commandId: err.commandId, sessionId: err.sessionId, delivery: 'uncertain', taskCompletion: 'unverified' };
              d.error = err.message;
              d.resolvedAt = Date.now();
              state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: d.state, result: d.result, error: err.message, at: Date.now(), trigger: 'user' });
            }
          }
        }
        state.status = state.directives.some((item) => item.state === 'pending') ? 'awaiting_approval' : 'idle';
        writeState();
        await assessActionResults(snapshotPending, decision === 'approve');
        return publicState();
      });
    },
    applyAutomation: (id, decision) => {
      if (!['apply', 'dismiss'].includes(decision)) throw new Error('Invalid automation decision');
      const auto = state.automations.find((item) => item.id === id);
      if (!auto || auto.state !== 'proposed') throw new Error('Automation proposal not found or already resolved');
      return enqueue(async () => {
        if (auto.state !== 'proposed') throw new Error('Automation proposal already resolved');
        recordApproval(auto, decision, 'automation');
        if (decision === 'dismiss') {
          auto.state = 'dismissed';
          writeState();
          return publicState();
        }
        try {
          await applyAutomationById(id);
        } catch (err) {
          auto.error = err.message;
        }
        writeState();
        return publicState();
      });
    },
    observe: observeFleet,
    observeChat,
    dispose: () => {
      turnLifecycle.dispose();
      disposed = true; activeTurnAbort?.abort();
      if (wakeTimer) timers.clearTimeout(wakeTimer);
      // Clean up internal listener handles
      chats.disconnect(client.id);
    },
  };
}

module.exports = {
  createCentcom,
  validateConfig,
  parseCentcomEnvelope,
  defaults,
  DIRECTIVE_KINDS,
  AUTOMATION_KINDS,
};
