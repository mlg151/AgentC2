import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, Check, ChevronDown, Circle, Link2Off, LockKeyhole, Send, Square, X, Zap } from 'lucide-react';
import type { ChatAnswer, ChatApi, ChatClientState, ChatCommand, ChatPage, ChatPendingRequest, ChatReceipt, ChatSession, ChatUpdate } from '../chatTypes';
import { chatCommandId, chatLink } from '../chatClient';
import { emptyChatTimeline, reduceChatTimeline, type ChatItem } from '../chatTimeline';
import './chat.css';

const plugins = [remarkGfm];
const markdownComponents: Components = {
  a: ({ href, children }) => href && chatLink(href) ? <a href={chatLink(href)} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => <span className="chat-image-reference">[Image: {alt || 'attachment'}]</span>,
};
const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={plugins} components={markdownComponents} skipHtml urlTransform={(url) => chatLink(url) || ''}>{text}</Markdown>;
});

const TimelineRow = memo(function TimelineRow({ item }: { item: ChatItem }) {
  if (item.kind === 'message') return <article className={`chat-message chat-message-${item.role}`} data-chat-item={item.id} aria-label={item.role === 'user' ? 'Your message' : 'Agent message'}><div className="chat-message-label">{item.role === 'user' ? 'You' : 'Agent'}{!item.complete ? <span className="chat-streaming">Streaming</span> : null}</div><div className="chat-markdown"><ChatMarkdown text={item.text} /></div></article>;
  if (item.kind === 'tool') return <details className={`chat-tool${item.isError ? ' chat-tool-error' : ''}`} data-chat-item={item.id}><summary><ChevronDown size={14} aria-hidden="true" /><strong>{item.name}</strong><span>{item.isError ? 'Failed or denied' : item.complete ? 'Finished' : 'Running'}</span></summary><div className="chat-tool-body">{item.input ? <><small>Input</small><pre tabIndex={0}>{item.input}</pre></> : null}{item.complete ? <><small>{item.isError ? 'Error / denial' : 'Output'}</small><pre tabIndex={0}>{item.output || '(No output)'}</pre></> : null}</div></details>;
  if (item.kind === 'request') return item.state === 'pending' || item.state === 'submitted' ? null : <div className="chat-request-history"><LockKeyhole size={13} aria-hidden="true" /><span>{item.title} · {item.decision === 'allow' ? 'Allowed once' : item.decision === 'deny' ? 'Denied' : item.decision === 'answered' ? 'Answered' : 'Expired'}</span></div>;
  if (item.kind === 'error') return <div className="chat-event-error" role="note"><strong>Provider notice</strong><p>{item.message}</p></div>;
  return <div className={`chat-turn-outcome ${item.outcome === 'completed' ? '' : 'chat-turn-warning'}`}><Circle size={9} aria-hidden="true" /><span>{item.outcome === 'completed' ? 'Turn finished' : item.outcome === 'interrupted' ? 'Turn interrupted' : item.outcome === 'denied' ? 'Turn ended with a denied action' : item.outcome === 'failed' ? 'Turn failed' : 'Turn outcome unknown'}{item.detail ? ` · ${item.detail}` : ''}</span></div>;
});

const Transcript = memo(function Transcript({ items }: { items: ChatItem[] }) {
  return <>{items.map((item) => <TimelineRow key={item.id} item={item} />)}</>;
});

