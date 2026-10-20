#!/usr/bin/env bash
set -euo pipefail
openbox > "${RUNNER_TEMP:-/tmp}/agentc2-openbox.log" 2>&1 &
wm_pid=$!
trap 'kill "$wm_pid" 2>/dev/null || true' EXIT
node tests/terminal.e2e.cjs
node tests/workspace.e2e.cjs
node tests/companion.e2e.cjs
