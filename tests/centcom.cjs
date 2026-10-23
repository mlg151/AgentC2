const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCentcom,
  validateConfig,
  parseCentcomEnvelope,
  defaults,
  DIRECTIVE_KINDS,
  AUTOMATION_KINDS,
} = require('../electron/centcom.cjs');

(async () => {
  // 1. Config Validation & Bounds
  const def = defaults('host-1');
  assert.equal(def.hostId, 'host-1');
  assert.equal(def.authority, 'gated');
  assert.equal(def.provider, 'codex');
  assert.equal(def.triggers.onSpecopsHalt, true);

  const validated = validateConfig(def);
  assert.deepEqual(validated, def);

  assert.throws(() => validateConfig({ ...def, authority: 'unrestricted' }), /Invalid authority mode/);
  assert.throws(() => validateConfig({ ...def, provider: 'gemini' }), /Unsupported provider for CENTCOM/);
  assert.throws(() => validateConfig({ ...def, hostId: '' }), /Invalid host ID/);
  assert.throws(() => validateConfig({ ...def, triggers: { ...def.triggers, cooldownSeconds: 5 } }), /Invalid event trigger configuration/);
  assert.throws(() => validateConfig({ ...def, triggers: { ...def.triggers, maxAutoTurnsPerHour: 200 } }), /Invalid event trigger configuration/);
  assert.throws(() => validateConfig({ ...def, maxDirectivesPerTurn: 50 }), /maxDirectivesPerTurn must be between 1 and 20/);
  assert.throws(() => validateConfig({ ...def, maxBudgetUsd: -5 }), /Invalid budget threshold/);

  // 2. parseCentcomEnvelope
  assert.equal(parseCentcomEnvelope('Standard text without envelope'), null);
  assert.equal(parseCentcomEnvelope('```json\n{"foo":"bar"}\n```'), null);
  assert.deepEqual(parseCentcomEnvelope('```agentc2-c2\n{not valid json}\n```'), {
    error: 'Malformed JSON in agentc2-c2 block',
  });
  assert.deepEqual(parseCentcomEnvelope('```agentc2-c2\n{"version": 2}\n```'), {
    error: 'Envelope requires version: 1',
  });

  const validEnvelope = `
Here is my commander plan:
\`\`\`agentc2-c2
{
  "version": 1,
  "rationale": "Arbitrate pending issues and check health",
  "queries": [
    { "type": "inspect_session", "params": { "sessionKey": "host-1/tmux:hq-123" } }
  ],
  "directives": [
    {
      "kind": "unit.stop",
      "summary": "Stop failed unit",
      "rationale": "Repeated crash loop",
      "params": { "name": "hq-123", "hostId": "host-1" }
    }
  ],
  "automations": [
    {
      "kind": "preset",
      "title": "Fast Rust preset",
      "rationale": "Frequently used cargo build",
      "evidence": ["3 cargo units launched"],
      "payload": { "id": "rust-fast", "name": "Rust Fast", "command": "cargo test" }
    }
  ]
}
\`\`\`
Follow-up text.`;

  const parsed = parseCentcomEnvelope(validEnvelope);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.rationale, 'Arbitrate pending issues and check health');
  assert.equal(parsed.queries.length, 1);
  assert.equal(parsed.directives.length, 1);
  assert.equal(parsed.directives[0].kind, 'unit.stop');
  assert.equal(parsed.automations.length, 1);
  assert.equal(parsed.automations[0].kind, 'preset');

  // Test directive & automation kinds registry
  assert.ok(DIRECTIVE_KINDS.includes('unit.create'));
  assert.ok(DIRECTIVE_KINDS.includes('unit.stop'));
  assert.ok(DIRECTIVE_KINDS.includes('specops.control'));
  assert.ok(DIRECTIVE_KINDS.includes('flash.decide'));
  assert.ok(AUTOMATION_KINDS.includes('specops_workflow'));
  assert.ok(AUTOMATION_KINDS.includes('preset'));

  // 3. CENTCOM Engine Integration Fixtures
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-test-'));
  const emittedEvents = [];
  const remoteCalls = [];
  const serviceActions = [];
  const createdSessions = [];

  const mockSettings = {
    hosts: [{ id: 'host-1', name: 'Primary Host', enabled: true }],
    presets: [],
  };

  const inventorySessions = [
    { key: 'host-1/tmux:hq-000000000001', hostId: 'host-1', name: 'hq-000000000001', state: 'live', kind: 'managed', managed: true, title: 'Task Worker' },
    { key: 'host-1/tmux:hq-000000000002', hostId: 'host-1', name: 'hq-000000000002', state: 'exited', kind: 'managed', managed: true, title: 'Exited Worker' },
  ];
  // A single terminal line can exceed the remote workspace's UTF-8 byte limit.
  inventorySessions[0].outputTail = 'old output\n' + '😀'.repeat(300000) + '\nlatest evidence';

  let specopsMissions = [
    { id: 'specops-1', repo: 'mlg151/AgentC2', workflow: { name: 'Patch Release' }, hostId: 'host-1', visits: [{ name: 'hq-000000000001' }], stage: 'plan_review', state: 'halted', error: 'Watch officer review required' },
  ];

  let flashRequests = [
    { id: 'flash-1', hostId: 'host-1', hostName: 'Primary Host', name: 'hq-000000000001', tool: 'Bash', createdAt: Math.floor(Date.now() / 1000), state: 'pending', connected: true },
  ];

  let faults = [
    { sessionKey: 'host-1/tmux:hq-000000000001', status: 'review', detail: 'loop detected', label: 'Loop fault' },
  ];

  const chatEvents = new Map();
  let chatSessionCounter = 0;
  let lastSubmittedPayload = null;

  const mockChats = {
    open: async (client, sessionId, hostId) => `handle-${sessionId}`,
    take: async (client, handleId) => {},
    disconnect: (clientId) => {},
    submit: async (client, handleId, payload) => {
      lastSubmittedPayload = payload;
      const list = chatEvents.get(payload.sessionId) || [];
      const unstamped = list.filter((ev) => !ev.turnId);
      if (unstamped.length > 0) {
        for (const ev of unstamped) ev.turnId = payload.commandId;
      } else {
        list.push(
          {
            sequence: list.length + 1,
            turnId: payload.commandId,
            type: 'message.completed',
            data: { role: 'assistant', text: 'Fleet status briefing completed.' },
          },
          {
            sequence: list.length + 2,
            turnId: payload.commandId,
            type: 'turn.completed',
            data: { outcome: 'completed' },
          }
        );
      }
      return { commandId: payload.commandId };
    },
    receipt: async (client, handleId, commandId) => ({
      state: 'completed',
      commandId,
      result: { turnId: commandId },
    }),
    request: async (_hostId, action, { commandId, command }) => ({
      state: 'completed', commandId: commandId || command.commandId,
      sessionId: command?.sessionId, result: { turnId: commandId },
    }),
    read: async (hostId, sessionId, after, limit) => {
      const list = chatEvents.get(sessionId) || [];
      return {
        events: list.filter((e) => e.sequence > after),
        truncated: false,
      };
    },
  };

  const mockService = {
    store: {
      data: { settings: mockSettings },
    },
    getHost: (id) => ({ id, name: 'Primary Host' }),
    runRemote: async (payload) => {
      remoteCalls.push(payload);
      for (const content of Object.values(payload.files || {})) {
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1_000_000) {
          throw new Error('Unsupported or oversized CENTCOM file');
        }
      }
      return { path: '/fixture/centcom', written: Object.keys(payload.files || {}) };
    },
    create: async (input) => {
      const id = `chat-centcom-${++chatSessionCounter}`;
      const name = `hq-centcom-${chatSessionCounter}`;
      const session = { name, chatSessionId: id, hostId: input.hostId, provider: input.provider, model: input.model };
      createdSessions.push(session);
      chatEvents.set(id, []);
      return session;
    },
    inventory: async () => ({
      hosts: [{ id: 'host-1', name: 'Primary Host', connected: true }],
      sessions: inventorySessions,
      missions: specopsMissions,
      faults,
      conflicts: [],
    }),
    health: async () => ({ status: 'healthy', hosts: [{ id: 'host-1', connected: true }] }),
    flashQueue: async () => flashRequests,
    flashDecide: async (client, { id, decision }) => {
      serviceActions.push({ type: 'flashDecide', id, decision });
      const r = flashRequests.find((f) => f.id === id);
      if (r) r.state = decision === 'allow' ? 'allowed' : 'denied';
      return { success: true };
    },
    specops: {
      list: () => specopsMissions,
      control: async (id, action) => {
        serviceActions.push({ type: 'specopsControl', id, action });
        const m = specopsMissions.find((item) => item.id === id);
        if (m) m.state = 'running';
        return { success: true };
      },
      definition: () => ({ profiles: [], workflows: [] }),
      configure: (yaml) => {
        serviceActions.push({ type: 'specopsConfigure', yaml });
      },
    },
    exercises: {
      list: () => [{ id: 'ex-1', hostId: 'host-1', contestants: [{ id: 'cont-1', name: 'hq-000000000001' }] }],
      inspect: (id, contestantId, verify) => {
        serviceActions.push({ type: 'exerciseInspect', id, contestantId, verify });
        assert.equal(verify, false, 'Centcom must strictly pass verify: false to inspect');
        return { id, verified: false };
      },
    },
    loopBreaker: {
      faults: () => faults,
    },
    interruptFaults: async (client) => {
      serviceActions.push({ type: 'interruptFaults' });
      return [{ sessionKey: 'host-1/tmux:hq-000000000001', status: 'interrupted' }];
    },
    resetFault: async (sessionKey) => {
      serviceActions.push({ type: 'resetFault', sessionKey });
      faults = faults.filter((f) => f.sessionKey !== sessionKey);
    },
    commanderControl: async (_client, _unit, fn) => fn('fixture-control'),
    action: async (client, action, name, hostId) => {
      serviceActions.push({ type: 'sessionAction', action, name, hostId });
      return { ok: true };
    },
    saveSettings: async (updated) => {
      serviceActions.push({ type: 'saveSettings', settings: updated });
      mockService.store.data.settings = updated;
    },
  };

  const centcom = createCentcom({
    directory: tmpDir,
    service: mockService,
    chats: mockChats,
    emit: (event, data) => emittedEvents.push({ event, data }),
  });

  // Verify Initial State
  let state = centcom.state();
  assert.equal(state.status, 'idle');
  assert.equal(state.config.authority, 'gated');
  assert.equal(state.directives.length, 0);

  // 4. Start Commander Session
  const started = await centcom.start('Evaluate fleet status');
  assert.ok(started.session, 'Session must be created');
  assert.match(started.session.name, /^hq-centcom-/);
  assert.equal(remoteCalls[0].action, 'centcom_sync', 'Must perform remote sync to ~/.cache/agentc2/centcom');
  const initialSituation = JSON.parse(remoteCalls[0].files['SITUATION.json']);
  assert.equal(initialSituation.units.length, 1);
  assert.ok(initialSituation.truncation.outputTailsOmitted > 0);
  assert.equal(initialSituation.truncation.omitted.units, 0);
  assert.ok(inventorySessions[0].outputTail.endsWith('latest evidence'), 'Snapshot reduction must not mutate inventory');
  delete inventorySessions[0].outputTail;

  // Verify Single-Turn Envelope Processing & Preconditions
  const commanderSessionId = started.session.chatSessionId;
  const events = chatEvents.get(commanderSessionId);

  // Simulate assistant completion with directives:
  // 1. One with requireSessionLive on live unit (should pass precondition)
  // 2. One with requireSessionLive on exited unit (should fail precondition)
  // 3. One with requireFlashPending on flash-1 (should pass precondition)
  events.push(
    {
      sequence: 1,
      turnId: null,
      type: 'message.completed',
      data: {
        role: 'assistant',
        text: `Here is the assessment:
\`\`\`agentc2-c2
{
  "version": 1,
  "rationale": "Stopping exited unit and approving pending flash",
  "directives": [
    {
      "kind": "unit.stop",
      "summary": "Stop live worker",
      "rationale": "Rebalancing tasks",
      "params": { "name": "hq-000000000001", "hostId": "host-1" },
      "preconditions": { "sessionKey": "host-1/tmux:hq-000000000001", "state": "live" }
    },
    {
      "kind": "unit.stop",
      "summary": "Stop dead worker",
      "rationale": "Cleanup",
      "params": { "name": "hq-000000000002", "hostId": "host-1" },
      "preconditions": { "sessionKey": "host-1/tmux:hq-000000000002", "state": "live" }
    },
    {
      "kind": "flash.decide",
      "summary": "Approve flash request 1",
      "rationale": "Safe read operation",
      "params": { "id": "flash-1", "decision": "allow" }
    }
  ]
}
\`\`\``,
      },
    },
    {
      sequence: 2,
      turnId: null,
      type: 'usage.updated',
      data: { costUsd: 0.15 },
    },
    {
      sequence: 3,
      turnId: null,
      type: 'turn.completed',
      data: { outcome: 'completed' },
    }
  );

  // Submit a turn request (which drains the scheduler and processes the events)
  inventorySessions[0].outputTail = 'Ordinary terminal evidence';
  await centcom.submit('Perform checks now');
  const normalSituation = JSON.parse(remoteCalls.at(-1).files['SITUATION.json']);
  assert.equal(normalSituation.truncation, undefined, 'Snapshots within the limit must retain all context');
  assert.equal(normalSituation.units[0].outputTail, 'Ordinary terminal evidence');

  state = centcom.state();
  assert.equal(state.status, 'awaiting_approval', 'Gated mode with pending directives enters awaiting_approval');
  assert.equal(state.directives.length, 3);

  const dLive = state.directives.find((d) => d.summary === 'Stop live worker');
  const dDead = state.directives.find((d) => d.summary === 'Stop dead worker');
  const dFlash = state.directives.find((d) => d.summary === 'Approve flash request 1');
  assert.ok(dLive && dDead && dFlash);
  assert.equal(dLive.state, 'pending');
  assert.equal(dDead.state, 'pending');
  assert.equal(dFlash.state, 'pending');

  // 5. Gated Decision Approval & Execution with Precondition Verification
  // Approve dLive -> passes precondition and completes
  const afterDLive = await centcom.decideDirective(dLive.id, 'approve');
  const dLiveUpdated = afterDLive.directives.find((item) => item.id === dLive.id);
  assert.equal(dLiveUpdated.state, 'completed');
  assert.ok(serviceActions.some((a) => a.type === 'sessionAction' && a.action === 'stop' && a.name === 'hq-000000000001'));
  assert.ok(afterDLive.auditLog.some((a) => a.id === dLive.id && a.outcome === 'completed'));

  // Approve dDead -> fails precondition at execution time and marks failed
  const afterDDead = await centcom.decideDirective(dDead.id, 'approve');
  const dDeadUpdated = afterDDead.directives.find((item) => item.id === dDead.id);
  assert.equal(dDeadUpdated.state, 'failed');
  assert.match(dDeadUpdated.error, /Precondition failed.*eligible connected active/);
  assert.ok(afterDDead.auditLog.some((a) => a.id === dDead.id && a.outcome === 'failed'));

  // Deny dFlash -> marked denied in audit log without executing
  const afterDFlash = await centcom.decideDirective(dFlash.id, 'deny');
  const dFlashUpdated = afterDFlash.directives.find((item) => item.id === dFlash.id);
  assert.equal(dFlashUpdated.state, 'denied');
  assert.ok(afterDFlash.auditLog.some((a) => a.id === dFlash.id && a.outcome === 'denied'));

  // 6. Multi-Hop Queries with Safe Inspection Bounds
  // Inject a query turn that calls inspect_exercise and verify inspect_exercise passes verify: false
  events.push(
    {
      sequence: 4,
      turnId: null,
      type: 'message.completed',
      data: {
        role: 'assistant',
        text: `\`\`\`agentc2-c2
{
  "version": 1,
  "rationale": "Inspecting joint exercise",
  "queries": [
    { "type": "inspect_exercise", "params": { "id": "ex-1", "contestantId": "cont-1" } }
  ]
}
\`\`\``,
      },
    },
    { sequence: 5, turnId: null, type: 'turn.completed', data: { outcome: 'completed' } }
  );

  // Submit to trigger turn
  await centcom.submit('Check joint exercise');
  assert.ok(serviceActions.some((a) => a.type === 'exerciseInspect' && a.verify === false), 'Exercise query must be strictly read-only (verify: false)');

  // 7. Event Observation & Anti-Recursion
  // A. Event from Centcom's own session must be dropped
  serviceActions.length = 0;
  await centcom.observe({
    sessions: [{ key: `host-1/tmux:${started.session.name}`, state: 'exited', exitCode: 1, title: 'Commander' }],
  });
  assert.equal(serviceActions.length, 0, 'Must ignore events originating from CENTCOM commander session');

  // B. Valid specops:halted triggers auto-wake turn
  const beforeTurns = centcom.state().autoTurnsLastHour;
  await centcom.observe({
    ...(await mockService.inventory()), faults: [],
  });
  const afterTurns = centcom.state().autoTurnsLastHour;
  assert.equal(afterTurns, beforeTurns + 1, 'Auto-wake must increment autoTurnsLastHour');

  // C. Cooldown limiter drops immediate follow-up event
  await centcom.observe({
    missions: [{ id: 'specops-2', repo: 'mlg151/AgentC2', workflow: { name: 'Patch Release' }, stage: 'plan_review', state: 'halted' }],
  });
  assert.equal(centcom.state().autoTurnsLastHour, afterTurns, 'Event within cooldown must be suppressed');

  // 8. Automation Suggestions
  events.push(
    {
      sequence: 6,
      turnId: null,
      type: 'message.completed',
      data: {
        role: 'assistant',
        text: `\`\`\`agentc2-c2
{
  "version": 1,
  "rationale": "Suggesting developer preset",
  "automations": [
    {
      "kind": "preset",
      "title": "Node 22 Test Suite Preset",
      "rationale": "High test volume",
      "evidence": ["test:ci runs frequently"],
      "payload": { "id": "node22-ci", "name": "Node 22 CI", "command": "npm run test:ci" }
    }
  ]
}
\`\`\``,
      },
    },
    { sequence: 7, turnId: null, type: 'turn.completed', data: { outcome: 'completed' } }
  );

  await centcom.submit('Propose automations');
  state = centcom.state();
  assert.equal(state.automations.length, 1);
  const suggestion = state.automations[0];
  assert.equal(suggestion.state, 'proposed');
  assert.equal(suggestion.title, 'Node 22 Test Suite Preset');

  // Apply automation suggestion
  await centcom.applyAutomation(suggestion.id, 'apply');
  assert.equal(centcom.state().automations[0].state, 'applied');
  assert.ok(serviceActions.some((a) => a.type === 'saveSettings'), 'Applied preset must save to service settings');

  // 9. Durable Persistence & Restart Recovery
  // Force state into 'running' with a directive in 'executing'
  const stateFilePath = path.join(tmpDir, 'centcom.json');
  const diskState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  diskState.status = 'running';
  diskState.directives.push({
    id: 'd-crash-test',
    kind: 'unit.create',
    state: 'executing',
    summary: 'Crashing unit launch',
    createdAt: Date.now(),
  });
  fs.writeFileSync(stateFilePath, JSON.stringify(diskState, null, 2));

  // Instantiate new centcom instance from same directory (simulating app restart)
  const restartedCentcom = createCentcom({
    directory: tmpDir,
    service: mockService,
    chats: mockChats,
    emit: () => {},
  });

  const restartedState = restartedCentcom.state();
  assert.equal(restartedState.status, 'halted', 'Interrupted running status must recover to halted');
  assert.match(restartedState.error, /Application restarted during CENTCOM turn/);

  const crashDirective = restartedState.directives.find((d) => d.id === 'd-crash-test');
  assert.equal(crashDirective.state, 'uncertain', 'Executing directive must be normalized to uncertain on crash recovery');

  // 10. Autonomous C2 Authority Execution
  await restartedCentcom.configure({ ...restartedState.config, authority: 'autonomous' });
  assert.equal(restartedCentcom.state().config.authority, 'autonomous');

  // Add turn with stop_unit directive in autonomous mode
  events.push(
    {
      sequence: 8,
      turnId: null,
      type: 'message.completed',
      data: {
        role: 'assistant',
        text: `\`\`\`agentc2-c2
{
  "version": 1,
  "rationale": "Autonomous intervention to stop runaway unit",
  "directives": [
    {
      "kind": "unit.stop",
      "summary": "Stop active unit automatically",
      "rationale": "Circuit breaker exceeded",
      "params": { "name": "hq-000000000001", "hostId": "host-1" }
    }
  ]
}
\`\`\``,
      },
    },
    { sequence: 9, turnId: null, type: 'turn.completed', data: { outcome: 'completed' } }
  );

  serviceActions.length = 0;
  await restartedCentcom.submit('Autonomous check');
  const autoState = restartedCentcom.state();
  const autoDirective = autoState.directives.find((d) => d.summary === 'Stop active unit automatically');
  assert.ok(autoDirective, 'Autonomous directive recorded');
  assert.equal(autoDirective.state, 'completed', 'Autonomous mode executes mutating directive without user prompt');
  assert.ok(autoState.auditLog.some((a) => a.id === autoDirective.id && a.outcome === 'completed'));

  // Bound aggregate history even when every individual unit is small. Put the
  // live unit last to verify that history cannot crowd it out of the snapshot.
  const largeSessions = Array.from({ length: 6000 }, (_, index) => ({
    key: `host-1/conversation:history-${index}`,
    title: 'Historical unit 😀 '.repeat(20),
    provider: 'codex',
    state: 'exited',
    kind: 'conversation',
  }));
  largeSessions.push(...inventorySessions);
  const largeDirectory = path.join(tmpDir, 'large-fleet');
  let rejectSync = false;
  let largeMissions = specopsMissions;
  const largeCentcom = createCentcom({
    directory: largeDirectory,
    service: {
      ...mockService,
      inventory: async () => ({ hosts: [{ id: 'host-1', connected: true }], sessions: largeSessions }),
      specops: { ...mockService.specops, list: () => largeMissions },
      runRemote: async (payload) => {
        if (rejectSync) throw new Error('Fixture workspace unavailable');
        return mockService.runRemote(payload);
      },
    },
    chats: mockChats,
    emit: () => {},
  });
  const largeSyncStart = remoteCalls.length;
  await largeCentcom.submit('Assess large fleet');
  largeMissions = [{ id: 'oversized-mission', state: 'halted', error: '\u0000😀'.repeat(150000) }];
  await largeCentcom.submit('Refresh large fleet');
  const largeSyncs = remoteCalls.slice(largeSyncStart);
  assert.equal(largeSyncs.length, 3, 'Initial session and every turn must sync a bounded snapshot');
  for (const sync of largeSyncs) {
    const content = sync.files['SITUATION.json'];
    assert.ok(Buffer.byteLength(content, 'utf8') <= 1_000_000);
    const snapshot = JSON.parse(content);
    assert.equal(snapshot.units.length, 1, 'Saved history must be excluded before bounding');
    assert.ok(snapshot.units.some((unit) => unit.key === inventorySessions[0].key));
    if (snapshot.truncation) assert.equal(snapshot.truncation.totals.units, 1);
  }
  const refreshedSituation = JSON.parse(largeSyncs.at(-1).files['SITUATION.json']);
  assert.equal(refreshedSituation.truncation.totals.specops, 1);
  assert.equal(refreshedSituation.truncation.omitted.specops, 1, 'Other oversized evidence must also fit the byte limit');
  assert.match(lastSubmittedPayload.payload.text, /SITUATION.json is partial/);
  const priorCommandId = lastSubmittedPayload.commandId;
  rejectSync = true;
  await assert.rejects(largeCentcom.submit('Do not use stale evidence'), /Fixture workspace unavailable/);
  assert.equal(largeCentcom.state().status, 'halted');
  assert.match(largeCentcom.state().error, /Fixture workspace unavailable/);
  assert.equal(lastSubmittedPayload.commandId, priorCommandId, 'Failed refresh must not send a provider turn');
  largeCentcom.dispose();

  // Clean up
  centcom.dispose();
  restartedCentcom.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('PASS centcom config, envelopes, gated/autonomous authority, preconditions, queries, observation, persistence, and automations');
})();
