import type { ChatCapabilities, ChatSessionState, ChatClientState, ChatCommand, ChatPage, ChatReceipt, ChatSnapshot, ChatUpdate } from './chatTypes';
export type { ChatProvider, ChatSessionState, ChatCommandState, ChatCapabilities, ChatUsage, ChatQuestion, ChatAnswer, ChatEvent, ChatCommand, ChatReceipt, ChatSession, ChatPage, ChatPendingRequest, ChatClientState, ChatSnapshot, ChatUpdate, ChatApi } from './chatTypes';
export type Provider = 'codex' | 'claude' | 'antigravity' | 'terminal';
export interface ProviderTelemetry { status: 'reported' | 'stale' | 'unknown' | 'unsupported'; sampledAt: string | null; source: string | null; context: { usedTokens: number; capacityTokens: number; percent: number } | null; totalTokens: number | null; tokensPerMinute: number | null; costUsd: number | null; costBasis: string | null }

export interface Session {
  key: string;
  provider: Provider;
  id: string;
  transport?: 'terminal' | 'chat';
  chatSessionId?: string;
  chatState?: ChatSessionState;
  title: string;
  cwd: string;
  updatedAt: string | null;
  startedAt?: string | null;
  events?: { id: string; kind: string; at: string; source?: string }[];
  state: string;
  kind: 'managed' | 'external-tmux' | 'unmanaged' | 'conversation' | 'background';
  managed?: boolean;
  attached?: boolean;
  tty?: string;
  agentId?: string;
  canResume?: boolean;
  canAttach?: boolean;
  canInterrupt?: boolean;
  canStop?: boolean;
  hostId: string;
  hostName: string;
  stale?: boolean;
  missing?: boolean;
  exitCode?: number | null;
  outputTail?: string;
  presetName?: string;
  presetId?: string;
  providerSessionId?: string | null;
  headCommit?: string | null;
  branch?: string | null;
  repository?: string | null;
  worktreeOperation?: string;
  outputActivity?: number[];
  activity?: 'engaged' | 'idle' | 'halted' | 'fault';
  contextPercent?: number | null;
  telemetry?: ProviderTelemetry;
  roeProfile?: RoeProfile | 'unknown';
}

export interface Inventory {
  hosts: { id: string; name: string; target: string; user?: string; connected: boolean; error?: string }[];
  sessions: Session[];
  attention: AttentionItem[];
  faults: FaultRecord[];
  conflicts?: { id: string; hostId: string; detail: string; at: string }[];
}
export interface FaultRecord { sessionKey: string; id: string; at: string; label: string; count: number; status: 'pending' | 'review' | 'attempted' | 'interrupted' | 'failed' | 'unknown'; detail: string; autoInterrupt: boolean; result?: string }

