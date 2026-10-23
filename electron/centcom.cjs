const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fleetReadiness } = require('./readiness.cjs');

const PROVIDERS = ['codex', 'claude', 'antigravity', 'opencode'];
const AUTHORITIES = ['gated', 'autonomous'];
const DIRECTIVE_KINDS = [
  'unit.create', 'unit.resume', 'unit.send', 'unit.steer', 'unit.interrupt',
  'unit.stop', 'unit.rename', 'unit.pin', 'sitrep.handoff', 'specops.launch',
  'specops.control', 'exercise.create', 'exercise.control', 'flash.decide',
  'chat.respond', 'fault.interrupt', 'fault.reset'
];
const AUTOMATION_KINDS = ['specops_workflow', 'oporder', 'preset', 'centcom_trigger'];
// Must match centcom_sync's per-file UTF-8 limit in remote.py.
const SITUATION_MAX_BYTES = 1_000_000;

function boundSituationSnapshot(snapshot) {
  const encodedSize = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (encodedSize(snapshot) <= SITUATION_MAX_BYTES) return snapshot;

  const reduced = structuredClone(snapshot);
  const collections = ['units', 'theaters', 'specops', 'exercises', 'faults', 'defconReasons'];
  reduced.truncation = {
    reason: 'Snapshot exceeds the CENTCOM workspace byte limit; omitted evidence is unavailable in this snapshot.',
    totals: Object.fromEntries(collections.map((key) => [key, snapshot[key].length])),
    omitted: Object.fromEntries(collections.map((key) => [key, 0])),
    outputTailsOmitted: 0,
  };
  // Preserve fleet identities and state before spending space on terminal text.
  for (const unit of reduced.units) {
    if (unit.outputTail) {
      unit.outputTail = '';
      reduced.truncation.outputTailsOmitted++;
    }
  }
  if (encodedSize(reduced) <= SITUATION_MAX_BYTES) return reduced;

  const faultKeys = new Set(reduced.faults.map((fault) => fault.sessionKey));
  const urgent = (unit) => unit.state === 'live' || unit.state === 'failed' || faultKeys.has(unit.key);
  reduced.units.sort((a, b) => Number(urgent(b)) - Number(urgent(a)));
  reduced.specops.sort((a, b) => Number(['running', 'halted'].includes(b.state)) - Number(['running', 'halted'].includes(a.state)));
  // Reduce the largest collection in batches so large histories stay cheap to
  // serialize. Counts make a partial snapshot explicit to the commander.
  while (encodedSize(reduced) > SITUATION_MAX_BYTES) {
    const largest = collections.filter((key) => reduced[key].length)
      .sort((a, b) => encodedSize(reduced[b]) - encodedSize(reduced[a]))[0];
    const keep = Math.floor(reduced[largest].length / 2);
    reduced[largest] = reduced[largest].slice(0, keep);
    reduced.truncation.omitted[largest] = reduced.truncation.totals[largest] - keep;
  }
  return reduced;
}

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
      cooldownSeconds: 60,
      maxAutoTurnsPerHour: 12,
    },
    maxDirectivesPerTurn: 5,
    maxBudgetUsd: 10.0,
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
      cooldownSeconds: t.cooldownSeconds,
      maxAutoTurnsPerHour: t.maxAutoTurnsPerHour,
    },
    maxDirectivesPerTurn: input.maxDirectivesPerTurn,
    maxBudgetUsd: input.maxBudgetUsd == null ? null : Number(input.maxBudgetUsd),
  };
}

function parseCentcomEnvelope(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const blocks = [...rawText.matchAll(/```agentc2-c2\n([\s\S]*?)\n```/g)];
  if (!blocks.length) return null;
  const lastBlock = blocks[blocks.length - 1][1];
  let parsed;
  try {
    parsed = JSON.parse(lastBlock);
  } catch {
    return { error: 'Malformed JSON in agentc2-c2 block' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
    return { error: 'Envelope requires version: 1' };
  }
  const queries = Array.isArray(parsed.queries) ? parsed.queries.slice(0, 5) : [];
  const directives = Array.isArray(parsed.directives) ? parsed.directives.slice(0, 20) : [];
  const automations = Array.isArray(parsed.automations) ? parsed.automations.slice(0, 10) : [];
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 4000) : '';

  return { version: 1, rationale, queries, directives, automations };
}

