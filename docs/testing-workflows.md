# Documented workflow audit

This is the behavior audit for the five requested test layers. It complements
[production coverage](testing-coverage.md); neither a list of tests nor a line
coverage percentage proves that every workflow is tested. The audit is open. The historical focused V8 counts below are diagnostic;
the original-source AST collector supersedes those denominators.

A contract check verifies a boundary's accepted inputs, outputs, errors, and
compatibility. A unit check isolates a production decision. Integration checks
execute collaborating production modules and their real local dependencies.
Functional checks assert an observable user outcome. An end-to-end check follows
the user action through the actual application, bridge, transport, execution
host, and readback where applicable. One suite can contain checks at multiple
layers, but a mocked renderer bridge alone is not an end-to-end check.
Provider protocol fixtures supply deterministic responses without credentials
or paid calls. Their results do not establish live provider/account or physical
network behavior. Every gap remains open until the corresponding assertion and
required suite result have been reviewed.

## Worktree lifecycle evidence reviewed

| Documented behavior | Contract and unit evidence | Integration evidence | Functional/end-to-end evidence | Remaining audit |
| --- | --- | --- | --- | --- |
| New isolated task resolves one base and leaves the primary checkout intact | `worktrees.py::test_parallel_isolation_and_idempotent_retry`; `worktree-boundaries.py::test_invalid_identity_and_admission_fields` | Disposable real Git branches, separate indexes, ownership records and parallel retry in `worktrees.py` | `workspace.e2e.cjs` creates the unit through Electron/SSH/tmux and checks branch/path association | Review the renderer's invalid-input and launch-failure paths at each applicable layer |
| Retry never dispatches a second live agent | `worktree-boundaries.py::test_live_retry_checks_tmux_identity_without_dispatching`; `test_chat_retry_binds_model_and_transport` | Real recorded ready/launch state with controlled tmux identity; `worktrees.py::test_reviewed_recovery_is_revision_bound_and_serialized` serializes concurrent retries | `chat-launch.e2e.cjs` and `centcom-adapters.e2e.cjs` exercise actual transport-backed creation/observation | Review desktop retry-picker interaction, expired reviews, and both transport variants |
| Ownership/branch/path changes refuse mutation | `worktree-boundaries.py` checks unsafe records, lock directories, canonical paths, branch mismatch, and changed provisioning commits | Real disposable Git detach, branch movement, record writes, links, and interrupted atomic publication | `workspace.e2e.cjs` and `centcom-adapters.e2e.cjs` verify owned-unit operations | Add explicit renderer error/outcome evidence for every documented ownership refusal |
| SitRep transfers exactly the reviewed patch before launch | `worktrees.py::test_sitrep_patch_is_applied_once_before_retryable_launch`; `worktree-boundaries.py` rejects malformed, oversized, binary and changed transfers | Real `git apply`, reverse-check crash recovery, failed check/apply/readback injection, and unchanged source checkout | `sitrep.e2e.cjs` reviews and sends across two isolated SSH routes, verifies recipient patch/trace and duplicate-safe retry | Review full validation/error matrix in the SitRep dialog |
| Restart recovery verifies retained patch and re-entered instructions | `worktrees.py::test_ready_sitrep_can_recover_after_restart_without_reapplying`; `worktree-boundaries.py::test_empty_sitrep_and_incomplete_ready_transfer` | Real ready records and changed target files; retry verifies the digest before dispatch | `sitrep.e2e.cjs` recovers a ready recipient from the owned-worktree picker | Verify all documented untracked-file and active-recipient GUI refusals |
| Archive preserves dirty, unmerged, active and unowned work | `worktrees.py::test_archive_preserves_dirty_unmerged_and_unowned_files`; boundary tests verify active and unavailable records | Real disposable merge/remove plus recovery after an interrupted removal; Git branch is retained | `workspace.e2e.cjs` checks dirty refusal, managed stop and clean archive; `centcom-adapters.e2e.cjs` executes reviewed archive | Review archive UI refusal/error presentation and persisted archived state |
| Diff stages/reverts only the reviewed hunk | `worktree-diff.py` and `worktree-diff-boundaries.py` check stale snapshots, wrong units, unusual names, binary/large files, artifact read races, hunk races and bounded subprocess failures | Real separate index/worktree mutations, partial staging, single-hunk revert and ownership checks | `workspace.e2e.cjs` opens the drawer and checks staged/index content, revert and dirty archive refusal | Review drawer keyboard focus, polling backoff, offline labels and every non-actionable file kind |

