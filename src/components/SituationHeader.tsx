import { useEffect, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, TerminalSquare } from 'lucide-react';
import type { HostConfig, Inventory } from '../types';

export function SituationHeader({ inventory, hosts, hostFilter, onHostFilter, onSearch, onSettings, onNew, collapsed, onToggleRoster }: { inventory: Inventory | null; hosts: HostConfig[]; hostFilter: string; onHostFilter: (id: string) => void; onSearch: () => void; onSettings: () => void; onNew: () => void; collapsed: boolean; onToggleRoster: () => void }) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(timer); }, []);
  return <header className="topbar situation-header">
    <button className="icon-button" title={collapsed ? 'Show ORBAT roster' : 'Collapse ORBAT roster'} aria-label={collapsed ? 'Show ORBAT roster' : 'Collapse ORBAT roster'} onClick={onToggleRoster}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
    <div className="brand"><TerminalSquare size={24} /><span>AGENTC2</span></div><span className="theater-label">SITUATION ROOM</span><span className="theater-count">{inventory ? `${inventory.hosts.filter((host) => host.connected).length}/${inventory.hosts.length}` : '—'} THEATERS</span>
    <div className="topbar-actions"><button className="quick-trigger" aria-label="Search units, hosts, and repositories" onClick={onSearch}><Search size={14} />Search units, hosts, repos… <kbd>⌘ / Ctrl K</kbd></button><label className="host-picker">Theater<select aria-label="Filter SSH host" value={hostFilter} onChange={(event) => onHostFilter(event.target.value)}><option value="all">All theaters</option>{hosts.filter((host) => host.enabled).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label><time className="mission-clock" dateTime={clock.toISOString()} title="UTC / Zulu time">UTC {clock.toISOString().slice(11, 19)}</time><button className="icon-button" aria-label="Settings" title="Settings" onClick={onSettings}><Settings size={18} /></button><button className="button-primary new-unit" onClick={onNew}><Plus size={16} />New unit</button></div>
  </header>;
}
