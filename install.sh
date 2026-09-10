#!/usr/bin/env bash
# Install the Better Remote Commander agent (and optionally relay) from npm.
#   curl -fsSL https://raw.githubusercontent.com/shahidx0x/better-remote-commander/main/install.sh | bash
#   ... | bash -s -- --relay      # also install the relay CLI
set -euo pipefail
command -v node >/dev/null || { echo "Node.js 22.13+ is required: https://nodejs.org"; exit 1; }
npm install -g brc-agent
[ "${1:-}" = "--relay" ] && npm install -g brc-relay
echo; echo "Done. Next:  brc-agent --relay https://your-relay.example.com"