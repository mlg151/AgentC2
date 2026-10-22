export type ChatProvider = 'codex' | 'claude' | 'antigravity';
export type ChatSessionState = 'starting' | 'idle' | 'running' | 'waiting' | 'stopped' | 'failed' | 'unknown';
export type ChatCommandState = 'accepted' | 'dispatching' | 'completed' | 'failed' | 'unknown';
export interface ChatCapabilities {
  provider: ChatProvider;
  version: string | null;
  status: 'supported' | 'unsupported' | 'unverified';
  reason: string | null;
  streaming: boolean;
  history: boolean;
  resume: boolean;
  interrupt: boolean;
  approvals: boolean;
  questions: boolean;
  steering: boolean;
  forks: boolean;
  attachments: boolean;
}
export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  contextUsedTokens: number | null;
  contextCapacityTokens: number | null;
}
export interface ChatQuestion { id: string; question: string; options: string[]; multiple: boolean }
export interface ChatAnswer { questionId: string; answers: string[] }
type ChatEventData =
  | { type: 'session.updated'; data: { state: ChatSessionState; detail: string } }
  | { type: 'message.delta'; data: { text: string } }
  | { type: 'message.completed'; data: { role: 'user' | 'assistant'; text: string } }
  | { type: 'tool.started'; data: { name: string; input: string } }
  | { type: 'tool.completed'; data: { name: string; output: string; isError: boolean } }
  | { type: 'approval.requested'; data: { requestId: string; action: string; detail: string } }
  | { type: 'question.requested'; data: { requestId: string; questions: ChatQuestion[] } }
  | { type: 'request.resolved'; data: { requestId: string; state: 'resolved' | 'expired'; decision: 'allow' | 'deny' | 'answered' | null } }
  | { type: 'usage.updated'; data: ChatUsage }
  | { type: 'turn.completed'; data: { outcome: 'completed' | 'failed' | 'interrupted' | 'denied' | 'unknown'; detail: string } }
  | { type: 'error'; data: { code: string; message: string; retryable: boolean } }
  | { type: 'provider.event'; data: { method: string; payload: Record<string, unknown> } };
export type ChatEvent = ChatEventData & {
  protocolVersion: 1;
  sessionId: string;
  sequence: number;
  timestamp: string;
  provider: ChatProvider;
  providerSessionId: string | null;
  turnId: string | null;
  itemId: string | null;
};
type ChatOperation =
  | { operation: 'create'; sessionId?: never; payload: { provider: ChatProvider; cwd: string; title: string; roeProfile: 'full' | 'gated' | 'provider-default'; providerSessionId?: string; managedName?: string; instructions?: string; model?: string } }
  | { operation: 'send'; sessionId: string; payload: { text: string } }
  | { operation: 'steer'; sessionId: string; payload: { text: string; expectedTurnId: string } }
  | { operation: 'respond'; sessionId: string; payload: { requestId: string; turnId: string | null; itemId: string | null } & ({ decision: 'allow' | 'deny'; answers?: never } | { answers: ChatAnswer[]; decision?: never }) }
  | { operation: 'interrupt' | 'stop'; sessionId: string; payload: Record<string, never> };
export type ChatCommand = ChatOperation & { protocolVersion: 1; commandId: string };
export interface ChatReceipt { commandId: string; sessionId: string; state: ChatCommandState; result: Record<string, unknown> | null; error: string | null }
export interface ChatSession {
  model?: string | null;
  managedName?: string | null;
  canStop?: boolean;
  id: string;
  provider: ChatProvider;
  providerSessionId: string | null;
  title: string;
  cwd: string;
  roeProfile: 'full' | 'gated' | 'provider-default';
  state: ChatSessionState;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  capabilities: ChatCapabilities;
}
export type ChatPendingRequest = { requestId: string; turnId: string | null; itemId: string | null; state: 'pending' | 'submitted' } & (
  | Extract<ChatEventData, { type: 'approval.requested' }>
  | Extract<ChatEventData, { type: 'question.requested' }>
);
export interface ChatPage { session: ChatSession; events: ChatEvent[]; cursor: number; latestCursor: number; hasMore: boolean; retainedFrom: number; truncated: boolean; pendingRequests: ChatPendingRequest[]; pendingCommands: ChatReceipt[] }
export interface ChatClientState { id: string; sessionId: string; controller: { id: string; name: string } | null; canControl: boolean; connection: 'connected' | 'reconnecting' }
export type ChatSnapshot = ChatPage & { state: ChatClientState };
export type ChatUpdate = ChatSnapshot & { id: string };
export interface ChatApi {
  open(id: string, hostId: string): Promise<string>;
  ready(id: string, after?: number): Promise<ChatSnapshot>;
  history(id: string, after?: number, limit?: number): Promise<ChatPage>;
  take(id: string): Promise<ChatClientState>;
  submit(id: string, command: ChatCommand): Promise<ChatReceipt>;
  receipt(id: string, commandId: string): Promise<ChatReceipt>;
  close(id: string): Promise<void>;
  prune(id: string): Promise<ChatPage>;
  onEvents(callback: (update: ChatUpdate) => void): () => void;
  onState(callback: (state: ChatClientState) => void): () => void;
}
