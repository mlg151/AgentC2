const crypto = require('node:crypto');

// Terminal text is evidence of a possible prompt, never proof of task completion.
function classify(session) {
  if (session.exitCode !== undefined && session.exitCode !== null) return { kind: Number(session.exitCode) === 0 ? 'completed' : 'failed', confidence: 'confirmed', detail: `Process exited with code ${session.exitCode}.` };
  if (['blocked', 'waiting_for_input', 'requires_action'].includes(session.state)) return { kind: 'input', confidence: 'confirmed', detail: 'The provider reports that this agent needs attention.' };
  const tail = (session.outputTail || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').filter((l) => l.trim()).slice(-8).join('\n');
  if (/(?:\[y\/n\]|\(y\/n\)|allow (?:this|once)|(?:do you want|would you like) to (?:proceed|continue|run|allow)|no, and tell codex|approve (?:this|the)|permission required|waiting for (?:your )?(?:input|approval)|press enter to (?:continue|confirm))/i.test(tail)) return { kind: 'input', confidence: 'inferred', detail: 'Recent terminal output looks like an input or approval prompt. Open the terminal to verify.' };
  return null;
}
class Attention {
  constructor(store) { this.store = store; this.observed = new Map(); }
  update(sessions) {
    const added = [];
    let items = this.store.data.attention;
    const cursors = { ...this.store.data.attentionCursors };
    let cursorChanged = false;
    for (const session of sessions) {
      const events = session.events || [];
      const savedCursor = cursors[session.key];
      const cursorId = typeof savedCursor === 'string' ? savedCursor : savedCursor?.id;
      const rememberedAt = typeof savedCursor === 'object' ? Date.parse(savedCursor.at || '') : Math.max(0, ...items.filter((item) => item.sessionKey === session.key && item.signature?.startsWith('hook:')).map((item) => Date.parse(item.createdAt) || 0));
      const cursorAt = Number.isFinite(rememberedAt) ? rememberedAt : 0;
      const cursor = events.findIndex((event) => event.id === cursorId);
      for (const event of events.slice(cursor + 1)) {
        if (!['completed', 'failed', 'input'].includes(event.kind) || typeof event.id !== 'string') continue;
        const eventAt = Date.parse(event.at || '');
        if (Number.isFinite(eventAt) && eventAt < cursorAt - 1000) continue;
        const signature = `hook:${event.id}`;
        if (items.some((i) => i.sessionKey === session.key && i.signature === signature)) continue;
        const item = { id: crypto.randomUUID(), sessionKey: session.key, hostId: session.hostId, title: session.title, provider: session.provider, createdAt: event.at || new Date().toISOString(), acknowledged: false, signature, kind: event.kind, confidence: 'confirmed', detail: event.kind === 'completed' ? 'The provider reported that its turn finished. Review the result in the terminal.' : event.kind === 'failed' ? 'The provider reported a failed turn.' : 'The provider reported an input or approval request.' };
        items = [...items, item].slice(-500); added.push(item);
      }
      if (events.length && cursorId !== events.at(-1).id) {
        const latestAt = Math.max(cursorAt, ...events.map((event) => Date.parse(event.at || '') || 0));
        cursors[session.key] = { id: events.at(-1).id, at: new Date(latestAt || Date.now()).toISOString() };
        cursorChanged = true;
      }
      const signal = classify(session);
      const signature = signal ? `${signal.kind}:${signal.confidence}:${signal.detail}` : '';
      const previous = this.observed.get(session.key);
      this.observed.set(session.key, signature);
      if (!signal || previous === signature) continue;
      if (previous === undefined && items.some((i) => i.sessionKey === session.key && i.signature === signature)) continue;
      const item = { id: crypto.randomUUID(), sessionKey: session.key, hostId: session.hostId, title: session.title, provider: session.provider, createdAt: new Date().toISOString(), acknowledged: false, signature, ...signal };
      items = [...items, item].slice(-500);
      added.push(item);
    }
    if (added.length) this.store.save('attention', items);
    if (cursorChanged) this.store.save('attentionCursors', cursors);
    return added;
  }
  acknowledge(id) {
    return this.store.save('attention', this.store.data.attention.map((i) => id === 'all' || i.id === id ? { ...i, acknowledged: true } : i));
  }
}
module.exports = { Attention, classify };
