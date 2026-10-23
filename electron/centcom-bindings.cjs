const { fingerprint, object, bounded } = require('./centcom-contract.cjs');
const { validateCommand } = require('./chat-protocol.cjs');

const PRECONDITIONS = ['sessionKey', 'state', 'processId', 'startedAt', 'turnId', 'revision', 'stage'];
function validatePreconditions(pre) {
  if (!object(pre) || Object.keys(pre).some((key) => !PRECONDITIONS.includes(key))) throw new Error('Unknown or malformed approval precondition');
  for (const [key, value] of Object.entries(pre)) if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 1000) throw new Error(`Invalid approval precondition: ${key}`);
}
function identity(unit) {
  const result = Object.fromEntries(['key', 'hostId', 'chatSessionId', 'providerSessionId', 'processId', 'startedAt', 'provider', 'cwd', 'worktreeOperation', 'roeProfile'].map((key) => [key, unit[key] ?? null]));
  result.name = unit.id || unit.name;
  result.transport = unit.transport || (unit.chatSessionId ? 'chat' : 'terminal');
  if (!result.startedAt || !(result.chatSessionId || result.processId)) throw new Error('Session incarnation is unknown; refresh identity evidence before proposing an action');
  return result;
}

function createBindings({ service: s, state, resolve, request }) {
  async function capture(entry, input, pre, controlling) {
    const startScope = fingerprint({ hosts: s.store.data.settings.hosts, roe: s.store.data.settings.roe, authority: state.config.authority, commander: state.session?.chatSessionId });
    const target = await resolve(entry, input, pre);
    const units = target ? (Array.isArray(target) ? target : [target]) : [];
    if (!units.length && Object.keys(pre).some((key) => key !== 'sessionKey')) throw new Error('Precondition does not apply to this operation target');
    if (pre.stage && !['mission', 'exercise', 'contestant'].includes(entry.target)) throw new Error('Stage precondition requires a mission or exercise');
    const targets = [];
    let requestEvidence = null;
    for (const unit of units) {
      const instance = identity(unit);
      const inspected = await s.commanderInspection(unit);
      const controller = controlling?.key === unit.key ? controlling.previousControllerId : inspected.ownership?.controller?.id || null;
      const detail = { identity: instance, controller, capabilities: inspected.capabilities || null };
      if (['diff.hunk', 'exercise.promote', 'exercise.complete', 'exercise.verify', 'exercise.control', 'sitrep.handoff'].includes(entry.operation)) detail.revision = { branch: unit.branch || null, headCommit: unit.headCommit || null };
      for (const field of ['processId', 'startedAt']) if (pre[field] && String(instance[field]) !== pre[field]) throw new Error(`Precondition failed: ${field} changed`);
      if (pre.revision && pre.revision !== unit.headCommit && pre.revision !== input.revision) throw new Error('Precondition failed: revision changed');
      const currentTurn = [...(inspected.journal?.events || [])].reverse().find((event) => event.turnId)?.turnId || null;
      if (pre.turnId && pre.turnId !== currentTurn) throw new Error('Precondition failed: turn identity changed');
      if (entry.operation === 'unit.steer' && input.expectedTurnId !== currentTurn) throw new Error('Steering target turn changed');
      if (pre.turnId || entry.operation === 'unit.steer') detail.turnId = currentTurn;
      if (entry.operation === 'chat.respond') {
        if (instance.transport !== 'chat') throw new Error('Responses require structured chat');
        const pending = inspected.pendingRequests?.find((r) => r.requestId === input.requestId && r.state === 'pending');
        if (!pending || pending.turnId !== input.turnId || pending.itemId !== input.itemId) throw new Error('Structured request identity changed or is no longer pending');
        const { requestId, turnId, itemId, decision, answers } = input;
        validateCommand({ protocolVersion: 1, commandId: '00000000-0000-4000-8000-000000000001', operation: 'respond', sessionId: instance.chatSessionId,
          payload: { requestId, turnId, itemId, ...(decision !== undefined ? { decision } : {}), ...(answers !== undefined ? { answers } : {}) } });
        if (pending.type === 'approval' ? decision === undefined : answers === undefined) throw new Error('Response does not match the pending request type');
        const capability = pending.type === 'approval' ? 'approvals' : 'questions';
        if (inspected.capabilities?.status !== 'supported' || !inspected.capabilities[capability]) throw new Error('Provider does not support this structured response');
        requestEvidence = pending;
      }
      targets.push(detail);
    }
    targets.sort((a, b) => a.identity.key.localeCompare(b.identity.key));
    const settings = s.store.data.settings;
    const draftHost = entry.operation === 'automation.apply' ? state.automations.find((a) => a.id === input.id)?.payload?.order?.hostId : null;
    const handoff = entry.operation === 'sitrep.handoff' ? s.sitrepSource(input.id) : null;
    const hostIds = [...new Set([...units.map((u) => u.hostId), input.hostId, input.sourceHostId, input.targetHostId, input.order?.hostId, draftHost, handoff?.sourceHostId, handoff?.targetHostId].filter(Boolean))];
    if (!hostIds.length && entry.operation === 'unit.create') hostIds.push(state.config.hostId);
    const hosts = hostIds.sort().map((id) => {
      const host = settings.hosts.find((h) => h.id === id);
      if (!host?.enabled) throw new Error('Approval host is unavailable');
      return host;
    });
    let operationEvidence = null;
    if (entry.operation === 'flash.decide') {
      operationEvidence = (await s.flashQueue()).find((r) => r.id === input.id && r.state === 'pending');
      if (!operationEvidence || !['allow', 'deny'].includes(input.decision)) throw new Error('Invalid or resolved Flash Traffic decision');
    }
    if (entry.operation.startsWith('fault.')) operationEvidence = s.loopBreaker.faults().find((r) => r.sessionKey === units[0]?.key) || null;
    if (entry.operation === 'specops.control') {
      const mission = s.specops.list().find((r) => r.id === input.id);
      if (pre.stage && pre.stage !== mission?.stage) throw new Error('Mission stage changed');
      if (pre.state && pre.state !== mission?.state) throw new Error('Mission state changed');
      operationEvidence = { id: mission.id, stage: mission.stage, state: mission.state, workflow: mission.workflow, worktree: mission.worktree, baseCommit: mission.baseCommit,
        visits: mission.visits.map((v) => ({ id: v.id, stage: v.stage, name: v.name, sessionId: v.sessionId, completion: v.completion, outcome: v.outcome })) };
    }
    if (entry.operation.startsWith('exercise.') && entry.operation !== 'exercise.create') {
      operationEvidence = s.exercises.list().find((r) => r.id === input.id);
      if (pre.stage && pre.stage !== operationEvidence?.state) throw new Error('Exercise stage changed');
      if (pre.state && pre.state !== operationEvidence?.state) throw new Error('Exercise state changed');
    }
    if (entry.operation === 'configuration.save') operationEvidence = settings;
    if (entry.operation === 'mission.update') {
      const previous = state.coordination.find((record) => record.id === input.id);
      if ((previous?.revision || null) !== input.expectedRevision) throw new Error('Mission revision changed; inspect and propose again');
      const ids = [...new Set([...input.plan.dependencies, ...input.plan.acceptanceCriteria].flatMap((item) => item.evidenceOutcomeIds))];
      const evidence = ids.map((id) => state.outcomes.find((row) => row.outcomeId === id));
      if (evidence.some((row) => !row)) throw new Error('Cited outcome is unavailable or expired');
      operationEvidence = { previous: previous || null, evidence: evidence.map((row) => ({ id: row.outcomeId, digest: fingerprint(row) })) };
    }
    if (['specops.configure', 'specops.launch'].includes(entry.operation)) {
      const definition = s.specops.definition();
      operationEvidence = { profiles: definition.profiles, workflows: definition.workflows };
    }
    if (entry.operation === 'automation.apply') {
      const draft = state.automations.find((a) => a.id === input.id);
      if (!draft || draft.state !== 'proposed') throw new Error('Automation draft is no longer proposed');
      operationEvidence = { id: draft.id, kind: draft.kind, payload: draft.payload, preview: draft.preview };
    }
    if (entry.operation === 'oporder.enroll') {
      const preview = await s.previewOpOrder(input.order);
      if (!preview?.ready || preview.revision !== input.revision) throw new Error('OpOrder preview revision changed or is not ready');
      operationEvidence = preview;
    }
    if (entry.operation === 'sitrep.handoff') operationEvidence = s.sitrepSource(input.id);
    if (entry.operation === 'worktree.archive') {
      operationEvidence = (await s.worktrees(input.hostId)).find((w) => w.operationId === input.operationId);
      if (!operationEvidence) throw new Error('Worktree identity is unavailable');
      if (!/^[a-f0-9]{40,64}$/.test(operationEvidence.status?.headCommit || '')) throw new Error('Worktree HEAD revision is unavailable');
    }
    const authority = { mode: state.config.authority, commander: state.session?.chatSessionId || null, hosts, roe: settings.roe || null,
      preset: input.presetId ? settings.presets.find((p) => p.id === input.presetId) || null : null };
    if (startScope !== fingerprint({ hosts: s.store.data.settings.hosts, roe: s.store.data.settings.roe, authority: state.config.authority, commander: state.session?.chatSessionId })) throw new Error('Authorization changed while inspecting approval evidence');
    return { targets, authority, requestEvidence, operationEvidence };
  }
  async function bind(directive, entry, input) {
    validatePreconditions(directive.preconditions);
    const evidence = structuredClone(await capture(entry, input, directive.preconditions));
    return { version: 1, requestHash: fingerprint({ operation: entry.operation, input, preconditions: directive.preconditions }), evidence, evidenceHash: fingerprint(evidence) };
  }
  async function assert(directive, entry, input, controlling) {
    const binding = directive.binding;
    if (!binding || binding.version !== 1) throw new Error('Approval has no reviewed identity binding; propose the action again');
    if (binding.requestHash !== fingerprint({ operation: entry.operation, input, preconditions: directive.preconditions }) || binding.evidenceHash !== fingerprint(binding.evidence)) throw new Error('Reviewed action parameters or binding changed');
    const current = await capture(entry, input, directive.preconditions, controlling);
    if (fingerprint(current) !== binding.evidenceHash) throw new Error('Approval evidence changed: target incarnation, control, revision, stage, or authorization scope requires fresh review');
  }
  return { bind, assert: (directive, controlling) => { const r = request(directive, 'action'); return assert(directive, r.entry, r.input, controlling); } };
}

function reviewSummary(binding) {
  if (!binding?.evidence || !Array.isArray(binding.evidence.targets)) return null;
  const evidence = binding.evidence;
  return { version: binding.version, requestHash: binding.requestHash, evidenceHash: binding.evidenceHash,
    targets: evidence.targets.map(({ identity, controller, revision }) => ({ identity, controller, ...(revision ? { revision } : {}) })),
    authority: bounded(evidence.authority, 8000), request: bounded(evidence.requestEvidence, 8000), operation: bounded(evidence.operationEvidence, 8000) };
}
module.exports = { createBindings, validatePreconditions, identity, reviewSummary };
