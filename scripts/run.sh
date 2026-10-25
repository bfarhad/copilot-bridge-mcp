#!/usr/bin/env bash
# Start copilot-bridge on macOS or Linux.
#
# Usage: scripts/run.sh [menu|node|docker|auto|stop]      (or RUN_MODE=...)
#   (no argument)  ask which option to use (menu); without a terminal behaves like auto
#   menu           always ask
#   node           option A: build and run the bridge with host Node.js 20+ (foreground, Ctrl+C stops it)
#   docker         option B: run the bridge and the CDP proxy as containers (needs only Docker)
#   auto           node if Node.js 20+ is installed, otherwise docker, without asking
#   stop           stop the Docker containers (switch between the options with this)
#
# Both options first make sure a dedicated Edge with remote debugging is running
# (scripts/edge-login.sh).
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPTS_DIR")"
DEBUG_PORT="${CDP_PORT:-9222}"
PROXY_PORT="${CDP_PROXY_PORT:-9223}"
PROXY_IMAGE="${PROXY_IMAGE:-node:22-alpine}"
BRIDGE_PORT="${PORT:-3100}"
MODE="${1:-${RUN_MODE:-}}"

die() { echo "ERROR: $*" >&2; exit 1; }

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]
}

docker_ok() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

bridge_container_running() {
  docker_ok && [ -n "$(docker ps -q --filter 'name=^copilot-bridge$' 2>/dev/null)" ]
}

stop_docker() {
  docker_ok || die "Docker is not installed or not running."
  (cd "$PROJECT_DIR" && docker compose down)
  docker rm -f cdp-proxy >/dev/null 2>&1 || true
  echo "Docker containers stopped."
}

# --- Mode selection ---------------------------------------------------------
choose_mode() {
  local n_state d_state default choice
  if node_ok; then n_state="available, Node.js $(node -v)"; else n_state="NOT available: needs Node.js 20+ and npm"; fi
  if docker_ok; then d_state="available"; else d_state="NOT available: Docker is not installed or not running"; fi
  if node_ok; then default=1; elif docker_ok; then default=2; else default=q; fi

  echo
  echo "How do you want to run copilot-bridge?"
  echo "  1) Node.js  - build and run on this machine. No Docker, no proxy.          [$n_state]"
  echo "  2) Docker   - bridge and CDP proxy as containers. No Node.js needed.        [$d_state]"
  echo "  q) Quit"
  while true; do
    read -r -p "Choice [$default]: " choice || choice=q
    choice="${choice:-$default}"
    case "$choice" in
      1) node_ok   && { MODE=node;   return; }; echo "Node.js option is not available on this machine." ;;
      2) docker_ok && { MODE=docker; return; }; echo "Docker option is not available on this machine." ;;
      q|Q) exit 0 ;;
      *) echo "Enter 1, 2 or q." ;;
    esac
  done
}

if [ -z "$MODE" ]; then
  if [ -t 0 ]; then MODE=menu; else MODE=auto; fi
fi

case "$MODE" in
  menu)   choose_mode ;;
  auto)
    if node_ok; then MODE=node
    elif docker_ok; then MODE=docker
    else die "Neither Node.js 20+ nor a running Docker was found. Install one of them."
    fi
    ;;
  node)   node_ok   || die "Node.js 20+ and npm are required for the Node.js option. Use 'docker' instead." ;;
  docker) docker_ok || die "Docker is not installed or not running. Use 'node' instead." ;;
  stop)   stop_docker; exit 0 ;;
  *)      die "Unknown mode '$MODE'. Use menu, node, docker, auto or stop." ;;
esac
echo "Mode: $MODE"

GIT_SHA="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"
export GIT_SHA

# --- Port check: the other option may still be running ----------------------
if [ "$MODE" = node ] && port_open "$BRIDGE_PORT"; then
  if bridge_container_running; then
    echo "Port $BRIDGE_PORT is used by the Docker container 'copilot-bridge'."
    read -r -p "Stop the Docker containers and continue? [y/N] " ans || ans=n
    case "$ans" in y|Y) stop_docker ;; *) die "Run 'scripts/run.sh stop' first, or pick the Docker option." ;; esac
  else
    die "Port $BRIDGE_PORT is already in use. Stop whatever uses it, or set PORT=<other port>."
  fi
fi
if [ "$MODE" = docker ] && port_open "$BRIDGE_PORT" && ! bridge_container_running; then
  die "Port $BRIDGE_PORT is used by another process (a Node.js bridge?). Stop it first (Ctrl+C in its terminal)."
fi

