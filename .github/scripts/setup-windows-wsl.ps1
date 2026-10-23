$ErrorActionPreference = 'Stop'
function Invoke-WSL {
  & wsl.exe @args
  if ($LASTEXITCODE -ne 0) { throw "wsl.exe failed ($LASTEXITCODE): $args" }
}
# Import a disposable distro rather than relying on a runner's default distro.
$archive = Join-Path $env:RUNNER_TEMP 'ubuntu-rootfs.tar.gz'
$url = 'https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz'
Invoke-WebRequest $url -OutFile $archive
$checksums = (Invoke-WebRequest 'https://cloud-images.ubuntu.com/wsl/jammy/current/SHA256SUMS').Content
$expected = ($checksums -split "`n" | Where-Object { $_ -match '\*?ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz$' }) -split '\s+'
if (!$expected[0] -or (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $expected[0]) { throw 'Ubuntu rootfs checksum mismatch' }
Invoke-WSL --import AgentC2-CI (Join-Path $env:RUNNER_TEMP 'agentc2-wsl') $archive --version 1
Invoke-WSL --set-default AgentC2-CI
Invoke-WSL -d AgentC2-CI -u root -- sh -ec 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 tmux'
Invoke-WSL -d AgentC2-CI -- sh -ec 'python3 --version && tmux -V'
