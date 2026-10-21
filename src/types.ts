export type Provider = 'codex' | 'claude' | 'antigravity' | 'terminal';

export interface Session {
  key: string;
  provider: Provider;
  id: string;
  title: string;
  cwd: string;
  updatedAt: string | null;
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
  branch?: string | null;
  repository?: string | null;
  outputActivity?: number[];
  activity?: 'engaged' | 'idle' | 'halted' | 'fault';
  contextPercent?: number | null;
}

export interface Inventory {
  hosts: { id: string; name: string; target: string; user?: string; connected: boolean; error?: string }[];
  sessions: Session[];
  attention: AttentionItem[];
}

export interface HostConfig { id: string; name: string; target: string; port: number; enabled: boolean }
export interface HostHealth { hostId: string; name: string; connected: boolean; cpuPercent?: number | null; memoryTotal?: number; memoryUsed?: number; disks?: { path: string; total: number; used: number; free: number }[]; sampledAt?: number; error?: string }
export interface LaunchPreset { id: string; name: string; provider: Provider; command: string; args: string; cwd: string; instructions: string; fullPermissions: boolean; attentionHooks: boolean; hostId: string }
export interface CleanupPolicy { hostId: string; provider: Exclude<Provider, 'terminal'>; enabled: boolean; days: number }
export interface Settings { hosts: HostConfig[]; presets: LaunchPreset[]; notifications: boolean; cleanup?: CleanupPolicy[] }
export interface CleanupInput { hostId: string; provider: Exclude<Provider, 'terminal'>; days: number; ids?: string[]; allowPinned?: boolean }
export interface CleanupItem { key: string; id: string; provider: Provider; title: string; eligible: boolean; reason: string; bytes: number | null; updatedAt: string | null; files: string[]; estimated: boolean; missing?: boolean }
export interface CleanupPreview { token: string; hostId: string; provider: Provider; items: CleanupItem[]; expiresAt: number; truncated: boolean }
export interface CleanupResult { key?: string; hostId: string; provider: Provider; at: string; automatic: boolean; status: string; detail: string; bytes?: number; estimated?: boolean }
export interface CleanupState { lastRuns: Record<string, string>; results: CleanupResult[] }
export interface SessionMetadata { pinned: boolean; project: string; notes: string }
export interface SituationWorkspace { version: 1; anchorKey: string | null; targetKey: string | null; focusedPane: 'anchor' | 'target'; callsigns: Record<string, string>; groupBy: 'host' | 'repository'; collapsedGroups: string[]; urgentFirst: boolean; rosterCollapsed: boolean; zen: boolean; ligatures: boolean; shortcuts: Record<string, string> }
export interface Workspace { tabs: string[]; selectedKey: string | null; splitKey: string | null; metadata: Record<string, SessionMetadata>; situation?: SituationWorkspace }
export interface AttentionItem { id: string; sessionKey: string; hostId: string; title: string; provider: Provider; createdAt: string; acknowledged: boolean; kind: 'completed' | 'failed' | 'input'; confidence: 'confirmed' | 'inferred'; detail: string; signature: string }

export interface TerminalState { id: string; cols: number; rows: number; controller: { id: string; name: string } | null; canControl: boolean; exitCode: number | null }
export interface TerminalSnapshot { text: string; sequence: number; state: TerminalState }
export interface UnitPreview { key: string; text: string; sampledAt: number | null; error: boolean }
export interface HistoryMatches { matches: { key: string; line: number; excerpt: string }[]; searched: number; total: number; truncated: boolean; errors: string[] }
export interface PairedDevice { id: string; name: string; createdAt: string; expiresAt: number }
export interface RemoteConfig { enabled: boolean; port: number; url: string; transport?: 'https' | 'tailnet-http' }
export interface RemoteStatus extends RemoteConfig { running: boolean; error: string; devices: PairedDevice[] }
export interface CompanionState { settings: Settings; metadata: Record<string, SessionMetadata>; attention: AttentionItem[] }

export interface CreateInput {
  provider: Provider;
  cwd: string;
  title: string;
  conversationId?: string;
  agentId?: string;
  hostId?: string;
  presetId?: string;
  instructions?: string;
}

export interface AgentHQApi {
  readonly platform: string;
  getState(): Promise<{ settings: Settings; workspace: Workspace; attention: AttentionItem[] }>;
  saveSettings(settings: Settings): Promise<Settings>;
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
  interrupt(name: string, hostId?: string): Promise<void>;
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
