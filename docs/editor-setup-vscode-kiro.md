# Using copilot-bridge from VS Code and Kiro

One bridge container serves both editors. Only the two small config files differ.

> **The container must be running and listening on port 3100 before either editor can connect.**
> If it is stopped, the editor shows the server as failed/disconnected and no tools appear.
> Check with `curl http://localhost:3100/health` (expects `{"status":"ok",...,"auth":"ready"}`).

## Endpoint

| URL | Works on |
|---|---|
| `http://localhost:3100/mcp` | any machine running the container (Docker publishes port 3100 to the host) |

Use this URL in every config below.

**Optional, OrbStack only:** OrbStack also gives each container a domain, e.g. `https://copilot-bridge.mcp-copilot.orb.local/mcp`. It resolves only on a Mac running OrbStack with this container, so don't put it in files you share. If you use Docker Desktop, Colima, Podman or Linux Docker, ignore it.

## Config comparison

| | VS Code | Kiro |
|---|---|---|
| Workspace file | `.vscode/mcp.json` | `.kiro/settings/mcp.json` |
| User file (macOS) | `~/Library/Application Support/Code/User/mcp.json` | `~/.kiro/settings/mcp.json` |
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
      "autoApprove": ["ask_copilot", "review_code", "get_status"]
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

## Workspace vs user config

- **Workspace** files can be committed: the `localhost:3100` URL works for every teammate who runs the container locally (each person also needs their own signed-in Edge, see the README).
- **User** files are personal and not committed, a good home if you use a non-default port or a remote URL.

## Q&A log (asked through the bridge itself)

**Q: Where do I add MCP server configuration in VS Code?**

- Workspace: `<workspace>/.vscode/mcp.json` (shareable via source control)
- User, macOS: `~/Library/Application Support/Code/User/mcp.json` (Windows: `%APPDATA%\Code\User\mcp.json`, Linux: `~/.config/Code/User/mcp.json`)
- Commands *MCP: Open User Configuration* and *MCP: Open Workspace Folder Configuration* open or create these files.

**Q: How do I make a server work with VS Code and Kiro at the same time?**

Run one server exposing a Streamable HTTP endpoint and point both clients at the same URL. Maintain two thin config files: `.vscode/mcp.json` (`servers`) and `.kiro/settings/mcp.json` (`mcpServers`, plus `autoApprove`/`disabled`). No proxy or second server is required as long as both clients support Streamable HTTP and any auth is satisfied.

## How the bridge authenticates (and why it changed)

The first design copied Edge's raw `Cookies` file into the container. On macOS Edge encrypts cookies with a Keychain key that the container's Linux Chromium cannot read, so every cookie was dropped and Copilot showed its sign-in page. An older URL-only session check reported that as "verified". Copying decrypted cookies into the container also failed for a work (Entra) account, because Microsoft redirected the new browser back to sign-in.

Current design: the bridge **drives your signed-in Edge directly** over the Chrome DevTools Protocol.

```
VS Code / Kiro → MCP HTTP → copilot-bridge (Docker :3100)
   → CDP http://host.docker.internal:9223
   → scripts/cdp-proxy.mjs (host, 127.0.0.1:9223)
   → dedicated Edge (host, 127.0.0.1:9222) → copilot.cloud.microsoft
```

`cdp-proxy.mjs` exists because Edge's DevTools endpoint rejects any `Host` header that is not an IP or `localhost`; the proxy rewrites it. It listens on loopback only.
