const { bounded, fingerprint, redact } = require('./centcom-contract.cjs');

const classification = (s) => s.kind === 'managed' && s.managed ? 'managed' : s.kind === 'conversation' || (s.kind === 'background' && ['saved', 'stopped', 'exited'].includes(s.state)) ? 'saved' : 'external';
const unknown = (reason, status = 'unknown') => ({ status, reason });
function execution(s) {
  if (s.stale || s.missing) return 'unknown';
  if (s.chatState === 'running' || s.activity === 'engaged') return 'executing';
  if (s.chatState === 'waiting' || ['waiting', 'waiting_for_input', 'requires_action', 'blocked'].includes(s.state)) return 'waiting';
  if (s.chatState === 'idle' || s.activity === 'idle') return 'idle';
  if (s.chatState === 'failed') return 'failed';
  if (['exited', 'saved', 'stopped'].includes(s.state) || s.chatState === 'stopped') return 'stopped';
  return 'unknown'; // A live process alone does not establish execution progress.
}
function page(items, { after = '', limit = 20 } = {}, key = (item) => item.id) {
  if (typeof after !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid evidence cursor or page limit (1–50)');
  const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b)));
  const remaining = sorted.filter((item) => !after || key(item).localeCompare(after) > 0);
  const entries = [];
  for (const item of remaining.slice(0, limit)) {
    const next = { ...bounded(item, 24000), id: key(item) };
    if (entries.length && Buffer.byteLength(JSON.stringify([...entries, next])) > 56000) break;
    entries.push(next);
  }
  return { entries, cursor: entries.length ? key(remaining[entries.length - 1]) : after, hasMore: remaining.length > entries.length, total: sorted.length, capturedAt: new Date().toISOString(), consistency: 'live; identities are stable, records may change between pages' };
}

