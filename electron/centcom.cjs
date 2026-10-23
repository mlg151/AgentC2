const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fleetReadiness } = require('./readiness.cjs');
const { activeFleet, commanderIdentity } = require('./centcom-fleet.cjs');
const { createOperations } = require('./centcom-operations.cjs');
const CONTEXT_REVISION = 1;

const PROVIDERS = ['codex', 'claude', 'antigravity', 'opencode'];
const AUTHORITIES = ['gated', 'autonomous'];
const DIRECTIVE_KINDS = [...createOperations({ service: {} }).catalog().filter((e) => e.classification === 'action').map((e) => e.operation), 'agentc2.query', 'agentc2.action'];
const AUTOMATION_KINDS = ['specops_workflow', 'oporder', 'preset', 'centcom_trigger'];
// Must match centcom_sync's per-file UTF-8 limit in remote.py.
const SITUATION_MAX_BYTES = 1_000_000;

function boundSituationSnapshot(snapshot) {
  const encodedSize = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (encodedSize(snapshot) <= SITUATION_MAX_BYTES) return snapshot;

  const reduced = structuredClone(snapshot);
  const collections = ['units', 'theaters', 'specops', 'exercises', 'faults', 'defconReasons', 'attention', 'flash'];
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
  const urgent = (unit) => ['live', 'waiting', 'waiting_for_input', 'blocked', 'requires_action'].includes(unit.state) || faultKeys.has(unit.key);
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
    contextRevision: CONTEXT_REVISION,
    commanderIdentities: [],
    consoleCommands: {},
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
          contextRevision: saved.contextRevision || 0,
          commanderIdentities: Array.isArray(saved.commanderIdentities) ? saved.commanderIdentities : [],
          consoleCommands: saved.consoleCommands || {},
          config: validateConfig(saved.config || state.config),
          directives: Array.isArray(saved.directives) ? saved.directives : [],
          automations: Array.isArray(saved.automations) ? saved.automations : [],
          auditLog: Array.isArray(saved.auditLog) ? saved.auditLog : [],
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
      auditLog: structuredClone((state.auditLog || []).slice(0, 100)),
    };
  }

  const client = { id: 'centcom-commander', name: 'CENTCOM Engine' };
  let queue = Promise.resolve();
  let activeTurnAbort = null;
  let activeChatHandle = null;
  const consoleFlights = new Map();
  const approvalResults = new Map();
  let disposed = false;
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
    retireSession();
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
      key: created.key || `${host.id}/tmux:${created.name}`,
    };
    state.commanderIdentities.push(commanderIdentity(state.session));
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
      'Only connected, live/waiting managed units in SITUATION.json are eligible targets. Never guess identities or resume inactive history.',
      'Desktop navigation, clipboard, remote-access administration, and app updates are outside operational control.',
      'Use agentc2.query or agentc2.action with params: { operation, input }. Queries cannot modify state or run tests.',
      'Terminal input delivery and command acceptance do not establish remote task completion.',
      '## Executable capabilities (availability refreshes in SITUATION.json each turn)',
      JSON.stringify(operations.catalog()),
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
    const evidence = f.clean({
      capturedAt: new Date().toISOString(),
      defcon: readiness.level, defconLabel: readiness.label, defconReasons: readiness.reasons,
      theaters: (f.inventory.hosts || []).map((h) => ({ id: h.id, name: h.name, connected: h.connected })),
      units, specops, exercises, faults, attention: f.inventory.attention || [],
      flash, flashCount: flash.filter((r) => r.state === 'pending').length,
    });
    return boundSituationSnapshot({ ...evidence, capabilities: operations.catalog(f) });
  }

  async function executeTurn(userPrompt, source = 'user', initialHop = 0, consoleCommand = null, logicalTurnId = null) {
    if (state.status === 'running') throw new Error('CENTCOM is already processing an active turn');
    const abort = new AbortController();
    activeTurnAbort = abort;
    const check = () => { if (abort.signal.aborted || disposed) throw new Error('CENTCOM turn interrupted by Watch Officer'); };
    let session;
    try { session = await ensureSession(); check(); }
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
          files: { 'SITUATION.json': JSON.stringify(snapshot) },
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
          (await fleet()).clean(nextPrompt),
        ].join('\n');

        // Keep one temporary commander view per provider turn, and release it
        // even if completion polling, cancellation, or envelope parsing fails.
        let finalAssistantText = '';
        let turnCost = 0;
        let handleId;
        let previousOwner;
        let record;
        try {
          previousOwner = chats.sessions?.get(`${session.hostId}/${session.chatSessionId}`)?.owner;
          handleId = await chats.open(client, session.chatSessionId, session.hostId);
          record = chats.handles?.get(handleId)?.record;
          await chats.take(client, handleId, (owner) => {
            previousOwner = owner;
            if (record) record.commanderPreviousOwner = owner;
          });
          activeChatHandle = { handleId, session };
          check();
          const turnStartCursor = record?.latestCursor || 0;
          const receipt = await chats.submit(client, handleId, {
            protocolVersion: 1, commandId: turnCommandId, operation: 'send',
            sessionId: session.chatSessionId, payload: { text: contextualPrompt },
          });
          if (queryHop === initialHop && consoleCommand) consoleCommand.dispatched(receipt);

          // Wait for verified turn completion
          let completed = false;
          const deadline = Date.now() + 180000;

          while (!completed && Date.now() < deadline) {
            const receipt = await chats.receipt(client, handleId, turnCommandId).catch(() => null);
            check();
            if (receipt && ['failed', 'unknown'].includes(receipt.state)) {
              throw new Error(`CENTCOM command failed: ${receipt.error || receipt.state}`);
            }
            if (receipt && receipt.state === 'completed') {
              const targetTurnId = receipt.result?.turnId || receipt.turnId || turnCommandId;
              let after = turnStartCursor;
              let page;
              do {
                page = await chats.read(session.hostId, session.chatSessionId, after, 500);
                check();
                for (const ev of page.events) {
                  if (ev.turnId === targetTurnId) {
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
                after = page.cursor || page.events.at(-1)?.sequence || after;
              } while (page.hasMore);
            }
            if (!completed) {
              await new Promise((r) => setTimeout(r, 250));
            }
          }

          if (!completed) throw new Error('CENTCOM turn timed out waiting for provider completion');

        } finally {
          state.costUsd = (state.costUsd || 0) + (turnCost || 0);
          if (record?.owner?.id === client.id && previousOwner && !previousOwner.closed && [...record.handles].some((id) => chats.handles.get(id)?.client.id === previousOwner.id)) {
            record.owner = previousOwner; chats.publish(record);
          }
          if (record) delete record.commanderPreviousOwner;
          if (activeChatHandle?.handleId === handleId) activeChatHandle = null;
          if (handleId && chats.close) chats.close(client, handleId);
        }
        check();

        // Parse completion-correlated agentc2-c2 envelope
        const envelope = parseCentcomEnvelope(finalAssistantText);
        if (envelope?.error) throw new Error(envelope.error);
        if (!envelope) {
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

        // Handle directives
        const actionResults = [];
        for (const d of envelope.directives) {
          check();
          const directiveRecord = {
            id: crypto.randomUUID(),
            turnId,
            kind: d.kind,
            summary: text(d.summary || d.kind, 150, 'directive summary'),
            rationale: text(d.rationale || envelope.rationale || 'Commander directive', 2000, 'directive rationale'),
            preconditions: d.preconditions || {},
            params: d.params || {},
            state: 'pending',
            trigger: source,
            createdAt: Date.now(),
            resolvedAt: null,
          };

          try { await bindDirective(directiveRecord); } catch (error) { directiveRecord.validationError = error.message; }
          check();
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
        // Handle queries (bounded multi-hop)
        if (envelope.queries.length && queryHop < 3) {
          queryHop++;
          const queryResults = [];
          for (const q of envelope.queries) {
            check();
            const qKind = q.kind || q.type;
            try {
              const res = await executeQuery(q, check);
              queryResults.push({ id: q.id, kind: qKind, status: 'ok', result: res });
            } catch (err) {
              queryResults.push({ id: q.id, kind: qKind, status: 'error', error: err.message });
            }
          }
          nextPrompt = [
            '<agentc2-c2-results>',
            JSON.stringify([...actionResults, ...queryResults], null, 2),
            '</agentc2-c2-results>',
            'Based on these query results, provide your final assessment and directives.',
          ].join('\n');
          continue; // Run next query hop
        }

        if (actionResults.length && queryHop < 3) {
          queryHop++;
          nextPrompt = '<agentc2-c2-results>\n' + JSON.stringify(actionResults) + '\n</agentc2-c2-results>\nAssess these action receipts. Delivery does not prove task completion.';
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
    if (['mission', 'exercise', 'contestant'].includes(entry.target)) {
      const mission = entry.target === 'mission';
      const record = (mission ? service.specops.list() : service.exercises.list()).find((r) => r.id === p.id);
      if (!record) throw new Error('Operation is unavailable');
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

  const operations = createOperations({ service, client, control: (unit, fn) => service.commanderControl(client, unit, async (handle) => {
    const current = (await fleet()).find(unit.key);
    if (!current || current.chatSessionId !== unit.chatSessionId || (current.id || current.name) !== (unit.id || unit.name)) throw new Error('Target left the active fleet while acquiring control');
    if (activeTurnAbort?.signal.aborted || disposed) throw new Error('CENTCOM turn interrupted by Watch Officer');
    return fn(handle);
  }), resolve: resolveTarget, fleet, applyAutomation: applyAutomationById });
  async function bindDirective(directive) {
    const request = operationRequest(directive, 'action');
    const entry = operations.validate(request.operation, request.input, 'action');
    const target = await resolveTarget(entry, request.input, directive.preconditions);
    if (Array.isArray(target)) directive.preconditions = { ...directive.preconditions, identities: target.map((u) => ({ key: u.key, hostId: u.hostId, name: u.id || u.name, chatSessionId: u.chatSessionId })) };
    if (target && !Array.isArray(target)) directive.preconditions = { ...directive.preconditions, sessionKey: target.key, identity: { hostId: target.hostId, name: target.id || target.name, chatSessionId: target.chatSessionId } };
  }
  async function executeQuery(query, check) {
    const r = operationRequest(query, 'query');
    return operations.execute(r.operation, r.input, 'query', {}, check);
  }
  async function executeDirective(directive, check) {
    if (directive.validationError) throw new Error(directive.validationError);
    const r = operationRequest(directive, 'action');
    return operations.execute(r.operation, r.input, 'action', directive.preconditions, check);
  }

  // Queue references, not text. Rebuild evidence from fresh eligible targets
  // after cooldown/queue delays, so retired units cannot wake the commander.
  async function observeFleet(snapshot) {
    if (disposed || state.paused || state.status === 'running') return;
    const f = activeFleet(snapshot, service.store.data.deletedSessions || [], state.commanderIdentities);
    const alerts = [];
    const add = (ref, signature) => {
      if (state.seenEventSignatures[signature]) return;
      state.seenEventSignatures[signature] = Date.now();
      alerts.push(ref);
    };
    if (state.config.triggers.onLoopFault) for (const fault of f.inventory?.faults || []) {
      if (['pending', 'review'].includes(fault.status)) add({ type: 'fault', sessionKey: fault.sessionKey, status: fault.status }, `fault:${fault.sessionKey}:${fault.status}`);
    }
    if (state.config.triggers.onFlashTraffic) for (const item of f.inventory?.attention || []) {
      if (!item.acknowledged && item.kind === 'input') add({ type: 'attention', id: item.id, sessionKey: item.sessionKey }, `attention:${item.id}`);
    }
    if (state.config.triggers.onFlashTraffic) for (const request of f.flash(await service.flashQueue().catch(() => []))) {
      if (request.state === 'pending') add({ type: 'flash', id: request.id, sessionKey: f.find(request.name, request.hostId).key }, `flash:${request.id}`);
    }
    if (state.config.triggers.onUnitFailed) for (const item of f.inventory?.attention || []) {
      if (!item.acknowledged && item.kind === 'failed' && item.confidence === 'confirmed') add({ type: 'attention', id: item.id, sessionKey: item.sessionKey }, `failure:${item.id}`);
    }
    if (state.config.triggers.onSpecopsHalt) for (const mission of service.specops.list()) {
      if (mission.state === 'halted' && (mission.visits || []).some((v) => f.find(v.name || v.sessionId, mission.hostId))) add({ type: 'mission', id: mission.id, stage: mission.stage }, `halt:${mission.id}:${mission.stage}`);
    }
    // Confirmed failed turns on eligible units may wake C2; exited units cannot.
    if (disposed || state.paused || state.status === 'running') return;
    pendingAlerts.push(...alerts);
    if (!pendingAlerts.length) return;
    return enqueue(async () => {
      if (disposed || state.paused) return;
      const now = Date.now();
      state.autoTurnsLastHour = state.autoTurnsLastHour.filter((t) => now - t < 3600000);
      if (now - lastAutoWakeAt < state.config.triggers.cooldownSeconds * 1000 || state.autoTurnsLastHour.length >= state.config.triggers.maxAutoTurnsPerHour) return;
      const current = await fleet();
      const evidence = [];
      for (const ref of pendingAlerts.splice(0)) {
        if (ref.sessionKey && !current.keys.has(ref.sessionKey)) continue;
        if (ref.type === 'fault') {
          const fault = service.loopBreaker.faults().find((v) => v.sessionKey === ref.sessionKey && v.status === ref.status);
          if (fault) evidence.push(current.clean(fault));
        } else if (ref.type === 'attention') {
          const item = current.inventory.attention?.find((v) => v.id === ref.id && !v.acknowledged);
          if (item) evidence.push(item);
        } else if (ref.type === 'flash') {
          const request = current.flash(await service.flashQueue()).find((v) => v.id === ref.id && v.state === 'pending' && current.find(v.name, v.hostId)?.key === ref.sessionKey);
          if (request) evidence.push(request);
        } else if (ref.type === 'mission') {
          const mission = service.specops.list().find((v) => v.id === ref.id && v.state === 'halted' && v.stage === ref.stage);
          if (mission?.visits?.some((v) => current.find(v.name || v.sessionId, mission.hostId))) evidence.push(current.clean(mission));
        }
      }
      if (!evidence.length) return;
      lastAutoWakeAt = now;
      state.autoTurnsLastHour.push(now);
      await executeTurn('Tactical Alert Briefing:\n' + JSON.stringify(evidence), 'auto_wake');
    });
  }

  async function applyAutomationById(id) {
    const auto = state.automations.find((item) => item.id === id);
    if (!auto || auto.state !== 'proposed') throw new Error('Automation proposal not found or already resolved');
    if (auto.kind === 'preset') {
      const settings = service.store.data.settings;
      await service.saveSettings({ ...settings, presets: [...(settings.presets || []).filter((p) => p.id !== auto.payload.id), auto.payload] });
    } else if (auto.kind === 'centcom_trigger') {
      state.config = validateConfig({ ...state.config, triggers: { ...state.config.triggers, ...auto.payload } });
    } else if (auto.kind === 'specops_workflow') {
      const def = service.specops.definition();
      service.specops.configure(require('yaml').stringify({ profiles: def.profiles, workflows: [...def.workflows.filter((w) => w.id !== auto.payload.id), auto.payload] }));
    } else if (auto.kind === 'oporder') {
      if (!service.enrollOpOrder || !auto.payload.order || !auto.payload.revision) throw new Error('OpOrder automation requires a reviewed order and revision');
      await service.enrollOpOrder(auto.payload.order, auto.payload.revision);
    } else throw new Error('Unknown automation kind');
    auto.state = 'applied'; auto.appliedAt = Date.now(); writeState();
    return auto;
  }

  function isCommander(hostId, identity) {
    return state.commanderIdentities.some((s) => s.hostId === hostId && [s.name, s.key, s.chatSessionId].includes(identity));
  }
  function interrupt(stopProvider = true) {
    activeTurnAbort?.abort();
    if (stopProvider && activeChatHandle) {
      const { handleId, session } = activeChatHandle;
      void chats.submit(client, handleId, { protocolVersion: 1, commandId: crypto.randomUUID(), operation: 'interrupt', sessionId: session.chatSessionId, payload: {} }).catch(() => {});
    }
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
      const flight = chats.request(record.hostId, 'command', { command }).then((receipt) => {
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

  async function assessActionResults(records, executed) {
    for (const d of records) if (executed) {
      const fresh = approvalResults.get(d.turnId) || [];
      fresh.push({ id: d.id, status: d.state, result: d.result, error: d.error });
      approvalResults.set(d.turnId, fresh);
    }
    for (const turnId of new Set(records.map((d) => d.turnId))) {
      if (!state.session || state.directives.some((d) => d.turnId === turnId && d.state === 'pending')) continue;
      const fresh = approvalResults.get(turnId);
      if (!fresh?.length) continue;
      approvalResults.delete(turnId);
      await executeTurn('<agentc2-c2-results>\n' + JSON.stringify(fresh) + '\n</agentc2-c2-results>\nAssess these newly executed actions. Command delivery is separate from task completion.', 'approval_result', 3, null, turnId);
    }
  }

  // Persist migration before the first model turn. Audit/proposals/cost stay intact.
  writeState();
  return {
    state: publicState,
    isCommander, submitCommand,
    capabilities: operations.catalog,
    configure: (newConfig) => {
      const config = validateConfig(newConfig);
      if (state.session && ['hostId', 'provider', 'model'].some((k) => config[k] !== state.config[k])) { interrupt(); retireSession(); }
      state.config = config;
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
    interrupt,
    pause: (paused) => {
      state.paused = Boolean(paused);
      writeState();
      return publicState();
    },
    resetSession: () => {
      interrupt();
      return enqueue(async () => {
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
        if (decision === 'deny') {
          d.state = 'denied';
          d.resolvedAt = Date.now();
          state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'denied', at: Date.now(), trigger: 'user' });
        } else {
          d.state = 'executing';
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
          if (decision === 'deny') {
            d.state = 'denied';
            d.resolvedAt = Date.now();
            state.auditLog.unshift({ id: d.id, kind: d.kind, summary: d.summary, outcome: 'denied', at: Date.now(), trigger: 'user' });
          } else {
            d.state = 'executing';
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
      const auto = state.automations.find((item) => item.id === id);
      if (!auto || auto.state !== 'proposed') throw new Error('Automation proposal not found or already resolved');
      return enqueue(async () => {
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
    dispose: () => {
      disposed = true; activeTurnAbort?.abort();
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
