# Desktop platforms

Remote inventory and provider support still require **Linux SSH hosts**, regardless of the local desktop OS.

## Supported targets

| Local OS baseline | Architecture | Packages | Automated runner |
| --- | --- | --- | --- |
| Windows 10/11, with Windows OpenSSH Client | x64 | NSIS `.exe` | Windows Server 2022 |
| Ubuntu 22.04 or newer, Debian-compatible desktop | x64 | `.AppImage`, `.deb` | Ubuntu 22.04, Xvfb/Openbox |
| macOS 13 Ventura or newer | Intel x64 | `.dmg`, `.zip` | macOS 15 Intel |
| macOS 13 Ventura or newer | Apple Silicon arm64 | `.dmg`, `.zip` | macOS 15 Apple Silicon |

Linux targets GNOME and KDE Plasma with X11 or XWayland available. Native Wayland, other distributions/desktops, Linux/Windows arm64, and macOS universal bundles are outside this matrix. CI's Xvfb/Openbox session validates desktop mechanics, not every GNOME/KDE integration. Minimum OS versions and physical desktop integrations still need the manual checks below. Electron 44 requires [macOS 13 or later](https://releases.electronjs.org/release/v44.0.0).

## Linux installation

Install the Debian package with `sudo apt install ./AgentC2-<version>-linux-amd64.deb`. Launch **AgentC2** from the applications menu or run `agentc2`.

For AppImage, run `chmod +x AgentC2-<version>-linux-x86_64.AppImage`, then execute it as your normal user. AppImages need FUSE 2 (`libfuse2` on Ubuntu 22.04, `libfuse2t64` on newer Ubuntu). If FUSE is unavailable, use `--appimage-extract`, then run `squashfs-root/AppRun`. AppImage does not install its own applications-menu shortcut. The Debian package registers its launcher and PNG icon.

Install `openssh-client`; the system also needs Electron's GTK/NSS/X11 libraries (the Debian package declares runtime dependencies). In a Wayland desktop, use the XWayland compatibility session when native Wayland integration causes clipboard or input differences. Do not run AgentC2 as root or disable Chromium's sandbox to work around an installation problem. Ubuntu policies restricting unprivileged user namespaces may require administrator configuration of an AppArmor profile; use the Debian package and your distribution's Electron application guidance.

When remote access is enabled, closing **minimizes** the window instead of hiding it. A visible taskbar/overview entry remains available even if GNOME has no AppIndicator extension or a tray host is absent. KDE/compatible tray hosts also show Open, Disable remote access, and Quit. File → Quit (Alt opens the menu bar) always exits. With remote access disabled, closing the last window quits.

## macOS installation

Choose the DMG/ZIP matching your processor. Open the DMG and drag **AgentC2** to Applications, or extract the ZIP and move the app there. Launch from Finder. The app uses `/usr/bin/ssh`; it does not depend on a shell alias or Homebrew OpenSSH being in Finder's PATH.

Unsigned/ad hoc builds are not notarized and may be blocked by Gatekeeper. Verify the release source/checksum, then use macOS **Privacy & Security → Open Anyway** where your policy permits. Some managed Macs prohibit unsigned applications entirely. Prefer Developer ID signed and notarized releases; do not disable Gatekeeper globally. The release's `*-signing.txt` files distinguish verified publisher signatures and stapled notarization from unsigned builds.

The application menu supports About, Hide, Services, and Quit; Edit provides native editing actions; Window and Dock provide access to the window. With remote access off, closing the last window leaves the app in the Dock; Dock activation recreates the window and restores workspace state. With remote access on, closing hides the window and keeps the gateway active; Open in the Dock/menu bar restores it. ⌘Q fully exits.

Use ⌘K for quick switching, ⌘F for history search, ⌘C to copy terminal selection, and ⌘V to paste. Ctrl+C remains a terminal interrupt even when text is selected. Shift+PageUp/PageDown scroll history; compact keyboards may require Fn for PageUp/PageDown. Windows/Linux retain Ctrl-based shortcuts.

## SSH configuration and authentication

First connect using the same system `ssh` binary in a normal terminal. Verify the server's host-key fingerprint through a trusted source and accept it there. AgentC2 uses `BatchMode=yes` and `StrictHostKeyChecking=yes`, so it cannot answer password, passphrase, or unknown-host prompts. Configure an SSH alias, port, and key in `~/.ssh/config`, or `%USERPROFILE%\.ssh\config` on Windows, and enter the alias in Settings → SSH hosts. Set the same port in AgentC2 if your alias uses a non-default port.

