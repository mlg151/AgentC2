import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { enableTerminalLinks } from '../terminalLinks';
import type { Session, TerminalSnapshot, TerminalState } from '../types';
import { CompanionClient } from './client';

const keys = [['Enter', '\r'], ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Ctrl-C', '\x03']];

export function PhoneTerminal({ client, session, connected, onResume, onRefresh }: { client: CompanionClient; session: Session; connected: boolean; onResume: () => void; onRefresh: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const handle = useRef<string | null>(null);
  const writable = useRef(false);
  const [control, setControl] = useState<TerminalState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [attached, setAttached] = useState(true);
  const [history, setHistory] = useState<{ text: string; truncated: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState(0);
  const canControl = connected && control?.canControl && control.exitCode === null && !session.stale;
  writable.current = Boolean(canControl);
  const showError = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  useEffect(() => {
    const node = element.current;
    if (!node || !session.canAttach || !attached || session.stale) return;
    let cancelled = false;
    let snapshotReady = false;
    let sequence = 0;
    const pending: { data: string; sequence: number }[] = [];
    const term = new Terminal({ cols: 100, rows: 30, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12, scrollback: 5000, disableStdin: true, theme: { background: '#0a1218', foreground: '#dbe6ec', cursor: '#35c9cc', selectionBackground: '#255b68' } });
    const addon = new FitAddon(); term.loadAddon(addon); enableTerminalLinks(term); term.open(node); terminal.current = term; fit.current = addon;
    function apply(state: TerminalState) {
      setControl(state);
      term.options.disableStdin = !state.canControl;
      writable.current = state.canControl && state.exitCode === null;
      if (!state.canControl) term.resize(state.cols, state.rows);
    }
    const offData = client.on('terminal:data', (value) => {
      const output = value as { id: string; data: string; sequence: number };
      if (output.id !== handle.current) return;
      if (!snapshotReady) pending.push(output);
      else if (output.sequence > sequence) { term.write(output.data); sequence = output.sequence; }
    });
    const offState = client.on('terminal:state', (value) => { const state = value as TerminalState; if (state.id === handle.current) apply(state); });
    const offExit = client.on('terminal:exit', (value) => { const exit = value as { id: string; code: number }; if (exit.id === handle.current) { writable.current = false; setError(`Terminal connection closed (${exit.code}). Reattach to reconnect.`); onRefresh(); } });
    const input = term.onData((data) => { if (writable.current && handle.current) void client.request('terminal:write', handle.current, data).catch(showError); });
    const resize = new ResizeObserver(() => {
      if (!writable.current || !handle.current || !node?.clientWidth || !node?.clientHeight) return;
      addon.fit(); void client.request('terminal:resize', handle.current, term.cols, term.rows).catch(showError);
    }); resize.observe(node);
    setControl(null); setError('');
    void client.request<string>('terminal:open', session.id, 100, 30, session.hostId).then(async (id) => {
      if (cancelled) { void client.request('terminal:close', id).catch(() => {}); return; }
      handle.current = id;
      const snapshot = await client.request<TerminalSnapshot>('terminal:ready', id);
      if (cancelled) return;
      apply(snapshot.state); term.resize(snapshot.state.cols, snapshot.state.rows); term.write(snapshot.text); sequence = snapshot.sequence;
      for (const output of pending) if (output.sequence > sequence) { term.write(output.data); sequence = output.sequence; }
      snapshotReady = true;
    }).catch((cause) => { if (!cancelled) showError(cause); });
    return () => {
      cancelled = true; offData(); offState(); offExit(); input.dispose(); resize.disconnect();
      if (handle.current) void client.request('terminal:close', handle.current).catch(() => {});
      handle.current = null; terminal.current = null; fit.current = null; term.dispose();
    };
  }, [client, session.id, session.hostId, session.canAttach, session.stale, attached, attempt]); // Inventory refreshes must not detach a terminal.

  async function take() {
    if (!handle.current) return;
    try {
      const state = await client.request<TerminalState>('terminal:take', handle.current);
      setControl(state); writable.current = true;
      const term = terminal.current;
      if (term) { term.options.disableStdin = false; fit.current?.fit(); await client.request('terminal:resize', handle.current, term.cols, term.rows); }
    } catch (cause) { showError(cause); }
  }
  async function action(kind: 'interrupt' | 'stop') {
    if (kind === 'stop' && !window.confirm(`Stop “${session.title}” on ${session.hostName}? This ends the session process and removes its tmux session.`)) return;
    setBusy(true); setError('');
    try { await client.request(kind, session.id, session.hostId); onRefresh(); }
    catch (cause) { showError(cause); } finally { setBusy(false); }
  }
  async function send() {
    if (!draft || !handle.current || !canControl) return;
    setBusy(true); setError('');
    try {
      // xterm.paste uses the provider's bracketed-paste mode. Resolve its write
      // before Enter so multiline prompts cannot overtake their pasted content.
      const term = terminal.current!;
      const data: string[] = [];
      const listener = term.onData((value) => data.push(value));
      writable.current = false;
      term.paste(draft);
      listener.dispose(); writable.current = true;
      await client.request('terminal:write', handle.current, data.join(''));
      await client.request('terminal:write', handle.current, '\r');
      setDraft('');
    } catch (cause) { showError(cause); } finally { setBusy(false); }
  }
  const matches: number[] = [];
  if (query && history) {
    const text = history.text.toLowerCase(), needle = query.toLowerCase();
    let start = 0, index;
    while ((index = text.indexOf(needle, start)) >= 0) { matches.push(index); start = index + needle.length; }
  }
  const position = matches.length ? matches[match % matches.length] : -1;
  return <section className="phone-session">
    <div className="phone-session-heading"><h1>{session.title}</h1><p>{session.hostName} · {session.provider} · {session.stale ? 'Stale — host unavailable' : session.state}</p><small>{session.cwd || 'Working directory unavailable'}</small></div>
    <div className="phone-control"><span>{canControl ? 'You control this session' : `Viewing · ${control?.controller?.name || 'no device'} controls`}</span>{session.canAttach ? <button className="button-primary" disabled={!connected || !control || Boolean(canControl) || control.exitCode !== null || session.stale} onClick={() => void take()}>Take control</button> : null}</div>
    <div className="phone-actions">
      {session.canResume ? <button disabled={!connected || session.stale || busy} onClick={onResume}>Resume</button> : null}
      {session.canAttach ? <><button disabled={!connected} onClick={() => { setAttached(!attached); setAttempt((value) => value + 1); }}>{attached ? 'Detach' : 'Attach'}</button><button disabled={!connected || !handle.current} onClick={() => void client.request<{ text: string; truncated: boolean }>('terminal:history', handle.current).then((value) => { setHistory(value); setQuery(''); setMatch(0); }).catch(showError)}>Find history</button>{control?.exitCode !== null && control ? <button onClick={() => setAttempt((value) => value + 1)}>Reattach</button> : null}</> : null}
      {session.canInterrupt ? <button disabled={!canControl || busy} onClick={() => void action('interrupt')}>Interrupt</button> : null}
      {session.canStop ? <button className="danger-text" disabled={!connected || !control?.canControl || busy || session.stale} onClick={() => void action('stop')}>Stop</button> : null}
    </div>
    {error ? <p className="phone-error" role="alert">{error}</p> : null}
    {session.canAttach && attached ? <div className="phone-terminal-scroll"><div className="phone-terminal" style={control && !canControl ? { width: Math.ceil(control.cols * 7.3 + 28) } : undefined} ref={element} aria-label="Remote terminal" /></div> : <div className="phone-empty">{session.kind === 'unmanaged' ? 'This process is read-only. Resume its saved conversation to create a managed session.' : session.canResume ? 'Resume this conversation to continue.' : 'Terminal detached. Remote sessions keep running.'}</div>}
    {session.canAttach && attached ? <>
      <div className="phone-keys" aria-label="Terminal keys">{keys.map(([label, value]) => <button key={label} aria-label={label} disabled={!canControl || busy} onClick={() => { if (handle.current) void client.request('terminal:write', handle.current, value).catch(showError); }}>{label}</button>)}</div>
      <form className="phone-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}><label htmlFor="prompt">{session.provider === 'terminal' ? 'Command' : 'Prompt or reply'}</label><textarea id="prompt" rows={3} value={draft} maxLength={20000} onChange={(event) => setDraft(event.target.value)} placeholder={canControl ? session.provider === 'terminal' ? 'Enter a shell command…' : 'Write instructions for this agent…' : 'Take control to send input'} /><button className="button-primary" disabled={!canControl || busy || !draft.trim()} type="submit">{busy ? 'Sending…' : 'Send'}</button></form>
    </> : null}
    {history ? <div className="phone-history" role="dialog" aria-label="Terminal history"><div className="phone-section-heading"><h2>Retained history</h2><button onClick={() => setHistory(null)}>Close history</button></div><p>{history.truncated ? 'Most recent 4 million characters.' : 'Snapshot of up to 50,000 retained lines.'}</p><input aria-label="Find in history" value={query} onChange={(e) => { setQuery(e.target.value); setMatch(0); }} placeholder="Find text…" /><div className="phone-actions"><span>{matches.length ? `${match % matches.length + 1} of ${matches.length}` : query ? 'No matches' : 'Enter text to search'}</span><button disabled={!matches.length} onClick={() => setMatch((value) => (value - 1 + matches.length) % matches.length)}>Previous</button><button disabled={!matches.length} onClick={() => setMatch((value) => value + 1)}>Next</button><button onClick={() => { if (handle.current) void client.request<{ text: string; truncated: boolean }>('terminal:history', handle.current).then(setHistory).catch(showError); }}>Reload</button></div><pre>{position < 0 ? history.text.slice(-20000) : <>{history.text.slice(Math.max(0, position - 1500), position)}<mark>{history.text.slice(position, position + query.length)}</mark>{history.text.slice(position + query.length, position + query.length + 1500)}</>}</pre></div> : null}
  </section>;
}
