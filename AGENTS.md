# Repository Guidelines

## Project Structure & Module Organization

AgentC2 is a Windows, Linux, and macOS Electron desktop app for managing remote Codex, Claude, and Antigravity CLI sessions over SSH.

- `src/`: React/TypeScript renderer; components in `src/components/`, shared bridge types in `src/types.ts`, styling in `src/styles.css`.
- `electron/`: CommonJS main process, preload IPC bridge, tmux control client, and ephemeral Python helper (`remote.py`).
- `tests/`: Node.js integration scripts for terminal behavior and provider launch modes.
- `assets/`, `design/`, `scripts/`: application icon, visual reference, and icon-generation helper.
- `dist/` and `release/`: generated renderer build and platform packages; excluded from Git.

## Build, Test, and Development Commands

Use Node.js 22 LTS and install dependencies with `npm ci`.

- `npm run dev`: start Vite on `127.0.0.1:5173` and launch Electron.
- `npm run build`: run TypeScript checks and build the renderer.
- `npm start`: launch Electron using the existing production build.
- `npm run dist`: build and package the current native platform into `release/`.
- `npm run test:ci`: renderer build and host-independent configuration, gateway, and platform checks.
- `npm run test:desktop` / `npm run test:package`: actual Electron and native PTY smoke checks, before/after packaging; use Xvfb on headless Linux.
- `npm run test:terminal`: build, then run Playwright/Electron terminal regression checks.
- `npm run test:launch-modes`: verify actual remote CLI permission flags, resume commands, and tmux history settings.

## Coding Style & Naming Conventions

Match existing code: two-space indentation, single quotes, and semicolons in TypeScript/JavaScript; four-space indentation and snake_case in Python. Use PascalCase component filenames and camelCase functions/variables in the renderer. Keep Electron modules as `.cjs`. TypeScript enables strict checks and rejects unused locals/parameters. No formatter or linter is configured; `npm run build` is the static-check baseline.

## Testing Guidelines

Tests are standalone `.cjs` scripts using Node assertions and Playwright where needed; `python3 tests/remote-helper.py` checks Linux helper exit-evidence parsing; no coverage threshold is configured. Live suites require local OpenSSH, key-based access, and remote Python 3/tmux; launch-mode checks also require provider CLIs. Set `AGENTC2_HOST` to the intended SSH test host; no host is hardcoded. Tests create remote sessions and clean up their fixtures. Preserve fixture isolation and terminal-test clipboard restoration. Run relevant suites for terminal, lifecycle, or launch changes and report any skipped checks.

## Commit & Pull Request Guidelines

There are no commits yet, so no established message convention exists. Use concise imperative subjects, such as `Fix terminal resize handling`. PRs should describe behavior changes, validation performed, and relevant issues; include screenshots for UI changes.

## Security & Configuration

Preserve renderer isolation, narrow preload APIs, SSH host-key verification, and managed-session-only stop controls. Keep `src/types.ts` synchronized with bridge changes. Never commit credentials or private keys. New/resumed agents currently launch with full permissions; review changes to those flags explicitly.

## Required CI and regression evidence

PRs target `main`. The rollout configures branch protection to require the GitHub Actions `Quality gate`, an up-to-date base, and resolved review conversations, including for administrators. Self-merge is supported with zero independent approvals. Force pushes and branch deletion are blocked.

Register every new executable test in `tests/suites.json`: required CI group, nested suite with its parent, or explicitly optional with a reason. Fixtures and reusable helpers belong in their named subdirectories. `npm run test:inventory` rejects omissions; `npm run test:ci` also validates inventory. Existing npm entrypoints remain available. Use Node 22 (`.nvmrc`).

Required tests use isolated fixtures without provider credentials or paid model calls. Windows CI provisions Ubuntu WSL1; missing Python/tmux is a failure. Cleanup CI uses a separate disposable SSH account. Never point cleanup tests at a real user's home. Suite reports, durations, skip messages, process logs, browser traces, and screenshots are retained as CI artifacts for 14 days. Tests are not automatically retried. Bug fixes need regression evidence reproducing the original failure; UI changes need screenshots. Report skipped checks and limitations in the PR.
