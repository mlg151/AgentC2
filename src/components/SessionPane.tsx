import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2Off, Play, Square, TerminalSquare, Trash2, Zap } from 'lucide-react';
import { TerminalView } from './TerminalView';
import type { Session } from '../types';

export function SessionPane({ session, visible, primary, onResume, onRefresh, onDeleteHistory }: { session: Session; visible: boolean; primary: boolean; onResume: (s: Session) => void; onRefresh: () => void; onDeleteHistory: (session: Session) => void }) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [wanted, setWanted] = useState(Boolean(session.canAttach));
  const [attempt, setAttempt] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  useEffect(() => window.agentHQ?.onTerminalExit((id, code) => {
    if (id !== idRef.current) return;
    idRef.current = null; setTerminalId(null); setWanted(false);
    void window.agentHQ?.closeTerminal(id);
    setError(`Terminal connection closed (${code}). Reattach to reconnect.`);
  }), []);
  const showError = useCallback((cause: unknown) => setError(String(cause)), []);
  async function stop() {
    if (!window.confirm(`Stop “${session.title}” on ${session.hostName}? This ends the session process and removes its tmux session.`)) return;
    setBusy(true);
    try { await window.agentHQ?.stop(session.id, session.hostId); setWanted(false); onRefresh(); }
    catch (cause) { showError(cause); } finally { setBusy(false); }
  }
  return <section style={{ order: primary ? 0 : 1 }} className={`session-pane${visible ? '' : ' pane-hidden'}`} aria-label={`Session ${session.title}`}>
    <div className="pane-heading"><div><strong title={session.title}>{session.title}</strong><small>{session.hostName} · {session.provider} · {session.cwd || 'Working directory unavailable'}</small></div><span className={session.stale ? 'danger-text' : ''}>{session.missing ? 'Session unavailable' : session.stale ? 'Host unavailable' : session.state === 'exited' ? `Exited (${session.exitCode ?? '?'})` : terminalId ? 'Attached' : session.kind}</span></div>
    <div className="toolbar">
      {session.canAttach ? <button className="button-primary" disabled={busy || Boolean(terminalId) || connecting || session.stale} onClick={() => { setWanted(true); setAttempt((a) => a + 1); }}><TerminalSquare size={15} />{connecting ? 'Attaching…' : 'Attach'}</button> : null}
      {session.canResume ? <button className="button-primary" disabled={session.stale || busy} onClick={() => onResume(session)}><Play size={15} />Resume</button> : null}
      {session.kind === 'conversation' ? <button className="toolbar-button danger" disabled={session.stale || busy} onClick={() => onDeleteHistory(session)}><Trash2 size={14} />Delete history</button> : null}
      {session.canInterrupt ? <button className="toolbar-button" disabled={session.stale || busy} onClick={() => void window.agentHQ?.interrupt(session.id, session.hostId).catch(showError)}><Zap size={15} />Interrupt</button> : null}
      {session.canAttach ? <button className="toolbar-button" disabled={!terminalId || busy} onClick={() => setWanted(false)}><Link2Off size={15} />Detach</button> : null}
      {session.canStop ? <button className="toolbar-button danger" disabled={session.stale || busy} onClick={() => void stop()}><Square size={14} />Stop</button> : null}
    </div>
    {error ? <p role="alert" className="pane-error">{error}</p> : null}
    <div className={`terminal-panel${terminalId ? ' is-attached' : ''}`}>
      <TerminalView terminalId={terminalId} visible={visible && Boolean(terminalId)} />
      {!terminalId ? <div className="terminal-empty"><TerminalSquare size={30} /><h2>{connecting ? session.provider === 'terminal' ? 'Attaching to terminal…' : 'Attaching to chat…' : session.missing ? 'Session unavailable' : session.stale ? 'Host unavailable' : session.kind === 'unmanaged' ? 'Unmanaged process' : session.canResume ? 'Conversation saved' : 'Session ready'}</h2><p>{session.missing ? 'This session is no longer in the host’s inventory. Its notes remain saved; close the tab or refresh to check again.' : session.stale ? 'The last known session state is shown. Reconnect the host to continue.' : session.kind === 'unmanaged' ? 'This process was started outside tmux. Find its saved conversation and resume a managed copy.' : session.canResume ? 'Resume this conversation with a launch preset.' : 'Attach to continue. Remote sessions stay available after disconnecting.'}</p></div> : null}
    </div>
    <div className="detail-footer"><span>ID <code>{session.id}</code></span><span>{session.presetName || session.provider}</span></div>
  </section>;
}
