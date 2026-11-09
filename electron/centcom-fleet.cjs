// One operational boundary for context, alerts, queries, and action targets.
function commanderIdentity(session) {
  return session && {
    hostId: session.hostId,
    name: session.name,
    key: session.key || `${session.hostId}/tmux:${session.name}`,
    chatSessionId: session.chatSessionId,
  };
}

function isCommanderSession(session, commanders = []) {
  return commanders.some((c) => c.hostId === session.hostId &&
    ((c.key && c.key === session.key) || (c.name && c.name === (session.id || session.name)) || (c.chatSessionId && c.chatSessionId === session.chatSessionId))) ||
    // Older installations did not persist every commander identity. This is a
    // display-only fallback, never authority to stop an unregistered session.
    ((session.managed === true && session.transport === 'chat' || session.kind === 'conversation') && /^CENTCOM \/\//.test(session.title || '') &&
      /(?:^|\/)\.cache\/agentc2\/centcom\/?$/.test((session.cwd || '').replace(/\\/g, '/')));
}

function rosterInventory(inventory, commanders = []) {
  const hidden = new Set([...(inventory.internalSessionKeys || []), ...commanders.map((c) => c.key).filter(Boolean)]);
  for (const session of inventory.sessions || []) if (isCommanderSession(session, commanders)) hidden.add(session.key);
  return { ...inventory, internalSessionKeys: [...hidden],
    sessions: (inventory.sessions || []).filter((s) => !hidden.has(s.key)),
    attention: (inventory.attention || []).filter((item) => !hidden.has(item.sessionKey)),
    faults: (inventory.faults || []).filter((item) => !hidden.has(item.sessionKey)) };
}

function activeFleet(inventory, deleted = [], commanders = []) {
  const tombstones = new Set(deleted);
  const connected = new Set((inventory?.hosts || []).filter((h) => h.connected).map((h) => h.id));
  const sessions = (inventory?.sessions || []).filter((s) =>
    s.kind === 'managed' && s.managed === true && typeof s.key === 'string' &&
    /^[A-Za-z0-9_-]{1,80}\/tmux:hq-[a-f0-9]{12}$/.test(s.key) &&
    s.key === `${s.hostId}/tmux:${s.id || s.name}` &&
    ['live', 'waiting', 'waiting_for_input', 'blocked', 'requires_action'].includes(s.state) &&
    !['stopped', 'failed', 'unknown', 'starting'].includes(s.chatState) &&
    connected.has(s.hostId) && !s.stale && !s.missing && !tombstones.has(s.key) &&
    !isCommanderSession(s, commanders));
  const keys = new Set(sessions.map((s) => s.key));
  const identities = new Map(sessions.flatMap((s) => [s.key, s.id, s.name, s.chatSessionId, s.providerSessionId].filter(Boolean).map((id) => [`${s.hostId}/${id}`, s])));
  const find = (value, hostId) => sessions.find((s) => s.key === value && (!hostId || s.hostId === hostId)) || (hostId ? identities.get(`${hostId}/${value}`) : sessions.find((s) => [s.id, s.name, s.chatSessionId, s.providerSessionId].includes(value)));
  const excluded = [...deleted.map((key) => ({ key, name: key.includes('/tmux:') ? key.split('/tmux:')[1] : undefined })), ...(inventory?.sessions || []).filter((s) => !keys.has(s.key)), ...commanders];
  const secrets = [...new Set(excluded.flatMap((s) => [s.key, s.id, s.name, s.chatSessionId, s.providerSessionId]).filter((s) => typeof s === 'string' && s.length > 3))];
  // Also reject identity references absent from inventory (saved operation records
  // can outlive both the session and the host's cache).
  const clean = (value, hostId) => {
    if (typeof value === 'string') {
      let result = value;
      for (const id of secrets) result = result.split(id).join('[Excluded session]');
      return result.replace(/(?<![\w-])[\w-]+\/tmux:[\w-]+|\bhq-[a-f0-9]{12}\b|\bchat-[a-f0-9]{32}\b/g,
        (id) => find(id, hostId) ? id : '[Excluded session]');
    }
    if (Array.isArray(value)) return value.map((v) => clean(v, hostId)).filter((v) => v !== undefined);
    if (!value || typeof value !== 'object') return value;
    const host = value.hostId || hostId;
    const refs = [value.sessionKey, value.chatSessionId, value.sessionId, value.providerSessionId,
      typeof value.key === 'string' && value.key.includes('/tmux:') ? value.key : null,
      typeof value.name === 'string' && value.name.startsWith('hq-') ? value.name : null].filter(Boolean);
    if (refs.some((ref) => !find(ref, host))) return undefined;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, host)]).filter(([, v]) => v !== undefined));
  };
  const filterRefs = (items) => (items || []).filter((v) => keys.has(v.sessionKey)).map((v) => clean(v)).filter(Boolean);
  const filtered = inventory && {
    ...inventory, sessions,
    attention: filterRefs(inventory.attention), faults: filterRefs(inventory.faults),
    conflicts: clean(inventory.conflicts || []), missions: clean(inventory.missions || []),
  };
  return { sessions, keys, find, clean, inventory: filtered,
    flash: (items) => (items || []).filter((f) => f.connected && find(f.name, f.hostId)).map((f) => clean(f)).filter(Boolean) };
}

module.exports = { activeFleet, commanderIdentity, rosterInventory };
