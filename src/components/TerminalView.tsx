import { isMac, primaryModifier } from '../platform';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ClipboardPaste, Copy, Search } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { HistorySearch } from './HistorySearch';
import { enableTerminalLinks } from '../terminalLinks';
import type { TerminalState } from '../types';

export function TerminalView({ terminalId, visible, focused = true }: { terminalId: string | null; visible: boolean; focused?: boolean }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const wheelPending = useRef(0);
  const wheelTimer = useRef<number | null>(null);
  const wheelFlight = useRef<Promise<void> | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [control, setControl] = useState<TerminalState | null>(null);
  const controlRef = useRef(false);
  const snapshotReady = useRef(false);
  const pendingOutput = useRef<{ data: string; sequence: number }[]>([]);
  const lastSequence = useRef(0);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  const showError = useCallback((cause: unknown) => {
    setFeedback(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const copySelection = useCallback(async () => {
    const text = terminalRef.current?.getSelection();
    if (!text || !window.agentHQ) return;
    try {
      await window.agentHQ.writeClipboard(text);
      setFeedback('Copied');
    } catch (cause) { showError(cause); }
  }, [showError]);

  const latest = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id || !window.agentHQ) return;
    wheelPending.current = 0;
    if (wheelTimer.current !== null) { clearTimeout(wheelTimer.current); wheelTimer.current = null; }
    await wheelFlight.current;
    if (activeIdRef.current !== id) return;
    if (controlRef.current) await window.agentHQ.scrollTerminal(id, 'latest');
    if (activeIdRef.current === id) {
      terminalRef.current?.scrollToBottom();
      terminalRef.current?.focus();
    }
  }, []);

  const pasteText = useCallback(async (text: string) => {
    const id = activeIdRef.current;
    if (!id || !text || !window.agentHQ) return;
    try {
      await latest();
      if (activeIdRef.current !== id) return;
      // xterm.paste preserves the CLI's bracketed-paste handling.
      terminalRef.current?.paste(text);
      terminalRef.current?.focus();
      setFeedback('Pasted');
    } catch (cause) { showError(cause); }
  }, [latest, showError]);

  const pasteClipboard = useCallback(async () => {
    if (!window.agentHQ) return;
    try { await pasteText(await window.agentHQ.readClipboard()); }
    catch (cause) { showError(cause); }
  }, [pasteText, showError]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, Consolas, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.38,
      scrollback: 50000,
      scrollOnUserInput: true,
      allowProposedApi: false,
      theme: {
        background: '#0a0e14', foreground: '#dbe6ec', cursor: '#00f0ff',
        selectionBackground: '#255b68', black: '#15222b', red: '#ec6c70',
        green: '#45d89b', yellow: '#e9bd76', blue: '#80b7ed',
        magenta: '#b7a4ec', cyan: '#50d4d8', white: '#dce7ea',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    enableTerminalLinks(terminal);
    terminal.open(element);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const resizeObserver = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      if (!controlRef.current) return;
      fit.fit();
      if (activeIdRef.current) void window.agentHQ?.resizeTerminal(activeIdRef.current, terminal.cols, terminal.rows).catch(showError);
    });
    resizeObserver.observe(element);
    const disposeInput = terminal.onData((data) => {
      if (activeIdRef.current && controlRef.current) void window.agentHQ?.writeTerminal(activeIdRef.current, data).catch(showError);
    });
    const disposeSelection = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()));
    terminal.attachCustomWheelEventHandler((event) => {
      const id = activeIdRef.current;
      if (!controlRef.current) return true;
      if (!id || !event.deltaY) return true;
      event.preventDefault();
      const amount = event.deltaMode === 1 ? Math.abs(event.deltaY) : Math.ceil(Math.abs(event.deltaY) / 40);
      wheelPending.current += Math.sign(event.deltaY) * Math.max(3, Math.min(amount, 60));
      if (wheelTimer.current === null && !wheelFlight.current) {
        wheelTimer.current = window.setTimeout(() => {
          wheelTimer.current = null;
          const flight = (async () => {
            while (activeIdRef.current === id && wheelPending.current) {
              const delta = wheelPending.current;
              wheelPending.current = 0;
              await window.agentHQ?.scrollTerminal(id, delta < 0 ? 'up' : 'down', Math.abs(delta));
            }
          })().catch((cause) => { if (activeIdRef.current === id) showError(cause); });
          wheelFlight.current = flight;
          void flight.finally(() => { if (wheelFlight.current === flight) wheelFlight.current = null; });
        }, 35);
      }
      return false;
    });
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && (key === 'k' || key === 'f')) {
        event.preventDefault();
        if (key === 'f' && event.type === 'keydown') setSearchOpen(true);
        return false;
      }
      const copy = event.metaKey && key === 'c' || event.ctrlKey && (key === 'c' && (event.shiftKey || !isMac && terminal.hasSelection()) || key === 'insert');
      const paste = modifier && key === 'v' || event.shiftKey && key === 'insert';
      const history = event.shiftKey && (key === 'pageup' || key === 'pagedown');
      if (!copy && !paste && !history) return true;
      event.preventDefault();
      if (event.type === 'keydown') {
        if (copy) void copySelection();
        else if (paste) void pasteClipboard();
        else if (activeIdRef.current) void window.agentHQ?.scrollTerminal(activeIdRef.current, key === 'pageup' ? 'up' : 'down', Math.max(1, terminal.rows - 2)).catch(showError);
      }
      return false;
    });
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData('text/plain');
      if (text) void pasteText(text);
    };
    const suppressRemoteContextMenu = (event: MouseEvent) => {
      if (event.button === 2) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const onContextMenu = async (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const action = await window.agentHQ?.terminalMenu(terminal.hasSelection());
      if (action === 'copy') await copySelection();
      else if (action === 'paste') await pasteClipboard();
      else if (action === 'latest') await latest().catch(showError);
    };
    element.addEventListener('paste', onPaste, true);
    element.addEventListener('mousedown', suppressRemoteContextMenu, true);
    element.addEventListener('mouseup', suppressRemoteContextMenu, true);
    element.addEventListener('contextmenu', onContextMenu);
    const offData = window.agentHQ?.onTerminalData((id, data, sequence) => {
      if (id !== activeIdRef.current) return;
      if (!snapshotReady.current) pendingOutput.current.push({ data, sequence });
      else if (sequence > lastSequence.current) { terminal.write(data); lastSequence.current = sequence; }
    });
    const offState = window.agentHQ?.onTerminalState((state) => {
      if (state.id !== activeIdRef.current) return;
      setControl(state); controlRef.current = state.canControl && state.connection === 'connected';
      terminal.options.disableStdin = !controlRef.current;
      if (!state.canControl) terminal.resize(state.cols, state.rows);
    });
    return () => {
      resizeObserver.disconnect();
      if (wheelTimer.current !== null) clearTimeout(wheelTimer.current);
      disposeInput.dispose();
      disposeSelection.dispose();
      element.removeEventListener('paste', onPaste, true);
      element.removeEventListener('mousedown', suppressRemoteContextMenu, true);
      element.removeEventListener('mouseup', suppressRemoteContextMenu, true);
      element.removeEventListener('contextmenu', onContextMenu);
      offData?.();
      offState?.();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [copySelection, latest, pasteClipboard, pasteText, showError]);

  useEffect(() => {
    activeIdRef.current = terminalId;
    snapshotReady.current = false;
    pendingOutput.current = [];
    lastSequence.current = 0;
    controlRef.current = false;
    setControl(null);
    wheelPending.current = 0;
    wheelFlight.current = null;
    if (wheelTimer.current !== null) { clearTimeout(wheelTimer.current); wheelTimer.current = null; }
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    setFeedback('');
    setHasSelection(false);
    if (!terminalId) return;
    const frame = requestAnimationFrame(() => {
      if (activeIdRef.current !== terminalId) return;
      fitRef.current?.fit();
      void window.agentHQ?.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(showError);
      void window.agentHQ?.readyTerminal(terminalId).then((snapshot) => {
        if (activeIdRef.current !== terminalId) return;
        setControl(snapshot.state); controlRef.current = snapshot.state.canControl && snapshot.state.connection === 'connected';
        terminal.options.disableStdin = !controlRef.current;
        terminal.resize(snapshot.state.cols, snapshot.state.rows);
        terminal.write(snapshot.text);
        lastSequence.current = snapshot.sequence;
        for (const output of pendingOutput.current) if (output.sequence > lastSequence.current) { terminal.write(output.data); lastSequence.current = output.sequence; }
        pendingOutput.current = []; snapshotReady.current = true;
        if (snapshot.state.canControl) {
          fitRef.current?.fit();
          void window.agentHQ?.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(showError);
        }
      }).catch(showError);
    });
    return () => cancelAnimationFrame(frame);
  }, [terminalId, showError]);

  useEffect(() => {
    if (!visible || !terminalId) return;
    const frame = requestAnimationFrame(() => {
      if (controlRef.current) fitRef.current?.fit();
      const terminal = terminalRef.current;
      if (terminal) {
        void window.agentHQ?.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(showError);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, terminalId, showError]);

  useEffect(() => {
    if (!visible || !focused || !terminalId) return;
    const frame = requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"]')) terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, focused, terminalId]);

  return <div className={`terminal-console${visible ? '' : ' terminal-hidden'}`}>
    <div className="terminal-utilities">
      {terminalId && control ? <><span className="control-owner">{control.connection === 'reconnecting' ? 'SSH reconnecting…' : control.canControl ? 'You control' : `${control.controller?.name || 'No device'} controls`}</span>{!control.canControl ? <button disabled={control.connection !== 'connected'} onClick={() => void window.agentHQ?.takeTerminal(terminalId).then((state) => { setControl(state); controlRef.current = true; fitRef.current?.fit(); const terminal = terminalRef.current; if (terminal) { terminal.options.disableStdin = false; void window.agentHQ?.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(showError); terminal.focus(); } }).catch(showError)}>Take control</button> : null}</> : null}
      <span className="terminal-hint" role="status">{feedback || 'Scroll for history · Drag to select'}</span>
      <button title={`Search retained history (${primaryModifier}+F)`} onClick={() => setSearchOpen(true)}><Search size={14} /> Find</button>
      <button title="Return to the latest output" onClick={() => void latest().catch(showError)}><ArrowDownToLine size={14} /> Latest</button>
      <button title={`Copy selection (${isMac ? '⌘+C' : 'Ctrl+Shift+C'})`} disabled={!hasSelection} onClick={() => void copySelection()}><Copy size={14} /> Copy</button>
      <button title={`Paste clipboard (${primaryModifier}+V)`} onClick={() => void pasteClipboard()}><ClipboardPaste size={14} /> Paste</button>
    </div>
    <div className="terminal-wrap" ref={elementRef} aria-label="Remote terminal" />
    {searchOpen && terminalId ? <HistorySearch terminalId={terminalId} onClose={closeSearch} /> : null}
  </div>;
}
