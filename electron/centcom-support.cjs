const { page } = require('./centcom-evidence.cjs');
const { redact } = require('./centcom-contract.cjs');
const PROVIDERS = ['codex', 'claude', 'antigravity', 'opencode', 'terminal'];
const LOCAL = new Set(['capabilities.read', 'capabilities.support', 'outcomes.read', 'history.read', 'configuration.inspect', 'configuration.save', 'specops.definition', 'specops.configure', 'automation.validate', 'automation.preview', 'automation.read', 'automation.apply', 'context.read', 'units.list', 'fleet.inspect', 'exercise.list']);
const NATIVE = new Set(['unit.send', 'unit.steer', 'unit.interrupt', 'unit.stop', 'unit.delete', 'chat.respond']);
const LAUNCH = new Set(['unit.create', 'specops.launch', 'exercise.create', 'sitrep.handoff']);

function requirements(entry) {
  return {
    scope: LOCAL.has(entry.operation) ? 'local_or_payload_dependent' : ['session', 'sessions', 'mission', 'exercise', 'contestant', 'sitrep'].includes(entry.target) ? 'managed_target' : 'host',
    connectedHost: !LOCAL.has(entry.operation),
    nativeCapability: ({ 'unit.steer': 'steering', 'unit.interrupt': 'interrupt', 'chat.respond': 'approvals_or_questions' })[entry.operation] || null,
    transports: ['unit.steer', 'chat.respond', 'specops.launch', 'specops.control'].includes(entry.operation) ? ['chat'] : ['chat', 'terminal'],
    approvalPolicy: entry.classification === 'query' ? 'read_only' : entry.reviewRequired ? 'watch_officer_in_both_modes' : 'current_c2_authority_and_fresh_binding',
    checks: 'Discovery does not grant control. Dispatch rechecks exact target, revision, controller, ROE, request, and admission as applicable.',
  };
}

