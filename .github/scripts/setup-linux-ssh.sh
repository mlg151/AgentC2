#!/usr/bin/env bash
set -euo pipefail
# This script creates an account and configures SSH only on a disposable CI runner.
test "${GITHUB_ACTIONS:-}" = true
sudo apt-get update
sudo apt-get install -y openssh-server tmux xvfb openbox
sudo useradd --create-home --shell /bin/bash agentc2-qa
ssh-keygen -q -t ed25519 -N '' -f "$RUNNER_TEMP/agentc2-ci-key"
sudo install -d -m 700 -o agentc2-qa -g agentc2-qa /home/agentc2-qa/.ssh
sudo install -m 600 -o agentc2-qa -g agentc2-qa "$RUNNER_TEMP/agentc2-ci-key.pub" /home/agentc2-qa/.ssh/authorized_keys
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
sudo ssh-keygen -A
# Trust the exact local host key, without keyscan or disabling verification.
sudo awk '{ print "agentc2-ci " $1 " " $2 }' /etc/ssh/ssh_host_ed25519_key.pub > "$RUNNER_TEMP/agentc2-ci-known-hosts"
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
sudo systemctl restart ssh
ssh -o BatchMode=yes agentc2-ci 'python3 --version && tmux -V'
