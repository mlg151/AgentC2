import { useCallback, useEffect, useRef, useState } from 'react';
import { Anchor, ChevronLeft, ChevronRight, ExternalLink, Link2Off, Play, Square, TerminalSquare, Trash2, Zap } from 'lucide-react';
import { TerminalView } from './TerminalView';
import { DiffDrawer } from './DiffDrawer';
import type { DevUrl, Session } from '../types';

export function SessionPane({ session, visible, primary, focused, slot, callsign, diffOpen, onToggleDiff, onFocus, onAnchor, onCycle, onResume, onRefresh, onDeleteHistory }: { session: Session; visible: boolean; primary: boolean; focused: boolean; slot: 'anchor' | 'target'; callsign?: string; diffOpen: boolean; onToggleDiff: () => void; onFocus: () => void; onAnchor: () => void; onCycle: (direction: number) => void; onResume: (s: Session) => void; onRefresh: () => void; onDeleteHistory: (session: Session) => void }) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [wanted, setWanted] = useState(Boolean(session.canAttach));
  const [attempt, setAttempt] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [devUrls, setDevUrls] = useState<DevUrl[]>([]);
  const idRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || !session.canAttach || !window.agentHQ) return;
    let cancelled = false;
    let connection: string | null = null;
    setConnecting(true); setError('');
    void window.agentHQ.openTerminal(session.id, 100, 32, session.hostId).then((id) => {
      connection = id;
      if (cancelled) { void window.agentHQ?.closeTerminal(id); return; }
      idRef.current = id; setTerminalId(id); setConnecting(false);
    }).catch((cause) => { if (!cancelled) { setConnecting(false); setError(String(cause)); } });
    return () => {
      cancelled = true;
      if (connection) void window.agentHQ?.closeTerminal(connection);
      idRef.current = null; setTerminalId(null);
    };
  }, [wanted, attempt, session.id, session.hostId, session.canAttach]);
  useEffect(() => {
    // An initial attach can fail while a cached host is offline. Retry only
    // when fresh inventory confirms that the host is reachable again.
    if (!session.stale && wanted && !terminalId && error) setAttempt((value) => value + 1);
  }, [session.stale]);
  useEffect(() => window.agentHQ?.onTerminalExit((id, code) => {
    if (id !== idRef.current) return;
    idRef.current = null; setTerminalId(null); setWanted(false);
    void window.agentHQ?.closeTerminal(id);
    setError(`Terminal connection closed (${code}). Reattach to reconnect.`);
  }), []);
  useEffect(() => {
    let cancelled = false;
    void window.agentHQ?.devUrls(session.key).then((urls) => { if (!cancelled) setDevUrls(urls); }).catch(() => {});
    const off = window.agentHQ?.onDevUrls((key, urls) => { if (key === session.key && !cancelled) setDevUrls(urls); });
    return () => { cancelled = true; off?.(); };
  }, [session.key]);
  const showError = useCallback((cause: unknown) => setError(String(cause)), []);
  async function stop() {
    if (!window.confirm(`Stop “${session.title}” on ${session.hostName}? This ends the session process and removes its tmux session.`)) return;
    setBusy(true);
    try { await window.agentHQ?.stop(session.id, session.hostId); setWanted(false); onRefresh(); }
    catch (cause) { showError(cause); } finally { setBusy(false); }
  }
  return <section data-session-key={session.key} data-viewport={slot} onFocusCapture={onFocus} onPointerDownCapture={onFocus} style={{ order: primary ? 0 : 1 }} className={`session-pane${focused ? ' is-focused' : ''}${visible ? '' : ' pane-hidden'}`} aria-label={`Session ${session.title}`}>
    <div className="viewport-heading"><span className="viewport-letter">{primary ? 'A' : 'B'}</span><strong>{primary ? 'PINNED ANCHOR' : 'CYCLING TARGET'}</strong><span className="viewport-callsign">{callsign || '—'}</span><div className="viewport-actions">{!primary ? <><button aria-label="Previous target unit" title="Previous target unit" onClick={() => onCycle(-1)}><ChevronLeft size={14} /></button><button aria-label="Next target unit" title="Next target unit" onClick={() => onCycle(1)}><ChevronRight size={14} /></button></> : null}<button onClick={onAnchor} title={primary ? 'Release the pinned anchor' : 'Swap this target into Pane A'}><Anchor size={13} />{primary ? 'Unpin anchor' : 'Pin to A'}</button></div></div>
    <div className="pane-heading"><div><strong title={session.title}>{session.title}</strong><small>{session.hostName} · {session.provider} · {session.cwd || 'Working directory unavailable'}</small></div><span className={session.stale ? 'danger-text' : ''}>{session.missing ? 'Session unavailable' : session.stale ? 'Host unavailable' : session.state === 'exited' ? `Exited (${session.exitCode ?? '?'})` : terminalId ? 'Attached' : session.kind}</span></div>
    <div className="toolbar">
      {session.canAttach ? <button className="button-primary" disabled={busy || Boolean(terminalId) || connecting || session.stale} onClick={() => { setWanted(true); setAttempt((a) => a + 1); }}><TerminalSquare size={15} />{connecting ? 'Attaching…' : 'Attach'}</button> : null}
      {session.canResume ? <button className="button-primary" disabled={session.stale || busy} onClick={() => onResume(session)}><Play size={15} />Resume</button> : null}
      {session.kind === 'conversation' ? <button className="toolbar-button danger" disabled={session.stale || busy} onClick={() => onDeleteHistory(session)}><Trash2 size={14} />Delete history</button> : null}
      {session.canInterrupt ? <button className="toolbar-button" disabled={session.stale || busy} onClick={() => void window.agentHQ?.interrupt(session.id, session.hostId).catch(showError)}><Zap size={15} />Interrupt</button> : null}
      {session.canAttach ? <button className="toolbar-button" disabled={!terminalId || busy} onClick={() => setWanted(false)}><Link2Off size={15} />Detach</button> : null}
      {session.canStop ? <button className="toolbar-button danger" disabled={session.stale || busy} onClick={() => void stop()}><Square size={14} />Stop</button> : null}
      {session.worktreeOperation ? <button className="toolbar-button" aria-pressed={diffOpen} onClick={onToggleDiff}>{diffOpen ? 'Hide diff' : 'Diff'}</button> : null}
      {devUrls.map((item) => <button key={item.url} className="toolbar-button" title={`${item.url}${item.error ? ` — ${item.error}` : ''}`} disabled={!terminalId || session.stale || item.status === 'opening'} onClick={() => void window.agentHQ?.openDevUrl(terminalId!, item.url).catch(showError)}><ExternalLink size={13} />{item.status === 'ready' ? 'Open' : item.status === 'opening' ? 'Opening' : item.status === 'failed' ? 'Retry' : 'Tunnel'} :{item.port}</button>)}
    </div>
    {session.provider !== 'terminal' ? <div className="telemetry-strip" aria-label="Provider telemetry and permissions">
      <span title="Launch-time provider permission profile; already-running agents may have changed modes">Launch ROE {session.roeProfile === 'gated' ? 'gated' : session.roeProfile === 'full' ? 'full' : session.roeProfile === 'provider-default' ? 'provider defaults' : 'unknown'}</span>
      <span className={session.telemetry?.status === 'reported' && session.telemetry.context?.percent && session.telemetry.context.percent >= 90 ? 'danger-text' : session.telemetry?.status === 'reported' && session.telemetry.context?.percent && session.telemetry.context.percent >= 75 ? 'warning-text' : ''}>Context {session.telemetry?.status === 'reported' && session.telemetry.context ? `${session.telemetry.context.percent}%${session.telemetry.context.percent >= 90 ? ' critical' : session.telemetry.context.percent >= 75 ? ' warning' : ''}` : session.telemetry?.status || 'unknown'}</span>
      <span>Tokens {session.telemetry?.status === 'reported' && session.telemetry.tokensPerMinute != null ? `${session.telemetry.tokensPerMinute}/min` : session.telemetry?.status === 'stale' ? 'stale' : session.telemetry?.status === 'unsupported' ? 'unsupported' : 'unknown'}</span>
      <span>Cost {session.telemetry?.status === 'reported' && session.telemetry.costUsd != null ? `$${session.telemetry.costUsd.toFixed(2)} USD · session estimate` : session.telemetry?.status === 'stale' ? 'stale' : session.telemetry?.status === 'unsupported' ? 'unsupported' : 'unknown'}</span>
      <small title={session.telemetry?.sampledAt || ''}>{session.telemetry?.source || 'No provider measurement'}{session.telemetry?.status === 'stale' ? ' · last sample is stale' : ''}</small>
    </div> : null}
    {error ? <p role="alert" className="pane-error">{error}</p> : null}
    <div className={`terminal-panel${terminalId ? ' is-attached' : ''}`}>
      <TerminalView terminalId={terminalId} visible={visible && Boolean(terminalId)} focused={focused} />
      {!terminalId ? <div className="terminal-empty"><TerminalSquare size={30} /><h2>{connecting ? session.provider === 'terminal' ? 'Attaching to terminal…' : 'Attaching to chat…' : session.missing ? 'Session unavailable' : session.stale ? 'Host unavailable' : session.kind === 'unmanaged' ? 'Unmanaged process' : session.canResume ? 'Conversation saved' : 'Session ready'}</h2><p>{session.missing ? 'This session is no longer in the host’s inventory. Its notes remain saved; close the tab or refresh to check again.' : session.stale ? 'The last known session state is shown. Reconnect the host to continue.' : session.kind === 'unmanaged' ? 'This process was started outside tmux. Find its saved conversation and resume a managed copy.' : session.canResume ? 'Resume this conversation with a launch preset.' : 'Attach to continue. Remote sessions stay available after disconnecting.'}</p></div> : null}
    </div>
    {diffOpen && session.worktreeOperation ? <DiffDrawer session={session} visible={visible} onClose={onToggleDiff} /> : null}
    <div className="detail-footer"><span>ID <code>{session.id}</code></span><span>{session.presetName || session.provider}</span></div>
  </section>;
}
