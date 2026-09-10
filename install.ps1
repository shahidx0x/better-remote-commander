# Install the Better Remote Commander agent (and optionally relay) from the latest GitHub release.
#   irm https://raw.githubusercontent.com/shahidx0x/better-remote-commander/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm .../install.ps1))) -Relay     # also install the relay CLI
param([switch]$Relay)
$ErrorActionPreference = 'Stop'
$repo = 'shahidx0x/better-remote-commander'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.13+ is required: https://nodejs.org' }
$tag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
$ver = $tag.TrimStart('v')
$base = "https://github.com/$repo/releases/download/$tag"
Write-Host "Installing agent $tag"
npm install -g "$base/brc-shared-$ver.tgz" "$base/brc-agent-$ver.tgz"
if ($Relay) { Write-Host "Installing relay $tag"; npm install -g "$base/brc-relay-$ver.tgz" }
Write-Host "`nDone. Next:  brc-agent --relay https://your-relay.example.com"
