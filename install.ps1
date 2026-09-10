# Install the Better Remote Commander agent (and optionally relay) from npm.
#   irm https://raw.githubusercontent.com/shahidx0x/better-remote-commander/main/install.ps1 | iex
param([switch]$Relay)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.13+ is required: https://nodejs.org' }
npm install -g brc-agent
if ($Relay) { npm install -g brc-relay }
Write-Host "`nDone. Next:  brc-agent --relay https://your-relay.example.com"
