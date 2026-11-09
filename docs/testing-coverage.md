# Production test coverage

PR #80 is being released for acceptance testing with aggregate coverage floors
of **93% statements, 89% branches, 93% functions, and 96% lines**. All six native
and isolated shards, the complete required suite inventory, and source/provenance
validation remain mandatory. No executable production module may be unobserved.

The original **100% in every file and every applicable workflow/test layer**
target remains an unfinished follow-up, not a claim or merge requirement for
this acceptance release. The strict coverage commands retain that target and
exit nonzero while gaps remain.

## Collect and inspect

Use Node 22 (`.nvmrc`) and install dependencies with `npm ci`. Coverage runs also
require `python3 -m pip install -r tests/requirements.txt` (use `python` on
Windows). The collector is copied into a test-only bootstrap directory so child
processes in private SDK virtual environments use the same pinned collector
without importing system SDK packages.

`npm run test:coverage -- core` builds without minification and with source maps, runs the selected group,
and reports both languages. Additional group names are accepted in order, for
example `npm run test:coverage -- core linux-python`. The default group is
`core`; this is a partial collection and must not be described as full workflow
coverage. A below-target report exits nonzero even when every selected suite
passes.

For a complete collection, first run `node scripts/coverage.cjs reset` when no
test processes are running. Build with `AGENTC2_COVERAGE=1 AGENTC2_SOURCE_COVERAGE=1 npm run build`, then run
the existing suite groups with `AGENTC2_COVERAGE=1`. Coverage is opt-in; ordinary
test entrypoints retain their existing behavior. Collect all required native
and isolated groups from `tests/suites.json`, including packaged startup and
updater tests. Linux display tests need Xvfb, and Linux UI tests also need a
window manager and notification daemon as configured by the existing CI script.
SSH tests require explicitly configured disposable hosts. Cleanup must use its
own disposable SSH account and the guarded QA home; never use a real user's
home.

Run `npm run test:coverage:report` to combine retained Python process data and
Node/Electron/browser original-source counters. It does not clear prior collection. Do not combine
data from different source revisions or instrumentation versions. Use `reset`
before establishing a new baseline after changing the collector. Collection
pins the Git revision and hashes of application source, test code, workflows,
dependencies, and collectors. A source or collector edit requires a reset; a
report cannot silently reuse measurements from the earlier snapshot. Local
uncommitted snapshots can be measured, but CI artifact export requires a clean
checkout. Raw data,
HTML reports, per-file summaries, and the exact remaining file/metric gaps are
written under the ignored `test-results/coverage/` directory. Existing suite
reports, process logs, traces, and screenshots remain under `test-results/`.

## Measurement boundaries

The executable denominator is defined in `scripts/production-sources.cjs`:
application code under `electron/`, `src/`, and `public/`, plus the documented
`scripts/pair-companion.cjs` runtime CLI. It includes the companion service
worker and the image-upload Python helper, which was previously embedded in a
JavaScript string. Files that no test loads remain in the denominator. CSS,
images, JSON data, dependencies, fixtures, generated bundles, and build/test
infrastructure are not application code. Declaration-only exclusions are
derived from the TypeScript AST; adding a runtime export puts a file back into
the denominator.

JavaScript and TypeScript use `istanbul-lib-instrument` 6.0.3 on the original
source AST, before TypeScript, React, Vite, or CommonJS transformations.
Statements on the same line remain separate counters. Every original function
has a static counter even if its enclosing callback never creates it; compiler
helpers do not add functions to the denominator. `coverage-source.cjs` checks
all production function counts against an independent TypeScript AST traversal.
The instrumenter uses Istanbul's statement, line, function, and branch metrics;
branch categories follow that instrumenter's source semantics. Workflow and
failure-path coverage remain separate requirements.

Node's test-only require/VM hook and the renderer loader instrument unchanged
source. Vite instruments original modules and the public service worker in both
development and QA builds. Browser snapshots include navigation/page/context
close boundaries and the separate service-worker global. Repeated cumulative
snapshots use a maximum within one process/document/worker epoch; independent
epochs add actual execution counts. Every collected map and source digest must
match a freshly generated original-source manifest. Runtime placeholders,
removed callbacks, modified source, malformed counts, and old-format artifacts
are rejected. An executable module that was never loaded cannot pass even when
it has zero metric counters. Coverage-exclusion directives are forbidden.

V8 raw reports and the legacy C8 adapter remain available for diagnostics, but
V8 percentages are not acceptance evidence: V8 can omit uncreated callbacks,
count compiler-generated functions, or vary branch ranges with the execution
profile. Legacy percentages must not be compared directly with the new fixed
original-source counters. Ordinary builds retain their existing optimization
and do not contain source counters.

