#!/usr/bin/env bash
# Install the Better Remote Commander agent (and optionally relay) from the latest GitHub release.
#   curl -fsSL https://raw.githubusercontent.com/shahidx0x/better-remote-commander/main/install.sh | bash
#   ... | bash -s -- --relay      # also install the relay CLI
set -euo pipefail
REPO="shahidx0x/better-remote-commander"
command -v node >/dev/null || { echo "Node.js 22.13+ is required: https://nodejs.org"; exit 1; }
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
[ -n "$TAG" ] || { echo "no release found"; exit 1; }
VER="${TAG#v}"
BASE="https://github.com/$REPO/releases/download/$TAG"
echo "Installing agent $TAG"
npm install -g "$BASE/ses-systems-rdp-agent-$VER.tgz"
if [ "${1:-}" = "--relay" ]; then
  echo "Installing relay $TAG"
  npm install -g "$BASE/ses-systems-rdp-relay-$VER.tgz"
fi
echo
echo "Done. Next:  ses-rdp-agent --relay https://your-relay.example.com"
