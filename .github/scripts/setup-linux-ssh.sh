#!/usr/bin/env bash
set -euo pipefail
# This script creates an account and configures SSH only on a disposable CI runner.
test "${GITHUB_ACTIONS:-}" = true
sudo apt-get update
sudo apt-get install -y openssh-server tmux xvfb openbox libnotify4 dunst dbus-x11 libglib2.0-bin
qa_home=${AGENTC2_CLEANUP_QA_HOME:-/home/agentc2-qa}
if [[ -n "${AGENTC2_CLEANUP_QA_HOME:-}" ]]; then
  [[ "$qa_home" == /tmp/agentc2-cleanup-ssh-*/remote-home ]]
  sudo install -d -m 755 "$(dirname "$qa_home")"
fi
sudo useradd --create-home --home-dir "$qa_home" --shell /bin/bash agentc2-qa
sudo usermod --password '*' agentc2-qa
ssh-keygen -q -t ed25519 -N '' -f "$RUNNER_TEMP/agentc2-ci-key"
sudo install -d -m 700 -o agentc2-qa -g agentc2-qa "$qa_home"/.ssh
sudo install -m 600 -o agentc2-qa -g agentc2-qa "$RUNNER_TEMP/agentc2-ci-key.pub" "$qa_home"/.ssh/authorized_keys
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
ssh-keygen -q -t ed25519 -N '' -f "$RUNNER_TEMP/agentc2-ci-host"
# Trust the exact local host key, without keyscan or disabling verification.
awk '{ print "agentc2-ci " $1 " " $2 }' "$RUNNER_TEMP/agentc2-ci-host.pub" > "$RUNNER_TEMP/agentc2-ci-known-hosts"
cat >> "$HOME/.ssh/config" <<EOF

Host agentc2-ci
  HostName 127.0.0.1
  User agentc2-qa
  IdentityFile $RUNNER_TEMP/agentc2-ci-key
  IdentitiesOnly yes
  HostKeyAlias agentc2-ci
  UserKnownHostsFile $RUNNER_TEMP/agentc2-ci-known-hosts
  StrictHostKeyChecking yes
EOF
chmod 600 "$HOME/.ssh/config"
# Use a loopback-only daemon with no PAM login-session teardown. The fixture's
# detached tmux processes must survive between independent SSH requests.
cat > "$RUNNER_TEMP/agentc2-ci-sshd.conf" <<EOF
Port 22
ListenAddress 127.0.0.1
HostKey $RUNNER_TEMP/agentc2-ci-host
PidFile $RUNNER_TEMP/agentc2-ci-sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
AllowUsers agentc2-qa
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes yes
EOF
sudo systemctl stop ssh
sudo install -d -m 755 /run/sshd
sudo /usr/sbin/sshd -f "$RUNNER_TEMP/agentc2-ci-sshd.conf"
ssh -o BatchMode=yes agentc2-ci 'python3 --version && tmux -V'
ssh -o BatchMode=yes agentc2-ci "tmux new-session -d -s agentc2-ci-probe 'sleep 60'"
ssh -o BatchMode=yes agentc2-ci 'tmux has-session -t agentc2-ci-probe && tmux kill-session -t agentc2-ci-probe'