The isolated helper collection for the worktree lifecycle reaches 237/237
statements and lines, 120/120 branch exits, and 9/9 named functions. This is
helper-specific evidence from the existing lifecycle suite plus the new boundary
suite. It does not resolve the open UI audit items or establish application-wide
100% coverage. The diff helper separately reaches 173/173 statements/lines
and 68/68 branch exits with the existing hunk suite and new boundary suite.

Additional isolated helper evidence now closes the code metrics for GitHub
(87 statements/lines, 50 branch exits, 3 functions), SitRep (118 statements/lines,
48 branch exits, 4 functions), and Joint Exercises (95 statements/lines,
42 branch exits). These checks include stale and unavailable targets, read-only
preview, omitted/binary/large work, verification timeout/cleanup, changed source,
conflicting/failed promotion, and rejection before external mutation. The GitHub
URL regression reproduces acceptance of lookalike hostnames before the fix and
requires an exact `github.com` hostname afterward. The session cleanup helper additionally reaches 352/352 statements/lines,
200/200 branch exits, 11/11 named functions and 2/2 callbacks in the combined
isolated cleanup/helper collection. The expanded safety tests preserve histories
on active/unknown ownership, provider readback failure, a stale batch, oversized
shared data, or an uncertain native receipt. Workflow/layer audit items below
remain open.

The chat timeline boundary suite runs the same replay assertions through native
TypeScript and the actual Vite browser target, using ESM output to avoid adding
CommonJS interoperability helpers to the production denominator. Its isolated
collection reaches 95/95 statements/lines, 187/187 branch counters and 9/9
functions. It covers late deltas after completion, backward history with and
without known items, prefix flushing before/after completion, exact tool inputs,
submitted-request expiry, retained decisions and missing-ID fallbacks. Prefix
flushes use their established message-map invariant; no event can remove those
rows or change their kind during the synchronous reduction.

Focused collections also reach all four code metrics for approval bindings
(143 statements/lines, 250 branch counters, 37 functions), launch admission
(76, 70, 20), and attention classification (65, 94, 15). New cases cover host
removal during admission, freshly reviewed recovery revisions, queued dispatch
and inventory failures, target/control/request changes, unsupported structured
responses, stale workflow stages, missing outcome citations and malformed or old
provider events. The complete core group passes with these additions. Queue
entries contain release barriers only; failed dispatches cannot reject them.
Host routes are revalidated again after the asynchronous admission check.

## Remaining documentation and candidate evidence

The following is a routing index for the unfinished audit. Test names are
candidates to inspect, not claims that all five layers pass. Split each row into
its documented success, rejection, interruption, restart, and platform variants;
record the specific assertions and any missing layer before closing it.

