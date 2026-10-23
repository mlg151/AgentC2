import { Suspense, lazy, useEffect, useState } from 'react';
import { AlertTriangle, Check, CheckCheck, Play, RotateCcw, Shield, ShieldAlert, Sparkles, TerminalSquare, X, Zap } from 'lucide-react';
import type { CentcomConfig, CentcomState, Settings } from '../types';
import { desktopChatApi } from '../chatClient';
import { Modal } from './Modal';

const ChatView = lazy(() => import('./ChatView').then((module) => ({ default: module.ChatView })));

const MODEL_PRESETS: Record<string, string[]> = {
  codex: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.5', 'fable'],
  claude: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-5-haiku-20241022'],
  antigravity: ['gemini-2.0-flash-exp', 'gemini-1.5-pro', 'argon'],
  opencode: ['default'],
};

export function CentcomDialog({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [state, setState] = useState<CentcomState | null>(null);
  const [tab, setTab] = useState<'command' | 'directives' | 'automations' | 'config'>('command');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configDraft, setConfigDraft] = useState<CentcomConfig | null>(null);

  useEffect(() => {
    let active = true;
    void window.agentHQ?.centcomState().then((s) => {
      if (active) {
        setState(s);
        setConfigDraft(s.config);
      }
    }).catch((e: Error) => { if (active) setError(e.message); });

    const off = window.agentHQ?.onCentcomState((s) => {
      if (active) {
        setState(s);
        if (!configDraft) setConfigDraft(s.config);
      }
    });

    return () => {
      active = false;
      off?.();
    };
  }, []);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pendingDirectives = (state?.directives || []).filter((d) => d.state === 'pending');
  const pendingAutomations = (state?.automations || []).filter((a) => a.state === 'proposed');

  return (
    <Modal title="CENTCOM // Fleet Command" onClose={onClose} wide>
      <div className="centcom-container">
        <header className="centcom-top-bar">
          <div className="centcom-brand">
            <TerminalSquare size={20} />
            <div>
              <strong>CENTCOM COMMAND CONSOLE</strong>
              <small>
                {state?.session
                  ? `${state.session.provider.toUpperCase()} (${state.session.model}) · ${state.session.hostId}`
                  : 'Session offline'}
              </small>
            </div>
          </div>
          <div className="centcom-header-badges">
            <span className={`centcom-badge status-${state?.status || 'idle'}`}>
              STATUS: {(state?.status || 'idle').toUpperCase().replace('_', ' ')}
            </span>
            <span className={`centcom-badge authority-${state?.config.authority || 'gated'}`}>
              {state?.config.authority === 'autonomous' ? <ShieldAlert size={13} /> : <Shield size={13} />}
              {state?.config.authority === 'autonomous' ? 'AUTONOMOUS C2' : 'GATED C2'}
            </span>
            <span className="centcom-badge spend">
              SPEND: ${state?.costUsd?.toFixed(2) || '0.00'}
            </span>
          </div>
        </header>

        <nav className="segmented centcom-tabs">
          <button className={tab === 'command' ? 'active' : ''} onClick={() => setTab('command')}>
            Command Deck
          </button>
          <button className={tab === 'directives' ? 'active' : ''} onClick={() => setTab('directives')}>
            Directives {pendingDirectives.length ? `(${pendingDirectives.length})` : ''}
          </button>
          <button className={tab === 'automations' ? 'active' : ''} onClick={() => setTab('automations')}>
            Automations {pendingAutomations.length ? `(${pendingAutomations.length})` : ''}
          </button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>
            Configuration & ROE
          </button>
        </nav>

        {error ? <p role="alert" className="form-error">{error}</p> : null}

        {tab === 'command' ? (
          <section className="centcom-tab-content">
            <div className="centcom-quick-actions">
              <button
                className="button-secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const next = await window.agentHQ?.submitCentcom(
                      'Conduct a full fleet situation assessment. Evaluate theater connectivity, unit activities, DEFCON readiness, and recommend any immediate tactical interventions.'
                    );
                    if (next) setState(next);
                  })
                }
              >
                <Sparkles size={14} /> Fleet SitRep & Readiness Brief
              </button>
              <button
                className="button-secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const next = await window.agentHQ?.submitCentcom(
                      'Analyze all active SPECOPS missions, LoopBreaker faults, and pending Flash Traffic tool approvals. Suggest or execute needed arbitrations.'
                    );
                    if (next) setState(next);
                  })
                }
              >
                <AlertTriangle size={14} /> Arbitrate Halts & Faults
              </button>
              <button
                className="button-secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const next = await window.agentHQ?.submitCentcom(
                      'Analyze recurring manual developer workflows and active units. Propose structured automation improvements (new SPECOPS templates, OpOrders, or launch presets).'
                    );
                    if (next) setState(next);
                  })
                }
              >
                <Zap size={14} /> Suggest Automations
              </button>
              {state?.status === 'running' ? (
                <button
                  className="button-secondary danger-text"
                  onClick={() =>
                    void perform(async () => {
                      const next = await window.agentHQ?.interruptCentcom();
                      if (next) setState(next);
                    })
                  }
                >
                  <X size={14} /> Halt Turn
                </button>
              ) : null}
            </div>

            <div className="centcom-chat-frame">
              {state?.session?.chatSessionId ? (
                <Suspense fallback={<div className="chat-empty">Connecting to CENTCOM chat…</div>}>
                  <ChatView
                    api={desktopChatApi}
                    sessionId={state.session.chatSessionId}
                    hostId={state.session.hostId}
                    enabled={true}
                    connected={true}
                    onRefresh={() => {
                      void window.agentHQ?.centcomState().then(setState);
                    }}
                  />
                </Suspense>
              ) : (
                <div className="chat-empty">
                  <strong>CENTCOM is not currently initialized.</strong>
                  <p>Click below to initialize the commander session on {state?.config.hostId || 'default'}.</p>
                  <button
                    className="button-primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const next = await window.agentHQ?.startCentcom();
                        if (next) setState(next);
                      })
                    }
                  >
                    <Play size={14} /> Initialize Commander Session
                  </button>
                </div>
              )}
            </div>
          </section>
        ) : null}

        {tab === 'directives' ? (
          <section className="centcom-tab-content">
            <div className="centcom-section-header">
              <div>
                <h3>C2 Directives Queue</h3>
                <p className="field-note">
                  Directives emitted by CENTCOM. In Gated C2 mode, destructive or unit-mutating actions require explicit Watch Officer confirmation.
                </p>
              </div>
              {pendingDirectives.length > 1 ? (
                <div className="inline-actions">
                  <button
                    className="button-primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const next = await window.agentHQ?.decideAllCentcomDirectives('approve');
                        if (next) setState(next);
                      })
                    }
                  >
                    <CheckCheck size={14} /> Approve All Pending ({pendingDirectives.length})
                  </button>
                  <button
                    className="button-secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const next = await window.agentHQ?.decideAllCentcomDirectives('deny');
                        if (next) setState(next);
                      })
                    }
                  >
                    <X size={14} /> Deny All
                  </button>
                </div>
              ) : null}
            </div>

            <div className="centcom-directives-list">
              {!state?.directives?.length ? (
                <p className="field-note">No directives recorded yet.</p>
              ) : null}
              {state?.directives?.map((d) => (
                <article key={d.id} className={`centcom-directive-card ${d.state}`}>
                  <div className="directive-header">
                    <div>
                      <strong>{d.summary}</strong>
                      <span className="signal-tag">{d.kind}</span>
                      <span className={`signal-tag directive-state-${d.state}`}>{d.state.toUpperCase()}</span>
                    </div>
                    {d.state === 'pending' ? (
                      <div className="inline-actions">
                        <button
                          className="button-secondary"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const next = await window.agentHQ?.decideCentcomDirective(d.id, 'deny');
                              if (next) setState(next);
                            })
                          }
                        >
                          <X size={14} /> Deny
                        </button>
                        <button
                          className="button-primary"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const next = await window.agentHQ?.decideCentcomDirective(d.id, 'approve');
                              if (next) setState(next);
                            })
                          }
                        >
                          <Check size={14} /> Approve & Execute
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <p>{d.rationale}</p>
                  <details>
                    <summary>Directive Parameters & Preconditions</summary>
                    <pre>{JSON.stringify({ params: d.params, preconditions: d.preconditions }, null, 2)}</pre>
                  </details>
                  {d.error ? <p role="alert" className="form-error">{d.error}</p> : null}
                  <small>
                    Trigger: {d.trigger} · Created: {new Date(d.createdAt).toLocaleTimeString()}
                    {d.resolvedAt ? ` · Resolved: ${new Date(d.resolvedAt).toLocaleTimeString()}` : ''}
                  </small>
                </article>
              ))}
            </div>

            <h3>Audit Log</h3>
            <div className="centcom-audit-log">
              {!state?.auditLog?.length ? <p className="field-note">No execution history recorded.</p> : null}
              {state?.auditLog?.map((item) => (
                <div key={item.id} className="audit-row">
                  <span className="audit-time">{new Date(item.at).toLocaleTimeString()}</span>
                  <span className={`signal-tag outcome-${item.outcome}`}>{item.outcome}</span>
                  <strong>{item.summary}</strong>
                  <small>({item.kind}) · Trigger: {item.trigger}</small>
                  {item.error ? <span className="audit-error">{item.error}</span> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {tab === 'automations' ? (
          <section className="centcom-tab-content">
            <div className="centcom-section-header">
              <div>
                <h3>Proactive Automation Proposals</h3>
                <p className="field-note">
                  CENTCOM analyzes developer workflows, repetitive unit handoffs, and issues to propose SPECOPS templates, OpOrders, and presets.
                </p>
              </div>
            </div>

            <div className="centcom-automations-list">
              {!state?.automations?.length ? (
                <p className="field-note">No automation suggestions generated yet. Click &ldquo;Suggest Automations&rdquo; in Command Deck to analyze current fleet activity.</p>
              ) : null}
              {state?.automations?.map((a) => (
                <article key={a.id} className={`centcom-automation-card ${a.state}`}>
                  <div className="directive-header">
                    <div>
                      <strong>{a.title}</strong>
                      <span className="signal-tag">{a.kind}</span>
                      <span className={`signal-tag directive-state-${a.state}`}>{a.state.toUpperCase()}</span>
                    </div>
                    {a.state === 'proposed' ? (
                      <div className="inline-actions">
                        <button
                          className="button-secondary"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const next = await window.agentHQ?.applyCentcomAutomation(a.id, 'dismiss');
                              if (next) setState(next);
                            })
                          }
                        >
                          Dismiss
                        </button>
                        <button
                          className="button-primary"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const next = await window.agentHQ?.applyCentcomAutomation(a.id, 'apply');
                              if (next) setState(next);
                            })
                          }
                        >
                          <Check size={14} /> Apply Configuration
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <p>{a.rationale}</p>
                  {a.evidence?.length ? (
                    <ul>
                      {a.evidence.map((ev, i) => <li key={i}>{ev}</li>)}
                    </ul>
                  ) : null}
                  <details>
                    <summary>Configuration Payload</summary>
                    <pre>{JSON.stringify(a.payload, null, 2)}</pre>
                  </details>
                  {a.error ? <p role="alert" className="form-error">{a.error}</p> : null}
                  <small>Created: {new Date(a.createdAt).toLocaleString()}</small>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {tab === 'config' && configDraft ? (
          <section className="centcom-tab-content">
            <h3>CENTCOM Configuration & Rules of Engagement</h3>
            <div className="form-grid">
              <label>
                Command Execution Host
                <select
                  value={configDraft.hostId}
                  onChange={(e) => setConfigDraft({ ...configDraft, hostId: e.target.value })}
                >
                  {settings.hosts.filter((h) => h.enabled).map((h) => (
                    <option key={h.id} value={h.id}>{h.name}</option>
                  ))}
                </select>
              </label>

              <label>
                AI Model Provider
                <select
                  value={configDraft.provider}
                  onChange={(e) => {
                    const provider = e.target.value as CentcomConfig['provider'];
                    const defaultModel = MODEL_PRESETS[provider]?.[0] || 'default';
                    setConfigDraft({ ...configDraft, provider, model: defaultModel });
                  }}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                  <option value="antigravity">Antigravity</option>
                  <option value="opencode">OpenCode</option>
                </select>
              </label>
            </div>

            <label>
              Model ID
              <input
                value={configDraft.model}
                onChange={(e) => setConfigDraft({ ...configDraft, model: e.target.value })}
              />
            </label>
            <div className="centcom-model-presets">
              <small>Presets:</small>
              {(MODEL_PRESETS[configDraft.provider] || []).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`text-button ${configDraft.model === m ? 'active-preset' : ''}`}
                  onClick={() => setConfigDraft({ ...configDraft, model: m })}
                >
                  {m}
                </button>
              ))}
            </div>

            <h4>C2 Authority Mode</h4>
            <div className="authority-picker">
              <label className={`authority-option ${configDraft.authority === 'gated' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="centcom-authority"
                  checked={configDraft.authority === 'gated'}
                  onChange={() => setConfigDraft({ ...configDraft, authority: 'gated' })}
                />
                <div>
                  <strong>Gated C2 (Recommended)</strong>
                  <p>CENTCOM inspects fleet state freely, but all mutating directives (launch, stop, interrupt, arbitrate) require one-click Watch Officer approval.</p>
                </div>
              </label>
              <label className={`authority-option ${configDraft.authority === 'autonomous' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="centcom-authority"
                  checked={configDraft.authority === 'autonomous'}
                  onChange={() => setConfigDraft({ ...configDraft, authority: 'autonomous' })}
                />
                <div>
                  <strong>Autonomous C2</strong>
                  <p>CENTCOM directly executes fleet C2 actions within configured directive and budget limits. Every action is logged to the Audit Log.</p>
                </div>
              </label>
            </div>

            <h4>Automated Event Triggers (Auto-Wake)</h4>
            <div className="checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={configDraft.triggers.onSpecopsHalt}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      triggers: { ...configDraft.triggers, onSpecopsHalt: e.target.checked },
                    })
                  }
                />
                Auto-wake on [!HALT] SPECOPS mission arbitration escalations
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={configDraft.triggers.onLoopFault}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      triggers: { ...configDraft.triggers, onLoopFault: e.target.checked },
                    })
                  }
                />
                Auto-wake on LoopBreaker repeated-failure faults
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={configDraft.triggers.onFlashTraffic}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      triggers: { ...configDraft.triggers, onFlashTraffic: e.target.checked },
                    })
                  }
                />
                Auto-wake on pending Flash Traffic tool approval requests
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={configDraft.triggers.onUnitFailed}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      triggers: { ...configDraft.triggers, onUnitFailed: e.target.checked },
                    })
                  }
                />
                Auto-wake on non-zero unit process exits
              </label>
            </div>

            <h4>Circuit Breakers & Safeguards</h4>
            <div className="form-grid">
              <label>
                Trigger Cooldown (seconds)
                <input
                  type="number"
                  min="10"
                  max="3600"
                  value={configDraft.triggers.cooldownSeconds}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      triggers: { ...configDraft.triggers, cooldownSeconds: Number(e.target.value) || 60 },
                    })
                  }
                />
              </label>
              <label>
                Max Auto-Turns per Hour
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={configDraft.triggers.maxAutoTurnsPerHour}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      triggers: { ...configDraft.triggers, maxAutoTurnsPerHour: Number(e.target.value) || 12 },
                    })
                  }
                />
              </label>
              <label>
                Max Directives per Turn
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={configDraft.maxDirectivesPerTurn}
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      maxDirectivesPerTurn: Number(e.target.value) || 5,
                    })
                  }
                />
              </label>
              <label>
                Max Cumulative Budget ($ USD)
                <input
                  type="number"
                  step="0.5"
                  min="1"
                  value={configDraft.maxBudgetUsd == null ? '' : configDraft.maxBudgetUsd}
                  placeholder="Unlimited"
                  onChange={(e) =>
                    setConfigDraft({
                      ...configDraft,
                      maxBudgetUsd: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </label>
            </div>

            <div className="inline-actions">
              <button
                className="button-primary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const next = await window.agentHQ?.configureCentcom(configDraft);
                    if (next) setState(next);
                  })
                }
              >
                Save Configuration
              </button>
              <button
                className="button-secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (window.confirm('Reset the CENTCOM session? A fresh commander chat transcript will be started while retaining the audit log.')) {
                      const next = await window.agentHQ?.resetCentcomSession();
                      if (next) setState(next);
                    }
                  })
                }
              >
                <RotateCcw size={14} /> Reset Commander Session
              </button>
            </div>
          </section>
        ) : null}

        <div className="dialog-actions">
          <button className="button-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
