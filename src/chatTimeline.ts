import type { ChatPage, ChatUsage } from './chatTypes';

interface ItemIdentity { id: string; sequence: number; turnId: string | null }
export type ChatItem = ItemIdentity & (
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; complete: boolean }
  | { kind: 'tool'; name: string; input: string; output: string; complete: boolean; isError: boolean }
  | { kind: 'request'; requestId: string; title: string; state: 'pending' | 'submitted' | 'resolved' | 'expired'; decision: string | null }
  | { kind: 'outcome'; outcome: string; detail: string }
  | { kind: 'error'; code: string; message: string }
);
export interface ChatTimeline { items: ChatItem[]; firstSequence: number; lastSequence: number; retainedFrom: number; usage: ChatUsage | null }
export const emptyChatTimeline: ChatTimeline = { items: [], firstSequence: 0, lastSequence: 0, retainedFrom: 1, usage: null };

export function reduceChatTimeline(state: ChatTimeline, page: Pick<ChatPage, 'events' | 'cursor' | 'retainedFrom' | 'pendingRequests'>): ChatTimeline {
  const retained = page.retainedFrom > state.retainedFrom ? state.items.filter((item) => item.sequence >= page.retainedFrom) : state.items;
  const indexed = new Map(retained.map((item) => [item.id, item]));
  const existingIds = new Set(indexed.keys());
  const prefixes = new Map<string, string>();
  let first = state.firstSequence && state.firstSequence >= page.retainedFrom ? state.firstSequence : 0;
  let last = state.lastSequence;
  let usage = state.usage;
  for (const event of page.events) {
    if (event.sequence < page.retainedFrom || (state.firstSequence && event.sequence >= state.firstSequence && event.sequence <= state.lastSequence)) continue;
    first = first ? Math.min(first, event.sequence) : event.sequence;
    last = Math.max(last, event.sequence);
    const older = state.firstSequence > 0 && event.sequence < state.firstSequence;
    const identity = (id: string): ItemIdentity => ({ id, sequence: Math.min(indexed.get(id)?.sequence ?? event.sequence, event.sequence), turnId: event.turnId });
    const messageId = `message:${event.itemId || event.sequence}`;
    const toolId = `tool:${event.itemId || event.sequence}`;
    switch (event.type) {
      case 'message.delta': {
        const previous = indexed.get(messageId);
        if (previous?.kind === 'message' && previous.complete) break;
        if (older && previous?.kind === 'message' && existingIds.has(messageId)) {
          prefixes.set(messageId, (prefixes.get(messageId) || '') + event.data.text);
          indexed.set(messageId, { ...previous, ...identity(messageId) });
        } else indexed.set(messageId, { ...identity(messageId), kind: 'message', role: 'assistant', text: (previous?.kind === 'message' ? previous.text : '') + event.data.text, complete: false });
        break;
      }
      case 'message.completed': {
        const previous = indexed.get(messageId);
        if (!older || previous?.kind !== 'message' || !previous.complete) indexed.set(messageId, { ...identity(messageId), kind: 'message', role: event.data.role, text: event.data.text, complete: true });
        break;
      }
      case 'tool.started': {
        const previous = indexed.get(toolId);
        indexed.set(toolId, { ...identity(toolId), kind: 'tool', name: event.data.name, input: older && previous?.kind === 'tool' && previous.input ? previous.input : event.data.input, output: previous?.kind === 'tool' ? previous.output : '', complete: previous?.kind === 'tool' ? previous.complete : false, isError: previous?.kind === 'tool' ? previous.isError : false });
        break;
      }
      case 'tool.completed': {
        const previous = indexed.get(toolId);
        indexed.set(toolId, { ...identity(toolId), kind: 'tool', name: event.data.name, input: previous?.kind === 'tool' ? previous.input : '', output: event.data.output, complete: true, isError: event.data.isError });
        break;
      }
      case 'approval.requested': case 'question.requested': {
        const id = `request:${event.data.requestId}`;
        const previous = indexed.get(id);
        indexed.set(id, { ...identity(id), kind: 'request', requestId: event.data.requestId, title: event.type === 'approval.requested' ? event.data.action : 'User question', state: previous?.kind === 'request' ? previous.state : 'expired', decision: previous?.kind === 'request' ? previous.decision : null });
        break;
      }
      case 'request.resolved': {
        const id = `request:${event.data.requestId}`;
        const previous = indexed.get(id);
        indexed.set(id, { ...identity(id), kind: 'request', requestId: event.data.requestId, title: previous?.kind === 'request' ? previous.title : 'Interactive request', state: event.data.state, decision: event.data.decision });
        break;
      }
      case 'usage.updated': if (!older) usage = event.data; break;
      case 'turn.completed': {
        const id = `outcome:${event.turnId || event.sequence}`;
        indexed.set(id, { ...identity(id), kind: 'outcome', outcome: event.data.outcome, detail: event.data.detail });
        break;
      }
      case 'error': {
        const id = `error:${event.sequence}`;
        indexed.set(id, { ...identity(id), kind: 'error', code: event.data.code, message: event.data.message });
        break;
      }
    }
  }
  for (const [id, prefix] of prefixes) {
    // Prefix keys are added only for existing messages. No event removes rows
    // or changes a message key's kind before this synchronous flush.
    const item = indexed.get(id) as Extract<ChatItem, { kind: 'message' }>;
    if (!item.complete) indexed.set(id, { ...item, text: prefix + item.text });
  }
  const pending = new Map(page.pendingRequests.map((request) => [request.requestId, request.state]));
  for (const [id, item] of indexed) if (item.kind === 'request') {
    const next = pending.get(item.requestId) || (item.state === 'pending' || item.state === 'submitted' ? 'expired' : item.state);
    if (next !== item.state) indexed.set(id, { ...item, state: next });
  }
  const items = [...indexed.values()].sort((a, b) => a.sequence - b.sequence);
  const nextLast = Math.max(last, page.cursor);
  if (items.length === state.items.length && items.every((item, index) => item === state.items[index]) && first === state.firstSequence && nextLast === state.lastSequence && page.retainedFrom === state.retainedFrom && usage === state.usage) return state;
  return { items, firstSequence: first, lastSequence: nextLast, retainedFrom: page.retainedFrom, usage };
}
