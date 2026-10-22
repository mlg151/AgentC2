# OpenCode

AgentC2 supports OpenCode on local and SSH hosts, including Windows through WSL. Install `opencode` on the execution host and sign in there with `opencode auth login`. Credentials stay on that host. The standard `~/.opencode/bin` installer path is discovered even when the desktop or SSH connection lacks an interactive shell PATH.

Choose the OpenCode preset in **New session**. Existing installations can add a preset with provider **OpenCode** and launch command `opencode`, or choose **Provider default** and select OpenCode. The phone uses presets saved on the desktop.

## Structured chat

OpenCode **2.1.3** is verified through its [ACP interface](https://opencode.ai/v2/docs/cli/acp/). Other versions remain available in Terminal mode until their ACP behavior is verified.

Chat supports streamed messages, native session creation and loading, replayed native history, tool results, permission decisions, form questions, interruption, and stopping the owned ACP process. AgentC2 keeps its own durable command receipts and transcript journal. Closing a view leaves the worker running. Session control and replies use the same ownership rules on desktop and phone as other providers.

OpenCode's host/project model configuration applies. Native usage updates report context and USD costs when available; AgentC2 leaves unavailable measurements unknown. Steering, forks, and attachments are not advertised through AgentC2's structured interface.

## Permissions and Terminal mode

Full permissions automatically approves the provider's permission requests once. Terminal launches use `--auto`. Explicit provider deny rules remain effective. Provider-default launches preserve the host/project policy and surface permission requests in chat. OpenCode gated enforcement has not been verified, so AgentC2 rejects that launch profile rather than claiming to enforce it. A host whose default is gated needs a full or provider-default override for OpenCode.

Terminal mode supports custom commands/arguments, prompts with `--prompt`, exact-ID resume with `--session`, tmux history, detach/reattach, and managed-session stop. New sessions and resumes retain the selected permission policy.

## Inventory, worktrees, and history

Inventory discovers OpenCode processes, managed tmux sessions, and top-level saved conversations from the legacy `session` and current `session_v2` SQLite tables under `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode/opencode.db`). Migrated IDs take precedence. Saved conversations can be resumed in chat or Terminal. Worktrees, SitRep recipients, Joint Exercise contestants, filters, and pins accept OpenCode.

OpOrders share `AGENTS.md` guidance and convert selected MCP servers into V2's `opencode.json` → `mcp.servers`, preserving unrelated settings and resolving credential references on the host. An existing `opencode.jsonc` requires a manual merge before enrolling converted MCP servers.

Cleanup previews fingerprint the reviewed V2 session, messages, and event records, then delegate exact-ID deletion to `opencode session delete --standalone`. Live providers, queued messages, parent/child or fork relationships, legacy histories needing migration, changed previews, and unverified layouts are excluded. AgentC2 never edits OpenCode's shared SQLite database or removes project files itself.

## Session names and application updates

**Rename** is available on managed session panes and phone detail views, including structured chats, shells, and retained exited sessions. Names persist in the chat journal or tmux metadata and propagate through inventory to all connected views. Empty/control-character names and names over 100 UTF-16 code units are rejected. Renaming preserves IDs, notes, pins, and native conversation identity.

The desktop checks GitHub on startup and hourly. An **Update to …** button opens the newest stable release when its version is newer. If main contains new commits beyond the build's embedded revision, **New main available** opens the comparison. Source archives without Git metadata can still discover releases. Installation/rebuilding remains a user action; checks do not replace a running application. Requests have a timeout and a five-minute cache; outages preserve an already discovered update.
