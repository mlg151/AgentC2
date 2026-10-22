# Unified chat implementation

Tracked by [epic #28](https://github.com/mlg151/AgentC2/issues/28) and native sub-issues #30–#41. The original provider research remains in the epic. Creating the issues does not establish that the integrations are implemented or verified.

## Current state

The versioned contract, remote journal, detached worker/bootstrap, and shared desktop/companion service APIs are implemented. The Codex 0.163.0 adapter has pinned-schema protocol fixtures and an installed-CLI unauthenticated handshake test. Antigravity CLI 1.4.4 has text-stream fixtures. Claude SDK 0.2.172 with CLI 2.1.306 has installed-SDK/CLI permission and question tests against a loopback model fixture. Rendered chat views, session migration, SDK investigation, remaining adapter scenarios, and the integrated live-provider matrix remain in progress. Terminal sessions remain the normal user-facing execution path until session migration is delivered.

The contract has JavaScript/Python runtime validation and renderer types. Its manifest is `electron/chat-protocol.json`; command/event definitions are in `electron/chat-protocol.cjs`, `electron/chat_protocol.py`, and `src/chatTypes.ts`. Protocol version 1 rejects unknown commands and unexpected command fields. Candidate CLI versions are research targets, not a claim of end-to-end support. A provider must probe its actual host version and return verified capabilities before creating a structured session.

## Worker and data ownership

The ephemeral SSH helper installs a source-digested worker bundle into `~/.cache/agentc2/chat-v1/` on the remote Linux account. The detached worker uses a locked private Unix socket and owns its provider processes. Worker directories use mode 0700; the socket, database, and worker log use mode 0600. Linux peer credentials must match the account running the worker. SSH host-key verification stays enabled; no provider credential is transported into the renderer or companion.

The desktop service has narrow chat capabilities, open/ready/history, take-control, submit, receipt, and close APIs. Companion operations use the existing authenticated WebSocket gateway and revocation rules. Client view handles are scoped to their connection. Taking control waits for any already-dispatched command acknowledgement before changing ownership. Detaching every client removes local polling/subscriptions and leaves remote work running. Connection failures block new mutations until recovery; commands are not queued offline.

An incompatible running worker is reported explicitly and is never replaced while it may own remote work. A worker can retire for an upgrade only after every managed session is confirmed stopped/failed and all accepted/dispatching commands have settled. Retirement fences new commands before shutting down, then the helper deploys the new bundle against the same journal. Worker crash recovery preserves journal records, marks active sessions and unfinished commands unknown, and expires obsolete live-process requests. Reattaching a healthy worker after an SSH disconnect is distinct from recovering a destroyed provider stdio connection after worker loss.

## Receipts and transcript recovery

Every mutation carries a UUID `commandId`. The worker commits the command fingerprint and receipt before dispatching. Repeating the same ID and content returns its receipt; changing the content is rejected. A send reserves its turn before acknowledgement so two simultaneous submissions cannot both start a turn.

Receipt states are `accepted`, `dispatching`, `completed`, `failed`, and `unknown`. `completed` means the command was acknowledged by the adapter; a `turn.completed` event separately records generation completion. `failed` indicates a definitive rejection. An uncertain provider acknowledgement or worker restart becomes `unknown` and must not trigger automatic resubmission. Inspect the receipt and provider history before deciding whether to start new work.

Events have monotonic per-session sequences and provider session/turn/item identities. History pages are bounded by event count and bytes. Approval/question requests persist with the exact request, turn, and item identity. One response reserves that request; conflicting replies, stale identities, and replies after turn completion are rejected. Streaming deltas and final messages retain the same item identity so clients can reconcile rather than concatenate duplicate output.

## Retention and access

Automatic transcript expiration is disabled by default. Structured transcripts and tool/request content are durable remote data beyond the existing metadata-only desktop workspace file. Only the remote account and authenticated paired clients through AgentC2 may access them. Companion static caching must never include transcripts or API responses.

The journal supports an explicit local-worker prune operation for confirmed stopped/failed sessions. Live, starting, waiting, and unknown sessions cannot be pruned. Pruning removes transcript/request content while retaining session mappings and command fingerprints/receipts to prevent old retries from repeating work. Sequence numbers never restart; a history response exposes `retainedFrom` and `truncated` when content was removed. User-facing retention controls and integration with provider history cleanup are tracked in #40/#41.

## Validation

Use Node.js 22 LTS and Python 3. Run `npm run test:chat` for the renderer build, shared contract parity, SQLite/journal recovery, detached worker fixtures, service ownership/replay, and authenticated gateway tests. Linux worker tests launch only disposable fixture processes and never submit prompts to installed providers. Windows runs wire validation/parity; remote worker lifecycle tests target Linux. Each fixture cleans up its owned processes and files.

The tests cover lost acknowledgements, concurrent retries and sends, request replay/correlation, stale replies, worker restart uncertainty, transcript pruning, duplicate bootstrap, helper exit, scoped stop, controller races, reconnect, late subscriptions, and gateway revocation. Passing fixtures do not prove real provider authentication, protocol behavior, or live model turns. Those gates remain in #34/#37/#38/#41, alongside desktop/phone screenshots, workflow migration, and existing terminal/worktree/companion regressions.

## Codex adapter evidence and limits

Codex uses app-server over stdio with an initialization handshake, host-side authentication checks, create/resume, paginated history import, correlated approvals/questions, steering, and interruption. The adapter probes the exact schema-supported version before launch. `scripts/generate-codex-chat-schema.cjs` regenerates the checked-in structural schemas from Codex 0.163.0. Other versions remain unavailable until their protocol and behavior are validated. No model name is hardcoded; host configuration supplies it.

ROE matches existing terminal behavior: full sets `approvalPolicy=never` and `sandbox=danger-full-access`; gated sets `approvalPolicy=on-request`, `sandbox=read-only`, and `approvalsReviewer=user`. The adapter checks the returned effective values before accepting a session. Provider-default inherits the host configuration. The adapter does not change the terminal launch flags. Attachments and forks remain unavailable in the structured adapter until their controls are implemented and validated.

The Codex fixtures cover streamed/final reconciliation, cumulative token usage with unknown cost, allowed/denied writes, questions, expected-turn steering, interruption, paginated resume, authentication failure, effective ROE, bounded output, and command/receipt dispatch through the deployed worker bundle. The installed CLI test uses an isolated unauthenticated Codex home and submits no model request. Live authenticated Codex turns and live SSH/UI checks remain required; no SSH QA host is configured in the current environment.

## Claude SDK integration

The remote Python environment must contain `claude-agent-sdk==0.2.172`, and the host CLI must be 2.1.306. `electron/chat-claude-requirements.txt` records the SDK pin. The adapter requires API or supported cloud-provider authentication in the remote environment and does not reuse personal CLI subscription sign-in. Credentials remain in the provider process environment; the service and renderer receive capability/setup status.

SDK options explicitly load user/project/local settings and the Claude Code system preset in the requested working directory. Gated mode retains session ask rules for Bash/Edit/Write/NotebookEdit; full retains bypassPermissions. Approvals use the SDK callback. AskUserQuestion uses a PreToolUse hook so it remains interactive in full mode, with the SDK stdio permission channel enabled. Decisions bind to the exact tool-use ID and managed turn. Requests expire if cancelled or after the configured provider-hook waiting period, and their UI replies cannot authorize another tool.

The installed SDK/CLI loopback tests verify that gated denial prevents an actual disposable file write, approval permits that exact write, project instructions reach the model request, and a full-mode question answer reaches the tool result. They use a local model-response fixture, an isolated Claude configuration directory, and a dummy API key. No external Anthropic model turn or user credentials are used. Run `PYTHONPATH=<isolated SDK dependency directory> python3 tests/chat-claude-native.py` with the pinned SDK/CLI available. The normal suite explicitly skips this provider-boundary test when they are absent.

Claude usage normalization reads the latest cumulative `model_usage` and cost estimate, including cache-input tokens. It does not sum cumulative results across turns. Per-turn `usage` is retained in provider metadata. Unknown pricing remains unknown; reported SDK cost is an estimate. Context usage is shown only when the last main-agent message provides the necessary fields.

## Antigravity CLI integration

The adapter keeps stdin open, sends text-only user NDJSON, and waits for each turn result before accepting another prompt. It maps streamed text and the final response to one message identity, preserves structured tool errors and stderr diagnostics, and uses cumulative result usage as a snapshot. Soft-denied tool results remain denied even when the CLI reports SUCCESS. Process exit by itself never establishes successful work.

CLI approvals, questions, steering, attachments, and native-history import are unavailable. Resume passes the native conversation ID and retains provider context; prior CLI-rendered messages cannot be recovered through this stream. AgentC2's journal retains managed structured turns. Gated ROE is rejected because this CLI transport cannot return approval decisions. Full adds the existing skip-permissions flag and checks the init event; provider-default inherits host policy. Interrupt targets only the adapter's owned process group.

Fixtures cover two-turn serialization, cumulative counters, stream/final reconciliation, resume IDs, soft denials, tool errors, interruption, nonterminal outcomes, and effective launch mode. Live authenticated CLI validation remains in the provider matrix. The SDK evaluation is a separate deliverable in #39 and does not replace this adapter automatically.