export interface HostConfig { id: string; kind?: 'ssh' | 'local'; name: string; target: string; port: number; enabled: boolean; autoForward?: boolean }
export type RoeProfile = 'full' | 'gated' | 'provider-default';
export interface DevUrl { url: string; hostId: string; port: number; status: 'available' | 'opening' | 'ready' | 'failed'; localUrl: string | null; error: string | null }
export interface HostHealth { hostId: string; name: string; connected: boolean; cpuPercent?: number | null; memoryTotal?: number; memoryUsed?: number; disks?: { path: string; total: number; used: number; free: number }[]; sampledAt?: number; sshRoundTripMs?: number; activeChannels?: number; gpu?: { status: 'reported' | 'unknown' | 'unsupported'; sampledAt: number | null; devices: { name: string; memoryTotal: number; memoryUsed: number }[] }; error?: string }
export interface LaunchPreset { id: string; name: string; provider: Provider; command: string; args: string; cwd: string; instructions: string; fullPermissions: boolean; roeProfile?: RoeProfile | ''; attentionHooks: boolean; hostId: string; loopBreaker?: { enabled: boolean; autoInterrupt: boolean; threshold: number; windowMinutes: number; cooldownMinutes: number } }
export interface OpOrderMcp { name: string; transport: 'stdio' | 'http'; providers: Exclude<Provider, 'terminal'>[]; command: string; args: string[]; url: string; env: string[]; headers: Record<string, string> }
export interface OpOrder { version: 1; id: string; hostId: string; repository: string; enabled: boolean; instructions: string; overrides: { codex: string; claude: string; antigravity: string }; mcp: OpOrderMcp[] }
export interface OpOrderPreview { revision: string; repository: string; changes: { path: string; status: 'create' | 'update' | 'remove' | 'unchanged' | 'conflict'; diff: string; reason?: string }[]; unsupported: string[]; ready: boolean }
export interface SitrepPreviewInput { sourceHostId: string; name: string; operationId: string; targetHostId: string; repository: string; testCommand: string }
export interface SitrepTest { command: string; exitCode: number | null; timedOut: boolean; output: string; outputTruncated: boolean; durationMs: number; ranAt: number }
export interface SitrepPreview { version: 1; id: string; source: { operationId: string; name: string; repository: string; branch: string; baseCommit: string; headCommit: string; path: string }; target: { ready: boolean; reason: string; repository: string }; revision: string; patchPreview: string; patchPreviewTruncated: boolean; patchBytes: number; untracked: string[]; warnings: string[]; test: SitrepTest | null; ready: boolean }
export interface SitrepLaunchInput { id: string; operationId: string; objective: string; summary: string; nextSteps: string; title: string; slug: string; provider: Exclude<Provider, 'terminal'>; presetId?: string; roeProfile?: RoeProfile }
export interface ExerciseInput { title: string; hostId: string; repository: string; baseRef: string; prompt: string; testCommand: string; contestants: { provider: Exclude<Provider, 'terminal'>; presetId?: string; roeProfile?: RoeProfile }[] }
export interface ExerciseTest { command: string; exitCode: number | null; timedOut: boolean; output: string; outputTruncated: boolean; durationMs: number; ranAt: number }
export interface ExerciseContestant { id: string; provider: Exclude<Provider, 'terminal'>; presetId: string; roeProfile: string; slug: string; state: string; name: string; error: string; markedComplete: boolean; evidence: { revision: string; test: ExerciseTest | null; verifiedAt: number; explicitCompletion: boolean } | null }
export interface ExerciseRecord { version: 1; id: string; title: string; hostId: string; repository: string; baseCommit: string; prompt: string; testCommand: string; contestants: ExerciseContestant[]; state: string; createdAt: number; promotion: { contestantId: string; revision: string; target: string; branch: string; patchBytes: number; at: number } | null }
export interface ExerciseInspection { operationId: string; baseCommit: string; branch: string; path: string; active: boolean; headCommit: string; revision: string; patchBytes: number; patch: string; patchTruncated: boolean; untracked: string[]; warnings: string[]; test: ExerciseTest | null; evidence: ExerciseContestant['evidence'] }
export interface ExercisePromotionPreview { contestantId: string; target: string; branch: string; headCommit: string; revision: string; patchBytes: number; paths: number; ready: boolean; test: ExerciseTest | null }
export interface FlashRequest { id: string; name: string; provider: 'claude'; tool: string; action: string; session: string; turn: string; createdAt: number; expiresAt: number; state: 'pending' | 'submitted' | 'resolved' | 'expired'; decision: 'allow' | 'deny' | null; resolvedAt?: number; hostId: string; hostName: string; connected: boolean; branch: string }
export interface CleanupPolicy { hostId: string; provider: Exclude<Provider, 'terminal'>; enabled: boolean; days: number }
export interface Settings { hosts: HostConfig[]; presets: LaunchPreset[]; notifications: boolean; cleanup?: CleanupPolicy[]; roe?: { version: 1; hostDefaults: Record<string, RoeProfile> }; opOrders?: OpOrder[] }
export interface CleanupInput { hostId: string; provider: Exclude<Provider, 'terminal'>; days: number; ids?: string[]; allowPinned?: boolean }
export interface CleanupItem { key: string; id: string; provider: Provider; title: string; eligible: boolean; reason: string; bytes: number | null; updatedAt: string | null; files: string[]; estimated: boolean; missing?: boolean }
export interface CleanupPreview { token: string; hostId: string; provider: Provider; items: CleanupItem[]; expiresAt: number; truncated: boolean }
export interface CleanupResult { key?: string; hostId: string; provider: Provider; at: string; automatic: boolean; status: string; detail: string; bytes?: number; estimated?: boolean }
export interface CleanupState { lastRuns: Record<string, string>; results: CleanupResult[] }
export interface SessionMetadata { pinned: boolean; project: string; notes: string }
export interface SituationWorkspace { version: 1; anchorKey: string | null; targetKey: string | null; focusedPane: 'anchor' | 'target'; callsigns: Record<string, string>; groupBy: 'host' | 'repository'; collapsedGroups: string[]; urgentFirst: boolean; rosterCollapsed: boolean; zen: boolean; ligatures: boolean; shortcuts: Record<string, string>; missionStartedAt: number }
export interface Workspace { tabs: string[]; selectedKey: string | null; splitKey: string | null; metadata: Record<string, SessionMetadata>; situation?: SituationWorkspace }
export interface AttentionItem { id: string; sessionKey: string; hostId: string; title: string; provider: Provider; createdAt: string; acknowledged: boolean; requestId?: string; kind: 'completed' | 'failed' | 'input'; confidence: 'confirmed' | 'inferred'; detail: string; signature: string }

