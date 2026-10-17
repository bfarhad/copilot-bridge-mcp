# mcp-copilot

A local MCP (Model Context Protocol) server that bridges prompts to **Microsoft Copilot** by driving your already signed-in Edge browser. Kiro, VS Code (Copilot Chat / Claude Code) and any other MCP client can call Copilot as a native tool — no API key, no separate login.

```
Kiro / VS Code → MCP HTTP :3100 → copilot-bridge (Docker) → CDP → your Edge → Copilot
```

> **The Docker container must be running and listening on port 3100 for any editor to connect.**
> Verify: `curl http://localhost:3100/health` → `{"status":"ok",...,"auth":"ready"}`.
> If the container is stopped, Kiro/VS Code show the server as disconnected and no tools appear.
> Start it with `docker compose up -d`; it uses `restart: unless-stopped`, so it comes back after Docker restarts.

More detail on editor setup: [docs/editor-setup-vscode-kiro.md](docs/editor-setup-vscode-kiro.md).

---

## Quick Start

### 1. Build and run the container

```bash
cd mcp-copilot
docker compose up -d --build
curl http://localhost:3100/health
```

`auth` stays `unauthenticated` until step 2 is done.

### 2. Sign in once (dedicated Edge + CDP proxy)

The bridge drives a dedicated Edge profile over the DevTools protocol. Run these on your Mac:

```bash
./scripts/edge-login.sh          # opens Edge (profile ~/.copilot-bridge-edge, debug port 9222)
# sign in to Copilot in that window (work accounts land on copilot.cloud.microsoft)
node scripts/cdp-proxy.mjs &     # loopback proxy 9223 -> 9222 (rewrites the Host header)
```

Within a few seconds the container reports `auth: ready` (restart it with `docker compose restart` if it started before Edge was up).
Keep that Edge window and the proxy running while you use the bridge. The sign-in is stored in the dedicated profile, so later launches are already signed in.

### Docker runtime compatibility

The container itself runs on any Docker. The one runtime-specific piece is how it reaches the Edge on your host: it connects to `host.docker.internal:9223`, which `scripts/cdp-proxy.mjs` forwards to Edge's debug port.

| Runtime | Status |
|---|---|
| OrbStack (macOS) | Tested. `host.docker.internal` reaches the host's loopback, so the proxy can stay on `127.0.0.1`. |
| Docker Desktop (macOS/Windows) | Not tested. `host.docker.internal` is built in and is expected to work the same way. |
| Linux Docker, Colima, Podman | Not tested. The host address may not be loopback; the proxy may need to listen on the Docker bridge address (set `CDP_PROXY_HOST`/adjust the bind address) and the `host-gateway` mapping in `docker-compose.yml` must resolve. Note that binding to `0.0.0.0` exposes full browser control to your network. |

### 3. Register in your editor

