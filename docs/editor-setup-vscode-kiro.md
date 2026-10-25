# copilot-bridge: architecture and editor setup

copilot-bridge exposes Microsoft Copilot, already signed in inside your own Edge browser, as a local MCP server. Any MCP client (Kiro, VS Code, Claude Code) can call Copilot as a tool: a prompt goes from the editor to the bridge, into the Copilot chat UI, and the reply returns to the editor.

> **The bridge must be running and listening on port 3100 before any editor can connect.**
> If it is stopped, the editor shows the server as failed/disconnected and no tools appear.
> Start it with `scripts/run.sh` (macOS/Linux) or `scripts\run.bat` (Windows) and choose Node.js or Docker in the menu (see the README).
> Check with `curl http://localhost:3100/health` (expects `{"status":"ok",...,"auth":"ready"}`). The status page at `http://localhost:3100/` shows the running version.

## How it works

Copilot authenticates with browser sessions, not API keys. The bridge drives a dedicated Edge that is already signed in, so no credentials, token refresh or API key are involved. It only automates what you would otherwise type by hand.

```
Kiro / VS Code / Claude Code          (MCP clients)
        │  MCP, Streamable HTTP  (http://localhost:3100/mcp)
        ▼
copilot-bridge  (host Node.js or Docker container, port 3100)
        │  Chrome DevTools Protocol
        ▼
Dedicated Edge  (host, signed in, remote debugging on 9222)
        ▼
Copilot chat tab  (copilot.cloud.microsoft for work accounts)
```

In Docker mode the container cannot reach Edge's DevTools port directly, so `scripts/cdp-proxy.mjs` (a second small container) forwards `9223` to Edge's `9222` and rewrites the `Host` header, which Edge otherwise rejects. In Node mode the bridge talks to `http://127.0.0.1:9222` and needs no proxy.

| Component | Role |
|---|---|
| `src/index.ts`, `src/mcp-server.ts` | HTTP server, status page, MCP tools `ask_copilot`, `ask_copilot_batch`, `review_code`, `get_status` |
| `src/browser.ts` | Attaches to Edge over CDP, finds or opens the Copilot tab, types the prompt, waits for the stream to finish, scrapes the reply |
| `src/reply.ts` | Converts the reply to Markdown, HTML, code blocks and sources; saves files to `output/` |
| `src/prompts.ts` | Builds the `review_code` prompt and the JSON / diff output instructions |
| `src/version.ts` | Reads the version from `package.json` and the build commit from `GIT_SHA` |
| `scripts/run.sh`, `scripts/run.bat` | Menu: start Edge and the bridge with Node.js or in Docker; `stop` shuts Docker down |
| `scripts/edge-login.sh` | Starts the dedicated Edge profile with remote debugging (macOS/Linux) |
| `scripts/cdp-proxy.mjs` | Lets the Docker container reach Edge's DevTools port |

### Request flow

1. The client calls a tool over MCP.
2. The bridge reuses the open Copilot tab, or opens one (and navigates to a fresh chat when `newChat` is set).
3. It waits for the chat input, types the prompt and submits it.
4. It waits for streaming to end: the stop button appears and disappears, or the last message stops changing.
5. It scrapes the last assistant message and returns it as text.

Calls run one at a time, because all clients share one Copilot tab.

### Design choices

| Choice | Reason |
|---|---|
| Streamable HTTP, not stdio | One long-lived server for several editors, same URL everywhere |
| Node.js or Docker | Node mode needs only Node.js 20+; Docker mode needs only Docker and keeps the bridge isolated and restartable |
| Playwright over CDP | Reuses a real signed-in session; the Copilot UI needs a real browser |
| Attach to the signed-in Edge, no cookie copying | Cookies are encrypted per OS and Microsoft rejects transplanted work-account sessions |
| Dedicated Edge profile (`~/.copilot-bridge-edge`, `%USERPROFILE%\.copilot-bridge-edge`) | Edge blocks the debug port on the default profile; the daily profile stays untouched |
| Selectors in one `SEL` object in `src/browser.ts` | Copilot UI changes are fixed in one place; `/debug/dom` lists the inputs on the live page |

The session check requires a visible chat input and a page that is not a sign-in page, so a sign-in wall is reported as `unauthenticated`, not `ready`.

### Limits

- Not an official Microsoft API. It scrapes the DOM and breaks if the Copilot UI changes significantly.
- It stops working when the session expires or Microsoft adds a sign-in challenge; sign in again in the dedicated Edge.
- The dedicated Edge window must stay open (and, in Docker mode, the proxy container running).
- Personal productivity use only; Microsoft's Terms of Service and rate limits apply.

