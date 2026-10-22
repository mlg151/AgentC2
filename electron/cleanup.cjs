const crypto = require('node:crypto');

const PROVIDERS = ['codex', 'claude', 'antigravity', 'opencode'];
const DAY = 86_400_000;

function createCleanup({ store, events, inventory, runRemote, hostId }) {
  const previews = new Map();
  const launches = new Map();
  const deleting = new Set();
  let busy = false;
  let scheduled = false;

  function beginLaunch(id) {
    if (busy) throw new Error('Wait for history cleanup before starting or resuming a session');
    launches.set(id, (launches.get(id) || 0) + 1);
    return () => { const count = launches.get(id) - 1; if (count) launches.set(id, count); else launches.delete(id); };
  }
  function validate(input) {
    if (!input || !PROVIDERS.includes(input.provider)) throw new Error('Choose a history provider');
    const id = hostId(input.hostId);
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 36500) throw new Error('Choose an age between 1 and 36500 days');
    if (input.ids !== undefined && (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 50 || input.ids.some((value) => typeof value !== 'string' || !/^[a-zA-Z0-9_-]{6,100}$/.test(value)))) throw new Error('Choose up to 50 saved conversations');
    if (input.allowPinned !== undefined && typeof input.allowPinned !== 'boolean') throw new Error('Invalid pinned history override');
    return { hostId: id, provider: input.provider, days: input.days, ids: input.ids ? [...new Set(input.ids)] : undefined, allowPinned: input.allowPinned === true };
  }
  async function preview(input) {
    const options = validate(input);
    const host = store.data.settings.hosts.find((item) => item.id === options.hostId);
    const connection = JSON.stringify([host.target, host.port]);
    if (busy || launches.size) throw new Error('Wait for session launches or cleanup to finish');
    const snapshot = await inventory();
    if (!snapshot.hosts.some((host) => host.id === options.hostId && host.connected)) throw new Error('Host unavailable; no history was selected for deletion');
    const sessions = snapshot.sessions.filter((session) => session.hostId === options.hostId && session.provider === options.provider && session.kind === 'conversation' && !session.stale);
    const cutoff = Date.now() - options.days * DAY;
    const candidates = options.ids ? options.ids : sessions.filter((session) => !Number.isFinite(Date.parse(session.updatedAt)) || Date.parse(session.updatedAt) <= cutoff).slice(0, 50).map((session) => session.id);
    const result = await runRemote({ action: 'cleanup_preview', provider: options.provider, ids: candidates }, options.hostId);
    const items = result.items.map((item) => {
      const key = `${options.hostId}/${options.provider}:${item.id}`;
      const session = sessions.find((entry) => entry.id === item.id);
      let reason = item.reason;
      if (!reason && (store.data.workspace.metadata[key]?.pinned || item.providerPinned) && !options.allowPinned) reason = 'Pinned history is protected';
      if (!reason && (!item.updatedAt || !Number.isFinite(Date.parse(item.updatedAt))) && !item.missing) reason = 'Last activity is unknown';
      if (!reason && !options.ids && (!item.updatedAt || Date.parse(item.updatedAt) > cutoff)) reason = 'History is newer than the retention cutoff or has no known activity';
      return { ...item, key, title: session?.title || item.id, eligible: item.eligible && !reason, reason };
    });
    const token = crypto.randomUUID();
    for (const [key, entry] of previews) if (entry.expiresAt < Date.now()) previews.delete(key);
    if (previews.size >= 30) previews.delete(previews.keys().next().value);
    const entry = { token, ...options, connection, items, expiresAt: Date.now() + 5 * 60_000, truncated: !options.ids && sessions.filter((session) => !Number.isFinite(Date.parse(session.updatedAt)) || Date.parse(session.updatedAt) <= cutoff).length > 50 };
    previews.set(token, entry);
    return entry;
  }
  function record(results, operationId) {
    const state = store.data.cleanupState;
    store.save('cleanupState', { ...state, results: [...results, ...state.results.filter((item) => !operationId || item.operationId !== operationId)].slice(0, 100) });
    events.emit('state:updated');
    return store.data.cleanupState;
  }
  async function execute(token, keys, automatic = false) {
    const entry = previews.get(token);
    if (!entry || entry.expiresAt < Date.now()) throw new Error('Cleanup preview expired; preview again');
    if (!Array.isArray(keys) || !keys.length || keys.length > 50 || new Set(keys).size !== keys.length || keys.some((key) => !entry.items.some((item) => item.key === key && item.eligible))) throw new Error('Choose eligible histories from this preview');
    if (busy || launches.size) throw new Error('Wait for session launches or cleanup to finish');
    hostId(entry.hostId);
    const host = store.data.settings.hosts.find((item) => item.id === entry.hostId);
    if (entry.connection !== JSON.stringify([host.target, host.port])) throw new Error('Host connection changed; preview again');
    previews.delete(token); // A timed-out mutation must never be blindly replayed.
    busy = true;
    const at = new Date().toISOString();
    const operationId = crypto.randomUUID();
    let results;
    try {
      const items = keys.map((key) => entry.items.find((item) => item.key === key));
      const excluded = [], eligible = [];
      for (const item of items) {
        if ((store.data.workspace.metadata[item.key]?.pinned || item.providerPinned) && (automatic || !entry.allowPinned)) excluded.push({ key: item.key, status: 'excluded', detail: 'History was pinned after preview' });
        else { eligible.push(item); deleting.add(item.key); }
      }
      let removed = [];
      if (eligible.length) {
        record(eligible.map((item) => ({ key: item.key, at, hostId: entry.hostId, provider: entry.provider, automatic, operationId, status: 'unknown', detail: 'Deletion is in progress or was interrupted. Refresh and preview remaining history before retrying' })));
        try {
          const response = await runRemote({ action: 'cleanup_delete', provider: entry.provider, items: eligible.map(({ id, fingerprint }) => ({ id, fingerprint })) }, entry.hostId);
          removed = eligible.map((item) => {
            const outcome = response.items.find((result) => result.id === item.id);
            return { key: item.key, status: outcome?.status || 'unknown', detail: outcome?.detail || 'Deletion outcome is unknown; refresh and preview before retrying', bytes: outcome?.bytes, estimated: outcome?.estimated };
          });
        } catch {
          removed = eligible.map((item) => ({ key: item.key, status: 'unknown', detail: 'SSH outcome is unknown. Refresh inventory and preview remaining history; no action was replayed' }));
        }
      }
      results = [...excluded, ...removed].map((result) => ({ ...result, at, hostId: entry.hostId, provider: entry.provider, automatic, operationId }));
      const confirmed = results.filter((item) => ['deleted', 'missing'].includes(item.status)).map((item) => item.key);
      if (confirmed.length) {
        store.forgetSessions(confirmed);
        events.emit('sessions:deleted', confirmed);
      }
      record(results, operationId);
    } finally { busy = false; deleting.clear(); }
    await inventory().catch(() => {});
    return results;
  }
  async function runDue() {
    if (scheduled || busy || launches.size) return;
    scheduled = true;
    try {
      for (const policy of store.data.settings.cleanup || []) {
        const scope = `${policy.hostId}/${policy.provider}`;
        if (!policy.enabled || !store.data.settings.hosts.some((host) => host.id === policy.hostId && host.enabled) || Date.now() - (Date.parse(store.data.cleanupState.lastRuns[scope]) || 0) < DAY) continue;
        // Persist before dispatch: one bounded catch-up per day after restart,
        // including failed/unreachable hosts. Never replay an uncertain action.
        store.save('cleanupState', { ...store.data.cleanupState, lastRuns: { ...store.data.cleanupState.lastRuns, [scope]: new Date().toISOString() } });
        try {
          const entry = await preview({ ...policy, allowPinned: false });
          const current = store.data.settings.cleanup?.find((item) => `${item.hostId}/${item.provider}` === scope);
          if (!current?.enabled || current.days !== policy.days) continue;
          const keys = entry.items.filter((item) => item.eligible).map((item) => item.key);
          if (keys.length) await execute(entry.token, keys, true);
          else record([{ at: new Date().toISOString(), hostId: policy.hostId, provider: policy.provider, status: 'skipped', detail: entry.items.length ? entry.items[0].reason || 'No eligible history' : 'No history past the retention cutoff', automatic: true }]);
        } catch {
          record([{ at: new Date().toISOString(), hostId: policy.hostId, provider: policy.provider, status: 'failed', detail: 'Automatic cleanup could not verify the host or histories. Review a manual preview', automatic: true }]);
        }
      }
    } finally { scheduled = false; }
  }
  return { preview, execute, runDue, beginLaunch, isBusy: () => busy, isDeleting: (key) => deleting.has(key), state: () => store.data.cleanupState };
}
module.exports = { createCleanup };