# --- Step 1: Edge with remote debugging -------------------------------------
echo
echo "=== Step 1: Ensure Microsoft Edge is running with remote debugging ==="
if port_open "$DEBUG_PORT"; then
  echo "Port $DEBUG_PORT is already listening. Skipping Edge launch."
else
  "$SCRIPTS_DIR/edge-login.sh"
  for _ in $(seq 1 20); do port_open "$DEBUG_PORT" && break; sleep 0.5; done
  port_open "$DEBUG_PORT" || die "Edge did not open debug port $DEBUG_PORT."
fi

# --- Step 2: Bridge ---------------------------------------------------------
if [ "$MODE" = node ]; then
  echo
  echo "=== Step 2: Build and run the bridge with Node.js $(node -v) ==="
  cd "$PROJECT_DIR"
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    npm ci
  fi
  npm run build

  # Edge accepts a Host header of localhost, so no CDP proxy is needed on the host.
  export CDP_ENDPOINT="http://127.0.0.1:$DEBUG_PORT"
  export COPILOT_URL="${COPILOT_URL:-https://copilot.cloud.microsoft/}"
  export RESPONSE_TIMEOUT_MS="${RESPONSE_TIMEOUT_MS:-240000}"
  export OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_DIR/output}"
  echo
  echo "MCP endpoint: http://localhost:$BRIDGE_PORT/mcp   (status page: http://localhost:$BRIDGE_PORT/)"
  echo "Sign in to Copilot in the Edge window if the status page says 'not authenticated'."
  exec node dist/index.js
fi

echo
echo "=== Step 2: Start the CDP proxy container ==="
docker rm -f cdp-proxy >/dev/null 2>&1 || true
OS_NAME="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)"
if [ "$(uname -s)" = Linux ] && ! echo "$OS_NAME" | grep -qiE 'docker desktop|orbstack'; then
  # Docker Engine on Linux: host.docker.internal is the docker0 gateway, not host loopback,
  # so the proxy shares the host network and listens on the gateway address only.
  GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
  docker run -d --name cdp-proxy --restart unless-stopped --network host \
    -e CDP_PROXY_HOST="$GATEWAY" -e CDP_PORT="$DEBUG_PORT" -e CDP_PROXY_PORT="$PROXY_PORT" \
    -v "$SCRIPTS_DIR:/scripts:ro" "$PROXY_IMAGE" node /scripts/cdp-proxy.mjs
else
  # Docker Desktop, OrbStack, Colima: host.docker.internal reaches host loopback.
  # Publish on host loopback only; this port gives full control of the browser.
  docker run -d --name cdp-proxy --restart unless-stopped \
    --add-host=host.docker.internal:host-gateway \
    -e CDP_TARGET_HOST=host.docker.internal -e CDP_PROXY_HOST=0.0.0.0 \
    -e CDP_PORT="$DEBUG_PORT" -e CDP_PROXY_PORT="$PROXY_PORT" \
    -p "127.0.0.1:$PROXY_PORT:$PROXY_PORT" \
    -v "$SCRIPTS_DIR:/scripts:ro" "$PROXY_IMAGE" node /scripts/cdp-proxy.mjs
fi

echo
echo "=== Step 3: Bring up the bridge with Docker Compose ==="
# Compose expands ${PWD} for the host output path, so run it from the project root.
cd "$PROJECT_DIR"
docker compose up -d --build

echo
echo "=== Step 4: Waiting for the bridge ==="
HEALTH=""
for _ in $(seq 1 40); do
  HEALTH="$(curl -fs "http://localhost:$BRIDGE_PORT/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done
[ -n "$HEALTH" ] || die "The bridge did not answer on port $BRIDGE_PORT. See: docker compose logs copilot-bridge"
echo "$HEALTH"
# Give the first session check a moment, then verify the container can really reach Edge.
sleep 3
if docker exec copilot-bridge node -e "fetch('http://host.docker.internal:$PROXY_PORT/json/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
  echo "Container -> proxy -> Edge: reachable."
else
  echo "WARNING: the container cannot reach Edge through the proxy (host.docker.internal:$PROXY_PORT)." >&2
  echo "         Check: docker logs cdp-proxy   and   curl http://127.0.0.1:$DEBUG_PORT/json/version" >&2
fi

echo
echo "Copilot Bridge startup completed."
echo "If auth is not ready, sign in to Copilot in the Edge window, then click Re-check on http://localhost:$BRIDGE_PORT/"
echo "MCP endpoint: http://localhost:$BRIDGE_PORT/mcp      Stop: scripts/run.sh stop"