The URL is the same everywhere — only the config file format differs. Use `http://localhost:3100/mcp`. (OrbStack users may also have a `*.orb.local` domain for the container; it is optional and Mac/OrbStack-only, so don't share it in config files.)

**Kiro** — `~/.kiro/settings/mcp.json` (user) or `.kiro/settings/mcp.json` (workspace); sample: [kiro-mcp-config.json](kiro-mcp-config.json)

```json
{
  "mcpServers": {
    "copilot-bridge": {
      "url": "http://localhost:3100/mcp",
      "disabled": false,
      "autoApprove": ["ask_copilot", "review_code", "get_status"]
    }
  }
}
```

- `mcpServers` — root key for Kiro.
- `url` — the bridge's MCP endpoint (container port 3100, path `/mcp`).
- `disabled` — `true` keeps the entry but doesn't connect.
- `autoApprove` — tools that run without a confirmation prompt.

Click **Reconnect** in Kiro's MCP panel; all three tools appear.

**VS Code** — `.vscode/mcp.json` (workspace) or `~/Library/Application Support/Code/User/mcp.json` (user); sample: [vscode-mcp-config.json](vscode-mcp-config.json)

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
```

- `ask_copilot` — plain prompt; Copilot's full reply returns to the chat.
- `review_code` — send a file/snippet with an instruction; tell the editor to apply the suggested changes afterwards.
- `newChat: true` — start a fresh Copilot conversation (default continues the current one).
- `get_status` — uptime and auth state.

---

## Authentication Details

Earlier versions copied Edge's `Cookies` file into the container. That does not work on macOS (cookies are Keychain-encrypted) nor for work/Entra accounts (Microsoft rejects the transplanted session). The bridge now **attaches to your signed-in Edge over CDP** (`CDP_ENDPOINT`) and types into a real Copilot tab, leaving your other tabs alone.

- The container reaches the host via `host.docker.internal:9223`.
- `scripts/cdp-proxy.mjs` forwards that to Edge's `127.0.0.1:9222` and rewrites the `Host` header, which Edge otherwise rejects. It listens on loopback only.
- The session check requires a visible chat input and a non-"Sign in" page, so a sign-in wall is reported as `unauthenticated` instead of `ready`.
- `COPILOT_URL` selects the entry page (`https://copilot.cloud.microsoft/` for work accounts, `https://copilot.microsoft.com/` for personal).

**Re-sign-in when:** Microsoft expires the session. Sign in again in the dedicated Edge window; no resync is needed.

Legacy cookie paths (`POST /auth/sync`, `POST /auth/cookies` with `scripts/sync-cookies.mjs`) remain for the non-CDP mode (unset `CDP_ENDPOINT`).

---

## MCP Tool Reference

### `ask_copilot`

Send any prompt to Copilot and return its response.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | ✓ | — | The message to send |
| `newChat` | boolean | | `false` | Start a new conversation thread |
| `maxChars` | number | | — | Truncate the returned text (saves tokens; saved files stay complete) |
| `includeSources` | boolean | | `false` | Append cited source URLs (off by default to save tokens) |
| `save` | `("md"\|"html"\|"json")[]` | | — | Also write the full reply to `output/` (see [Saving replies](#saving-replies)) |

**Returns:** Copilot's response as compact Markdown (tables, fenced code blocks with language, lists; no citation chips or UI labels).

---

### `review_code`

Send code with a specific instruction. Copilot returns analysis, explanation, or a rewritten version.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `instruction` | string | ✓ | — | What to do — e.g. "review for bugs", "explain this", "refactor to use async/await" |
| `code` | string | ✓ | — | Full file content or a snippet |
| `language` | string | | — | e.g. `TypeScript`, `Python` — helps Copilot format its response |
| `filename` | string | | — | e.g. `browser.ts` — gives Copilot extra context |
| `newChat` | boolean | | `false` | Start a new conversation thread |
| `maxChars`, `includeSources`, `save` | | | | Same as `ask_copilot` |

**Returns:** Copilot's response as Markdown (analysis, suggestions, or rewritten code).

---

### `get_status`

Returns the current bridge state as JSON. Useful for confirming auth before calling other tools.

No parameters.

**Returns:**
```json
{
  "status": "ok",
  "name": "copilot-bridge",
  "version": "0.1.0",
  "uptime": 142,
  "auth": "ready",
  "authMessage": "Authenticated — cookies active"
}
```

`auth` values: `unauthenticated` | `syncing` | `ready` | `error`

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
| `GET` | `/health` | JSON health probe (used by Docker) |
| `GET` | `/debug/dom` | Inputs found on the live Copilot page (selector debugging) |
| `POST` | `/auth/sync` | Legacy: copy cookies from host Edge profile |
| `POST` | `/auth/cookies` | Legacy: import `{ cookies: [...] }` (see `scripts/sync-cookies.mjs`) |
| `ALL` | `/mcp` | MCP Streamable HTTP transport |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | HTTP port |
| `PROFILE_DIR` | `/app/profile` | Container Chromium profile directory |
| `HOST_PROFILE_DIR` | `/host-profile` | Mount point for the host Edge profile |
| `CDP_ENDPOINT` | `http://host.docker.internal:9223` (compose) | Drive the signed-in Edge via the CDP proxy; unset for legacy cookie mode |
| `COPILOT_URL` | `https://copilot.microsoft.com/` (compose: `copilot.cloud.microsoft`) | Copilot entry page |
| `OUTPUT_DIR` | `/app/output` | Where `save` writes inside the container |
| `HOST_OUTPUT_DIR` | _(none)_ | Host path shown in "Saved:" results (set in compose) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `error` |
| `RESPONSE_TIMEOUT_MS` | `120000` | Max wait for Copilot to finish responding |
| `SELECTOR_TIMEOUT_MS` | `30000` | Max wait for DOM elements |

---

## Project Structure

```
mcp-copilot/
├── src/
│   ├── index.ts        — HTTP server, /auth/sync route, MCP transport wiring
│   ├── mcp-server.ts   — Tool definitions (ask_copilot, review_code, get_status)
│   ├── browser.ts      — Playwright automation, auth state machine, lock cleanup
│   ├── reply.ts        — Reply → Markdown/HTML/code blocks/sources; saving to output/
│   ├── cookies.ts      — Edge Cookies SQLite copy + CDP extraction fallback
│   ├── config.ts       — All config from environment variables
│   └── logger.ts       — Structured logger
├── dist/               — Compiled JS (after npm run build)
├── Dockerfile          — Multi-stage: TS builder + Playwright/Chromium runtime
├── docker-compose.yml  — Docker Compose config (Edge profile mount is opt-in, legacy mode only)
├── scripts/
│   ├── edge-login.sh    — launch dedicated Edge with remote debugging
│   ├── cdp-proxy.mjs    — loopback proxy 9223 → 9222 (Host header rewrite)
│   ├── extract-code.mjs — saved reply (json) → files, no LLM involved
│   └── sync-cookies.mjs — legacy cookie export/import
├── examples/thumbnail-lambda/ — Copilot (Terraform) + Claude (Python) example with token measurements
├── output/             — Saved replies (git-ignored)
├── docs/                — editor setup notes (VS Code / Kiro)
├── kiro-mcp-config.json   — sample for ~/.kiro/settings/mcp.json
└── vscode-mcp-config.json — sample for .vscode/mcp.json
```

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
Make sure the dedicated Edge (`scripts/edge-login.sh`) is open and signed in to Copilot, and `node scripts/cdp-proxy.mjs` is running. Then `docker compose restart`. The status page at http://localhost:3100 shows the reason.

**`SingletonLock` / "profile in use by another process"**
Fixed in the current version — the bridge clears all Chromium lock files before each launch and passes `--no-process-singleton-locks`. If you still see this, run:
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
