const crypto = require('node:crypto');
const { validateSettings, validateWorkspace, validateSessionPin } = require('./config.cjs');
const kinds = new Set(['host', 'preset', 'roe', 'order', 'cleanup', 'metadata', 'callsign', 'deleted', 'ack']);
const keyFor = (kind, id) => JSON.stringify([kind, id]);
const ackKey = (item) => crypto.createHash('sha256').update(JSON.stringify([item.sessionKey, item.signature || item.id])).digest('hex');
function extract(data) {
  const entries = {};
  const local = new Set(data.settings.hosts.filter((host) => host.kind === 'local').map((host) => host.id));
  const remoteKey = (key) => !local.has(key.split('/')[0]);
  const add = (kind, id, value) => { entries[keyFor(kind, id)] = value; };
  for (const host of data.settings.hosts) if (!local.has(host.id)) add('host', host.id, host);
  for (const preset of data.settings.presets) if (!local.has(preset.hostId)) add('preset', preset.id, preset);
  for (const [id, value] of Object.entries(data.settings.roe?.hostDefaults || {})) if (!local.has(id)) add('roe', id, value);
  for (const order of data.settings.opOrders || []) if (!local.has(order.hostId)) add('order', order.id, order);
  for (const policy of data.settings.cleanup || []) if (!local.has(policy.hostId)) add('cleanup', `${policy.hostId}/${policy.provider}`, policy);
  for (const [id, value] of Object.entries(data.workspace.metadata)) if (remoteKey(id)) add('metadata', id, value);
  for (const [id, value] of Object.entries(data.workspace.situation?.callsigns || {})) if (remoteKey(id)) add('callsign', id, value);
  for (const id of data.deletedSessions) if (remoteKey(id)) add('deleted', id, true);
  for (const item of data.attention) if (item.acknowledged && remoteKey(item.sessionKey)) add('ack', ackKey(item), true);
  return entries;
}
function validateRecords(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records) || Object.keys(records).length > 30000 || Buffer.byteLength(JSON.stringify(records)) > 4_000_000) throw new Error('Peer state exceeds limits');
  for (const [key, row] of Object.entries(records)) {
    const parts = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 2 || !kinds.has(parts[0]) || typeof parts[1] !== 'string' || parts[1].length > 300 || key !== keyFor(...parts) || !row || !Number.isSafeInteger(row.clock) || row.clock < 0 || row.clock > Number.MAX_SAFE_INTEGER - 1000000 || !/^[a-f0-9]{32}$/.test(row.peer || '') || typeof row.deleted !== 'boolean') throw new Error('Invalid peer revision');
    const [kind, id] = parts;
    if (['metadata', 'callsign', 'deleted'].includes(kind)) validateSessionPin(id, false);
    if (['host', 'preset', 'roe', 'order'].includes(kind) && !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid shared entity ID');
    if (['deleted', 'ack'].includes(kind) && (row.deleted || row.value !== true)) throw new Error('Invalid monotonic peer state');
    if (kind === 'ack' && !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid acknowledgement');
    if (!row.deleted && ['host', 'preset', 'order'].includes(kind) && row.value?.id !== id) throw new Error('Peer entity ID mismatch');
    if (kind === 'host' && !row.deleted && row.value.kind === 'local') throw new Error('Local hosts cannot be shared');
  }
  return records;
}
function mergeRecords(current, incoming) {
  validateRecords(incoming);
  const next = { ...current };
  for (const [key, row] of Object.entries(incoming)) {
    const old = next[key];
    if (!old || row.clock > old.clock || row.clock === old.clock && row.peer > old.peer) next[key] = row;
    else if (row.clock === old.clock && row.peer === old.peer && JSON.stringify(row) !== JSON.stringify(old)) throw new Error('Conflicting peer revision');
  }
  return validateRecords(next);
}
function project(data, records) {
  const settings = structuredClone(data.settings), workspace = structuredClone(data.workspace);
  const local = new Set(settings.hosts.filter((host) => host.kind === 'local').map((host) => host.id));
  const rows = (kind) => Object.entries(records).filter(([key, row]) => JSON.parse(key)[0] === kind && !row.deleted).map(([key, row]) => [JSON.parse(key)[1], row.value]);
  const remotes = rows('host').map(([, value]) => value);
  if (remotes.some((host) => local.has(host.id))) throw new Error('A shared host ID conflicts with this computer’s local host. Rename the local host ID before syncing.');
  settings.hosts = [...settings.hosts.filter((host) => local.has(host.id)), ...remotes];
  const hosts = new Set(settings.hosts.map((host) => host.id));
  const shared = (kind, existing, getId) => {
    const own = existing.filter((item) => local.has(item.hostId));
    const ids = new Set(own.map(getId));
    const incoming = rows(kind).map(([, value]) => value).filter((item) => !item.hostId || hosts.has(item.hostId) && !local.has(item.hostId));
    if (incoming.some((item) => ids.has(getId(item)))) throw new Error('A shared configuration ID conflicts with local settings');
    return [...own, ...incoming];
  };
  settings.presets = shared('preset', settings.presets, (item) => item.id);
  settings.opOrders = shared('order', settings.opOrders || [], (item) => item.id);
  settings.cleanup = shared('cleanup', settings.cleanup || [], (item) => `${item.hostId}/${item.provider}`);
  settings.roe = { version: 1, hostDefaults: Object.fromEntries([...Object.entries(settings.roe?.hostDefaults || {}).filter(([id]) => local.has(id)), ...rows('roe').filter(([id]) => hosts.has(id) && !local.has(id))]) };
  const deleted = new Set([...data.deletedSessions, ...rows('deleted').map(([id]) => id).filter((id) => !local.has(id.split('/')[0]))]);
  const localEntries = (object) => Object.entries(object || {}).filter(([id]) => local.has(id.split('/')[0]));
  workspace.metadata = Object.fromEntries([...localEntries(workspace.metadata), ...rows('metadata').filter(([id]) => !local.has(id.split('/')[0]) && !deleted.has(id))]);
  const callsigns = {}, used = new Set();
  // Concurrent allocations can request the same callsign. Assign shared units in a stable key order so every peer converges.
  for (const [id, requested] of [...rows('callsign').filter(([id]) => !local.has(id.split('/')[0]) && !deleted.has(id)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), ...localEntries(workspace.situation?.callsigns)]) {
    if (typeof requested !== 'string' || !/^(0[1-9]|[1-9][0-9])$/.test(requested)) throw new Error('Invalid shared callsign');
    const value = !used.has(requested) ? requested : Array.from({ length: 99 }, (_, n) => String(n + 1).padStart(2, '0')).find((value) => !used.has(value));
    if (value) { callsigns[id] = value; used.add(value); }
  }
  workspace.situation = { ...workspace.situation, callsigns };
  workspace.tabs = workspace.tabs.filter((id) => !deleted.has(id));
  for (const field of ['selectedKey', 'splitKey']) if (deleted.has(workspace[field])) workspace[field] = null;
  for (const field of ['anchorKey', 'targetKey']) if (deleted.has(workspace.situation[field])) workspace.situation[field] = null;
  const acknowledged = new Set(rows('ack').map(([id]) => id));
  const attention = data.attention.filter((item) => !deleted.has(item.sessionKey)).map((item) => acknowledged.has(ackKey(item)) ? { ...item, acknowledged: true } : item);
  return { settings: validateSettings(settings), workspace: validateWorkspace(workspace), deletedSessions: [...deleted], attention };
}
module.exports = { extract, project, mergeRecords, validateRecords, keyFor, ackKey };
