#!/usr/bin/env bash
# Launch a dedicated Edge profile with remote debugging (macOS and Linux).
# Sign in to Copilot once; the profile persists, so later runs are already signed in.
#
# Environment:
#   COPILOT_EDGE_PROFILE  profile directory (default ~/.copilot-bridge-edge)
#   CDP_PORT              remote debugging port (default 9222)
#   COPILOT_URL           page to open (default https://copilot.cloud.microsoft/)
#   EDGE_BIN              Edge executable (Linux only; auto-detected by default)
set -euo pipefail

PROFILE="${COPILOT_EDGE_PROFILE:-$HOME/.copilot-bridge-edge}"
PORT="${CDP_PORT:-9222}"
URL="${COPILOT_URL:-https://copilot.cloud.microsoft/}"
ARGS=(--remote-debugging-port="$PORT" --user-data-dir="$PROFILE" --no-first-run "$URL")

case "$(uname -s)" in
  Darwin)
    open -na "Microsoft Edge" --args "${ARGS[@]}"
    ;;
  Linux)
    EDGE_BIN="${EDGE_BIN:-$(command -v microsoft-edge-stable || command -v microsoft-edge || command -v msedge || true)}"
    if [ -z "$EDGE_BIN" ]; then
      echo "Microsoft Edge not found. Install it or set EDGE_BIN=/path/to/edge." >&2
      exit 1
    fi
    nohup "$EDGE_BIN" "${ARGS[@]}" >/dev/null 2>&1 &
    ;;
  *)
    echo "Unsupported OS for this script. On Windows use scripts\\run.bat." >&2
    exit 1
    ;;
esac

echo "Edge started (profile: $PROFILE, CDP: http://127.0.0.1:$PORT)."
echo "Sign in to Copilot in that window if you are not signed in yet."