## Endpoint

| URL | Works on |
|---|---|
| `http://localhost:3100/mcp` | any machine running the bridge (Node mode, or Docker publishing port 3100) |

Use this URL in every config below.

**Optional, OrbStack only:** OrbStack also gives each container a domain, e.g. `https://copilot-bridge.mcp-copilot.orb.local/mcp`. It resolves only on a Mac running OrbStack, so don't put it in files you share. The bridge rejects Host names it does not know: to use the OrbStack domain, start with `ALLOWED_HOSTS=localhost,127.0.0.1,[::1],copilot-bridge.mcp-copilot.orb.local docker compose up -d`.

## Config comparison

| | VS Code | Kiro |
|---|---|---|
| Workspace file | `.vscode/mcp.json` | `.kiro/settings/mcp.json` |
| User file (macOS) | `~/Library/Application Support/Code/User/mcp.json` | `~/.kiro/settings/mcp.json` |
| User file (Windows / Linux) | `%APPDATA%\Code\User\mcp.json` / `~/.config/Code/User/mcp.json` | `%USERPROFILE%\.kiro\settings\mcp.json` / `~/.kiro/settings/mcp.json` |
| Root key | `servers` | `mcpServers` |
| Transport field | `"type": "http"` | not needed (inferred from `url`) |
| Extra fields | — | `disabled`, `autoApprove` |
| Open from UI | Command Palette → *MCP: Open Workspace Folder Configuration* / *MCP: Open User Configuration* | Command Palette → *Open User MCP Configuration* |
| See status | *MCP: List Servers* | Kiro MCP panel → *Reconnect* |

### VS Code — `.vscode/mcp.json`

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

### Kiro — `.kiro/settings/mcp.json`

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

Field meanings:

- `servers` / `mcpServers` — root object, keyed by server name.
- `type: "http"` (VS Code) — Streamable HTTP transport; the bridge speaks this on `/mcp`.
- `url` — the bridge's MCP endpoint.
- `disabled` (Kiro) — set `true` to keep the entry without connecting.
- `autoApprove` (Kiro) — tools that run without a confirmation prompt. VS Code asks per tool call instead.

### Claude Code (CLI / VS Code extension)

```bash
claude mcp add --transport http --scope user copilot-bridge http://localhost:3100/mcp
claude mcp list
```

In the extension, type `/mcp` in the chat panel to see status. Reload the window (Command Palette → *Developer: Reload Window*) or start a new session after adding a server; MCP servers load at session start.

### Continue (VS Code / JetBrains extension)

Continue reads one YAML file per MCP server from `.continue/mcpServers/` (workspace root, or `~/.continue/` for all workspaces). Create `.continue/mcpServers/copilot-bridge.yaml`:

```yaml
name: Copilot Bridge
version: 0.0.1
schema: v1
mcpServers:
  - name: copilot-bridge
    type: streamable-http
    url: http://localhost:3100/mcp
```

Field meanings:

- `name`, `version`, `schema: v1` — block metadata required by Continue's config format. `version` is the version of this config block, not of the bridge.
- `mcpServers` — list of servers; each needs a `name`.
- `type: streamable-http` — the transport the bridge speaks on `/mcp`. Do not use `sse` or `stdio`.
- `url` — the bridge's MCP endpoint. Use `http://localhost:3100/mcp`; the OrbStack `*.orb.local` domain works only on a Mac running OrbStack and uses HTTPS with a local certificate, so avoid it in shared files.

Steps:

1. Start the bridge (`scripts/run.sh` or `scripts\run.bat`) and confirm `curl http://localhost:3100/health`.
2. Save the YAML file. Continue reloads MCP servers when the file changes; if the tools do not appear, reload the window.
3. Switch Continue's chat to **Agent** mode. MCP tools are available only in Agent mode, not in Chat or Plan.
4. Open the tools list in the chat input; `ask_copilot`, `ask_copilot_batch`, `review_code` and `get_status` should be listed. Continue asks for approval on each call unless you set the tool policy to *Automatic*.

If the server shows an error, check that the URL starts with `http://` (not `https://`) and that the bridge is running.

## Workspace vs user config

- **Workspace** files can be committed: the `localhost:3100` URL works for every teammate who runs the bridge locally (each person also needs their own signed-in Edge, see the README).
- **User** files are personal and not committed, a good home if you use a non-default port or a remote URL.

One bridge serves every editor at once; only the two small config files differ.