| Documentation | Behaviors to audit | Existing evidence to inspect |
| --- | --- | --- |
| README: Run; platforms; releases | Install/start/build/package, dependency failures, native PTY, isolation, settings location/migration, signing, updates, version assignment and publication | `desktop.e2e`, `native-pty`, `packaging`, `platform`, `local-lifecycle`, `updates`, `source-updates`, `mac-updates`, `update-download.e2e`, `auto-version`, `ci-policy` |
| README: Situation Room | ORBAT grouping/filter/search, pins, callsigns/capacity, split panes/tab eviction, focus/keyboard/IME, notes/handoffs, multi-host routing, resources/staleness | `situation`, `productivity`, `readiness`, `workspace.e2e`, `desktop-sessions.e2e`, `component-ui.e2e`, `config-boundaries` |
| Situation Room: Overwatch | Paged read-only snapshots, unavailable/stale labels, paging/jump keys, detached singleton window, docking, IPC restrictions and selection sync | `workspace.e2e`, `overwatch-window.e2e`, `window-sender`, `main-contract` |
| README: scrolling/clipboard; clipboard-images | Wheel/page history, input versus scrolling, text/image paste, bounds, ownership/lost transfer, URL routing and focus restoration | `terminal-scroll`, `tmux-control`, `terminal.e2e`, `image-upload`, `image-upload-python`, `renderer-contract`, `desktop.e2e` |
| README: commands/history/help | Callsign command timeout/cancel, switcher/history limits, unavailable/truncated results, duplicate shortcuts and persistence | `productivity`, `situation`, `workspace.e2e`, `component-ui.e2e` |
| README: launch presets; rules-of-engagement | Shell arguments/instructions, create/resume, profile precedence, native flags/hooks, custom/gated rejection, model/host selection and existing-session safety | `remote-helper-python`, `remote-boundaries-python`, `chat-provider-contracts-python`, `chat-runtime-python`, optional `launch-modes` and `claude-gated` |
| README: attention; provider-telemetry; fleet-readiness | Confirmed versus inferred evidence, acknowledgements/notifications, hook deduplication, usage provenance/staleness, readiness precedence and clock persistence | `attention`, `readiness`, `provider-telemetry-python`, `remote-helper-python`, `workspace.e2e`, `loop-breaker` |
| README: companion/remote control | Pairing expiry/single use, cookies/origins/rate limits, HTTPS/private-IP transports, scoped handles, control handoff/resize/input, lifecycle receipts, links/history, filters, revoke/forget and disconnect | `pair-companion-cli`, `coverage-source-browser.e2e`, `remote-control`, `companion-client`, `renderer-contract`, `companion.e2e`, `companion-filters.e2e`, `component-ui.e2e` |
| README: background access; platforms | Native close/hide/minimize/tray/Dock/menu/Quit, simulated/physical sleep, observer reconnect without mutation replay, Tailscale discovery and installation | `platform`, `main-contract`, `desktop.e2e`, `companion.e2e`; physical desktop/tailnet checks remain unevidenced by headless fixtures |
| desktop-sync | Pair/connect/revoke, endpoint/auth/encryption/replay, limits/backoff, convergence/tombstones/local exclusions, offline restart/conflicts, pull tabs and active-service guards | `peer-sync`, `peer-sync-ui`, `component-ui.e2e` |
| reconnect | Retry/backoff/last-view cancellation, retained ownership, stale inventory, restart workspace, host-retarget invalidation, normal exit versus transport loss | `reconnect`, `local-service`, `workspace.e2e`, `chat-upgrade-python` |
| dev-tunnels | Loopback URL discovery, shared forward/probe, safe path/query preservation, explicit/automatic forward, failures/retries and detach/quit cleanup | `tunnels`, `tunnels.e2e`, `renderer-contract`, `remote-boundaries-python` |
| history-cleanup; README: retention | Provider eligibility/native deletion, exact review expiry/revision, pins, locks/activity, partial/uncertain results, no replay, local tombstones, daily batches and restart catch-up | `cleanup`, `cleanup.e2e`, `remote-helper-python`, `session-cleanup-boundaries-python`, `antigravity-cleanup-boundaries-python` |
| oporders | MCP conversion/admission, reviewed preview/enrolment, owned sections, unrelated-file preservation, rollback/modes/backups, conflicts, pause/remove and inventory reconciliation | `oporders-unit`, `oporders-python`, `oporders.e2e`, `oporders.ui.e2e`, `component-ui.e2e`, `centcom-oporders` |
| sitrep; worktrees; worktree-diffs | Reviewed Git transfer/lifecycle/diff behaviors above, including LFS, binary/untracked/size limits and verification command provenance | Worktree table above; `sitrep-python`, `worktree-diff-python`, `sitrep.e2e`, `workspace.e2e` |
| exercises | Serialized dispatch/partial retry, separate worktrees/base, completion/verification evidence, cancellation, winner review/promotion/retry, preserved losers and safe archive | `exercises`, `exercises-python`, `exercises.e2e` |
| flash-traffic; loop-breaker | Exact one-shot permissions and deadlines, stale/duplicate decisions, control ownership, confirmed failure streak/reset/cooldown, scoped interruption and restart uncertainty | `flash-python`, `flash.e2e`, `loop-breaker`, `loop-breaker-python`, `loop-breaker.e2e`, optional `claude-gated` |
| unified-chat; opencode; antigravity-sdk-evaluation | Provider capability/runtime preparation, sessions/turns/events/tools/requests/models, streaming/replay/cursors, receipts versus completion, deletion/retention, private runtimes and safe upgrades | `chat-protocol`, `chat-provider-contracts-python`, `chat-runtime-unit-python`, `chat-runtime-python`, **required** `chat-upgrade-python`, `chat-launch.e2e`, `chat-launch-local`, `chat-ui.e2e`, `chat-ui-opencode` |
| specops | Rank/workflow editing, graph/model/ROE validation, mission dispatch/observe/handoff, bounded denial/retry/HALT, artifact/journal/budget evidence, GitHub readiness/close checks, cancellation and uncertain restart | `specops`, `github-python`, `specops.ui.e2e`, `centcom-workflows.e2e`, `centcom-adapters.e2e` |
| centcom-contract: requests/outcomes | Every registered input/output/example, aliases, query/action limits, deduplication, journal correlation/retention/redaction, history patterns, separate submission/completion/acceptance | `centcom-schema`, `centcom-doctrine`, `centcom-evidence`, `centcom-history`, `centcom-boundary`, `centcom-adapters.e2e` |
| centcom-contract: approval/persistence | Reviewed identity/revision binding, authority, trusted actor, stale approval, configuration drafts/status races, async dispatch scope and interrupted/uncertain recovery | `centcom`, `centcom-dispatch`, `centcom-bindings`, `centcom-recovery`, `centcom.ui.e2e`, `component-ui.e2e` |
| centcom-contract: operational evidence | Unit/fleet/support/resource/artifact/diff/mission/context queries, exact owned targets, pagination, read-only status and adapter completion | `centcom-support`, `centcom-missions`, `centcom-operations`, `centcom-evidence`, `centcom-adapters.e2e` |
| centcom-contract: scheduling/spend/completion | Triggers/fallback/budgets/limits, serialized turns/cancellation/deadlines, automation propose/review/apply/dismiss, provider turn matching and retained completion facts | `centcom-turn`, `centcom-automations`, `centcom-launch`, `centcom-hooks.e2e`, `centcom-bridge.e2e`, `centcom-workflows.e2e` |

