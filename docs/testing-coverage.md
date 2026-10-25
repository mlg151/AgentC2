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
before establishing a new baseline after changing the collector. Raw data,
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

The report compares integer covered/total counts for every metric in every
file. Rounded percentages, missing reports, missing production files, disabled
Python branch measurement, and absent Python function measurements cannot pass.
An unexecuted file remains a coverage gap. A successful report is evidence for
the measured code dimensions; workflow completeness requires the separate
workflow-to-test audit and actual suite results, including explicit accounting
for skips and platform limitations.

## Current status

The 100% target is not yet met. Coverage collection and boundary regression
tests are being added; the workflow audit, cross-platform aggregation, required
coverage CI enforcement, and remaining production coverage gaps are unfinished.
Do not merge the coverage work as satisfying the target until those checks pass.