Python uses Coverage.py 7.16.0 statement/line and branch metrics. Named function
regions require body execution. Lambda callbacks additionally require negative
runtime entry arcs; an executed definition alone does not count. Ambiguous
shared-line callbacks stay uncovered. Copied worker modules and renamed session
hooks are attributed only when their bytes match; frozen v1 workers cannot
contribute current-source coverage. Image upload still transfers an ephemeral
Python command: its compile filename contains a SHA-256 computed from the
actual decoded source bytes, and only a matching current-source digest is
attributed to `electron/image-upload.py`. The required deployed-v1 compatibility
and upgrade fixtures are unchanged. The Claude history reader and detached
launcher are separate Python files in the content-addressed worker bundle. New
bundles use those files; a deployed worker continues from its own existing
bundle until the established retirement checks permit handoff. No protocol,
journal, pending-command, or session migration is introduced, and uncertain
commands are never replayed to upgrade a worker.

## Required cross-platform CI result

Each native/isolated job exports one portable artifact after all of its required
suite groups pass:

| Shard | Required groups |
| --- | --- |
| Windows x64 | core, desktop, updater, windows, packaged |
| Linux x64 | core, desktop, updater, packaged |
| macOS Intel | core, desktop, updater, packaged |
| macOS Apple Silicon | core, desktop, updater, packaged |
| Isolated Linux SSH | linux-python, linux-web, linux-chat, linux-ui |
| Separate disposable cleanup account | cleanup |

`node scripts/coverage.cjs export <shard>` writes
`test-results/coverage/artifact/<shard>.json`. Shard names are
`desktop-win-x64`, `desktop-linux-x64`, `desktop-mac-x64`,
`desktop-mac-arm64`, `linux-ssh`, and `linux-cleanup`. An export is partial
evidence and does not pass the complete coverage target. It retains suite
durations, skip messages, exact JavaScript counters, and Python branch arcs and
contexts. The cleanup shard can have no local Python execution; its helper runs
over SSH, and all Python source remains in the combined denominator.

`node scripts/coverage.cjs aggregate <artifact-directory>` requires exactly one
artifact from every shard, matching revision/source/collector hashes and the
complete successful suite inventory for each job. It rejects failed, duplicate,
missing, cancelled, or malformed suite evidence, wrong native architectures,
missing branch collection, and skipped deployed-worker upgrade regressions.
Ordinary duplicate system-SDK skips remain visible alongside the required
private-runtime results. CRLF/LF checkout differences are normalized for text
hashes; original-source maps and counter identities must match exactly.

The `Production coverage acceptance` job uses
`node scripts/coverage.cjs aggregate <artifact-directory> --acceptance`. It
combines counts, regenerates JSON/HTML reports, and applies the aggregate floors
above with integer comparisons. It still rejects missing shards, invalid source
maps, failed required suites, skipped deployed-v1 upgrades, and unobserved modules.
The summary retains the original 100% target and every per-file gap, and records
`policy: "acceptance"`, the floors, and any acceptance failures. Without the flag,
the aggregate command enforces strict per-file 100%.

Coverage acceptance is a required dependency of `Quality gate`; release
publication still depends on that gate. All artifacts, provenance, suite logs, screenshots, and traces retain
the existing 14-day lifetime. Packaging rebuilds the optimized production
renderer, so coverage builds are not published as release packages.

The strict report compares integer covered/total counts for every metric in every
file; acceptance compares the summed counts without rounding. Rounded percentages, missing reports, missing production files, disabled
Python branch measurement, and absent Python function measurements cannot pass.
An unexecuted file remains a coverage gap. Reports retain both languages and
list never-loaded JavaScript modules in `summary.json` under `unobserved`; even
a zero-counter module prevents success until runtime evidence exists. A successful report is evidence for
the measured code dimensions; workflow completeness requires the separate
[workflow-to-test audit](testing-workflows.md) and actual suite results, including explicit accounting
for skips and platform limitations.

## Acceptance baseline and remaining work

The [six-shard run for 3a02d68](https://github.com/mlg151/AgentC2/actions/runs/40299442418)
passed all four native package jobs and both isolated Linux jobs. Its aggregate
measured **15452/16531 statements (93.47%), 11608/12946 branches (89.66%),
3063/3277 functions (93.47%), and 11898/12359 lines (96.27%)**. It included 123
production files, 69 complete files, 180 file/metric gaps, and no unobserved
modules. That run failed the former strict gate; it was not a test-suite failure.
The final PR revision must pass a fresh complete run under the acceptance policy.

Regression repairs include chat attachment/recovery races, desktop-sync draft
merging, modal focus in empty/busy dialogs, xterm disposal and phone scrolling,
bounded fleet redaction, and Codex stop signal races. The latter tolerates an
already-exited process group but still requires child reaping; permissions and
unconfirmed termination remain errors. Its new boundary checks and all 33
Linux/Python suites pass locally, including the unchanged deployed-v1 upgrades.
The additional existing Codex fixture suite passes with its optional installed
CLI probe explicitly skipped; CI provisions the required private runtimes.

The [workflow audit](testing-workflows.md) records outstanding layer-specific
checks. Authenticated provider/model calls, physical phone/desktop network and
sleep behavior, publisher signing, and interactive installers remain acceptance
or follow-up work. Required CI uses isolated homes/accounts and no paid model
calls. Passing this release gate does not establish 100% code or workflow coverage.
