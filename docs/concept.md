# Concept: MCP Copilot Browser Bridge

## Goal

Expose Microsoft Copilot, already signed in inside your own Edge browser, as a local MCP server. Any MCP client (Kiro, VS Code, Claude Code) can then call Copilot as a tool. A prompt goes from the editor to the bridge, into the Copilot chat UI, and the response returns to the editor.

## Why it works

Copilot authenticates with browser sessions, not API keys. If the bridge drives the browser that is already signed in, no credentials, token refresh or API key are needed. The bridge only automates what you would otherwise type by hand.

## Architecture

```
Kiro / VS Code / Claude Code          (MCP clients)
        │  MCP, Streamable HTTP  (http://localhost:3100/mcp)
        ▼
copilot-bridge  (Docker container, always running, port 3100)
        │  Chrome DevTools Protocol → host.docker.internal:9223
        ▼
cdp-proxy.mjs   (host, 127.0.0.1:9223 → 9222, rewrites Host header)
        ▼
Dedicated Edge  (host, signed in, remote debugging on 9222)
        ▼
Copilot chat tab  (copilot.cloud.microsoft for work accounts)
```

Components:

| Component | Role |
|---|---|
| MCP server (`src/mcp-server.ts`, `src/index.ts`) | Speaks MCP over HTTP; exposes `ask_copilot`, `review_code`, `get_status` |
| Browser layer (`src/browser.ts`) | Attaches to Edge over CDP, finds or opens the Copilot tab, types the prompt, waits for the stream to finish, scrapes the reply |
| Docker container | Runs the bridge as a daemon with a stable URL, shared by every editor |
| `scripts/edge-login.sh` | Starts a dedicated Edge profile with remote debugging |
| `scripts/cdp-proxy.mjs` | Lets the container reach Edge's DevTools port |

## Request flow

1. The client calls a tool over MCP.
2. The bridge reuses the open Copilot tab, or opens one (and navigates to a fresh chat when `newChat` is set).
3. It waits for the chat input, types the prompt and submits it.
4. It waits for streaming to end: the stop button appears and disappears, or the last message stops changing.
5. It scrapes the last assistant message and returns it as text.

## Key decisions

| Decision | Choice | Reason |
|---|---|---|
| Transport | Streamable HTTP, not stdio | One long-lived server for several editors; same URL everywhere |
| Packaging | Docker (developed and tested on OrbStack) | Runs as a daemon, survives restarts, isolated from the host; any Docker runs the container |
| Browser control | Playwright over CDP | Reuses a real signed-in session; the SPA needs a real browser |
| Auth | Drive the signed-in Edge, no cookie copying | See below |
| Profile | Dedicated Edge profile (`~/.copilot-bridge-edge`) | Edge blocks the debug port on the default profile; keeps the daily profile untouched |

## Authentication: what was tried

1. **Copy Edge's `Cookies` file into the container.** Failed: on macOS the cookies are encrypted with a Keychain key the container's Linux Chromium cannot read, so they were dropped and Copilot showed its sign-in page.
2. **Export decrypted cookies over CDP and import them into the container's Chromium.** Failed for a work (Entra) account: Microsoft redirected the new browser back to sign-in.
3. **Attach to the signed-in Edge over CDP (current).** Works. No cookie transfer; the bridge types into the real tab. Cost: the dedicated Edge window and the proxy must stay running.

The session check requires a visible chat input and a non-"Sign in" page, so a sign-in wall is reported as `unauthenticated`, not `ready`.

## Challenges and mitigations

| Challenge | Mitigation |
|---|---|
| Copilot UI changes break selectors | Selectors are centralised in the `SEL` object in `src/browser.ts`; `/debug/dom` lists the inputs on the live page |
| Streaming replies | Stop-button lifecycle first, stable-text polling as a fallback |
| Rate limits / captcha | Keep one persistent tab; don't restart the browser between calls |
| Profile already open | Dedicated profile plus CDP attach, instead of launching a second instance on the same profile |
| Conversation context | Continues the current thread by default; `newChat: true` starts a fresh one |
| Edge rejects the container's `Host` header | Loopback-only proxy that rewrites it |

## Limits

- Not an official Microsoft API. It scrapes the DOM and will break if the Copilot UI changes significantly.
- It stops working if the session expires or Microsoft adds new sign-in challenges; sign in again in the dedicated Edge.
- The dedicated Edge window and the proxy must be running on the host.
- Personal productivity use only; Microsoft's Terms of Service and rate limits still apply.

## Related docs

- [README](../README.md): setup, tool reference, troubleshooting
- [Editor setup for VS Code and Kiro](editor-setup-vscode-kiro.md): config files and JSON fields