Use an SSH agent or an appropriately protected key that works without interactive prompts. Encrypted keys must be unlocked in the agent before launching AgentC2. On Linux, ensure GUI applications inherit `SSH_AUTH_SOCK`; on macOS, use your configured system agent/Keychain integration and test a Finder launch separately. AgentC2 neither reads private keys nor runs a login shell locally to discover agent configuration. Provider aliases/presets run on the remote Linux host as before. Stop is still restricted to managed sessions, and opening links still permits only HTTP(S).

## Tailscale and background access

Install Tailscale on the computer and phone and sign into the intended private tailnet. Keep AgentC2 and the computer awake. Settings → Remote access shows the appropriate local-shell instructions. Use Tailscale Serve, not Funnel; the gateway always binds to loopback.

On macOS, install CLI integration in the Tailscale settings before running `tailscale serve --bg http://127.0.0.1:43127` in Terminal. For App Store installations, use `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg http://127.0.0.1:43127`. AgentC2 checks the app bundle, Apple Silicon Homebrew, Intel Homebrew/CLI integration, and PATH locations, forcing CLI mode with `TAILSCALE_BE_CLI=1` so a Finder launch does not accidentally open another GUI. See [Tailscale's CLI instructions](https://tailscale.com/docs/reference/tailscale-cli?tab=macos).

On Linux, sign in using your installed Tailscale client and run Serve from a terminal; it may require `sudo` or a configured Tailscale operator. On Windows, use Administrator PowerShell. Existing Serve routes must be preserved. The README describes the alternate private-IP transport and firewall restrictions.

Actual suspend disconnects companion sockets; on resume AgentC2 refreshes inventory/resources. Phones reconnect as observers and must take control again. Pending lifecycle operations are never replayed automatically. Remote tmux sessions continue through desktop sleep or Quit.

## Saved state and troubleshooting

Electron stores app data under `%APPDATA%` (Windows), `$XDG_CONFIG_HOME` or `~/.config` (Linux), and `~/Library/Application Support` (macOS), in the app's `agentc2`/`AgentC2` directory. Existing legacy directories retain precedence when appropriate. `AGENTC2_DATA_DIR` explicitly selects a directory, including for `scripts/pair-companion.cjs`; the legacy `AGENT_HQ_DATA_DIR` is also supported. These directories contain notes, settings, and device credentials, not SSH keys or terminal transcripts.

For a missing/wrong-architecture native module, use the package matching your processor. Source builds need Node.js 22 LTS, Python 3, and native build tools: MSVC C++/Spectre libraries on Windows, `build-essential` on Ubuntu, or Xcode Command Line Tools on macOS. Run `npm ci` on the target OS/architecture; never copy `node_modules` between platforms. Packaging rebuilds `node-pty`, unpacks it from ASAR, and restores executable permissions on macOS's spawn helper. `npm run test:package` checks the result by creating, resizing, writing to, and exiting a real local PTY.

## Validation coverage and manual release checks

The ordinary workflow builds and smoke-tests each target natively, and runs isolated Linux SSH terminal/workspace/companion regressions. The optional SSH QA workflow runs those live checks on Windows and both macOS architectures against a configured Linux account. Terminal fixtures cover wheel/history, resizing, keyboard input, clipboard, browser-link routing, lifecycle protections, persistence, and attention notification dispatch/click routing. Companion tests cover phone layouts, control handoff, window-close background access, gateway reconnect, and simulated suspend/resume. No model prompts are sent.

Before declaring a release validated on a desktop, record the OS version, architecture, session type, and results for these checks:

- Install and launch the downloaded installer/AppImage/DMG/ZIP; verify its checksum and signing report. Packaged smoke tests exercise the unpacked application produced by the packager, not OS installer UI.
- On GNOME and KDE, test launcher/taskbar association, minimize/restore, tray Open/Quit where available, clipboard with another application, and real notification banners. Test without a visible tray host.
- On each Mac architecture, launch from Finder with the expected SSH agent and Tailscale installation, use native menu Copy/Paste in terminal and settings fields, close/reopen via the Dock, and Quit from the app/menu bar.
- Perform physical sleep/wake with a live phone on cellular Tailscale; verify observer reconnection, explicit control handoff, fresh resource readings, and no duplicate lifecycle action.
- Check native notification permission/Focus/Do Not Disturb behavior and clicking a real notification. CI tests dispatch but does not validate OS notification permission prompts or delivery.

These physical-desktop, signing, and real-tailnet checks cannot be established by headless CI alone. CI results must be consulted for Windows/macOS execution; a local Linux build is not evidence that those platforms passed.
