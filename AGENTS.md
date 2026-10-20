# Repository Guidelines

## Project Structure & Module Organization

AgentC2 is a Windows Electron desktop app for managing remote Codex, Claude, and Antigravity CLI sessions over SSH.

- `src/`: React/TypeScript renderer; components in `src/components/`, shared bridge types in `src/types.ts`, styling in `src/styles.css`.
- `electron/`: CommonJS main process, preload IPC bridge, tmux control client, and ephemeral Python helper (`remote.py`).
- `tests/`: Node.js integration scripts for terminal behavior and provider launch modes.
- `assets/`, `design/`, `scripts/`: application icon, visual reference, and icon-generation helper.
- `dist/` and `release/`: generated renderer build and Windows installer; excluded from Git.

## Build, Test, and Development Commands

Use Node.js 20+ and install dependencies with `npm ci`.

- `npm run dev`: start Vite on `127.0.0.1:5173` and launch Electron.
- `npm run build`: run TypeScript checks and build the renderer.
- `npm start`: launch Electron using the existing production build.
- `npm run dist`: build and package the Windows NSIS installer into `release/`.
- `npm run test:terminal`: build, then run Playwright/Electron terminal regression checks.
- `npm run test:launch-modes`: verify actual remote CLI permission flags, resume commands, and tmux history settings.

## Coding Style & Naming Conventions

Match existing code: two-space indentation, single quotes, and semicolons in TypeScript/JavaScript; four-space indentation and snake_case in Python. Use PascalCase component filenames and camelCase functions/variables in the renderer. Keep Electron modules as `.cjs`. TypeScript enables strict checks and rejects unused locals/parameters. No formatter or linter is configured; `npm run build` is the static-check baseline.

## Testing Guidelines

Tests are standalone `.cjs` scripts using Node assertions and Playwright where needed; no coverage threshold is configured. Both suites require Windows OpenSSH, key-based access, and remote Python 3/tmux; launch-mode checks also require provider CLIs. Set `$env:AGENTC2_HOST` to the intended SSH test host; no host is hardcoded. Tests create remote sessions and clean up their fixtures. Preserve fixture isolation and terminal-test clipboard restoration. Run relevant suites for terminal, lifecycle, or launch changes and report any skipped checks.

## Commit & Pull Request Guidelines

There are no commits yet, so no established message convention exists. Use concise imperative subjects, such as `Fix terminal resize handling`. PRs should describe behavior changes, validation performed, and relevant issues; include screenshots for UI changes.

## Security & Configuration

Preserve renderer isolation, narrow preload APIs, SSH host-key verification, and managed-session-only stop controls. Keep `src/types.ts` synchronized with bridge changes. Never commit credentials or private keys. New/resumed agents currently launch with full permissions; review changes to those flags explicitly.
