import { useEffect, useRef, useState } from 'react';
import { bindingMatches, commandBinding, commandDefinitions } from './commands';
import type { CommandActions, CommandId } from './commands';
import { isMac } from './platform';

export function useCommandKeys({ actions, overrides, onCallsign, overwatch }: { actions: CommandActions; overrides: Record<string, string>; onCallsign: (callsign: string) => void | string; overwatch: boolean }) {
  const latest = useRef({ actions, overrides, onCallsign, overwatch }); latest.current = { actions, overrides, onCallsign, overwatch };
  const [prefix, setPrefix] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const mode = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const swallowed = new Set<string>();
    function cancel() { if (timer.current) clearTimeout(timer.current); timer.current = null; mode.current = null; setPrefix(null); }
    function arm(value: string) { cancel(); mode.current = value; setPrefix(value); setStatus(''); timer.current = setTimeout(() => { cancel(); setStatus('Command mode timed out'); }, 1500); }
    function consume(event: KeyboardEvent) { event.preventDefault(); event.stopImmediatePropagation(); if (event.type === 'keydown') swallowed.add(event.code || event.key); }
    function execute(id: CommandId) {
      const action = latest.current.actions[id];
      if (!action || action.available === false) setStatus(action?.reason || 'This action is unavailable for the current unit');
      else { setStatus(action.run() || ''); }
    }
    function key(event: KeyboardEvent) {
      const code = event.code || event.key;
      if (event.type === 'keyup') { if (swallowed.delete(code)) consume(event); return; }
      if (event.isComposing || event.getModifierState?.('AltGraph')) return;
      if (mode.current !== null) {
        consume(event);
        if (event.repeat || ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
        if (event.key === 'Escape') { cancel(); setStatus('Command cancelled'); return; }
        const value = event.key.toLowerCase();
        if (/^[0-9]$/.test(value)) {
          const digits = mode.current + value;
          if (digits.length === 2) { cancel(); setStatus(latest.current.onCallsign(digits) || ''); }
          else arm(digits);
          return;
        }
        const command = commandDefinitions.find((item) => item.chord === value);
        cancel();
        if (command) execute(command.id); else setStatus('Unknown command; press F1 for keyboard help');
        return;
      }
      const target = event.target as HTMLElement | null;
      const dialog = target?.closest?.('[role="dialog"]');
      const editable = target?.closest?.('input,textarea,select,[contenteditable="true"]') && !target.classList.contains('xterm-helper-textarea');
      if (editable || dialog && !latest.current.overwatch) return;
      for (const definition of commandDefinitions) {
        if (latest.current.overwatch && definition.id !== 'overwatch') continue;
        let matches = false;
        try { matches = bindingMatches(event, commandBinding(definition.id, latest.current.overrides), isMac); } catch { continue; }
        if (!matches) continue;
        if (definition.id !== 'commandMode' && (!latest.current.actions[definition.id] || latest.current.actions[definition.id]?.available === false)) return;
        consume(event);
        if (definition.id === 'commandMode') { if (!event.repeat) arm(''); }
        else execute(definition.id);
        return;
      }
    }
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true); if (timer.current) clearTimeout(timer.current); };
  }, []);
  return { prefix, status, setStatus };
}
