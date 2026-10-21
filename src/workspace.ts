import type { AttentionItem, Session, SessionMetadata, SituationWorkspace, Workspace } from './types';

export const emptyMetadata: SessionMetadata = { pinned: false, project: '', notes: '' };
export function projectFor(session: Session, metadata: Record<string, SessionMetadata>) {
  return metadata[session.key]?.project || session.cwd || 'Ungrouped';
}

export function situationFor(workspace: Workspace): SituationWorkspace {
  return workspace.situation || { version: 1, anchorKey: workspace.selectedKey, targetKey: workspace.splitKey, focusedPane: 'anchor', callsigns: {}, groupBy: 'host', collapsedGroups: [], urgentFirst: false, rosterCollapsed: false, zen: false, ligatures: false, shortcuts: {}, missionStartedAt: Date.now() };
}

export function updateSituation(workspace: Workspace, patch: Partial<SituationWorkspace>): Workspace {
  const situation = { ...situationFor(workspace), ...patch };
  if (situation.anchorKey && !workspace.tabs.includes(situation.anchorKey)) situation.anchorKey = null;
  if (situation.targetKey && (!workspace.tabs.includes(situation.targetKey) || situation.targetKey === situation.anchorKey)) situation.targetKey = null;
  if (situation.focusedPane === 'anchor' && !situation.anchorKey && situation.targetKey) situation.focusedPane = 'target';
  if (situation.focusedPane === 'target' && !situation.targetKey) situation.focusedPane = 'anchor';
  return { ...workspace, situation, selectedKey: situation.focusedPane === 'anchor' ? situation.anchorKey : situation.targetKey, splitKey: situation.focusedPane === 'anchor' ? situation.targetKey : situation.anchorKey };
}

export function assignCallsigns(workspace: Workspace, sessions: Session[]): Workspace {
  const current = situationFor(workspace).callsigns;
  const used = new Set(Object.values(current));
  const callsigns = { ...current };
  for (const session of sessions.filter((item) => item.kind !== 'conversation').sort((a, b) => a.key.localeCompare(b.key))) {
    if (callsigns[session.key]) continue;
    const available = Array.from({ length: 99 }, (_, index) => String(index + 1).padStart(2, '0')).find((value) => !used.has(value));
    if (!available) break;
    callsigns[session.key] = available; used.add(available);
  }
  return Object.keys(callsigns).length === Object.keys(current).length ? workspace : updateSituation(workspace, { callsigns });
}

export function openInPane(workspace: Workspace, key: string, pane: 'anchor' | 'target' = 'target'): Workspace {
  const situation = situationFor(workspace);
  const tabs = workspace.tabs.includes(key) ? workspace.tabs : [...workspace.tabs, key];
  // The anchor must never fall out of the tab limit while inspecting targets.
  while (tabs.length > 40) { const index = tabs.findIndex((item) => item !== situation.anchorKey && item !== key); tabs.splice(index, 1); }
  if (key === situation.anchorKey) return updateSituation({ ...workspace, tabs }, { focusedPane: 'anchor' });
  if (!situation.anchorKey && !situation.targetKey) pane = 'anchor';
  return updateSituation({ ...workspace, tabs }, { [pane === 'anchor' ? 'anchorKey' : 'targetKey']: key, focusedPane: pane });
}

export function closeWorkspaceTab(workspace: Workspace, key: string): Workspace {
  const situation = situationFor(workspace);
  const tabs = workspace.tabs.filter((item) => item !== key);
  const anchorKey = situation.anchorKey === key ? situation.targetKey || tabs.at(-1) || null : situation.anchorKey;
  const targetKey = situation.targetKey === key || situation.anchorKey === key ? null : situation.targetKey;
  return updateSituation({ ...workspace, tabs }, { anchorKey, targetKey, focusedPane: situation.focusedPane });
}

export function unitState(session: Session, attention: AttentionItem[]) {
  if (session.stale || session.missing) return { code: 'UNKNOWN', label: 'Last known state; host unavailable', tone: 'unknown', priority: 3 };
  if (session.activity === 'fault' || session.exitCode != null && session.exitCode !== 0) return { code: 'FAULT', label: 'Confirmed process or provider failure', tone: 'fault', priority: 0 };
  if (session.activity === 'halted' || session.state === 'blocked' || attention.some((item) => item.sessionKey === session.key && item.kind === 'input' && item.confidence === 'confirmed' && !item.acknowledged)) return { code: 'HALT', label: 'Confirmed request for input', tone: 'halt', priority: 1 };
  if (session.activity === 'engaged') return { code: 'ENG', label: 'Confirmed agent execution', tone: 'nominal', priority: 2 };
  if (session.activity === 'idle' || session.kind === 'conversation' || session.state === 'exited') return { code: 'STBY', label: 'Saved, idle, or exited', tone: 'standby', priority: 4 };
  return { code: 'LIVE', label: 'Process running; task activity is unreported', tone: 'nominal', priority: 2 };
}
