#!/usr/bin/env bash
# Launch a dedicated Edge profile with remote debugging so cookies can be
# exported without touching the Keychain. Sign in to Copilot once; the profile
# persists, so later runs are already signed in.
set -euo pipefail
PROFILE="${COPILOT_EDGE_PROFILE:-$HOME/.copilot-bridge-edge}"
PORT="${CDP_PORT:-9222}"
open -na "Microsoft Edge" --args \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  "https://copilot.microsoft.com/"
echo "Edge started (profile: $PROFILE, CDP: http://127.0.0.1:$PORT)."
echo "Sign in to Copilot, then run: node scripts/sync-cookies.mjs"