Historical implementation plans and previously recorded validation dates are not
fresh execution evidence. Native CI results must come from the current revision.
Optional provider probes, target-network checks, OS installer interaction,
physical phone/sleep, notification permission prompts, and publisher signing
remain explicit limitations until actual evidence is available. Do not mark the
goal complete or merge on the basis of this preliminary audit.

The source-inventory audit also includes the companion service worker and local
pairing CLI. The required browser suite checks real worker activation/cache
isolation, network-only private routes and POST/foreign-origin requests, failed
responses, offline asset reads, and 40-entry eviction. The CLI suite uses private
fixture directories for configuration precedence, invitation JSON, hash-only
persistence, and single-use consumption. Image-upload tests validate the same
extracted Python bytes both directly and through the base64 transfer wrapper,
including PNG corruption/truncation, private file modes, safe stale-file cleanup,
and symlink rejection. Remaining failure branches and desktop image-paste flows
still require review against the final source report.

The original-source focused collection for upload/binding boundaries covers
`image-upload.cjs` (49 statements, 29 branches, 10 functions, 31 lines),
`image-upload.py` (62 statements/lines, 24 branches, one function), and
`centcom-bindings.cjs` (175 statements, 235 branches, 37 functions, 110 lines)
at 100% in all four metrics. Image-transfer tests include spawn/close races,
stdout/stderr limits, invalid receipts, broken pipes, timeouts, unsafe parent and
root links, unreadable stale entries, and temporary-file disappearance after a
committed hard link. Approval capture's two unused private defaults are removed;
both callers already always pass normalized arrays. These focused results do
not replace the final native aggregate or workflow audit.