function createCentcom({ directory, service, chats, emit }) {
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
    status: 'idle',
    activeLogicalTurn: null,
    seenEventSignatures: {},
    autoTurnsLastHour: [],
    costUsd: 0,
    costKnown: true,
    paused: false,
    directives: [],
    automations: [],
    auditLog: [],
  };

  if (fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved && saved.version === 1) {
        state = {
          ...state,
          ...saved,
          config: validateConfig(saved.config || state.config),
          directives: Array.isArray(saved.directives) ? saved.directives : [],
          automations: Array.isArray(saved.automations) ? saved.automations : [],
          auditLog: Array.isArray(saved.auditLog) ? saved.auditLog.slice(-500) : [],
        };
      }
    } catch (e) {
      console.warn(`Could not load CENTCOM state from ${stateFile}:`, e.message);
    }
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

  function writeState() {
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
      error: state.error || '',
      costUsd: state.costUsd || 0,
      costKnown: state.costKnown !== false,
      paused: Boolean(state.paused),
      autoTurnsLastHour: (state.autoTurnsLastHour || []).filter((t) => Date.now() - t < 3600000).length,
      directives: structuredClone(state.directives || []),
      automations: structuredClone(state.automations || []),
      auditLog: structuredClone((state.auditLog || []).slice(-100)),
    };
  }

  const client = { id: 'centcom-commander', name: 'CENTCOM Engine' };
  let queue = Promise.resolve();
  let activeTurnAbort = null;
  let lastAutoWakeAt = 0;
  const pendingAlerts = [];

  function enqueue(action) {
    const flight = queue.then(action);
    queue = flight.catch((err) => {
      console.error('CENTCOM scheduler turn error:', err);
    });
    return flight;
  }

  async function ensureSession() {
    if (state.session && state.session.hostId === state.config.hostId && state.session.provider === state.config.provider && state.session.model === state.config.model) {
      return state.session;
    }
    const host = service.getHost(state.config.hostId);
    const managedName = `hq-centcom-${crypto.randomBytes(3).toString('hex')}`;
    const initialDoctrine = buildDoctrinePrompt();

    // CENTCOM workspace is strictly isolated on the host
    const syncRes = await service.runRemote({
      action: 'centcom_sync',
      files: {
        'AGENTS.md': initialDoctrine,
        'SITUATION.json': JSON.stringify(await buildSituationSnapshot()),
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
      instructions: initialDoctrine,
    });

    state.session = {
      name: created.name,
      chatSessionId: created.chatSessionId,
      hostId: host.id,
      provider: state.config.provider,
      model: state.config.model,
      createdAt: Date.now(),
      state: 'idle',
    };
    writeState();
    return state.session;
  }

  function buildDoctrinePrompt() {
    return [
      '# CENTCOM (Central Command) Doctrine & Standing Operating Procedures',
      '',
      'You are CENTCOM, the supreme AI commanding officer for AgentC2.',
      'You oversee all runtime units (Codex, Claude, Antigravity, OpenCode), operational theaters (SSH hosts), and mission workflows.',
      '',
      '## Tactical Guidelines & ROE',
      '1. NEVER execute unverified destructive actions.',
      '2. In Gated C2 mode, all modifying directives (creating, stopping, interrupting units, launching missions) are staged for Watch Officer review.',
      '3. To request live context from units or operations, output `queries`.',
      '4. To execute C2 actions, output `directives`.',
      '5. To propose persistent automations (SPECOPS workflows, OpOrders, presets), output `automations`.',
      '',
      '## Protocol Envelope',
      'Wrap your tactical directives and queries in exactly one fenced `agentc2-c2` JSON block at the very end of your final response:',
      '```agentc2-c2',
      '{',
      '  "version": 1,',
      '  "rationale": "Tactical assessment...",',
      '  "queries": [ { "id": "q1", "kind": "inspect_unit", "params": { "sessionKey": "default/tmux:hq-123456789abc" } } ],',
      '  "directives": [ { "id": "d1", "kind": "unit.interrupt", "summary": "Stop runaway agent", "preconditions": { "sessionKey": "default/tmux:hq-123456789abc" }, "params": { "name": "hq-123456789abc", "hostId": "default" } } ],',
      '  "automations": []',
      '}',
      '```',
    ].join('\n');
  }

  async function buildSituationSnapshot() {
    let inventory = null;
    try {
      inventory = await service.inventory();
    } catch { /* inventory unavailable */ }
    let health = [];
    try {
      health = await service.health();
    } catch { /* health unavailable */ }
    let flash = [];
    try {
      flash = await service.flashQueue();
    } catch { /* flash unavailable */ }

    const readiness = fleetReadiness(inventory, flash);
    const specopsRuns = service.specops.list();
    const exercises = service.exercises.list();
    const faults = service.loopBreaker.faults();

    // Sanitized unit allowlist
    const units = (inventory?.sessions || []).map((s) => ({
      key: s.key,
      title: s.title,
      provider: s.provider,
      transport: s.transport,
      state: s.state,
      activity: s.activity,
      roeProfile: s.roeProfile,
      hostId: s.hostId,
      branch: s.branch,
      repository: s.repository,
      telemetry: s.telemetry,
      outputTail: s.outputTail ? s.outputTail.split('\n').slice(-20).join('\n') : '',
    }));

    return boundSituationSnapshot({
      capturedAt: new Date().toISOString(),
      defcon: readiness.level,
      defconLabel: readiness.label,
      defconReasons: readiness.reasons,
      theaters: (inventory?.hosts || []).map((h) => ({ id: h.id, name: h.name, connected: h.connected })),
      units,
      specops: specopsRuns.map((r) => ({ id: r.id, repo: r.repo, workflow: r.workflow?.name || r.workflow || 'unknown', stage: r.stage, state: r.state, error: r.error })),
      exercises: exercises.map((e) => ({ id: e.id, title: e.title, state: e.state, contestants: e.contestants.map((c) => ({ id: c.id, provider: c.provider, state: c.state })) })),
      faults,
      flashCount: flash.filter((f) => f.state === 'pending').length,
    });
  }

  async function executeTurn(userPrompt, source = 'user', initialHop = 0) {
    if (state.status === 'running') throw new Error('CENTCOM is already processing an active turn');
    const session = await ensureSession();

    state.status = 'running';
    state.error = '';
    const turnId = crypto.randomUUID();
    state.activeLogicalTurn = { turnId, source, hop: initialHop, startedAt: Date.now() };
    writeState();

    let queryHop = initialHop;
    let nextPrompt = userPrompt;

    try {
      while (queryHop <= 3) {
        // Enforce spending ceiling
        if (state.config.maxBudgetUsd != null && state.costUsd >= state.config.maxBudgetUsd) {
          state.status = 'halted';
          state.error = `CENTCOM budget limit ($${state.config.maxBudgetUsd}) reached. Further turns paused.`;
          writeState();
          return;
        }

        // Sync fresh sanitized snapshot to host workspace
        const snapshot = await buildSituationSnapshot();
        await service.runRemote({
          action: 'centcom_sync',
          files: { 'SITUATION.json': JSON.stringify(snapshot) },
        }, session.hostId);

        const turnCommandId = crypto.randomUUID();
        const contextualPrompt = [
          `<UNTRUSTED_FLEET_EVIDENCE>`,
          `SITUATION SNAPSHOT (DEFCON ${snapshot.defcon || '—'} · ${snapshot.defconLabel}):`,
          `Observed units: ${snapshot.units.length} · Halted missions: ${snapshot.specops.filter((m) => m.state === 'halted').length} · Faults: ${snapshot.faults.length}`,
          ...(snapshot.truncation ? ['SITUATION.json is partial. Read its truncation totals and omitted counts before assessing the fleet.'] : []),
          `</UNTRUSTED_FLEET_EVIDENCE>`,
          '',
          nextPrompt,
        ].join('\n');

        // Submit prompt through chats
        let handleId;
        try {
          handleId = await chats.open(client, session.chatSessionId, session.hostId);
          await chats.take(client, handleId);
        } catch (e) {
          throw new Error(`Could not connect to CENTCOM chat session: ${e.message}`);
        }

        await chats.submit(client, handleId, {
          protocolVersion: 1,
          commandId: turnCommandId,
          operation: 'send',
          sessionId: session.chatSessionId,
          payload: { text: contextualPrompt },
        });

        // Wait for verified turn completion
        let completed = false;
        let finalAssistantText = '';
        let turnCost = 0;
        const deadline = Date.now() + 180000;

        while (!completed && Date.now() < deadline) {
          const receipt = await chats.receipt(client, handleId, turnCommandId).catch(() => null);
          if (receipt && ['failed', 'unknown'].includes(receipt.state)) {
            throw new Error(`CENTCOM command failed: ${receipt.error || receipt.state}`);
          }
          if (receipt && receipt.state === 'completed') {
            const targetTurnId = receipt.result?.turnId || receipt.turnId || turnCommandId;
            const page = await chats.read(session.hostId, session.chatSessionId, 0, 500);
            for (const ev of page.events) {
              if (ev.turnId === targetTurnId || !ev.turnId) {
                if (ev.type === 'message.completed' && ev.data.role === 'assistant') {
                  finalAssistantText = ev.data.text;
                }
                if (ev.type === 'usage.updated' && ev.data.costUsd != null) {
                  turnCost = ev.data.costUsd;
                }
                if (ev.type === 'turn.completed') {
                  if (ev.data.outcome !== 'completed') {
                    throw new Error(`Turn ended with outcome ${ev.data.outcome}: ${ev.data.detail}`);
                  }
                  completed = true;
                }
              }
            }
          }
          if (!completed) {
            await new Promise((r) => setTimeout(r, 250));
          }
        }

        if (!completed) throw new Error('CENTCOM turn timed out waiting for provider completion');

        state.costUsd = (state.costUsd || 0) + (turnCost || 0);

        // Parse completion-correlated agentc2-c2 envelope
        const envelope = parseCentcomEnvelope(finalAssistantText);
        if (!envelope || envelope.error) {
          // No actionable block or syntax error: turn finishes cleanly as regular advisory
          break;
        }

        // Handle automations
        for (const auto of envelope.automations) {
          if (AUTOMATION_KINDS.includes(auto.kind)) {
            state.automations.unshift({
              id: crypto.randomUUID(),
              turnId,
              kind: auto.kind,
              title: text(auto.title || 'Automation Proposal', 150, 'title'),
              rationale: text(auto.rationale || '', 2000, 'rationale'),
              evidence: Array.isArray(auto.evidence) ? auto.evidence.map(String).slice(0, 10) : [],
              payload: auto.payload && typeof auto.payload === 'object' ? auto.payload : {},
              state: 'proposed',
              createdAt: Date.now(),
              appliedAt: null,
            });
          }
        }

        // Handle queries (bounded multi-hop)
        if (envelope.queries.length && queryHop < 3) {
          queryHop++;
          const queryResults = [];
          for (const q of envelope.queries) {
            const qKind = q.kind || q.type;
            try {
              const res = await executeQuery(q);
              queryResults.push({ id: q.id, kind: qKind, status: 'ok', result: res });
            } catch (err) {
              queryResults.push({ id: q.id, kind: qKind, status: 'error', error: err.message });
            }
          }
          nextPrompt = [
            '<agentc2-c2-results>',
            JSON.stringify(queryResults, null, 2),
            '</agentc2-c2-results>',
            'Based on these query results, provide your final assessment and directives.',
          ].join('\n');
          continue; // Run next query hop
        }

        // Handle directives
        for (const d of envelope.directives) {
          if (!DIRECTIVE_KINDS.includes(d.kind)) continue;
          const directiveRecord = {
            id: crypto.randomUUID(),
            turnId,
            kind: d.kind,
            summary: text(d.summary || d.kind, 150, 'directive summary'),
            rationale: text(d.rationale || envelope.rationale || '', 2000, 'directive rationale'),
            preconditions: d.preconditions || {},
            params: d.params || {},
            state: 'pending',
            trigger: source,
            createdAt: Date.now(),
            resolvedAt: null,
          };

          if (state.config.authority === 'autonomous') {
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
                const execResult = await executeDirective(directiveRecord);
                directiveRecord.state = 'completed';
                directiveRecord.result = execResult;
                directiveRecord.resolvedAt = Date.now();
                state.auditLog.unshift({
                  id: directiveRecord.id,
                  kind: directiveRecord.kind,
                  summary: directiveRecord.summary,
                  outcome: 'completed',
                  at: Date.now(),
                  trigger: source,
                });
              } catch (err) {
                directiveRecord.state = 'failed';
                directiveRecord.error = err.message;
                directiveRecord.resolvedAt = Date.now();
                state.auditLog.unshift({
                  id: directiveRecord.id,
                  kind: directiveRecord.kind,
                  summary: directiveRecord.summary,
                  outcome: 'failed',
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
    }
  }

  async function executeQuery(query) {
    const kind = query.kind || query.type;
    if (kind === 'inspect_unit') {
      const keys = [query.params.sessionKey];
      const previews = await service.terminalPreviews(keys);
      return previews[0] || { error: 'Preview unavailable' };
    }
    if (kind === 'search_history') {
      return service.searchHistory(query.params.query, query.params.keys || []);
    }
    if (kind === 'inspect_specops') {
      return service.specops.list().find((r) => r.id === query.params.id) || null;
    }
    if (kind === 'inspect_exercise') {
      // Safe inspection: verification commands are strictly disabled in read-only queries
      return service.exercises.inspect(query.params.id, query.params.contestantId, false);
    }
    if (kind === 'preview_sitrep') {
      return service.previewSitrep(client, query.params);
    }
    throw new Error(`Unknown query kind: ${kind}`);
  }

  async function executeDirective(directive) {
    const { kind, params, preconditions } = directive;

    // Verify preconditions
    if (preconditions?.sessionKey) {
      const snapshot = await service.inventory();
      const target = snapshot.sessions.find((s) => s.key === preconditions.sessionKey);
      if (!target) throw new Error(`Precondition failed: target session ${preconditions.sessionKey} not found`);
      if (preconditions.state && target.state !== preconditions.state) {
        throw new Error(`Precondition failed: session is ${target.state}, expected ${preconditions.state}`);
      }
    }

    if (kind === 'unit.create') {
      return service.create(params);
    }
    if (kind === 'unit.interrupt') {
      return service.action(client, 'interrupt', params.name, params.hostId);
    }
    if (kind === 'unit.stop') {
      return service.action(client, 'stop', params.name, params.hostId);
    }
    if (kind === 'unit.rename') {
      return service.renameSession(params.key, params.title);
    }
    if (kind === 'unit.pin') {
      return service.setSessionPinned(params.key, params.pinned);
    }
    if (kind === 'unit.send') {
      // Structured chat only; terminal raw input injection is rejected for security
      const snapshot = await service.inventory();
      const unit = snapshot.sessions.find((s) => s.key === params.sessionKey);
      if (!unit || unit.transport !== 'chat' || !unit.chatSessionId) {
        throw new Error('Prompt delivery is only supported for structured chat units');
      }
      const handle = await chats.open(client, unit.chatSessionId, unit.hostId);
      await chats.take(client, handle);
      return chats.submit(client, handle, {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        operation: 'send',
        sessionId: unit.chatSessionId,
        payload: { text: params.text },
      });
    }
    if (kind === 'unit.steer') {
      const snapshot = await service.inventory();
      const unit = snapshot.sessions.find((s) => s.key === params.sessionKey);
      if (!unit || unit.transport !== 'chat' || !unit.chatSessionId) {
        throw new Error('Steering is only supported for structured chat units');
      }
      const handle = await chats.open(client, unit.chatSessionId, unit.hostId);
      await chats.take(client, handle);
      return chats.submit(client, handle, {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        operation: 'steer',
        sessionId: unit.chatSessionId,
        payload: { text: params.text, expectedTurnId: params.expectedTurnId },
      });
    }
    if (kind === 'specops.launch') {
      return service.specops.launch(params);
    }
    if (kind === 'specops.control') {
      if (!['resume', 'retry', 'cancel'].includes(params.action)) {
        throw new Error(`Unauthorized SPECOPS control action: ${params.action}`);
      }
      return service.specops.control(params.id, params.action);
    }
    if (kind === 'exercise.create') {
      return service.exercises.create(params);
    }
    if (kind === 'exercise.control') {
      const { action, id, contestantId, revision } = params;
      if (action === 'retry') return service.exercises.launch(id);
      if (action === 'cancel') return service.exercises.cancel(id);
      if (action === 'complete') return service.exercises.markComplete(id, contestantId);
      if (action === 'promote') return service.exercises.promote(id, contestantId, revision);
      throw new Error(`Unauthorized Exercise control action: ${action}`);
    }
    if (kind === 'flash.decide') {
      return service.flashDecide(client, params);
    }
    if (kind === 'fault.interrupt') {
      return service.interruptFaults(client);
    }
    if (kind === 'fault.reset') {
      return service.resetFault(params.sessionKey);
    }
    if (kind === 'sitrep.handoff') {
      return service.launchSitrep(client, params);
    }
    throw new Error(`Unsupported directive kind: ${kind}`);
  }

  // Event Observer & Auto-Wake Circuit Breakers
  function observeFleet(snapshot) {
    if (state.paused || state.status === 'running') return;
    const now = Date.now();
    const cleanTurns = (state.autoTurnsLastHour || []).filter((t) => now - t < 3600000);
    state.autoTurnsLastHour = cleanTurns;

    // Filter out CENTCOM's own session to prevent recursive self-triggering
    const sessions = (snapshot.sessions || []).filter((s) => !s.key.includes('/tmux:hq-centcom-'));
    const haltedMissions = (snapshot.missions || []).filter((m) => m.state === 'halted');
    const faults = (snapshot.faults || []).filter((f) => ['pending', 'review'].includes(f.status));
    const failedUnits = sessions.filter((s) => s.state === 'exited' && s.exitCode !== 0 && s.exitCode != null);

    const alerts = [];

    if (state.config.triggers.onSpecopsHalt) {
      for (const m of haltedMissions) {
        const sig = `halt:${m.id}:${m.stage}`;
        if (!state.seenEventSignatures[sig]) {
          state.seenEventSignatures[sig] = now;
          alerts.push(`SPECOPS mission ${m.id} (${m.repo}) HALTED at stage ${m.stage}: ${m.error || 'arbitration required'}`);
        }
      }
    }

    if (state.config.triggers.onLoopFault) {
      for (const f of faults) {
        const sig = `fault:${f.sessionKey}:${f.status}`;
        if (!state.seenEventSignatures[sig]) {
          state.seenEventSignatures[sig] = now;
          alerts.push(`LoopBreaker fault on unit ${f.sessionKey}: ${f.label} (${f.detail})`);
        }
      }
    }

    if (state.config.triggers.onUnitFailed) {
      for (const u of failedUnits) {
        const sig = `unit-failed:${u.key}:${u.exitCode}`;
        if (!state.seenEventSignatures[sig]) {
          state.seenEventSignatures[sig] = now;
          alerts.push(`Unit ${u.key} (${u.title}) exited with code ${u.exitCode}`);
        }
      }
    }

    if (!alerts.length) return;

    // Enforce cooldown and hourly limits
    if (now - lastAutoWakeAt < state.config.triggers.cooldownSeconds * 1000) {
      pendingAlerts.push(...alerts);
      return;
    }
    if (cleanTurns.length >= state.config.triggers.maxAutoTurnsPerHour) {
      console.warn('CENTCOM auto-wake rate limit reached for the hour');
      return;
    }

    lastAutoWakeAt = now;
    state.autoTurnsLastHour.push(now);
    const combinedAlerts = [...alerts, ...pendingAlerts.splice(0, pendingAlerts.length)];

    return enqueue(() =>
      executeTurn(
        `Tactical Alert Briefing: The following fleet events require your command assessment:\n${combinedAlerts.join('\n')}`,
        'auto_wake'
      )
    );
  }

  return {
    state: publicState,
    configure: (newConfig) => {
      state.config = validateConfig(newConfig);
      writeState();
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
    interrupt: () => {
      if (state.status === 'running') {
        state.status = 'halted';
        state.error = 'Turn interrupted by Watch Officer';
        writeState();
      }
      return publicState();
    },
    pause: (paused) => {
      state.paused = Boolean(paused);
      writeState();
      return publicState();
    },
    resetSession: async () => {
      state.session = null;
      state.status = 'idle';
      state.error = '';
      writeState();
      await ensureSession();
      return publicState();
    },
    decideDirective: (id, decision) => {
      const d = state.directives.find((item) => item.id === id);
      if (!d || d.state !== 'pending') throw new Error('Directive not found or already resolved');
      return enqueue(async () => {
        if (decision === 'deny') {
          d.state = 'denied';
          d.resolvedAt = Date.now();
          state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'denied', at: Date.now(), trigger: 'user' });
        } else {
          d.state = 'executing';
          writeState();
          try {
            const result = await executeDirective(d);
            d.state = 'completed';
            d.result = result;
            d.resolvedAt = Date.now();
            state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'completed', at: Date.now(), trigger: 'user' });
          } catch (err) {
            d.state = 'failed';
            d.error = err.message;
            d.resolvedAt = Date.now();
            state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'failed', error: err.message, at: Date.now(), trigger: 'user' });
          }
        }
        state.status = state.directives.some((item) => item.state === 'pending') ? 'awaiting_approval' : 'idle';
        writeState();
        return publicState();
      });
    },
    decideAllDirectives: (decision) => {
      return enqueue(async () => {
        // Snapshot pending set to avoid race conditions with incoming directives
        const snapshotPending = state.directives.filter((d) => d.state === 'pending');
        for (const d of snapshotPending) {
          if (decision === 'deny') {
            d.state = 'denied';
            d.resolvedAt = Date.now();
            state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'denied', at: Date.now(), trigger: 'user' });
          } else {
            d.state = 'executing';
            writeState();
            try {
              const result = await executeDirective(d);
              d.state = 'completed';
              d.result = result;
              d.resolvedAt = Date.now();
              state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'completed', at: Date.now(), trigger: 'user' });
            } catch (err) {
              d.state = 'failed';
              d.error = err.message;
              d.resolvedAt = Date.now();
              state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'failed', error: err.message, at: Date.now(), trigger: 'user' });
            }
          }
        }
        state.status = state.directives.some((item) => item.state === 'pending') ? 'awaiting_approval' : 'idle';
        writeState();
        return publicState();
      });
    },
    applyAutomation: (id, decision) => {
      const auto = state.automations.find((item) => item.id === id);
      if (!auto || auto.state !== 'proposed') throw new Error('Automation proposal not found or already resolved');
      return enqueue(async () => {
        if (decision === 'dismiss') {
          auto.state = 'dismissed';
          writeState();
          return publicState();
        }
        try {
          if (auto.kind === 'preset') {
            const currentSettings = service.store.data.settings;
            const newPresets = [...(currentSettings.presets || []).filter((p) => p.id !== auto.payload.id), auto.payload];
            await service.saveSettings({ ...currentSettings, presets: newPresets });
          } else if (auto.kind === 'centcom_trigger') {
            state.config.triggers = { ...state.config.triggers, ...(auto.payload || {}) };
          } else if (auto.kind === 'specops_workflow') {
            const currentDef = service.specops.definition();
            const workflows = [...(currentDef.workflows || []).filter((w) => w.id !== auto.payload.id), auto.payload];
            service.specops.configure(require('yaml').stringify({ profiles: currentDef.profiles, workflows }));
          }
          auto.state = 'applied';
          auto.appliedAt = Date.now();
        } catch (err) {
          auto.error = err.message;
        }
        writeState();
        return publicState();
      });
    },
    observe: observeFleet,
    dispose: () => {
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
