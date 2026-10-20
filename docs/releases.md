# Builds and releases

## CI and artifacts

`.github/workflows/desktop.yml` runs for pull requests, pushes to `main`, version tags, and manual dispatch. It uses Node.js 22, `npm ci`, TypeScript/Vite, configuration/gateway/platform checks, and actual Electron/PTY tests before and after packaging. Native runners are Windows 2022 x64, Ubuntu 22.04 x64, macOS 15 Intel x64, and macOS 15 Apple Silicon arm64. `node-pty` rebuilds from source against the locked Electron runtime; its entire module is unpacked from ASAR. No live external SSH account or provider credential is needed by ordinary CI.

An isolated Linux SSH job creates a disposable account on its runner, trusts that runner's exact local host key, and runs the terminal, workspace, and companion suites under Xvfb/Openbox with an isolated D-Bus notification service. It does not use provider CLIs. A release waits for this job and all four native package jobs.

Open the successful **Desktop CI and releases** Actions run and download `AgentC2-win-x64`, `AgentC2-linux-x64`, `AgentC2-mac-x64`, or `AgentC2-mac-arm64`. Artifacts are retained for 14 days and contain:

| Target | Package names (`<version>` is `package.json`'s version) |
| --- | --- |
| Windows x64 | `AgentC2-<version>-win-x64-setup.exe` |
| Linux x64 | `AgentC2-<version>-linux-x86_64.AppImage`, `AgentC2-<version>-linux-amd64.deb` |
| macOS Intel | `AgentC2-<version>-mac-x64.dmg`, `AgentC2-<version>-mac-x64.zip` |
| macOS Apple Silicon | `AgentC2-<version>-mac-arm64.dmg`, `AgentC2-<version>-mac-arm64.zip` |

Each artifact also contains `AgentC2-<version>-<platform>-<arch>-signing.txt`, reporting whether a publisher signature was verified and, on macOS, whether a stapled notarization ticket was verified. AppImage/Debian filename architectures use the target format's conventional names. Supplementary blockmaps may also be attached. No automatic-update feed is configured.

Separate `Desktop-QA-<platform>-<arch>` artifacts contain screenshots of the rendered desktop and packaged app for review. They are not attached to releases.

## Publish a version

1. Update `package.json` and the lockfile together (`npm version <version> --no-git-tag-version`). Commit and merge the change. Complete the [manual platform checks](platforms.md#validation-coverage-and-manual-release-checks) for the release candidate.
2. Tag that commit with the exact version, for example `git tag v0.4.1`, then `git push origin v0.4.1`. Use a new version for each release.
3. The workflow rejects a tag/version mismatch and checks the lockfile versions. All builds and tests must succeed before publication. It verifies that every expected package/signing report is present, generates `SHA256SUMS.txt`, creates a draft GitHub Release, uploads all assets, and then publishes it. Publishing only runs for pushed `v*` tags, never for pull requests or manual workflow runs.
4. Download assets from the repository's Releases page. Check the signing report and checksum before installation. Inspect workflow logs and the remaining manual checks before advertising a target as validated.

Only the final release job has `contents: write`; build/test jobs have `contents: read`. The builder uses `--publish never`. No personal GitHub token is needed. If upload/publication fails after draft creation, inspect/delete the incomplete draft before rerunning the release job; do not silently replace a published release's assets.

## Optional signing and notarization

Without signing secrets, builds are unsigned or ad hoc and are not notarized. macOS bundles always receive an ad hoc signature after packaging (including on pull requests) so changed bundle resources and native helpers can launch on Apple Silicon. Ad hoc signing uses no certificate and leaves hardened runtime off; subsequent Developer ID signing enables hardened runtime for notarization. SmartScreen and Gatekeeper may warn or block them. Signing is optional for CI; supplying credentials makes signature verification mandatory. Signing secrets are passed only to the packaging step for version-tag builds, never to pull requests or ordinary branch builds.

Configure repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `WIN_CSC_LINK` | Windows publisher certificate as a base64 `.p12`/`.pfx` accepted by electron-builder |
| `WIN_CSC_KEY_PASSWORD` | Certificate password |
| `MAC_CSC_LINK` | Apple Developer ID Application certificate and private key as a base64 `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Matching Apple Developer team |

Set all three Apple notarization secrets along with the Mac certificate. electron-builder signs the bundle, native dependencies/helpers, and nested Electron components, then notarizes/staples when credentials are present. The checked-in hardened-runtime entitlement permits JIT; it does not disable library validation. The signing report runs `codesign --verify --deep --strict` and validates the stapled ticket when requested. Windows reports the packaged executable's Authenticode status. Signing errors fail packaging rather than silently claiming a signed release. Linux distribution signatures are not configured; release checksums provide integrity comparison, not a publisher signature.

For local signed builds, use electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables on the relevant native machine, plus the Apple variables for notarization. Run `node scripts/record-package.cjs` after packaging to verify/report the result. Never commit keys, certificates, tokens, or passwords. See [electron-builder signing](https://www.electron.build/v26/docs/code-signing) and [notarization](https://www.electron.build/v26/docs/features/code-signing/notarization/).

## Live SSH QA

The **Optional desktop SSH QA** workflow is manually dispatched and separate from release gating. Create a GitHub environment named `ssh-qa` with a dedicated, reachable **Linux** test account on port 22, Python 3, `tmux`, and no production sessions/data. Configure:

- Environment variable `AGENTC2_QA_TARGET`: `user@hostname` reachable from hosted runners.
- Environment secret `AGENTC2_QA_PRIVATE_KEY`: the dedicated unencrypted test key, restricted to that account.
- Environment secret `AGENTC2_QA_KNOWN_HOSTS`: trusted known-hosts entries for that hostname, obtained through a trusted channel.

Use environment access rules to restrict which refs can use these credentials. The workflow creates a scoped SSH alias, never disables host-key verification, and removes the local credentials afterward. Fixtures use random managed session IDs and clean up only their own sessions. Suites run on all four native runners. The optional provider checkbox additionally runs launch-mode/adapter tests and requires Codex, Claude, Antigravity, and `claude3` installed on the test account; it does not submit prompts.

Locally, set `AGENTC2_HOST` to an explicitly configured test alias, build, and run `npm run test:terminal`, `npm run test:workspace`, and `npm run test:companion`. Linux headless tests need Xvfb, libnotify, a D-Bus session, a notification daemon such as Dunst, and a window manager (for example, `AGENTC2_HOST=qa-host xvfb-run -a dbus-run-session -- bash .github/scripts/test-linux-ssh.sh` after building and installing Playwright Chromium). Set `AGENT_HQ_QA_EXECUTABLE` to a packaged executable to run these suites against that app. Screenshots and isolated app stores go to the OS temporary directory; clipboard contents are restored.
