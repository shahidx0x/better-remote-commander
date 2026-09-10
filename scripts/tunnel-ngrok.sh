#!/usr/bin/env bash
# Dev helper: run the relay on this machine behind a temporary ngrok URL (random hostname).
# For a stable URL use NGROK_DOMAIN in .env with the compose `ngrok` profile instead.
set -euo pipefail
PORT="${PORT:-3210}"
: "${BRC_ADMIN_PASSWORD:?set BRC_ADMIN_PASSWORD}"
ngrok http "$PORT" --log=stdout >/tmp/ngrok.log &
NGROK_PID=$!
trap 'kill $NGROK_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  URL=$(curl -s localhost:4040/api/tunnels | sed -n 's/.*"public_url":"\(https:[^"]*\)".*/\1/p' | head -n1 || true)
  [ -n "${URL:-}" ] && break; sleep 1
done
[ -n "${URL:-}" ] || { echo "ngrok did not come up"; exit 1; }
echo "PUBLIC_URL=$URL"
PUBLIC_URL="$URL" TRUST_PROXY=true PORT="$PORT" node packages/relay/dist/cli.js