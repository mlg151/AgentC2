export const commandDefinitions = [
  { id: 'commandMode', label: 'Command mode / two-digit callsign', binding: 'Ctrl+Space', chord: '' },
  { id: 'search', label: 'Search units and retained history', binding: 'Primary+K', chord: '' },
  { id: 'overwatch', label: 'Overwatch snapshots', binding: 'Ctrl+G', chord: 'g' },
  { id: 'cycleNext', label: 'Cycle Pane B forward', binding: 'Alt+J', chord: '' },
  { id: 'cyclePrevious', label: 'Cycle Pane B backward', binding: 'Alt+K', chord: '' },
  { id: 'focusAnchor', label: 'Focus Pane A', binding: 'Alt+H', chord: '' },
  { id: 'focusTarget', label: 'Focus Pane B', binding: 'Alt+L', chord: '' },
  { id: 'promote', label: 'Swap target into pinned anchor', binding: '', chord: 'p' },
  { id: 'zen', label: 'Toggle Zen focus', binding: '', chord: 'z' },
  { id: 'newUnit', label: 'Task a new unit', binding: '', chord: 'n' },
  { id: 'urgent', label: 'Inspect next confirmed urgent unit', binding: 'Alt+Shift+Space', chord: '' },
  { id: 'approve', label: 'Approve current Flash Traffic request', binding: 'Alt+Y', chord: '' },
  { id: 'deny', label: 'Deny current Flash Traffic request', binding: 'Alt+N', chord: '' },
  { id: 'jumpRequest', label: 'Jump to the current permission request', binding: 'Alt+G', chord: '' },
  { id: 'diff', label: 'Toggle worktree diff', binding: 'Alt+D', chord: 'd' },
  { id: 'exercise', label: 'Joint Exercise', binding: '', chord: 'b' },
  { id: 'handoff', label: 'SitRep handoff', binding: '', chord: 'r' },
  { id: 'faultStop', label: 'Interrupt faulted managed units', binding: '', chord: 'x' },
  { id: 'help', label: 'Keyboard help and remapping', binding: 'F1', chord: '?' },
] as const;
export type CommandId = typeof commandDefinitions[number]['id'];
export interface CommandAction { run: () => void | string; available?: boolean; reason?: string }
export type CommandActions = Partial<Record<CommandId, CommandAction>>;

export function normalizeBinding(value: string): string {
  if (!value.trim()) return '';
  const parts = value.split('+').map((part) => part.trim());
  const key = parts.pop() || '';
  const aliases: Record<string, string> = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta', primary: 'Primary' };
  const keys: Record<string, string> = { space: 'Space', enter: 'Enter', escape: 'Escape', tab: 'Tab', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', home: 'Home', end: 'End' };
  const modifiers = parts.map((part) => aliases[part.toLowerCase()]);
  if (modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length || modifiers.includes('Primary') && (modifiers.includes('Ctrl') || modifiers.includes('Meta'))) throw new Error('Use one key with Ctrl, Alt, Shift, Meta, or Primary modifiers');
  const normalizedKey = key.length === 1 && /[a-z0-9/?]/i.test(key) ? key.toUpperCase() : (keys[key.toLowerCase()] || (/^f([1-9]|1[0-2])$/i.test(key) ? key.toUpperCase() : ''));
  if (!normalizedKey || !modifiers.length && !/^F\d+$/.test(normalizedKey)) throw new Error('Choose a modified key or F1–F12; leave blank to disable');
  return [...['Ctrl', 'Alt', 'Shift', 'Meta', 'Primary'].filter((part) => modifiers.includes(part)), normalizedKey].join('+');
}
export function resolvedBinding(value: string, mac: boolean): string { return normalizeBinding(normalizeBinding(value).replace('Primary', mac ? 'Meta' : 'Ctrl')); }
export function bindingMatches(event: KeyboardEvent, value: string, mac: boolean): boolean {
  if (!value || event.isComposing || event.getModifierState?.('AltGraph')) return false;
  const parts = resolvedBinding(value, mac).split('+');
  const expected = parts.pop();
  const physical = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.code === 'Slash' ? '/' : event.key === ' ' ? 'Space' : event.key.toUpperCase();
  const key = expected === '?' ? '?' : expected?.toUpperCase();
  return (physical.toUpperCase() === key || event.key.toUpperCase() === key) && event.ctrlKey === parts.includes('Ctrl') && event.altKey === parts.includes('Alt') && event.shiftKey === parts.includes('Shift') && event.metaKey === parts.includes('Meta');
}
export function commandBinding(id: CommandId, overrides: Record<string, string>): string { return overrides[id] ?? commandDefinitions.find((item) => item.id === id)!.binding; }
export function validateShortcuts(overrides: Record<string, string>, mac: boolean): Record<string, string> {
  const result: Record<string, string> = {}, used = new Map<string, string>();
  for (const command of commandDefinitions) {
    const value = normalizeBinding(overrides[command.id] ?? command.binding);
    const resolved = resolvedBinding(value, mac);
    if (resolved && used.has(resolved)) throw new Error(`${command.label} conflicts with ${used.get(resolved)}`);
    if (resolved) used.set(resolved, command.label);
    if (overrides[command.id] !== undefined) result[command.id] = value;
  }
  return result;
}