function createSupport({ service, fleet, catalog, authority, inspectUnit }) {
  return async function inspect({ operation, hostId, provider, transport, sessionKey, after = '', limit = 20 }) {
    const entry = catalog().find((e) => e.operation === operation || e.aliases.includes(operation));
    if (!entry) throw Object.assign(new Error('Unknown capability operation'), { code: 'unknown_operation' });
    const policy = requirements(entry);
    const inventory = await service.inventory();
    const current = await fleet(inventory);
    const settings = service.store.data.settings;
    if (hostId && !settings.hosts.some((h) => h.id === hostId)) throw new Error('Unknown capability host');
    const selected = sessionKey ? current.find(sessionKey, hostId) : null;
    const inventoryUnit = sessionKey ? inventory.sessions.find((s) => s.key === sessionKey) : null;
    const inspection = entry.operation === 'unit.inspect' && inventoryUnit;
    if (inspection) {
      try { await inspectUnit({ sessionKey }); }
      catch { return { ...page([], { after, limit }), operation: entry.operation, status: 'unavailable', reason: 'Unit inspection is unavailable for this identity', authority: authority(), requirements: policy }; }
    }
    // Do not derive operational eligibility from an unverified caller-supplied key.
    if (sessionKey && !selected && !inspection) return { ...page([], { after, limit }), operation: entry.operation, status: 'unavailable', reason: 'Session is outside the eligible managed fleet', authority: authority(), requirements: policy };
    const target = selected || inspection;
    const hosts = settings.hosts.filter((h) => (!hostId || h.id === hostId) && (!target || target.hostId === h.id));
    const rows = hosts.flatMap((host) => PROVIDERS.filter((p) => (!provider || provider === p) && (!target || target.provider === p)).flatMap((p) => ['chat', 'terminal'].filter((t) => (!transport || transport === t) && (!target || (target.transport || 'terminal') === t)).map((t) => ({
      id: `${host.id}/${p}/${t}`, hostId: host.id, provider: p, transport: t, enabled: host.enabled,
    }))));
    const selectedPage = page(rows, { after, limit });
    const capabilities = new Map();
    if (NATIVE.has(entry.operation) || LAUNCH.has(entry.operation)) await Promise.all([...new Set(selectedPage.entries.filter((r) => r.transport === 'chat').map((r) => r.hostId))].map(async (id) => {
      if (!current.inventory.hosts.some((h) => h.id === id && h.connected)) return;
      try { capabilities.set(id, await service.commanderCapabilities(id)); }
      catch { capabilities.set(id, null); }
    }));
    let detail;
    if (selected && service.commanderInspection) {
      try { detail = await service.commanderInspection(selected); } catch { /* Explicit unknown below. */ }
    }
    const mode = authority();
    const entries = selectedPage.entries.map((row) => {
      const connected = current.inventory.hosts.some((h) => h.id === row.hostId && h.connected);
      const units = current.sessions.filter((u) => u.hostId === row.hostId && u.provider === row.provider && (u.transport || 'terminal') === row.transport && (!sessionKey || u.key === sessionKey));
      const cap = (selected && detail?.capabilities) || capabilities.get(row.hostId)?.find((c) => c.provider === row.provider);
      let status = 'unknown', reason = 'Implemented adapter; repository, tool, target, and revision prerequisites are checked by the operation.';
      if (!entry.available) { status = 'unsupported'; reason = entry.unavailableReason; }
      else if (LOCAL.has(entry.operation)) {
        status = 'supported'; reason = 'Local read/configuration adapter is available; host/provider requirements of the selected payload are checked at validation and apply.';
      } else if (inspection) { status = 'supported'; reason = 'Read-only inspection is available; stale or missing runtime evidence remains explicit and grants no control'; }
      else if (!row.enabled || !connected) { status = 'unavailable'; reason = row.enabled ? 'Host is disconnected' : 'Host is disabled'; }
      else if (['specops.launch', 'specops.control'].includes(entry.operation) && !['codex', 'claude', 'antigravity'].includes(row.provider)) { status = 'unsupported'; reason = 'SPECOPS profiles currently support Codex, Claude, and Antigravity only'; }
      else if (['exercise.create', 'sitrep.handoff'].includes(entry.operation) && row.provider === 'terminal') { status = 'unsupported'; reason = 'This launch requires an agent provider'; }
      else if (['flash.decide', 'fault.interrupt'].includes(entry.operation) && row.provider !== 'claude') { status = 'unsupported'; reason = 'This operation requires the Claude provider hook; use chat.respond for native structured requests'; }
      else if (!policy.transports.includes(row.transport) || (row.provider === 'terminal' && row.transport === 'chat')) { status = 'unsupported'; reason = 'Operation is unavailable for this provider/transport combination'; }
      else if (policy.scope === 'managed_target' && !units.length && !['mission', 'exercise', 'contestant', 'sitrep'].includes(entry.target)) { status = 'unavailable'; reason = 'No eligible active managed unit in this host/provider/transport scope'; }
      else if ((NATIVE.has(entry.operation) || LAUNCH.has(entry.operation)) && row.transport === 'chat') {
        if (!cap || cap.status === 'unverified') { status = 'unknown'; reason = cap?.reason || 'Native provider capabilities could not be verified'; }
        else if (cap.status === 'unsupported') { status = 'unsupported'; reason = cap.reason || 'Native provider integration is unsupported'; }
        else if (policy.nativeCapability === 'approvals_or_questions' ? !cap.approvals && !cap.questions : policy.nativeCapability && !cap[policy.nativeCapability]) { status = 'unsupported'; reason = `Native provider lacks ${policy.nativeCapability}`; }
        else { status = 'supported'; reason = 'Verified native provider adapter; exact parameters, ownership, and pending request are rechecked at dispatch'; }
      } else if (NATIVE.has(entry.operation) && row.transport === 'terminal' && units.length) {
        status = 'supported'; reason = 'Existing managed terminal is eligible for the terminal adapter; delivery does not prove provider completion';
      } else if (LAUNCH.has(entry.operation)) reason = 'Terminal launch is implemented; binary, preset, ROE, worktree, and resource readiness are not proven by inventory';
      else if (['unit.pin', 'unit.rename', 'attention.acknowledge', 'fault.reset', 'devurl.list', 'unit.inspect'].includes(entry.operation) && units.length) {
        status = 'supported'; reason = 'Eligible managed target exists; exact parameters and applicable revision/ownership checks remain required';
      }
      if (entry.operation === 'chat.respond' && selected && status === 'supported') {
        const pending = detail?.pendingRequests?.filter((r) => r.state === 'pending') || [];
        if (!detail?.pendingRequests) { status = 'unknown'; reason = 'Pending structured requests could not be inspected'; }
        else if (!pending.length) { status = 'unavailable'; reason = 'No pending structured request on this target'; }
        else if (!pending.some((r) => r.type === 'approval' ? cap?.approvals : r.type === 'question' && cap?.questions)) { status = 'unsupported'; reason = 'Native capabilities do not support the pending request type'; }
      }
      return { ...row, connected, status, reason, nativeVersion: cap?.version || null,
        nativeFeatures: cap ? Object.fromEntries(['interrupt', 'steering', 'approvals', 'questions'].map((k) => [k, cap[k]])) : null,
        eligibleUnits: units.length, sessionKeys: units.slice(0, 20).map((u) => u.key), sessionKeysTruncated: units.length > 20,
        ownership: selected ? detail?.ownership || { status: 'unknown', reason: 'Control ownership could not be inspected' } : { status: 'unknown', reason: 'Select sessionKey for current controller evidence' },
        approval: entry.classification === 'query' ? 'not_required' : entry.reviewRequired || mode === 'gated' ? 'watch_officer' : 'fresh_binding_and_admission',
      };
    });
    const boundedPage = page(entries, { after, limit });
    return redact({ ...selectedPage, ...boundedPage, total: selectedPage.total, hasMore: selectedPage.hasMore || boundedPage.hasMore, operation: entry.operation, authority: mode, requirements: policy });
  };
}

module.exports = { createSupport, requirements };
