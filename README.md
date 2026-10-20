# AgentC2

AgentC2 is a Windows, Linux, and macOS desktop SSH manager for Codex, Claude Code, and Antigravity CLI conversations across configurable SSH hosts.

## Run

Install a package from [GitHub Releases](https://github.com/mlg151/AgentC2/releases), or download a package artifact from the **Desktop CI and releases** Actions workflow. Windows x64 uses NSIS, Linux x64 uses AppImage/Debian packages, and macOS 13+ uses separate Intel and Apple Silicon DMG/ZIP packages. See [platform setup and troubleshooting](docs/platforms.md) for prerequisites, desktop behavior, and unsigned-build limitations. See [release instructions](docs/releases.md) for the build matrix, artifact names, and signing configuration.

AgentC2 needs local OpenSSH and working key/agent authentication to your configured hosts. Configure Settings → SSH hosts, or set `AGENTC2_HOST` before first launch. Remote hosts remain Linux and need Python 3, `tmux`, and the provider CLIs you use. AgentC2 uses existing SSH config and known hosts; it does not store passwords or private keys.

Build from source with Node.js 22 LTS and the platform's native compiler tools:

```sh
npm ci
npm run dev
```

For a built app:

```sh
npm run build
npm start
```

`npm run dist` packages the current OS into `release/`. Explicit targets are `npm run dist:win`, `npm run dist:linux`, and `npm run dist:mac`; use a native runner for each target OS and architecture. Dependencies rebuild for the pinned Electron runtime during installation and packaging. Packages have no verified publisher signature unless signing credentials are supplied; per-platform signing reports accompany CI artifacts and releases.

## Productivity workspace

- **Pins and projects:** Pin sessions from the list or workspace toolbar. The project sidebar groups sessions by working directory; edit the Project field to assign a custom group. Search includes projects, host names, providers, directories, titles, and IDs.
- **Tabs and splits:** Opening a session keeps its terminal connected in its tab. Choose another open tab from the split selector to view both. The selected tab appears first; narrow windows stack the panes. Tabs, the selected session, and the split layout restore on restart. Close a tab to detach its terminal; the remote process keeps running. Up to 40 tabs can be open.
- **Quick switching:** Ctrl+K (⌘K on macOS) opens keyboard search for sessions, projects, New session, Settings, and the attention inbox. Use arrows and Enter to choose.
- **Launch presets:** Settings → Launch presets saves the provider, command, additional arguments, host, directory, starting instructions, full-permissions mode, and attention hooks. A **Claude (OpenRouter)** preset uses `claude3`; change it to your command if needed. Commands run in `bash -lic`, so aliases and functions must be available in that shell. Arguments are parsed as shell words and passed literally; starting instructions are quoted and passed as one positional prompt. Resume automatically adds the provider's conversation flag. Store provider credentials on the remote host, not in presets.
- **Notes and handoffs:** Notes & handoff keeps an objective, status, next steps, and links beside each session. Copy handoff includes the host, project, directory, and notes. Notes save automatically on each change.
- **Multiple hosts:** Settings → SSH hosts accepts SSH config aliases or user@hostname targets, ports, and enable/disable controls. Inventory and the inbox cover all enabled hosts; the header filters sessions by host. Close a host's terminal tabs before editing/removing its connection. Sessions with identical IDs on different hosts remain separate. An unavailable host shows an error and preserves its cached sessions as stale.
- **Live resources:** The resource strip remains visible beneath terminals and the inbox. Every five seconds it refreshes each enabled host's CPU utilization, used/total memory, and free/total disk space. CPU is measured between samples (the first reading says Sampling); memory excludes available filesystem cache. It reports `/` and the home filesystem when mounted separately. Readings retain their last values with an Unavailable/Stale label on failure; no reading is presented as live after 20 seconds without a sample. High utilization or low disk space is highlighted. Multiple hosts can be scrolled horizontally in the strip.

Settings, session metadata, workspace layout, and up to 500 inbox events persist in `workspace.json` in Electron's user-data directory (`%APPDATA%/agentc2` on Windows, `$XDG_CONFIG_HOME/agentc2` or `~/.config/agentc2` on Linux, and `~/Library/Application Support/agentc2` on macOS; packaged builds may use `AgentC2` capitalization). Existing installations retain their previous settings directory and paired devices. Override the directory with `AGENTC2_DATA_DIR` (or the legacy `AGENT_HQ_DATA_DIR`). This file contains notes and commands; it does not contain terminal transcripts.

Before first use, replace the `your-ssh-host` placeholder in Settings → SSH hosts with your own SSH config alias or `user@hostname`, or set `AGENTC2_HOST` before launching. Live SSH tests require `AGENTC2_HOST` explicitly; `AGENT_HQ_HOST` remains supported for existing setups. Internal session IDs, bridge names, cookies, and remote cache paths retain their legacy identifiers for compatibility.

## Phone companion and remote control

The companion is a mobile web app served by the desktop app. It can view live terminals and retained history, send prompts and special keys, create/resume agents with saved presets, start plain terminals, interrupt/stop managed sessions, inspect host resources, and acknowledge attention items. Pins, projects, and notes are visible; desktop tabs and phone navigation are independent. Host and preset editing stays on desktop.

On desktop or the companion, choose **New → Session type → Terminal** to start your remote account’s interactive login shell. Choose a host, working directory, and name; no agent CLI or launch preset is required. Terminals appear alongside agents, with a **Terminals** filter. **Detach** leaves the remote shell and its state running; **Attach** reconnects, and **Stop** ends the shell and removes its managed tmux session. The companion uses the same **Take control** handoff as agent sessions before accepting input or Stop.

HTTP(S) URLs in live chat/terminal output are clickable. The desktop opens links in the default browser; the companion opens a separate browser tab. Explicit terminal hyperlinks use the same handler. Other URL schemes are blocked.

1. Install/sign in to Tailscale on the computer and phone using the same intended tailnet. This computer must remain awake with AgentC2 running.
2. Open Settings → Remote access. Choose a local port (default `43127`). In Administrator PowerShell on Windows, Terminal on macOS, or a Linux terminal, run `tailscale serve --bg http://127.0.0.1:43127`. On macOS, enable the Tailscale CLI integration first; see [platform setup](docs/platforms.md). On Linux, prefix the command with `sudo` if Tailscale requires it. Follow Tailscale's HTTPS setup if prompted. Use Serve, not Funnel; access stays inside your tailnet. If this computer already serves another app, configure a separate HTTPS port without replacing its routes.
3. Enter the HTTPS origin printed by Tailscale, such as `https://your-pc.your-tailnet.ts.net`, enable remote access, and select Apply remote access. The gateway listens only on `127.0.0.1`.
4. Choose Pair a device and open the pairing link on your phone, or scan the QR code. Give the device a name and confirm pairing. The link expires in 15 minutes and can be used once. Pair each browser or home-screen installation separately if it uses a separate cookie store.
5. Open a session and choose Take control before typing. Desktop can reclaim control with the same button. One device owns input and terminal dimensions at a time; observers can scroll horizontally. Phone history browsing does not change the remote terminal's scroll mode. Composer Send pastes the text using the terminal's bracketed-paste handling, then presses Enter.

When enabled, closing the desktop window keeps monitoring and remote access running. Linux minimizes to the taskbar so desktops without tray integration remain accessible. Windows hides to the tray (or minimizes if tray creation fails); macOS hides while remaining accessible through the Dock and menu bar. The tray offers Open, Disable remote access, and Quit. Quit, sleep, or loss of connectivity disconnects the phone; tmux processes continue on their hosts. Reconnection restores viewing and requires an explicit control handoff before phone input. Interrupted/timed-out actions are never automatically replayed: refresh inventory before repeating an action whose outcome is uncertain.

If Tailscale DNS is disabled, select **Private Tailscale IP** instead. Run `tailscale serve --bg --tcp=8080 tcp://127.0.0.1:43127`, then use `http://<computer-Tailscale-IPv4>:8080` as the companion origin. Only IPv4 addresses in Tailscale's `100.64.0.0/10` range are accepted in this mode. The gateway still binds only to loopback; the TCP forwarder must remain tailnet-only, with inbound firewall access restricted to the Tailscale interface and address. Tailscale encrypts this connection even though the browser uses HTTP. HTTPS remains the default; public/LAN HTTP origins are rejected. Browser installation/service-worker features may require HTTPS; ordinary phone-browser controls work in either mode.

When you are away from the computer, an authorized local or remote shell on that computer can run `node scripts/pair-companion.cjs` from this repository to generate a one-use link without scanning a screen. This replaces any previous invitation. Treat the link like a temporary password. Its hash and expiration are stored in `companion-invitation.json`; it survives app restart until used or expired, and applying remote-access settings invalidates it.

Remote access defaults to disabled. Gateway settings, hashed device credentials, and a bounded 24-hour lifecycle-request ledger live in `remote-access.json` beside `workspace.json`. Paired-device cookies expire after 90 days; Revoke or Forget this device disconnects its active connections immediately. Revocation and shutdown remove only device subscriptions; another device's terminal remains attached. SSH credentials stay on the desktop and provider credentials stay on the remote host. Pairing credentials authenticate only the companion gateway. The companion never accesses the desktop clipboard or desktop settings APIs.

Use your browser's Add to Home Screen / Install action where supported. The manifest and service worker cache only static assets, never API responses or terminal output. Attention alerts update while the app is open; background push is not included. Tailscale authentication/HTTPS setup and a real-phone cellular check remain installation steps.

`npm run test:remote` covers gateway authentication/origin checks, pairing expiry/reuse/rate limits, scoped terminal handles, control ownership, snapshot sequencing, lifecycle deduplication, revocation, and disconnect cleanup. `npm run test:companion` runs live Electron/SSH and phone-size Chromium/Edge flows through a local transport proxy using the production HTTPS-origin/cookie rules; it never changes Tailscale configuration or sends model prompts. On Windows it uses installed Edge by default; set `AGENTC2_COMPANION_CHROMIUM=1` to use downloaded Chromium. On other platforms install Chromium with `npx playwright-core install chromium` first. Set `AGENT_HQ_COMPANION_BROWSER=webkit` to run with installed Playwright WebKit. The proxy test does not establish real Tailscale or physical-phone connectivity. Screenshots go to the OS temporary directory.

## Attention inbox

The app polls session state every 15 seconds while running. Acknowledge an item to clear it from the inbox; Show acknowledged restores the view. Notifications are optional in Settings; clicking one opens the corresponding session. Monitoring resumes when AgentC2 reopens.

New/resumed Codex and Claude presets can enable session-only provider reporting:

- **Codex:** The supported `notify` adapter records confirmed turn completion. It chains the user's configured notifier (including a selected profile when available). An explicit `notify=` preset argument takes precedence. Approval/input prompts use inferred terminal detection.
- **Claude / claude3:** Additional session settings merge hooks for Stop, StopFailure, PermissionRequest, notification prompts, and AskUserQuestion. These report completed/stopped turns, failed turns, and requests for input. They do not answer or change permissions. Managed policy, `--bare`, or disabled hooks can prevent provider reporting.
- **All providers and older sessions:** Confirmed exit codes produce process-completed/failed items. Recent terminal text can produce a **Possible input needed** item labeled **inferred**. Quiet output and disappearing sessions never establish completion. Antigravity and already-running sessions use this fallback unless their provider reports state directly.

Provider adapters keep only event IDs, event types, provider name, and timestamps in a bounded remote log under `~/.cache/agent-hq/<managed-session>/`; no prompt or response content is logged. Stop removes this session's adapter. No daemon or global provider configuration is installed. A completed turn/process is a signal to review its output, not proof the requested project work succeeded.

Provider references: [Codex notifications](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications), [Claude hooks](https://code.claude.com/docs/en/hooks).

## How sessions work

- **Managed:** Opening a managed chat automatically attaches it. The first managed chat attaches on a new workspace; saved tabs reconnect on startup. Use Attach after explicitly detaching. Closing AgentC2 leaves remote processes running. Interrupt sends Ctrl-C. Stop ends that `tmux` session and its CLI process. Newly launched managed sessions retain exited panes so exit status and output can be reviewed.
- **External tmux:** Existing `tmux` sessions running one of the CLIs can be attached or detached. AgentC2 does not stop them.
- **Unmanaged process:** A running CLI process outside `tmux` is listed read-only. SSH cannot take over its existing terminal. Find the saved conversation and use Resume to start a managed copy.
- **Saved conversation:** Codex records come from its local SQLite state; Claude records from its project JSONL files; Antigravity CLI IDs from its conversation files. Resume launches the provider's CLI with that conversation ID in a new managed terminal. Antigravity conversation titles and working directories are not available from the CLI files, so enter a working directory when resuming if needed.

Default presets start new and resumed agents with full permissions: Codex uses `--dangerously-bypass-approvals-and-sandbox`, and Claude and Antigravity use `--dangerously-skip-permissions`. Turn off Full permissions in a preset to use that command's configured defaults. Attaching an existing process retains its launch mode.

## Scrolling and clipboard

- Scroll the mouse wheel over a chat to browse retained terminal history. Shift+PageUp and Shift+PageDown also scroll. Click **Latest** to return to the current chat input.
- Fullscreen agents scroll their own transcript using mouse reporting or PageUp/PageDown; **Latest** sends Ctrl+End for Codex and Claude. Shells and inline agents use tmux history. Scrolling down at the live shell prompt leaves input active, and typing after browsing shell history returns to live input automatically.
- Drag over terminal text, then use **Copy**, Ctrl+C, or Ctrl+Shift+C on Windows/Linux, or ⌘C on macOS. macOS Ctrl+C always sends an interrupt; on Windows/Linux it sends an interrupt when there is no selection.
- Use **Paste**, Ctrl+V, Ctrl+Shift+V, or Shift+Insert (⌘V on macOS) to paste from the desktop clipboard. Pasting returns to live input first and preserves the CLI's bracketed-paste handling.
- Right-click the terminal for Copy, Paste, and Back to latest.
- **Find** or Ctrl+F (⌘F on macOS) searches a snapshot of up to 50,000 retained tmux history lines, including output from before attachment. Next/Previous or Enter/Shift+Enter navigates matches; Reload captures newer output. The search display shows surrounding context and clearly labels snapshots truncated to the most recent 4 million characters.

New managed chats retain up to 50,000 terminal lines. Existing chats expose the history already retained by tmux; older discarded output cannot be recovered. Terminal history reflects what the CLI rendered.

The app sends a Python helper over SSH for inventory, metrics, and lifecycle requests, and uses separate tmux control connections for scrolling. It does not install a service on the server. Runtime metadata lives in tmux options; optional provider adapters use session-specific files described above. Local pins, notes, and layout survive process exits.

`npm run test:terminal` runs a live desktop regression check using two isolated shells and two fullscreen transcript fixtures (with and without mouse reporting). It checks rendered scrolling, return to live input, clipboard handling, and the SSH fallback without sending prompts to agents. It restores the clipboard and removes its own fixture sessions. Set `AGENT_HQ_QA_EXECUTABLE` to test a packaged executable.

`npm run test:ci` runs the build and checks that require no live host. `npm run test:desktop` starts Electron and checks the native PTY, clipboard, switcher, menus, and window lifecycle; after packaging, `npm run test:package` repeats these checks against the packaged executable. Linux display tests use Xvfb in CI. The isolated Linux SSH CI job runs terminal/workspace/companion regressions against a disposable account, without provider prompts or external credentials. [Optional SSH QA](docs/releases.md#live-ssh-qa) runs against an explicitly configured test environment.

`npm run test:productivity` checks config validation, workspace persistence, attention confidence, transitions, acknowledgement, cursors, and restart deduplication. `npm run test:workspace` runs live Electron/SSH checks for the new UI, host routing, metrics, presets, notifications, inbox, history search, restart restoration, and unavailable-host recovery. `npm run test:launch-modes` verifies installed provider argv, resume flags, tmux history, and hook adapters using synthetic provider events, without submitting model prompts. Tests use isolated local stores and remote fixtures and restore the clipboard.

## Safety and scope

AgentC2 never reads provider authentication tokens or SSH private keys. Electron isolates the renderer from Node.js; narrow validated APIs cross the preload bridge. The companion uses short-lived pairing links and revocable HttpOnly device cookies over private Tailscale connections, with origin validation on mutations and WebSocket upgrades. HTTPS cookies retain their Secure and __Host protections; private-IP mode uses a separate cookie name. OpenSSH host-key verification remains mandatory. Stop is limited to sessions created by AgentC2 and requires confirmation. This app supports Antigravity **CLI** conversations, not Antigravity IDE windows.
