# OpenCode

AgentC2 supports OpenCode on local and SSH hosts, including Windows through WSL. Install `opencode` on the execution host and sign in there with `opencode auth login`. Credentials stay on that host. The standard `~/.opencode/bin` installer path is discovered even when the desktop or SSH connection lacks an interactive shell PATH.

Choose the OpenCode preset in **New session**. On upgrade, existing installations receive this preset once if they do not already have an OpenCode preset. Custom presets are preserved, and removing the added preset is respected on subsequent restarts. If all 100 preset slots are occupied, migration waits until a slot is available. You can also choose **Provider default** and select OpenCode. The phone uses presets saved on the desktop.

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

The desktop's permanent **Updates** control checks on startup and hourly, and offers a manual check. Packaged installations download and verify the newest stable release in the app, then offer **Restart and install**. Checking never downloads automatically, and downloading never quits the app. Progress and failures appear in the update dialog, with retry available.

Source installations offer **Build update** for the latest `main`. Git fetches the checked commit into a separate directory under the app's data directory, then npm installs dependencies and builds it. **Restart and install** opens that build, and subsequent launches of the original production checkout redirect to it. Original repositories, dirty files, settings, and saved sessions are preserved. Development launches and `--no-source-update` bypass redirection; manually rebuilding the original checkout at another revision also bypasses it. Git, Node.js 22, and npm must be available on PATH. A failed build leaves the current app running.

Native updates use electron-updater for Windows NSIS, Linux AppImage/DEB, and macOS ZIP applications. Developer ID signed Mac builds use Apple's native installer. Existing ad hoc Mac builds use a bundle replacement installer after SHA-512, code-signature integrity, application identity, and version verification; a hidden `.AgentC2-previous-….app` beside the app preserves the previous bundle for rollback. Mac installations in protected folders and Linux DEB installations may prompt for administrator authorization. No path disables Gatekeeper or removes quarantine attributes. Release publication verifies update-manifest checksums and combines both Mac architectures before publishing. PRs automatically receive the next patch version. After merging, a successful main quality gate creates the matching version tag and publishes the installable update. While publication is pending, packaged apps show **New main detected**. See [Versions and releases](releases.md). Older apps with only the GitHub link require one manual installation of this updater-capable version.