function RequestCard({ request, disabled, onRespond }: { request: ChatPendingRequest; disabled: boolean; onRespond: (request: ChatPendingRequest, response: { decision: 'allow' | 'deny' } | { answers: ChatAnswer[] }) => void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [written, setWritten] = useState<Record<string, string>>({});
  if (request.type === 'approval.requested') return <section className="chat-request-card" aria-label="Action approval"><div className="chat-request-heading"><LockKeyhole size={17} /><strong>Action needs your approval</strong></div><p>{request.data.action}</p><details open><summary>Review the requested action</summary><pre tabIndex={0}>{request.data.detail}</pre></details><div className="chat-request-actions"><button disabled={disabled || request.state !== 'pending'} onClick={() => onRespond(request, { decision: 'deny' })}><X size={15} />Deny</button><button className="button-primary" disabled={disabled || request.state !== 'pending'} onClick={() => onRespond(request, { decision: 'allow' })}><Check size={15} />Allow once</button></div>{request.state === 'submitted' ? <small>Decision sent; waiting for the provider.</small> : null}</section>;
  const answers = request.data.questions.map((question) => ({ questionId: question.id, answers: [...(selected[question.id] || []), ...(written[question.id]?.trim() ? [written[question.id].trim()] : [])] }));
  return <form className="chat-request-card" aria-label="Agent questions" onSubmit={(event) => { event.preventDefault(); onRespond(request, { answers }); }}><div className="chat-request-heading"><LockKeyhole size={17} /><strong>The agent has a question</strong></div>{request.data.questions.map((question) => <fieldset key={question.id} disabled={disabled || request.state !== 'pending'}><legend>{question.question}</legend>{question.options.map((option) => <label className="chat-answer-option" key={option}><input type={question.multiple ? 'checkbox' : 'radio'} name={`${request.requestId}/${question.id}`} checked={(selected[question.id] || []).includes(option)} onChange={(event) => { setSelected((current) => ({ ...current, [question.id]: question.multiple ? event.target.checked ? [...(current[question.id] || []), option] : (current[question.id] || []).filter((value) => value !== option) : [option] })); if (!question.multiple) setWritten((current) => ({ ...current, [question.id]: '' })); }} />{option}</label>)}<label className="chat-written-answer">{question.options.length ? 'Or write an answer' : 'Your answer'}<input aria-label={`Answer: ${question.question}`} value={written[question.id] || ''} maxLength={10000} onChange={(event) => { setWritten((current) => ({ ...current, [question.id]: event.target.value })); if (!question.multiple && event.target.value) setSelected((current) => ({ ...current, [question.id]: [] })); }} /></label></fieldset>)}<div className="chat-request-actions"><button className="button-primary" type="submit" disabled={disabled || request.state !== 'pending' || answers.some((answer) => !answer.answers.length)}><Send size={15} />Send answers</button></div>{request.state === 'submitted' ? <small>Answers sent; waiting for the provider.</small> : null}</form>;
}

export function ChatView({ api, sessionId, hostId, enabled = true, connected = true, onRefresh }: { api: ChatApi; sessionId: string; hostId: string; enabled?: boolean; connected?: boolean; onRefresh?: () => void }) {
  const [timeline, setTimeline] = useState(emptyChatTimeline);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [control, setControl] = useState<ChatClientState | null>(null);
  const [requests, setRequests] = useState<ChatPendingRequest[]>([]);
  const [pendingCommands, setPendingCommands] = useState<ChatReceipt[]>([]);
  const [pending, setPending] = useState<{ command: ChatCommand; phase: 'submitting' | 'checking' | 'uncertain'; receipt?: ChatReceipt } | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [receiptError, setReceiptError] = useState('');
  const [wanted, setWanted] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [taking, setTaking] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [following, setFollowing] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [receiptAttempt, setReceiptAttempt] = useState(0);
  const handle = useRef<string | null>(null);
  const generation = useRef(0);
  const cursor = useRef(0);
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const preserve = useRef<{ height: number; top: number } | null>(null);
  const canControl = connected && wanted && control?.canControl && control.connection === 'connected';
  const writable = Boolean(canControl && session && !['starting', 'unknown', 'stopped', 'failed'].includes(session.state));

  const apply = useCallback((page: ChatPage) => {
    cursor.current = Math.max(cursor.current, page.cursor);
    setTimeline((current) => reduceChatTimeline(current, page));
    setSession(page.session);
    setRequests(page.pendingRequests);
    setPendingCommands(page.pendingCommands);
  }, []);

  useEffect(() => {
    if (!enabled || !wanted || !connected) return;
    const epoch = ++generation.current;
    let cancelled = false, id: string | null = null, ready = false;
    const buffered: ChatUpdate[] = [];
    setConnecting(true); setControl(null); setError('');
    const offEvents = api.onEvents((page) => {
      if (page.id !== id || cancelled) return;
      if (!ready) buffered.push(page);
      else { apply(page); setControl(page.state); }
    });
    const offState = api.onState((state) => { if (state.id === id && !cancelled) setControl(state); });
    void api.open(sessionId, hostId).then(async (next) => {
      id = next;
      if (cancelled || epoch !== generation.current) { await api.close(next).catch(() => {}); return; }
      handle.current = next;
      const snapshot = await api.ready(next, cursor.current || undefined);
      if (cancelled) return;
      apply(snapshot); setControl(snapshot.state); ready = true;
      for (const page of buffered) { apply(page); setControl(page.state); }
    }).catch((cause) => { if (!cancelled) setError(String(cause)); }).finally(() => { if (!cancelled) setConnecting(false); });
    return () => {
      cancelled = true; generation.current++; offEvents(); offState();
      if (id) void api.close(id).catch(() => {});
      handle.current = null;
    };
  }, [api, sessionId, hostId, enabled, wanted, connected, attempt, apply]);

  useEffect(() => {
    if (!pending || pending.phase === 'submitting' || !handle.current || !connected || control?.connection !== 'connected' || pending.receipt?.state === 'unknown') return;
    const id = handle.current, command = pending.command;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const receipt = await api.receipt(id, command.commandId);
        if (cancelled) return;
        setReceiptError('');
        if (receipt.state === 'accepted' || receipt.state === 'dispatching') timer = setTimeout(() => void check(), 750);
        else if (receipt.state === 'completed') { setPending(null); onRefresh?.(); }
        else {
          if (command.operation === 'send') setDraft((current) => current || command.payload.text);
          setError(receipt.error || 'The provider did not confirm this action. Inspect the conversation before repeating it.');
          setPending(receipt.state === 'unknown' ? { command, receipt, phase: 'uncertain' } : null);
        }
      } catch (cause) { if (!cancelled) { setReceiptError(String(cause)); setPending((current) => current ? { ...current, phase: 'uncertain' } : null); } }
    }
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, pending?.command.commandId, pending?.phase === 'submitting', pending?.receipt?.state, connected, control?.id, control?.connection, receiptAttempt, onRefresh]);

  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (preserve.current) { node.scrollTop = preserve.current.top + node.scrollHeight - preserve.current.height; preserve.current = null; }
    else if (follow.current) node.scrollTop = node.scrollHeight;
  }, [timeline]);

  async function submit(command: ChatCommand, retry = false) {
    if (!handle.current || !canControl || (pending && !retry && command.operation !== 'stop')) return;
    const epoch = generation.current;
    setPending({ command, phase: 'submitting' }); setError(''); setReceiptError('');
    try {
      const receipt = await api.submit(handle.current, command);
      setPending((current) => current?.command.commandId === command.commandId ? { command, phase: receipt.state === 'unknown' ? 'uncertain' : 'checking', ...(receipt.state === 'unknown' ? { receipt } : {}) } : current);
      if (epoch !== generation.current) return;
      if (command.operation === 'send' || command.operation === 'steer') setDraft((current) => current === command.payload.text ? '' : current);
    } catch (cause) {
      setPending((current) => current?.command.commandId === command.commandId ? { ...current, phase: 'uncertain' } : current);
      if (epoch === generation.current) setReceiptError(`Action outcome may be unknown. ${String(cause)}`);
    }
  }

  const respond = useCallback((request: ChatPendingRequest, response: { decision: 'allow' | 'deny' } | { answers: ChatAnswer[] }) => {
    void submit({ protocolVersion: 1, commandId: chatCommandId(), sessionId, operation: 'respond', payload: { requestId: request.requestId, turnId: request.turnId, itemId: request.itemId, ...response } });
  }, [api, sessionId, pending, canControl]);

  async function loadEarlier() {
    if (!handle.current || loadingHistory || !timeline.firstSequence) return;
    setLoadingHistory(true);
    const epoch = generation.current;
    try {
      const page = await api.history(handle.current, Math.max(timeline.retainedFrom - 1, timeline.firstSequence - 201), 200);
      if (epoch !== generation.current) return;
      if (viewport.current) preserve.current = { height: viewport.current.scrollHeight, top: viewport.current.scrollTop };
      setTimeline((current) => reduceChatTimeline(current, page));
    } catch (cause) { if (epoch === generation.current) setError(String(cause)); }
    finally { if (epoch === generation.current) setLoadingHistory(false); }
  }

  async function pruneTranscript() {
    if (!handle.current || !canControl || pruning || !window.confirm('Remove the managed transcript and tool/request content from this SSH host? Native provider history is separate and stays available. Session identities and command receipts are retained to prevent duplicate retries.')) return;
    const epoch = generation.current;
    setPruning(true); setError('');
    try {
      const page = await api.prune(handle.current);
      if (epoch === generation.current) apply(page);
    } catch (cause) {
      if (epoch === generation.current) setError(`Transcript removal could not be confirmed. Reopen chat to check retained content. ${String(cause)}`);
    } finally { setPruning(false); }
  }

  const active = session?.state === 'running' || session?.state === 'waiting';
  const sendable = writable && session?.state === 'idle' && !pending && Boolean(draft.trim());
  const unknown = pendingCommands.filter((receipt) => receipt.state === 'unknown');
  return <div className="structured-chat" aria-label="Structured agent chat">
    <div className="chat-controls"><span className="chat-live-state" role="status">{!wanted ? 'Detached' : !connected || control?.connection === 'reconnecting' ? 'Reconnecting' : connecting ? 'Connecting…' : session?.state || 'Waiting for chat'}</span><span className="chat-controller">{control?.canControl ? 'You control this chat' : control?.controller ? `${control.controller.name} has control` : 'Read only'}</span><div className="chat-control-buttons">{!wanted || (!connecting && !control && connected) ? <button onClick={() => { setWanted(true); setAttempt((value) => value + 1); }}>Attach chat</button> : null}{wanted && !control?.canControl ? <button disabled={!connected || !control || control.connection !== 'connected' || taking} onClick={() => { if (!handle.current) return; setTaking(true); void api.take(handle.current).then(setControl).catch((cause) => setError(String(cause))).finally(() => setTaking(false)); }}>Take control</button> : null}<button disabled={!canControl || !active || !session?.capabilities.interrupt || Boolean(pending)} onClick={() => void submit({ protocolVersion: 1, commandId: chatCommandId(), operation: 'interrupt', sessionId, payload: {} })}><Zap size={14} />Interrupt</button><button disabled={!control || !wanted} onClick={() => { setWanted(false); setControl(null); }}><Link2Off size={14} />Detach</button><button className="danger" disabled={!canControl || !session || session.canStop === false || session.state === 'stopped' || (Boolean(pending) && pending?.phase !== 'uncertain')} onClick={() => { if (window.confirm(`Stop “${session?.title}”? This ends its managed remote process.`)) void submit({ protocolVersion: 1, commandId: chatCommandId(), operation: 'stop', sessionId, payload: {} }); }}><Square size={13} />Stop</button></div></div>
    {error ? <p className="chat-local-error" role="alert">{error}<button aria-label="Dismiss chat error" onClick={() => setError('')}>×</button></p> : null}
    {receiptError ? <div className="chat-uncertain" role="alert"><p>{receiptError}</p><button disabled={!connected || !control} onClick={() => setReceiptAttempt((value) => value + 1)}>Check action status</button><small>The prompt will not be resent automatically.</small>{pending?.phase === 'uncertain' && pending.receipt?.state !== 'unknown' ? <button disabled={!canControl} title="Reuses the original action ID so an accepted command is deduplicated" onClick={() => void submit(pending.command, true)}>Retry same action</button> : null}</div> : null}
    {unknown.length || pending?.receipt?.state === 'unknown' ? <div className="chat-uncertain" role="status"><strong>A previous action has an uncertain outcome.</strong><p>Review this conversation and native provider history before repeating the action.</p></div> : null}
    <div className="chat-transcript" ref={viewport} role="log" aria-label="Conversation messages" aria-live="off" onScroll={(event) => { const node = event.currentTarget; const next = node.scrollHeight - node.scrollTop - node.clientHeight < 80; follow.current = next; setFollowing(next); }}>
      {timeline.firstSequence > timeline.retainedFrom ? <button className="chat-earlier" disabled={loadingHistory || !control || !connected} onClick={() => void loadEarlier()}>{loadingHistory ? 'Loading earlier messages…' : 'Load earlier managed messages'}</button> : null}
      {timeline.retainedFrom > 1 ? <p className="chat-history-note">Earlier transcript content was removed under the retention policy.</p> : null}
      {!timeline.items.length ? <div className="chat-empty"><strong>{connecting ? 'Connecting to remote chat…' : 'A clear view of your agent’s work.'}</strong><p>Messages, tools, and requests will appear here.</p></div> : <Transcript items={timeline.items} />}
    </div>
    {!following ? <button className="chat-latest" onClick={() => { follow.current = true; setFollowing(true); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }}><ArrowDown size={14} />Latest</button> : null}
    {requests.length ? <div className="chat-pending" aria-label="Pending agent requests">{requests.map((request) => <RequestCard key={request.requestId} request={request} disabled={!writable || Boolean(pending)} onRespond={respond} />)}</div> : null}
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); if (sendable) void submit({ protocolVersion: 1, commandId: chatCommandId(), operation: 'send', sessionId, payload: { text: draft } }); }}><label className="sr-only" htmlFor={`chat-draft-${sessionId}`}>Message to agent</label><textarea id={`chat-draft-${sessionId}`} aria-label="Message to agent" rows={3} maxLength={200000} value={draft} disabled={!writable} placeholder={!wanted ? 'Attach this chat to continue' : !canControl ? 'Take control to send a message' : session?.state === 'unknown' ? 'Inspect the uncertain session before resuming' : 'Message your agent…'} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && sendable) { event.preventDefault(); void submit({ protocolVersion: 1, commandId: chatCommandId(), operation: 'send', sessionId, payload: { text: draft } }); } }} /><div className="chat-composer-footer"><span>Text messages · Ctrl/⌘ + Enter to send</span><div>{session?.capabilities.steering && session.state === 'running' && session.activeTurnId ? <button type="button" disabled={!writable || Boolean(pending) || !draft.trim()} onClick={() => void submit({ protocolVersion: 1, commandId: chatCommandId(), operation: 'steer', sessionId, payload: { text: draft, expectedTurnId: session.activeTurnId! } })}>Send to active turn</button> : null}<button className="button-primary" type="submit" disabled={!sendable}><Send size={15} />{pending?.command.operation === 'send' ? 'Sending…' : 'Send'}</button></div></div></form>
    <div className="chat-usage" aria-label="Chat usage"><span>{session?.provider || 'Agent'} · {session?.capabilities.version || 'Version unavailable'}</span><span>Tokens {timeline.usage?.totalTokens == null ? 'unknown' : timeline.usage.totalTokens.toLocaleString()}</span><span>Est. cost {timeline.usage?.costUsd == null ? 'unknown' : `$${timeline.usage.costUsd.toFixed(4)}`}</span><span>Context {timeline.usage?.contextUsedTokens == null || !timeline.usage.contextCapacityTokens ? 'unknown' : `${Math.round(timeline.usage.contextUsedTokens / timeline.usage.contextCapacityTokens * 100)}%`}</span></div>
    {session?.capabilities.reason ? <p className="chat-capability-note">{session.capabilities.reason}</p> : null}
    <details className="chat-storage"><summary>Transcript storage</summary><p>Messages and tool/request content stay on the SSH host until you remove them. Native provider history is separate. Session identities and command receipts remain after removal to prevent duplicate retries.</p><button disabled={!canControl || pruning || Boolean(pending) || !session || !['stopped', 'failed'].includes(session.state) || pendingCommands.some((command) => command.state === 'accepted' || command.state === 'dispatching')} onClick={() => void pruneTranscript()}>{pruning ? 'Removing transcript…' : 'Remove managed transcript'}</button>{session && !['stopped', 'failed'].includes(session.state) ? <small>Stop this session before removing its managed transcript. Uncertain sessions require inspection first.</small> : null}</details>
  </div>;
}
