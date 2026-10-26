# Production test coverage

The acceptance target is **100% statements, branches, functions, and lines in
every executable production file**, plus every documented workflow at each
applicable contract, unit, integration, functional, and end-to-end layer.
Passing the existing suite inventory alone does not establish that target.

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
test processes are running. Build with `AGENTC2_COVERAGE=1 npm run build`, then run
the existing suite groups with `AGENTC2_COVERAGE=1`. Coverage is opt-in; ordinary
test entrypoints retain their existing behavior. Collect all required native
and isolated groups from `tests/suites.json`, including packaged startup and
updater tests. Linux display tests need Xvfb, and Linux UI tests also need a
window manager and notification daemon as configured by the existing CI script.
SSH tests require explicitly configured disposable hosts. Cleanup must use its
own disposable SSH account and the guarded QA home; never use a real user's
home.

Run `npm run test:coverage:report` to combine retained Python process data and
Node/Electron/browser V8 data. It does not clear prior collection. Do not combine
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

The executable denominator includes all `.cjs` and `.py` production files under
`electron/` and `.ts`/`.tsx` renderer files under `src/`, including files that no
test loads. CSS, image assets, JSON data, and erased TypeScript declarations are
not executable code. Declaration-only exclusions are derived from the AST;
adding a runtime export puts the file back into the denominator. Dependencies,
fixtures, generated bundles, and test infrastructure are not application
source. Browser bundle execution is mapped back to original production files.
Coverage builds retain generated statement boundaries for accurate source-map
remapping; ordinary production builds keep their existing minification.

Python reports use the standard Coverage.py statement/line and branch metrics.
Named function regions are covered only when their bodies execute. Python
lambda callbacks additionally require negative runtime entry arcs; an executed
definition alone does not count. Ambiguous shared-line callbacks stay uncovered.
Anonymous JavaScript callbacks receive stable coverage-only names so C8 cannot
silently omit them from the function denominator. Copied
worker modules and renamed session hooks are attributed to production files
only when their bytes match; frozen v1 workers and modified fixtures cannot
contribute coverage for the current worker. The deployed-v1 compatibility and
upgrade tests remain required independently of these metrics.

Each compiled JavaScript layout keeps its own V8 offset space and source map.
Node unit transpilation, Vite development transforms, and built browser bundles
cannot overwrite one another's maps merely because they share an original
TypeScript filename. Source counters merge only at identical locations; an
uncalled child function or branch cannot borrow a containing range's count.
Only explicit unexecuted-file placeholders yield to measured execution. C8 is
pinned to 12.0.0 because the adapter uses its raw V8 parser and source mapper;
real subprocess regressions guard that interface and callback attribution.

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
hashes; generated layouts are already mapped to original line/column counters.

The `Complete production coverage` job combines counts, regenerates JSON/HTML
reports, and applies the same exact per-file 100% requirement. Its success is a
required dependency of `Quality gate`; release publication still depends on
that gate. All artifacts, provenance, suite logs, screenshots, and traces retain
the existing 14-day lifetime. Packaging rebuilds the optimized production
renderer, so coverage builds are not published as release packages.

The report compares integer covered/total counts for every metric in every
file. Rounded percentages, missing reports, missing production files, disabled
Python branch measurement, and absent Python function measurements cannot pass.
An unexecuted file remains a coverage gap. A successful report is evidence for
the measured code dimensions; workflow completeness requires the separate
[workflow-to-test audit](testing-workflows.md) and actual suite results, including explicit accounting
for skips and platform limitations.

## Current status

The 100% target is not yet met. The [six-shard CI run for 6e5ac4e](https://github.com/mlg151/AgentC2/actions/runs/40261948716)
passed all four native package jobs and both isolated Linux jobs. Its verified
aggregate measured 15807/16387 statements and lines (96.46%), 11654/13411 branch
exits (86.90%), and 2910/3284 functions (88.61%). There were 211 production
file/metric gaps. The aggregate and Quality gate correctly failed the exact
100% requirement. The combined HTML/JSON reports and source/suite provenance
are retained in `Complete-coverage-QA` for 14 days.

Further isolated helper and timeline tests do not replace a fresh complete
aggregate. The [workflow audit](testing-workflows.md) remains unfinished.
Do not merge the coverage work as satisfying the target until the complete
coverage and workflow requirements pass on the final revision.
