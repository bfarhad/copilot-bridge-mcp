# mcp-copilot

A local MCP (Model Context Protocol) server that bridges prompts to **Microsoft Copilot** by driving your already signed-in Edge browser. Kiro, VS Code (Copilot Chat / Claude Code) and any other MCP client can call Copilot as a native tool — no API key, no separate login.

```
Kiro / VS Code → MCP HTTP :3100 → copilot-bridge (host Node.js or Docker) → CDP → your Edge → Copilot
```

> **The bridge must be running and listening on port 3100 for any editor to connect.**
> Verify: `curl http://localhost:3100/health` → `{"status":"ok",...,"auth":"ready"}`.
> If it is stopped, Kiro/VS Code show the server as disconnected and no tools appear.
> Start it with `scripts/run.sh` (macOS/Linux) or `scripts\run.bat` (Windows) and choose Node.js or Docker. In Docker mode it uses `restart: unless-stopped`, so it comes back after Docker restarts.

Architecture, design choices and editor setup: [docs/editor-setup-vscode-kiro.md](docs/editor-setup-vscode-kiro.md).
Using the tools from an AI assistant (Claude, Kiro, Continue): [docs/ai-assistant-guide.md](docs/ai-assistant-guide.md).

---

## Prerequisites

| Requirement | Needed for | Notes |
|---|---|---|
| Microsoft Edge | both modes | Run on the host, not in a container. Windows, macOS, or Linux (`microsoft-edge-stable`). |
| Microsoft account with Copilot access | both modes | Work/school (Entra) accounts use `copilot.cloud.microsoft`; personal accounts use `copilot.microsoft.com`. |
| Node.js 20+ and npm | node mode | Check with `node -v`. |
| Docker (Engine, Desktop, OrbStack or Colima), with Compose v2 | docker mode | Needed only when Node.js is not installed, or if you choose `docker`. Check with `docker compose version`. |
| An MCP client | using the tools | Kiro, VS Code (Copilot Chat), Continue, Claude Code. See [editor setup](docs/editor-setup-vscode-kiro.md). |
| git, curl | optional | git adds the commit hash to the version; curl runs the health check. |

You need Node.js **or** Docker, not both. Port `3100` (bridge), `9222` (Edge debugging) and, in Docker mode, `9223` (proxy) must be free.

## Quick Start

### 1. Start the bridge

Run one script. It asks how to run the bridge, then starts a dedicated Edge (remote debugging on `9222`) and the bridge:

```bash
scripts/run.sh            # macOS / Linux
scripts\run.bat           # Windows
```

```
How do you want to run copilot-bridge?
  1) Node.js  - build and run on this machine. No Docker, no proxy.   [available, Node.js v22.x]
  2) Docker   - bridge and CDP proxy as containers. No Node.js needed. [available]
  q) Quit
Choice [1]:
```

| Option | Needs | What runs |
|---|---|---|
| **A: Node.js** | Node.js 20+ and npm | `npm ci`, `npm run build`, then `node dist/index.js` in the terminal (Ctrl+C stops it). Talks to Edge directly. |
| **B: Docker** | Docker with Compose v2 | The `cdp-proxy` container and the `copilot-bridge` container (`docker compose up -d --build`). Keeps running in the background. |

The menu marks an option as not available when its requirement is missing, and the default is the first available one. To skip the menu, pass the choice:

| Command | Effect |
|---|---|
| `scripts/run.sh node` / `scripts\run.bat node` | Option A without asking |
| `scripts/run.sh docker` / `scripts\run.bat docker` | Option B without asking |
| `scripts/run.sh auto` | Node.js if installed, otherwise Docker, without asking. Also the behaviour when there is no terminal. |
| `scripts/run.sh stop` / `scripts\run.bat stop` | Stop the Docker containers (`copilot-bridge`, `cdp-proxy`) |

`RUN_MODE=node|docker|auto` does the same as the argument.

**Switching options.** Both options use port `3100`, so only one can run. If you pick A while the Docker bridge is running, the script offers to stop it. If you pick B while a Node.js bridge is running, it tells you to stop that one first (Ctrl+C). Use `stop` to shut Docker down.

**Docker option checks.** After starting, the script waits for `/health` and checks that the container can reach Edge through the proxy. It prints a warning with the commands to check if it cannot.

Manual start, if you prefer: `./scripts/edge-login.sh` (macOS/Linux) opens the dedicated Edge, then either `npm ci && npm run build && CDP_ENDPOINT=http://127.0.0.1:9222 node dist/index.js`, or `node scripts/cdp-proxy.mjs &` followed by `docker compose up -d --build`.

