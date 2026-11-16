#!/bin/sh
# Native Android ARM64 Termux launcher for the compiled BRC Node agent.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -f "$HERE/packages/agent/dist/cli.js" ]; then
  echo "BRC Agent build missing; build the checkout first." >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js required: pkg install nodejs-lts" >&2
  exit 2
fi
if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep required: pkg install ripgrep" >&2
  exit 2
fi
export BRC_PLUGINS=none
export BRC_MAX_CONCURRENCY="${BRC_MAX_CONCURRENCY:-2}"
cd "$HERE"
exec node packages/agent/dist/cli.js --no-plugins --no-browser --auto-connect "$@"
