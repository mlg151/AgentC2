import type { FlashRequest, Inventory } from './types';

export interface FleetReadiness {
  level: 1 | 2 | 3 | 4 | 5 | null;
  label: string;
  reasons: { source: string; detail: string; at?: string }[];
  uncertain: boolean;
  active: number;
  observed: number;
  costUsd: number | null;
  totalTokens: number | null;
  costPartial: boolean;
  tokensPartial: boolean;
  sampledAt: string | null;
}

const recent = (value: string | null | undefined, now: number, span = 120000) => {
  const at = Date.parse(value || '');
  return Number.isFinite(at) && at <= now + 60000 && now - at <= span;
};

export function fleetReadiness(inventory: Inventory | null, requests: FlashRequest[], now = Date.now()): FleetReadiness {
  if (!inventory) return { level: null, label: 'Evidence unavailable', reasons: [{ source: 'Fleet', detail: 'Waiting for the first SSH inventory' }], uncertain: true, active: 0, observed: 0, costUsd: null, totalTokens: null, costPartial: true, tokensPartial: true, sampledAt: null };
  const units = inventory.sessions.filter((item) => item.kind === 'managed' && item.provider !== 'terminal');
  const sources = new Map<string, { source: string; detail: string; at?: string }[]>();
  const add = (key: string, source: string, detail: string, at?: string) => sources.set(key, [...(sources.get(key) || []), { source, detail, at }]);
  let unknown = false, active = 0, idle = 0;
  for (const host of inventory.hosts) {
    if (!host.connected) {
      if (units.some((unit) => unit.hostId === host.id && unit.state === 'live')) add('transport', host.name, 'SSH inventory is disconnected while a managed unit was last seen live');
      else { unknown = true; add('unknown', host.name, 'SSH inventory is disconnected'); }
    }
  }
  for (const fault of inventory.faults || []) add('fault', fault.sessionKey, `${fault.detail}; ${fault.status}`, fault.at);
  for (const conflict of inventory.conflicts || []) add('fault', conflict.hostId, `OpOrder ${conflict.id}: ${conflict.detail}`, conflict.at);
  for (const request of requests) if (request.state === 'pending') {
    if (request.connected) add('approval', `${request.hostName}/${request.name}`, `${request.tool} permission decision pending`, new Date(request.createdAt * 1000).toISOString());
    else { unknown = true; add('unknown', `${request.hostName}/${request.name}`, 'Last known permission request is disconnected'); }
  }
  for (const item of inventory.attention) {
    if (!item.acknowledged && item.kind === 'input' && item.confidence === 'confirmed' && !item.requestId) {
      const target = inventory.sessions.find((session) => session.key === item.sessionKey);
      if (target?.state === 'live' && !target.stale) add('approval', item.title, item.detail, item.createdAt);
      else { unknown = true; add('unknown', item.title, 'Unreviewed input alert has no connected live target', item.createdAt); }
    }
    if (!item.acknowledged && item.kind === 'failed' && !item.signature?.startsWith('loop:')) { unknown = true; add('unknown', item.title, 'Unreviewed confirmed failure alert', item.createdAt); }
  }
  for (const unit of units) {
    if (unit.stale || unit.missing) { unknown = true; continue; }
    if (unit.state !== 'live') { idle++; continue; }
    const latest = unit.events?.at(-1);
    if (latest && ['working', 'tool_ok', 'tool_failed'].includes(latest.kind) && recent(latest.at, now)) {
      active++;
      add('active', unit.title, `Provider ${latest.kind.replace('_', ' ')} event`, latest.at);
    } else if (latest && ['completed', 'failed'].includes(latest.kind)) idle++;
    else { unknown = true; add('unknown', unit.title, 'Live process has no recent confirmed execution or idle event'); }
  }
  const level: FleetReadiness['level'] = sources.has('transport') ? 1 : sources.has('fault') ? 2 : sources.has('approval') ? 3 : active ? 4 : !unknown && units.length && idle === units.length ? 5 : null;
  const label = level === null ? 'Evidence incomplete' : ['','Transport alert','Confirmed fault','Decision pending','Active execution','Observed idle'][level];
  const selected = level === 1 ? 'transport' : level === 2 ? 'fault' : level === 3 ? 'approval' : level === 4 ? 'active' : level === 5 ? '' : 'unknown';
  const reasons = selected ? (sources.get(selected) || []).slice(0, 20) : [{ source: 'Fleet', detail: 'All observed managed units have completed or exited; no open confirmed alerts' }];
  const unique = new Set<string>();
  let cost = 0, tokens = 0, costCount = 0, tokenCount = 0, total = 0;
  let newest: string | null = null;
  for (const unit of units.slice(0, 1000)) {
    const identity = `${unit.hostId}/${unit.provider}/${unit.providerSessionId || unit.key}`;
    if (unique.has(identity)) continue;
    unique.add(identity); total++;
    const metric = unit.telemetry;
    if (metric?.status !== 'reported' || !recent(metric.sampledAt, now)) continue;
    if (metric.sampledAt && (!newest || metric.sampledAt > newest)) newest = metric.sampledAt;
    if (typeof metric.costUsd === 'number' && Number.isFinite(metric.costUsd) && metric.costUsd >= 0) { cost += metric.costUsd; costCount++; }
    if (typeof metric.totalTokens === 'number' && Number.isFinite(metric.totalTokens) && metric.totalTokens >= 0) { tokens += metric.totalTokens; tokenCount++; }
  }
  return { level, label, reasons, uncertain: unknown || inventory.hosts.some((host) => !host.connected), active, observed: units.length, costUsd: costCount ? cost : null, totalTokens: tokenCount ? tokens : null, costPartial: costCount !== total || units.length > 1000, tokensPartial: tokenCount !== total || units.length > 1000, sampledAt: newest };
}

export function elapsedClock(startedAt: number | string | null | undefined, now = Date.now()): string {
  const start = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  if (!start || !Number.isFinite(start) || start > now) return '—';
  const seconds = Math.floor((now - start) / 1000);
  const hours = Math.floor(seconds / 3600);
  return `${hours.toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