export interface TerminalState { id: string; cols: number; rows: number; controller: { id: string; name: string } | null; canControl: boolean; exitCode: number | null; connection: 'connected' | 'reconnecting' | 'exited' }
export interface TerminalSnapshot { text: string; sequence: number; state: TerminalState }
export interface UnitPreview { key: string; text: string; sampledAt: number | null; error: boolean }
export interface HistoryMatches { matches: { key: string; line: number; excerpt: string }[]; searched: number; total: number; truncated: boolean; errors: string[] }
export interface PairedDevice { id: string; name: string; createdAt: string; expiresAt: number }
export interface RemoteConfig { enabled: boolean; port: number; url: string; transport?: 'https' | 'tailnet-http' }
export interface RemoteStatus extends RemoteConfig { running: boolean; error: string; devices: PairedDevice[] }
export interface CompanionState { settings: Settings; metadata: Record<string, SessionMetadata>; attention: AttentionItem[] }

export interface CreateInput {
  launchId?: string;
  transport?: 'chat' | 'terminal';
  provider: Provider;
  cwd: string;
  title: string;
  conversationId?: string;
  agentId?: string;
  hostId?: string;
  presetId?: string;
  roeProfile?: RoeProfile;
  instructions?: string;
  recoverSitrep?: boolean;
  worktree?: { operationId: string; repository: string; baseRef: string; slug: string };
}

export interface WorktreeRecord { transport?: 'chat' | 'terminal'; operationId: string; repository?: string; baseRef?: string; baseCommit?: string; branch?: string; path?: string; name?: string; provider?: Provider; slug?: string; title?: string; presetName?: string; hasInstructions?: boolean; sitrepSource?: { version: 1; hostId: string; operationId: string; name: string; repository: string; revision: string }; state: string; status: { exists?: boolean; active?: boolean; owned: boolean; dirty?: boolean | null; merged?: boolean | null } }
export interface DiffScope { hostId: string; name: string; operationId: string }
export interface DiffFile { id: string; path: string; staged: boolean; unstaged: boolean; untracked: boolean }
export interface DiffHunk { id: string; text: string; actionable: boolean }
export interface DiffDetail { revision: string; staged: DiffHunk[]; unstaged: DiffHunk[]; summary: string; binary: boolean; large: boolean }