The inline Claude history reader and detached worker launcher are now separate
Python sources in the content-addressed worker bundle. Helper tests verify
missing/empty/populated native history, SDK failure propagation, exact detached
process flags, and a real detached child. Frozen-v1 upgrade fixtures remain
unchanged; all six compatibility, ownership, pending-command, SDK-preparation,
and unknown-receipt regressions must pass before merge.

The main-process contract suite also covers late service events after window
close, focusing an already visible detached Overwatch window, and repeated
remote-access saves without duplicate tray creation. The focused original-source
report reaches 457/457 statements, 140/140 branches, 158/158 functions, and
254/254 lines in `electron/main.cjs`. Its unused private sender default is
removed; the registration wrapper always supplies the observer permission.

Focused original-source coverage also reaches all four thresholds for capability
support (129 statements, 176 branches, 24 functions, 70 lines) and automation
handling (117 statements, 79 branches, 21 functions, 81 lines). Support tests use
the real operation registry and fleet boundary and reject any attempt to mutate
or acquire control. They cover disabled/disconnected hosts, legacy terminal
metadata, missing ownership/request/capability evidence, unsupported hooks,
unknown scopes, stale inspection, and unproven repository prerequisites.
Automation tests cover malformed/legacy drafts, absent persisted settings,
legacy settings without OpOrders, and an actual Store save racing a read-only
preview. JSON shape/revision checks already enforced by the published schema
are not repeated after that validator; invalid payloads retain their schema
errors before any persistence or enrollment. The existing real Git OpOrder and
both-authority engine integration suites remain required.


`app-workflows.e2e` exercises the real desktop renderer through a deterministic
public preload boundary: tabs/panes/anchor/callsigns/keyboard routes, persistent
notes/projects/pins, settings and clipboard recovery, inbox/fault/Flash traffic,
launch/handoff acknowledgement with delayed inventory and no automatic replay,
SPECOPS escalation/stage routing, host recovery, empty workspaces, and initial,
peer-sync, and native Overwatch event races. Actual SSH and native window suites
remain necessary for transport and OS behavior.

The app suite also rejects renderer errors through repeated React StrictMode
terminal disposal. xterm 5.5 fails this check with the upstream pending viewport
callback error; xterm 6 and matching addons resolve it. The desktop wheel handler
runs in DOM capture so xterm's changed viewport cannot consume provider scrolling
first. `terminal.e2e` checks rendered keyboard/mouse fullscreen movement, shell
history, fallback, clipboard, links, and retained state against real SSH/tmux.

`terminal-touch` checks the local touch adapter's direction, sub-row accumulation,
intent threshold, horizontal/multi-touch passthrough, identity, zero-size fallback,
cancellation, and disposal. `phone-terminal-touch.e2e` drives real Chromium touch
gestures over the production phone terminal with a normal-buffer snapshot. It
asserts older/newer rendered history, no remote writes/resizes/control requests,
and detach/reattach safety. This fixture covers xterm's local scrollback; live
SSH/tmux uses the alternate screen and the separate retained-history dialog.
Physical mobile/browser and publisher/platform limitations above remain open.


`service-boundaries` tests the real service factory with isolated Store files and
controlled process/clock boundaries. It covers health coalescing, CPU delta and
GPU freshness recovery, active-channel evidence, child spawn/exit/stdin/output
failures, bounded transport and stdin embedding, stale/disabled cached hosts,
normal/chat preview provenance, search candidate/match limits, pre-mutation
launch/permission/diff rejection, Flash queue disconnect/decision handling, and
active terminal/chat settings guards. It never opens a native PTY or contacts a
provider. Actual SSH, adapters, and native platform suites remain required.
