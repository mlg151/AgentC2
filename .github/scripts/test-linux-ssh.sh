#!/usr/bin/env bash
set -euo pipefail
openbox > "${RUNNER_TEMP:-/tmp}/agentc2-openbox.log" 2>&1 &
wm_pid=$!
qa_notify_pid=''
cleanup() {
  kill "$wm_pid" 2>/dev/null || true
  if [[ -n "$qa_notify_pid" ]]; then kill "$qa_notify_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
if command -v dunst >/dev/null 2>&1; then
  dunst > "${RUNNER_TEMP:-/tmp}/agentc2-notifications.log" 2>&1 &
  qa_notify_pid=$!
  gdbus wait --session --timeout 10 org.freedesktop.Notifications
fi
node scripts/run-tests.cjs linux-ui