export interface AgentHQApi {
  readonly platform: string;
  getState(): Promise<{ settings: Settings; workspace: Workspace; attention: AttentionItem[] }>;
  saveSettings(settings: Settings): Promise<Settings>;
  previewOpOrder(order: OpOrder): Promise<OpOrderPreview>;
  enrollOpOrder(order: OpOrder, revision: string): Promise<Settings>;
  previewSitrep(input: SitrepPreviewInput): Promise<SitrepPreview>;
  launchSitrep(input: SitrepLaunchInput): Promise<{ name: string; hostId: string }>;
  listExercises(): Promise<ExerciseRecord[]>;
  exerciseCapabilities(hostId: string): Promise<Record<Exclude<Provider, 'terminal'>, boolean>>;
  createExercise(input: ExerciseInput): Promise<ExerciseRecord>;
  retryExercise(id: string): Promise<ExerciseRecord>;
  cancelExercise(id: string): Promise<ExerciseRecord>;
  markExerciseComplete(id: string, contestantId: string): Promise<ExerciseRecord>;
  inspectExercise(id: string, contestantId: string, verify: boolean): Promise<ExerciseInspection>;
  previewExercisePromotion(id: string, contestantId: string): Promise<ExercisePromotionPreview>;
  promoteExercise(id: string, contestantId: string, revision: string): Promise<ExerciseRecord>;
  listFlashTraffic(): Promise<FlashRequest[]>;
  decideFlashTraffic(input: { hostId: string; name: string; id: string; decision: 'allow' | 'deny' }): Promise<{ id: string; state: string; decision: string; duplicate: boolean }>;
  saveWorkspace(workspace: Workspace): Promise<Workspace>;
  setSessionPinned(key: string, pinned: boolean): Promise<boolean>;
  onSessionPinned(callback: (key: string, pinned: boolean) => void): () => void;
  onSessionsDeleted(callback: (keys: string[]) => void): () => void;
  previewCleanup(input: CleanupInput): Promise<CleanupPreview>;
  executeCleanup(token: string, keys: string[]): Promise<CleanupResult[]>;
  cleanupState(): Promise<CleanupState>;
  terminalPreviews(keys: string[]): Promise<UnitPreview[]>;
  searchHistory(query: string, keys: string[]): Promise<HistoryMatches>;
  acknowledge(id: string): Promise<AttentionItem[]>;
  onInventory(callback: (inventory: Inventory) => void): () => void;
  onAttentionOpen(callback: (key: string) => void): () => void;
  inventory(): Promise<Inventory>;
  health(): Promise<HostHealth[]>;
  onHealth(callback: (readings: HostHealth[]) => void): () => void;
  create(input: CreateInput): Promise<{ name: string }>;
  chatCapabilities(hostId: string): Promise<ChatCapabilities[]>;
  openChat(id: string, hostId: string): Promise<string>;
  readyChat(id: string, after?: number): Promise<ChatSnapshot>;
  chatHistory(id: string, after?: number, limit?: number): Promise<ChatPage>;
  takeChat(id: string): Promise<ChatClientState>;
  submitChat(id: string, command: ChatCommand): Promise<ChatReceipt>;
  chatReceipt(id: string, commandId: string): Promise<ChatReceipt>;
  closeChat(id: string): Promise<void>;
  pruneChat(id: string): Promise<ChatPage>;
  onChatEvents(callback: (update: ChatUpdate) => void): () => void;
  onChatState(callback: (state: ChatClientState) => void): () => void;
  listWorktrees(hostId: string): Promise<WorktreeRecord[]>;
  archiveWorktree(hostId: string, operationId: string): Promise<WorktreeRecord>;
  diffFiles(input: DiffScope): Promise<DiffFile[]>;
  diffDetail(input: DiffScope & { fileId: string }): Promise<DiffDetail>;
  diffHunk(input: DiffScope & { fileId: string; revision: string; hunkId: string; operation: 'stage' | 'revert' }): Promise<{ changed: true }>;
  interrupt(name: string, hostId?: string): Promise<void>;
  interruptFaults(): Promise<{ sessionKey: string; status: string; result?: string }[]>;
  resetFault(key: string): Promise<boolean>;
  stop(name: string, hostId?: string): Promise<void>;
  openTerminal(name: string, cols: number, rows: number, hostId?: string): Promise<string>;
  terminalHistory(id: string): Promise<{ text: string; truncated: boolean }>;
  readyTerminal(id: string): Promise<TerminalSnapshot>;
  terminalState(id: string): Promise<TerminalState>;
  takeTerminal(id: string): Promise<TerminalState>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  scrollTerminal(id: string, direction: 'up' | 'down' | 'latest', lines?: number): Promise<void>;
  readClipboard(): Promise<string>;
  readClipboardForTerminal(id: string): Promise<{ kind: 'text'; text: string } | { kind: 'image'; path: string }>;
  devUrls(sessionKey: string): Promise<DevUrl[]>;
  openDevUrl(id: string, url: string): Promise<string>;
  onDevUrls(callback: (sessionKey: string, urls: DevUrl[]) => void): () => void;
  writeClipboard(text: string): Promise<void>;
  terminalMenu(hasSelection: boolean): Promise<'copy' | 'paste' | 'latest' | null>;
  onTerminalData(callback: (id: string, data: string, sequence: number) => void): () => void;
  onTerminalExit(callback: (id: string, code: number) => void): () => void;
  onTerminalState(callback: (state: TerminalState) => void): () => void;
  remoteStatus(): Promise<RemoteStatus>;
  saveRemote(input: RemoteConfig): Promise<RemoteStatus>;
  pairRemote(): Promise<{ url: string; expiresAt: number }>;
  revokeRemote(id: string): Promise<RemoteStatus>;
  tailscaleStatus(): Promise<{ installed: boolean; state: string; url: string; error: string }>;
  onRemoteStatus(callback: (state: RemoteStatus) => void): () => void;
}

declare global {
  interface Window { agentHQ?: AgentHQApi }
}
