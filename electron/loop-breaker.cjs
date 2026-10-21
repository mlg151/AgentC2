// Only structured provider outcomes can trip this breaker. The remote hook
// stores a digest of tool input, never the command or error output.
class LoopBreaker {
  constructor(store) { this.store = store; }
  faults() {
    return Object.entries(this.store.data.loopState).filter(([, value]) => value.fault).map(([sessionKey, value]) => ({ sessionKey, ...value.fault }));
  }
  observe(sessions) {
    const next = { ...this.store.data.loopState };
    const raised = [];
    let changed = false;
    for (const session of sessions) {
      if (session.stale || session.kind !== 'managed' || session.provider !== 'claude' || !session.presetId || !session.key?.includes('/tmux:hq-')) continue;
      const preset = this.store.data.settings.presets.find((item) => item.id === session.presetId && item.provider === 'claude');
      const policy = preset?.loopBreaker;
      if (!policy?.enabled || !preset.attentionHooks) continue;
      const old = next[session.key] || { cursor: '', signature: '', count: 0, firstAt: 0, lastFaultAt: 0, fault: null, headCommit: null };
      const state = { ...old };
      const events = Array.isArray(session.events) ? session.events : [];
      const cursor = events.findIndex((event) => event.id === state.cursor);
      // If the hook ring wrapped while disconnected, start fresh rather than
      // treating an incomplete sequence as consecutive evidence.
      const revisionChanged = session.worktreeOperation && session.headCommit && state.headCommit && session.headCommit !== state.headCommit;
      if (revisionChanged || state.cursor && cursor < 0) {
        state.signature = ''; state.count = 0; state.firstAt = 0;
        state.cursor = events.at(-1)?.id || state.cursor;
        state.headCommit = session.headCommit || null;
        next[session.key] = state;
        changed = true;
        continue;
      }
      if (session.worktreeOperation && session.headCommit) state.headCommit = session.headCommit;
      for (const event of events.slice(cursor + 1)) {
        if (!event || event.source !== 'claude' || typeof event.id !== 'string' || !/^[a-f0-9]{32}$/.test(event.id)) continue;
        const at = Date.parse(event.at || '');
        if (!Number.isFinite(at) || at > Date.now() + 60_000) continue;
        if (at < Date.now() - policy.windowMinutes * 60_000) { state.signature = ''; state.count = 0; state.firstAt = 0; state.cursor = event.id; continue; }
        if (['tool_ok', 'working', 'completed'].includes(event.kind)) {
          state.signature = ''; state.count = 0; state.firstAt = 0;
        } else if ((event.kind === 'tool_failed' || event.kind === 'failed') && typeof event.failureSignature === 'string' && /^(?:[a-f0-9]{32}|api:[a-z_]{1,40})$/.test(event.failureSignature)) {
          const within = state.signature === event.failureSignature && at >= state.firstAt && at - state.firstAt <= policy.windowMinutes * 60_000;
          state.count = within ? state.count + 1 : 1;
          state.signature = event.failureSignature;
          state.firstAt = within ? state.firstAt : at;
          if (!state.fault && state.count >= policy.threshold && at - state.lastFaultAt >= policy.cooldownMinutes * 60_000) {
            state.lastFaultAt = at;
            state.fault = { id: event.id, at: event.at, label: typeof event.failureLabel === 'string' ? event.failureLabel.slice(0, 100) : 'Repeated confirmed failure', count: state.count, status: policy.autoInterrupt ? 'pending' : 'review', detail: `${state.count} consecutive matching provider failures in ${policy.windowMinutes} minutes`, autoInterrupt: policy.autoInterrupt };
            raised.push({ sessionKey: session.key, ...state.fault });
          }
        } else if (['tool_failed', 'failed', 'input'].includes(event.kind)) {
          // An unknown error or intervening permission request breaks a
          // consecutive sequence, even when it cannot identify a new streak.
          state.signature = ''; state.count = 0; state.firstAt = 0;
        }
        state.cursor = event.id;
      }
      if (JSON.stringify(old) !== JSON.stringify(state)) { next[session.key] = state; changed = true; }
    }
    if (changed) this.store.save('loopState', Object.fromEntries(Object.entries(next).slice(-500)));
    return raised;
  }
  record(sessionKey, status, detail) {
    const state = this.store.data.loopState[sessionKey];
    if (!state?.fault) throw new Error('No current confirmed fault');
    const next = { ...state, fault: { ...state.fault, status, result: String(detail).slice(0, 300) } };
    this.store.save('loopState', { ...this.store.data.loopState, [sessionKey]: next });
    return { sessionKey, ...next.fault };
  }
  reset(sessionKey) {
    const state = this.store.data.loopState[sessionKey];
    if (!state?.fault) throw new Error('No current confirmed fault');
    this.store.save('loopState', { ...this.store.data.loopState, [sessionKey]: { ...state, fault: null, signature: '', count: 0, firstAt: 0 } });
    return true;
  }
}
module.exports = { LoopBreaker };
