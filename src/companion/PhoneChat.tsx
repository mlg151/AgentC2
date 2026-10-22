import { lazy, Suspense, useMemo } from 'react';
import type { Session } from '../types';
import { companionChatApi } from '../chatClient';
import type { CompanionClient } from './client';

const ChatView = lazy(() => import('../components/ChatView').then((module) => ({ default: module.ChatView })));

export function PhoneChat({ client, session, connected, onResume, onRefresh }: { client: CompanionClient; session: Session; connected: boolean; onResume: () => void; onRefresh: () => void }) {
  const api = useMemo(() => companionChatApi(client), [client]);
  return <section className="phone-chat-detail" aria-label={`Session ${session.title}`}><div className="phone-section-heading"><div><h1>{session.title}</h1><p className="phone-muted">{session.hostName} · {session.provider}<br />{session.cwd}</p></div>{session.canResume ? <button disabled={!connected || session.stale} onClick={onResume}>Resume</button> : null}</div><div className="phone-chat"><Suspense fallback={<p role="status">Loading chat…</p>}><ChatView key={`${session.hostId}/${session.chatSessionId || session.id}`} api={api} sessionId={session.chatSessionId || session.id} hostId={session.hostId} connected={connected && !session.stale} onRefresh={onRefresh} /></Suspense></div></section>;
}