function createEvidence({ service: s, isCommander, activeKeys }) {
  async function inventory() {
    const inv = await s.inventory();
    const deleted = new Set(s.store.data.deletedSessions || []);
    return { ...inv, sessions: (inv.sessions || []).filter((u) => !deleted.has(u.key) && !isCommander(u.hostId, u.chatSessionId || u.name || u.id)) };
  }
  function canonical(inv) {
    const groups = new Map();
    for (const unit of inv.sessions) {
      const native = unit.providerSessionId || (['conversation', 'background'].includes(unit.kind) ? unit.id : null);
      const identity = native ? [unit.hostId, unit.provider, 'native', native] : unit.chatSessionId ? [unit.hostId, 'chat', unit.chatSessionId] : [unit.hostId, 'unit', unit.key];
      const id = fingerprint(identity);
      const group = groups.get(id) || [];
      group.push(unit); groups.set(id, group);
    }
    return [...groups.entries()].map(([id, representations]) => {
      const sorted = [...representations].sort((a, b) => Number(classification(b) === 'managed') - Number(classification(a) === 'managed') || Number(['live', 'waiting_for_input'].includes(b.state)) - Number(['live', 'waiting_for_input'].includes(a.state)));
      const u = sorted[0];
      const host = inv.hosts?.find((h) => h.id === u.hostId);
      const stale = u.stale || u.missing || !host?.connected;
      return redact({
        id, key: u.key, hostId: u.hostId, provider: u.provider, title: u.title || null,
        classification: classification(u), classifications: [...new Set(sorted.map(classification))],
        execution: stale ? 'unknown' : execution(u), state: u.state || 'unknown', chatState: u.chatState || 'unsupported',
        freshness: { status: stale ? 'stale' : 'reported', capturedAt: inv.capturedAt || null, sourceUpdatedAt: u.updatedAt || null, startedAt: u.startedAt || null },
        relationship: { providerSessionId: u.providerSessionId || (classification(u) === 'saved' ? u.id : null), chatSessionId: u.chatSessionId || null, representations: sorted.map((r) => ({ key: r.key, classification: classification(r), processId: r.processId || (r.kind === 'unmanaged' ? r.id : null), processRole: r.processRole || (r.kind === 'unmanaged' ? 'unmanaged_agent' : 'unknown'), startedAt: r.startedAt || null, state: r.state })) },
        cwd: u.cwd || null, repository: u.repository || null, branch: u.branch || null, headCommit: u.headCommit || null,
        worktreeOperation: u.worktreeOperation || null, roeProfile: u.roeProfile || 'unknown',
        telemetry: u.telemetry || unknown('Provider telemetry is unavailable'),
        currentTask: unknown('Inspect the structured journal or notes; process liveness is not task progress'),
        notes: bounded(s.store.data.workspace?.metadata?.[u.key] || {}, 8000),
        mission: u.specops || null,
      });
    });
  }
  async function units(input = {}) {
    const inv = await inventory();
    const items = canonical(inv).filter((u) => (!input.hostId || u.hostId === input.hostId) && (!input.provider || u.provider === input.provider) && (!input.classification || u.classifications.includes(input.classification)) && (!input.execution || u.execution === input.execution));
    if (input.classification && !['managed', 'external', 'saved'].includes(input.classification)) throw new Error('Invalid unit classification filter');
    if (input.execution && !['executing', 'waiting', 'idle', 'stopped', 'failed', 'unknown'].includes(input.execution)) throw new Error('Invalid execution filter');
    return page(items, input);
  }
  async function inspect({ sessionKey, commandId }) {
    const inv = await inventory();
    const unit = inv.sessions.find((u) => u.key === sessionKey);
    if (!unit) throw new Error('Unit is unavailable, deleted, or belongs to CENTCOM');
    const detail = canonical(inv).find((u) => u.relationship.representations.some((r) => r.key === sessionKey));
    const controlKeys = await activeKeys(inv);
    const runtime = s.commanderInspection ? await s.commanderInspection(unit, commandId).catch((error) => unknown(error.message)) : unknown('Runtime inspection service is unavailable');
    const inspection = { ...detail, inspectedKey: sessionKey, runtime: { state: runtime.sessionState || 'unknown', sampledAt: runtime.sampledAt || null }, control: { eligible: controlKeys.has(sessionKey), reason: controlKeys.has(sessionKey) ? null : 'Only connected active managed sessions can be controlled', ownership: runtime.ownership || unknown('No control observation') },
      capabilities: runtime.capabilities || unknown('Capabilities unavailable', unit.transport === 'chat' ? 'unknown' : 'unsupported'),
      ...(commandId ? { command: runtime.command || unknown(runtime.reason || 'Command receipt unavailable', unit.transport === 'chat' ? 'unknown' : 'unsupported') } : {}),
      pendingRequests: runtime.pendingRequests || unknown('Structured request inspection unavailable', unit.transport === 'chat' ? 'unknown' : 'unsupported'),
      currentTask: runtime.currentTask || detail.currentTask, journal: runtime.journal || null,
      transcript: unit.outputTail ? { text: unit.outputTail.slice(-12000), truncated: unit.outputTail.length > 12000, source: 'inventory', sourceUpdatedAt: unit.updatedAt || null } : unknown('No transcript evidence in this inventory'),
    };
    // Query outcomes have a 12 KB per-result delivery limit. Keep the live
    // operational summary outside a bounded preview of large journal details.
    const result = bounded(inspection, commandId ? 4000 : 10000);
    if (!result.truncated) return result;
    return { ...bounded(inspection, 2000), inspectedKey: sessionKey,
      runtime: bounded(inspection.runtime, 500), control: bounded(inspection.control, 1000),
      currentTask: { ...bounded(inspection.currentTask, 1000), ...(inspection.currentTask.turnId ? { turnId: inspection.currentTask.turnId } : {}) },
      pendingRequests: bounded(inspection.pendingRequests, 2000),
      ...(commandId ? { command: inspection.command } : {}) };
  }
  async function hosts({ hostId } = {}) {
    const inv = await inventory();
    let readings;
    try { readings = s.health ? await s.health() : []; } catch { readings = []; }
    if (!Array.isArray(readings)) readings = readings?.hosts || [];
    const results = await Promise.all((inv.hosts || []).filter((h) => !hostId || h.id === hostId).map(async (h) => {
      const health = readings.find((r) => (r.hostId || r.id) === h.id);
      const capabilities = s.commanderCapabilities ? await s.commanderCapabilities(h.id).catch((error) => unknown(error.message)) : unknown('Provider capability discovery unavailable');
      const available = health?.connected && Number.isFinite(health.memoryTotal) && Number.isFinite(health.memoryUsed) ? Math.max(0, health.memoryTotal - health.memoryUsed) : null;
      const group = health?.resources;
      const groupAvailable = Number.isFinite(group?.memoryHeadroomBytes) ? group.memoryHeadroomBytes : null;
      return { id: h.id, connected: h.connected, health: health ? redact(health) : unknown('Host health is unavailable'), capabilities,
        headroom: { status: health?.connected && available !== null && (group?.memoryLimitStatus !== 'limited' || groupAvailable !== null) ? 'reported' : 'unknown', memoryBytes: available === null ? null : groupAvailable === null ? available : Math.min(available, groupAvailable),
          cpuPercent: Number.isFinite(health?.cpuPercent) && health.connected ? Math.max(0, 100 - health.cpuPercent) : null,
          scope: group?.memoryLimitStatus === 'limited' ? 'host_and_reported_cgroup' : 'host; cgroup headroom may be unknown',
          limitsCoverage: group?.memoryLimitStatus || 'unknown', sampledAt: health?.sampledAt || null },
        roe: s.store.data.settings.roe?.hostDefaults?.[h.id] || 'unknown' };
    }));
    return bounded({ hosts: results, capturedAt: new Date().toISOString() });
  }
  async function context(input = {}) {
    const sections = {
      definitions: () => { const d = s.specops.definition(); return [...d.profiles.map((v) => ({ ...v, id: `profile:${v.id}`, type: 'profile' })), ...d.workflows.map((v) => ({ ...v, id: `workflow:${v.id}`, type: 'workflow' }))]; },
      presets: () => s.store.data.settings.presets || [],
      oporders: () => (s.store.data.settings.opOrders || []).map((o) => ({ ...o, conflict: s.store.data.opOrderConflicts?.[o.id] || null })),
      notes: () => Object.entries(s.store.data.workspace?.metadata || {}).filter(([key]) => !(s.store.data.deletedSessions || []).includes(key) && !isCommander(key.split('/')[0], key)).map(([key, value]) => ({ ...value, id: key, sessionKey: key })),
      handoffs: () => s.commanderHandoffs ? s.commanderHandoffs() : [],
    };
    if (!sections[input.section]) throw new Error('Choose context section: definitions, presets, oporders, notes, handoffs');
    const entries = await sections[input.section]();
    return { ...page(entries, input), section: input.section, status: input.section === 'handoffs' && !s.commanderHandoffs ? 'unsupported' : 'reported' };
  }
  async function admission(input, { reuse, recovery } = {}) {
    const inv = await inventory();
    const hostId = input.hostId || s.store.data.settings.hosts.find((h) => h.enabled)?.id;
    const host = inv.hosts?.find((h) => h.id === hostId);
    const report = (await hosts({ hostId })).hosts?.[0];
    const blockers = [], unknowns = [];
    if (!host?.connected) blockers.push('Host is disconnected or unavailable');
    const observed = s.worktrees ? await Promise.resolve(s.worktrees(hostId)).catch(() => null) : null;
    const records = Array.isArray(observed) ? observed : null;
    const requested = input.worktree?.operationId;
    const existing = requested && records?.find((worktree) => worktree.operationId === requested);
    let recoveryEvidence = null;
    if (existing) {
      const recoverable = recovery?.operationId === requested && ['ready', 'provisioning'].includes(existing.state) && existing.status?.owned === true && existing.status.active === false && existing.status.dirty === false &&
        existing.repository === recovery.repository && existing.baseCommit === recovery.baseCommit && existing.provider === recovery.provider && existing.slug === recovery.slug &&
        !existing.sitrepSource && typeof existing.path === 'string' && existing.path.startsWith('/') && /^[a-f0-9]{40,64}$/.test(existing.status.headCommit || '');
      if (recoverable) {
        recoveryEvidence = { operationId: requested, revision: fingerprint(existing), path: existing.path, repository: existing.repository, baseCommit: existing.baseCommit, headCommit: existing.status.headCommit, state: existing.state };
        unknowns.push('Existing owned workflow worktree requires fresh reviewed recovery');
      } else blockers.push('Worktree operation ID is already assigned or its recovery ownership cannot be verified');
    }
    const candidates = inv.sessions.filter((u) => u.hostId === hostId && !['saved', 'exited', 'stopped'].includes(u.state));
    const withPaths = candidates.filter((u) => u.cwd);
    let paths;
    if ((!input.worktree || recoveryEvidence) && host?.connected && s.commanderLaunchPaths && withPaths.length <= 200) paths = await s.commanderLaunchPaths(hostId, recoveryEvidence?.path || input.cwd, withPaths.map((u) => u.cwd)).catch(() => null);
    if (recoveryEvidence && paths?.cwd !== recoveryEvidence.path) blockers.push('Recovery worktree path changed or could not be verified');
    const owners = candidates.filter((u) => (requested && u.worktreeOperation === requested) || (paths && u.cwd && paths.paths[withPaths.indexOf(u)] === paths.cwd));
    const sharedOwners = [];
    if (reuse) {
      const worktree = records?.find((record) => record.operationId === reuse.operationId);
      if (!worktree?.status?.owned || worktree.state === 'archived' || worktree.path !== input.cwd || paths?.cwd !== worktree.path) blockers.push('Workflow worktree ownership/path changed or could not be verified');
      else for (const owner of owners) {
        const predecessor = reuse.predecessors?.find((item) => item.sessionKey === owner.key && item.chatSessionId === owner.chatSessionId && item.turnId);
        if (!predecessor || !owner.managed || owner.kind !== 'managed' || owner.stale || owner.missing || owner.transport !== 'chat') continue;
        const detail = await s.commanderInspection(owner).catch(() => null);
        const events = detail?.journal?.events || [];
        const latestTurn = [...events].reverse().find((event) => event.turnId)?.turnId;
        const ended = events.some((event) => event.type === 'turn.completed' && event.turnId === predecessor.turnId && ['completed', 'failed', 'interrupted'].includes(event.data?.outcome));
        if (['idle', 'failed', 'stopped'].includes(detail?.sessionState) && Array.isArray(detail.pendingRequests) && !detail.pendingRequests.length && latestTurn === predecessor.turnId && ended) sharedOwners.push(owner.key);
      }
    }
    if (owners.some((owner) => !sharedOwners.includes(owner.key))) blockers.push('The exact working directory or worktree is already assigned to a live unit');
    if (!paths && (!input.worktree || recoveryEvidence)) unknowns.push('Canonical working directory identity could not be inspected');
    if ((!input.worktree || recoveryEvidence) && candidates.some((u) => !u.cwd)) unknowns.push('Some live unit working directories are unknown');
    if (!records) unknowns.push('Managed worktree ownership could not be inspected');
    const memory = report?.headroom?.memoryBytes;
    if (Number.isFinite(memory) && memory < 256 * 1024 * 1024) blockers.push('Available memory is below the 256 MiB launch reserve');
    if (report?.headroom?.status !== 'reported' || report?.headroom?.limitsCoverage === 'unknown') unknowns.push('Resource headroom has incomplete coverage');
    if (report?.headroom?.cpuPercent != null && report.headroom.cpuPercent < 5) unknowns.push('Host CPU is above 95% utilization');
    return { status: blockers.length ? 'blocked' : unknowns.length ? 'unknown' : 'admitted', hostId, blockers, unknowns,
      owners: owners.map((u) => ({ key: u.key, cwd: u.cwd || null, worktreeOperation: u.worktreeOperation || null, roeProfile: u.roeProfile || 'unknown' })),
      sharedOwners,
      recovery: recoveryEvidence,
      resources: report?.headroom || unknown('Health unavailable'), policy: 'Block known assignment conflicts and memory exhaustion; unknowns require Watch Officer review. Repository names alone never establish conflicts.', capturedAt: new Date().toISOString() };
  }
  return { units, inspect, hosts, context, admission };
}

module.exports = { createEvidence, classification, execution, page };
