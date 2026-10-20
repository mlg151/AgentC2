#!/usr/bin/env bash
set -euo pipefail
openbox > "${RUNNER_TEMP:-/tmp}/agentc2-openbox.log" 2>&1 &
wm_pid=$!
trap 'kill "$wm_pid" 2>/dev/null || true' EXIT
qa_status=0
for qa_suite in terminal.e2e.cjs workspace.e2e.cjs companion.e2e.cjs; do
  if ! node "tests/$qa_suite"; then qa_status=1; fi
done
exit "$qa_status"
