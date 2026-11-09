import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Inventory, Workspace } from '../types';
import { assignCallsigns, situationFor } from '../workspace';
import { Overwatch } from './Overwatch';

const emptyWorkspace: Workspace = { tabs: [], selectedKey: null, splitKey: null, metadata: {} };
export function OverwatchWindowApp() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [error, setError] = useState('');
  useEffect(() => {
    document.title = 'AgentC2 — Overwatch';
    const api = window.agentHQ;
    if (!api) { setError('Open Overwatch from the AgentC2 desktop app.'); return; }
    let cancelled = false, workspaceUpdated = false, inventoryUpdated = false;
    const offInventory = api.onInventory((value) => { inventoryUpdated = true; setInventory(value); });
    const offWorkspace = api.onOverwatchWorkspace((value) => { workspaceUpdated = true; setWorkspace(value); });
    const offDeleted = api.onSessionsDeleted((keys) => setInventory((current) => current ? { ...current, sessions: current.sessions.filter((session) => !keys.includes(session.key)) } : current));
    void Promise.all([api.getState(), api.inventory()]).then(([state, snapshot]) => {
      if (cancelled) return;
      if (!workspaceUpdated) setWorkspace(state.workspace);
      if (!inventoryUpdated) setInventory(snapshot);
    }).catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; offInventory(); offWorkspace(); offDeleted(); };
  }, []);
  const situation = useMemo(() => situationFor(assignCallsigns(workspace, inventory?.sessions || [])), [workspace, inventory]);
  const dock = useCallback(() => { void window.agentHQ?.dockOverwatch().catch((cause) => setError(String(cause))); }, []);
  return <>
    <Overwatch standalone sessions={inventory?.sessions || []} attention={inventory?.attention || []} situation={situation} onSelect={(session) => { void window.agentHQ?.selectOverwatchUnit(session.key).catch((cause) => setError(String(cause))); }} onClose={dock} onDock={dock} />
    {error ? <p className="overwatch-window-error form-error" role="alert">{error}</p> : null}
  </>;
}