### 2. Sign in once

In the Edge window that opened (profile `~/.copilot-bridge-edge`, or `%USERPROFILE%\.copilot-bridge-edge` on Windows), sign in to Copilot. Work accounts land on `copilot.cloud.microsoft`. Within a few seconds `curl http://localhost:3100/health` reports `auth: ready` (restart the bridge if it started before Edge was up). The sign-in is stored in the dedicated profile, so later launches are already signed in. Keep that Edge window open while you use the bridge.

Open <http://localhost:3100/> to see the status page, including the running version.

### Docker runtime compatibility

In Docker mode the bridge reaches the host's Edge through `host.docker.internal:9223`, which the proxy container forwards to Edge's `127.0.0.1:9222`. The proxy port is published on host loopback only: it gives full control of the browser, so never expose it to a network.

| Runtime | Status |
|---|---|
| OrbStack (macOS) | Tested. |
| Docker Desktop (macOS/Windows), Colima | Not tested. `host.docker.internal` is expected to reach host loopback the same way. |
| Docker Engine on Linux | Not tested. `run.sh` runs the proxy on the host network and binds it to the Docker bridge gateway address, because `host.docker.internal` is not host loopback there. |
| Podman | Not supported by the scripts. |

### 3. Register in your editor

The URL is the same everywhere — only the config file format differs. Use `http://localhost:3100/mcp`. (OrbStack users may also have a `*.orb.local` domain for the container; it is optional and Mac/OrbStack-only, so don't share it in config files.)

**Kiro** — `~/.kiro/settings/mcp.json` (user) or `.kiro/settings/mcp.json` (workspace); sample: [configs/kiro-mcp-config.json](configs/kiro-mcp-config.json)

```json
{
  "mcpServers": {
    "copilot-bridge": {
      "url": "http://localhost:3100/mcp",
      "disabled": false,
      "autoApprove": ["ask_copilot", "ask_copilot_batch", "review_code", "get_status"]
    }
  }
}
```

- `mcpServers` — root key for Kiro.
- `url` — the bridge's MCP endpoint (container port 3100, path `/mcp`).
- `disabled` — `true` keeps the entry but doesn't connect.
- `autoApprove` — tools that run without a confirmation prompt.

Click **Reconnect** in Kiro's MCP panel; all four tools appear.

**VS Code** — `.vscode/mcp.json` (workspace) or `~/Library/Application Support/Code/User/mcp.json` (user); sample: [configs/vscode-mcp-config.json](configs/vscode-mcp-config.json)

```json
{
  "servers": {
    "copilot-bridge": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

- `servers` — root key for VS Code (not `mcpServers`).
- `type: "http"` — Streamable HTTP transport.
- `url` — the same endpoint as Kiro.

Open Command Palette → **MCP: List Servers** to start/inspect it. VS Code asks for approval per tool call.

**Continue** (VS Code / JetBrains) — `.continue/mcpServers/copilot-bridge.yaml`; see [editor setup](docs/editor-setup-vscode-kiro.md#continue-vs-code--jetbrains-extension)

**Claude Code** (CLI or VS Code extension)

```bash
claude mcp add --transport http --scope user copilot-bridge http://localhost:3100/mcp
claude mcp list
```

Reload the window (or start a new session) afterwards — MCP servers load at session start. Type `/mcp` in the extension to see status.

---

## How to Use From Kiro / VS Code

Ask naturally — the editor calls the matching tool:

```
ask Copilot: "what is the difference between TCP and UDP?"
ask Copilot to review #File:src/browser.ts for security issues
ask Copilot "summarize the MCP protocol" and start a new chat
call get_status on copilot-bridge
review these two files for security issues and return findings as JSON
```

- `ask_copilot` — plain prompt; Copilot's full reply returns to the chat.
- `review_code` — send a file/snippet with an instruction; tell the editor to apply the suggested changes afterwards.
- `newChat: true` — start a fresh Copilot conversation (default continues the current one).
- `ask_copilot_batch` — several prompts in order.
- `get_status` — version, auth, Edge reachability, queue and call statistics.

---

## Authentication Details

The bridge **attaches to your signed-in Edge over CDP** (`CDP_ENDPOINT`) and types into a real Copilot tab, leaving your other tabs alone. No cookies or tokens are copied.

- Node mode connects to `http://127.0.0.1:9222`.
- Docker mode connects to `host.docker.internal:9223`; `scripts/cdp-proxy.mjs` forwards that to Edge's `127.0.0.1:9222` and rewrites the `Host` header, which Edge otherwise rejects. Set `CDP_TARGET_HOST` and `CDP_PROXY_HOST` to change where it connects and listens.
- The session check requires a visible chat input and a non-"Sign in" page, so a sign-in wall is reported as `unauthenticated` instead of `ready`.
- `COPILOT_URL` selects the entry page (`https://copilot.cloud.microsoft/` for work accounts, `https://copilot.microsoft.com/` for personal).

**Re-sign-in when:** Microsoft expires the session. Sign in again in the dedicated Edge window; no resync is needed.

If `CDP_ENDPOINT` is unset the bridge falls back to a cookie-import mode (`POST /auth/sync`, `POST /auth/cookies` with `scripts/sync-cookies.mjs`). It is not needed for normal use.

---

## MCP Tool Reference

Four tools. Every tool that sends a prompt accepts the **call options** and **output options** below. A quick usage guide for AI assistants is in [docs/ai-assistant-guide.md](docs/ai-assistant-guide.md).

**Call options** (`ask_copilot`, `ask_copilot_batch`, `review_code`)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `timeoutMs` | number (5000–900000) | server `RESPONSE_TIMEOUT_MS` | Max wait for the reply |
| `retries` | number (0–3) | `0` | Extra attempts on failure; retries run in a fresh chat |
| `dryRun` | boolean | `false` | Return the exact prompt that would be sent, without contacting Copilot |

**Output options**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `maxChars` | number | — | Truncate the returned text (saves tokens; saved files stay complete) |
| `includeSources` | boolean | `false` | Append cited source URLs |
| `save` | `("md"\|"html"\|"json")[]` | — | Also write the full reply to `output/` (see [Saving replies](#saving-replies)) |

### `ask_copilot`

Send any prompt to Copilot and return its response.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | ✓ | — | The message to send |
| `newChat` | boolean | | `false` | Start a new conversation thread |
| `systemPrompt` | string | | — | Role or standing instruction placed before the prompt |
| `format` | `"markdown"\|"json"` | | `markdown` | `json` asks for a single JSON block and returns it parsed and pretty-printed |

**Returns:** Copilot's response as compact Markdown (tables, fenced code blocks with language, lists; no citation chips or UI labels), or JSON when `format` is `json`.

### `ask_copilot_batch`

Send up to 10 prompts one after another and return all answers in order. They share one conversation by default.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompts` | string[] (1–10) | ✓ | — | Prompts, in order |
| `newChat` | boolean | | `false` | New thread before the first prompt |
| `newChatEach` | boolean | | `false` | New thread for every prompt (independent questions) |
| `stopOnError` | boolean | | `true` | Stop at the first failure |
| `systemPrompt` | string | | — | Placed before every prompt |

**Returns:** `### Answer N` sections. `isError` is set if any prompt failed.

### `review_code`

Send code with a specific instruction. Copilot returns analysis, explanation, or a rewritten version.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `instruction` | string | ✓ | — | What to do — e.g. "review for bugs", "explain this", "refactor to use async/await" |
| `code` | string | one of `code`/`files` | — | Full file content or a snippet |
| `files` | `{filename?, language?, code}[]` (max 10) | one of `code`/`files` | — | Several files reviewed together |
| `language`, `filename` | string | | — | Describe `code` |
| `focus` | `("bugs"\|"security"\|"performance"\|"tests"\|"style"\|"readability")[]` | | — | What to look for |
| `minSeverity` | `"info"\|"low"\|"medium"\|"high"` | | all | Report only findings at or above this level |
| `outputFormat` | `"markdown"\|"findings-json"\|"patch"` | | `markdown` | `findings-json`: array of `{file, line, severity, title, suggestion}`; `patch`: a unified diff |
| `newChat` | boolean | | `false` | Start a new conversation thread |

**Returns:** Copilot's response as Markdown, parsed JSON, or a diff. If the requested block is missing from the reply, the raw text is returned with a note.

---

### `get_status`

Returns the bridge state as JSON. Use it to confirm auth before calling other tools.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `refresh` | boolean | `false` | Re-check the Copilot session now (waits for running prompts, then loads the page) |

**Returns:**
```json
{
  "status": "ok",
  "name": "copilot-bridge",
  "version": "0.3.2",
  "commit": "a1b2c3d",
  "uptime": 142,
  "auth": "ready",
  "authMessage": "Authenticated — cookies active",
  "browser": { "mode": "cdp", "edgeReachable": true, "edgeVersion": "Edg/…", "tabOpen": true, "tabUrl": "https://copilot.cloud.microsoft/chat" },
  "queue": { "queued": 0, "inFlight": false, "calls": 12, "errors": 1, "avgLatencyMs": 18400, "lastSuccessAt": "2026-10-25T21:40:00.000Z", "lastError": null },
  "config": { "copilotUrl": "https://copilot.cloud.microsoft/", "responseTimeoutMs": 240000, "selectorTimeoutMs": 30000 },
  "node": "22.x"
}
```

`auth` values: `unauthenticated` | `syncing` | `ready` | `error`. The counters reset when the bridge restarts. `edgeReachable` is `null` outside CDP mode.

---

## Saving replies

Pass `save` to keep the full reply as a file. Files are written to `./output/` on the host (bind mount; git-ignored) and the paths are appended to the tool result. Ask naturally: *"ask Copilot …, save as md and json"*.

| Format | Contents |
|---|---|
| `md` | Title (the prompt), timestamp, reply as Markdown, sources |
| `html` | Standalone styled page (light/dark) with the prompt, rendered reply, real `<table>`s and `<pre><code class="language-…">` blocks, sources |
| `json` | `{ prompt, createdAt, markdown, html, codeBlocks[], sources[] }` — each code block is `{ language, code }`, plus `parsed` when it is valid JSON, so other data formats and JSON can be consumed programmatically |

Files are named `YYYYMMDD-HHMMSS-<prompt-slug>.<ext>`. Set `OUTPUT_DIR` / `HOST_OUTPUT_DIR` to change locations.

**Reducing token use:** the returned text is already stripped of citations and UI noise. Use `maxChars` to cap it, and `save` to keep the complete answer on disk so the model only reads what it needs.

---

## Example: splitting work between Copilot and Claude

[examples/thumbnail-lambda](examples/thumbnail-lambda/README.md) is an AWS Lambda + API Gateway (API key) thumbnail service where **Copilot wrote the Terraform** through this bridge and **Claude wrote the Python app and tests**. Measured on that run: ~40 % fewer Claude output tokens than writing everything in Claude, **but only** when the reply is saved (`save: ["json"]`, small `maxChars`) and turned into files with `scripts/extract-code.mjs`. Reading the reply and re-typing it was ~13 % *more* expensive. Details and caveats are in the example's README.

```bash
node scripts/extract-code.mjs output/<reply>.json <outDir>   # blocks starting with "# file: name" → files
```

---

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Status page with auth state |
| `GET` | `/health` | JSON health probe (used by Docker); includes the version |
| `GET` | `/version` | `{ name, version, commit }` |
| `GET` | `/debug/dom` | Inputs found on the live Copilot page (selector debugging) |
| `POST` | `/auth/recheck` | Re-check the Copilot session (button on the status page) |
| `POST` | `/auth/sync` | Cookie mode only: copy cookies from host Edge profile |
| `POST` | `/auth/cookies` | Cookie mode only (rejected in CDP mode): import `{ cookies: [...] }` (see `scripts/sync-cookies.mjs`) |
| `ALL` | `/mcp` | MCP Streamable HTTP transport |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | HTTP port |
| `PROFILE_DIR` | `/app/profile` | Container Chromium profile directory |
| `HOST_PROFILE_DIR` | `/host-profile` | Mount point for the host Edge profile |
| `CDP_ENDPOINT` | `http://host.docker.internal:9223` (compose), `http://127.0.0.1:9222` (node mode) | Drive the signed-in Edge; unset for cookie-import mode |
| `COPILOT_URL` | `https://copilot.microsoft.com/` (compose: `copilot.cloud.microsoft`) | Copilot entry page |
| `OUTPUT_DIR` | `/app/output` | Where `save` writes inside the container |
| `HOST_OUTPUT_DIR` | _(none)_ | Host path shown in "Saved:" results (set in compose) |
| `GIT_SHA` | `dev` | Build commit shown next to the version (set by the run scripts and the Docker build) |
| `RUN_MODE` | _(ask)_ | Choice for `scripts/run.sh` / `run.bat` without the menu: `node`, `docker`, `auto`, `stop` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `error` |
| `RESPONSE_TIMEOUT_MS` | `120000` | Max wait for Copilot to finish responding |
| `SELECTOR_TIMEOUT_MS` | `30000` | Max wait for DOM elements |

---

## Project Structure

```
copilot-bridge-mcp/
├── src/
│   ├── index.ts        — HTTP server, status page, /version, MCP transport wiring
│   ├── mcp-server.ts   — Tool definitions (ask_copilot, ask_copilot_batch, review_code, get_status)
│   ├── prompts.ts      — Prompt building for review_code, JSON / diff output instructions
│   ├── browser.ts      — Playwright automation, auth state machine
│   ├── reply.ts        — Reply → Markdown/HTML/code blocks/sources; saving to output/
│   ├── cookies.ts      — Cookie-import mode helpers
│   ├── config.ts       — All config from environment variables
│   ├── version.ts      — Version (package.json) and build commit (GIT_SHA)
│   └── logger.ts       — Structured logger
├── dist/               — Compiled JS (after npm run build)
├── Dockerfile          — Multi-stage: TS builder + Playwright/Chromium runtime
├── docker-compose.yml  — Docker Compose config
├── scripts/
│   ├── run.sh           — start Edge + bridge on macOS/Linux; menu: Node.js or Docker; `stop`
│   ├── run.bat          — start Edge + bridge on Windows; menu: Node.js or Docker; `stop`
│   ├── edge-login.sh    — launch dedicated Edge with remote debugging (macOS/Linux)
│   ├── cdp-proxy.mjs    — proxy 9223 → 9222 (Host header rewrite) for Docker mode
│   ├── extract-code.mjs — saved reply (json) → files, no LLM involved
│   └── sync-cookies.mjs — cookie-import mode helper
├── examples/thumbnail-lambda/ — Copilot (Terraform) + Claude (Python) example with token measurements
├── output/             — Saved replies (git-ignored)
├── docs/               — architecture and editor setup (VS Code / Kiro / Claude Code), security fix plan, AI assistant guide
├── CHANGELOG.md        — release notes
└── configs/            — sample MCP configs (kiro-mcp-config.json, vscode-mcp-config.json)
```

---

## Versioning

The release version is the `version` field in `package.json` ([Semantic Versioning](https://semver.org/)); release notes are in [CHANGELOG.md](CHANGELOG.md). It is shown on the status page (<http://localhost:3100/>), at `GET /version`, in `/health`, in `get_status` and in the MCP server info. The commit hash appears next to it when `GIT_SHA` is set, which the run scripts and `docker compose build` do automatically.

To release: update `CHANGELOG.md`, run `npm version <patch|minor|major>` (this edits `package.json` and `package-lock.json`), rebuild the container, and tag the commit.

---

## Development

```bash
npm install           # install deps
npm run build         # compile TypeScript → dist/
npm run dev           # run locally with tsx (no Docker)
npm run typecheck     # type-check only, no output
```

Rebuild and restart the container after source changes:
```bash
docker compose up -d --build
```

---

## Troubleshooting

**Editor shows the server as disconnected / no tools**
The container isn't running or isn't on port 3100. Run `docker compose up -d` and `curl http://localhost:3100/health`.

**`auth: unauthenticated`**
Make sure the dedicated Edge (started by `scripts/run.sh` / `run.bat`) is open and signed in to Copilot and, in Docker mode, the `cdp-proxy` container is running (`docker ps`). Then restart the bridge (`docker compose restart` in Docker mode). The status page at http://localhost:3100 shows the reason.

**`SingletonLock` / "profile in use by another process"**
The bridge clears all Chromium lock files before each launch and passes `--no-process-singleton-locks`. If you still see this, run:
```bash
docker compose down -v && docker compose up -d
```
This wipes the volume (removing stale locks). Only relevant to the legacy cookie mode; in the default CDP mode the bridge drives your Edge and uses no container profile.

**Copilot chat input not found (selector timeout)**
Copilot's DOM changes occasionally. The selectors are in the `SEL` object at the top of `src/browser.ts`. Update them if Copilot redesigns the chat input.

**Tool call returns empty response**
The stable-text polling fallback may have timed out. Increase `RESPONSE_TIMEOUT_MS` in `docker-compose.yml` for long Copilot responses.

---

## Known Limitations

- Relies on DOM scraping — not an official Microsoft API. Selectors may break when Copilot updates its UI.
- Conversation history lives in the browser tab. It resets when the container restarts or when `newChat: true` is passed.
- Personal use only. Microsoft's Terms of Service apply.
