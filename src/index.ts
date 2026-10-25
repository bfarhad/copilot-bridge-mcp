/**
 * Entry point.
 *
 * HTTP routes:
 *   GET  /           — status page (shows the version)
 *   GET  /health     — Docker health probe
 *   GET  /version    — version and build commit as JSON
 *   POST /auth/recheck — re-check the Copilot session (status page button)
 *   POST /auth/sync  — cookie mode only: copy cookies from host Edge profile
 *   ALL  /mcp        — MCP Streamable HTTP transport (Kiro connects here)
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { createMcpServer } from "./mcp-server.js";
import { closeBrowser, tryRestoreSession, syncAuth, importCookies, getAuthStatus, debugPage, recheckSession } from "./browser.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { APP_NAME, COMMIT, VERSION, VERSION_LABEL } from "./version.js";

const app = express();
// DNS-rebinding protection: reject requests whose Host header is not an allowed
// hostname (default: localhost only). Extend with ALLOWED_HOSTS if needed.
app.use(hostHeaderValidation(config.allowedHosts));
app.use(express.json({ limit: "5mb" }));

// ---------------------------------------------------------------------------
// Status page
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => {
  const auth = getAuthStatus();
  const isReady = auth.status === "ready";
  const isSyncing = auth.status === "syncing";

  const color = isReady ? "#16a34a" : isSyncing ? "#d97706" : "#dc2626";
  const label = isReady ? "● ready" : isSyncing ? "● syncing…" : "● not authenticated";

  const cdp = !!config.cdpEndpoint;
  const recheck = `<form method="post" action="/auth/recheck"><button>Re-check session</button></form>`;
  const actionSection = isReady
    ? `<p>Copilot session is active. Kiro can use <code>ask_copilot</code>.</p>
       <p>Signed out later? Sign in again in the dedicated Edge window${cdp ? "" : ", then run <code>node scripts/sync-cookies.mjs</code>"}.</p>`
    : isSyncing
    ? `<p>Checking the Copilot session…</p>`
    : cdp
    ? `<p>Sign in to Copilot in the dedicated Edge window (opened by <code>scripts/run.sh</code> / <code>run.bat</code>).
       In Docker mode the CDP proxy must be running.</p>${recheck}`
    : `<p>Run <code>scripts/edge-login.sh</code> (sign in to Copilot once),
       then <code>node scripts/sync-cookies.mjs</code>.</p>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="refresh" content="4"/>
  <title>copilot-bridge v${VERSION}</title>
  <style>
    *    { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 580px; margin: 60px auto; padding: 0 20px; color: #111; }
    h1   { font-size: 1.35rem; margin-bottom: .2rem; }
    p    { margin: .45rem 0; color: #555; font-size: .95rem; }
    code { background: #f3f3f3; padding: 2px 6px; border-radius: 4px; font-size: .88rem; }
    .status { font-weight: 700; color: ${color}; font-size: 1rem; }
    .msg    { font-size: .82rem; color: #888; margin-top: .3rem; }
    .ver { color: #888; font-weight: 400; font-size: .85rem; margin-left: .4rem; }
    hr   { border: none; border-top: 1px solid #e8e8e8; margin: 1.4rem 0; }
    a    { color: #2563eb; }
    button {
      margin-top: .5rem; background: #2563eb; color: #fff; border: none;
      padding: 9px 20px; border-radius: 6px; cursor: pointer; font-size: .93rem;
    }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <h1>copilot-bridge<span class="ver">v${VERSION_LABEL}</span></h1>
  <p class="status">${label}</p>
  <p class="msg">${auth.message}</p>
  <hr/>
  ${actionSection}
  <hr/>
  <p><strong>MCP endpoint</strong></p>
  <p><code>http://localhost:${config.port}/mcp</code></p>
  <p style="margin-top:.8rem"><a href="/health">Health check →</a></p>
  <p style="font-size:.78rem;color:#bbb;margin-top:2rem">Auto-refreshes every 4 s</p>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  const { status } = getAuthStatus();
  res.json({ status: "ok", version: VERSION, uptime: process.uptime(), auth: status });
});

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------
app.get("/version", (_req, res) => {
  res.json({ name: APP_NAME, version: VERSION, commit: COMMIT });
});

// ---------------------------------------------------------------------------
// Debug endpoint — dumps input elements from the live Copilot page
// ---------------------------------------------------------------------------
app.get("/debug/dom", async (_req, res) => {
  try {
    const info = await debugPage();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Auth sync — imports cookies from the mounted host Edge profile
// ---------------------------------------------------------------------------
app.post("/auth/sync", async (_req, res) => {
  logger.info("Cookie sync requested");
  try {
    const result = await syncAuth();
    if (result.ok) {
      res.redirect("/");
    } else {
      res.status(400).setHeader("Content-Type", "text/plain").send(result.message);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("syncAuth error:", msg);
    res.status(500).send(msg);
  }
});

// ---------------------------------------------------------------------------
// Re-check the Copilot session (status page button)
// ---------------------------------------------------------------------------
app.post("/auth/recheck", async (_req, res) => {
  await recheckSession().catch((err) => logger.error("recheck failed:", err));
  res.redirect("/");
});

// ---------------------------------------------------------------------------
// Cookie import — body: { cookies: Playwright cookie[] } (see scripts/sync-cookies.mjs)
// ---------------------------------------------------------------------------
app.post("/auth/cookies", async (req, res) => {
  const cookies = req.body?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    res.status(400).json({ ok: false, message: "Body must be { cookies: [...] }" });
    return;
  }
  logger.info(`Cookie import requested (${cookies.length} cookies)`);
  const result = await importCookies(cookies);
  res.status(result.ok ? 200 : 400).json(result);
});

// ---------------------------------------------------------------------------
// MCP endpoint
// ---------------------------------------------------------------------------
const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        logger.info(`MCP session: ${id}`);
        transports.set(id, transport!);
      },
    });
    transport.onclose = () => {
      const id = transport!.sessionId;
      if (id) transports.delete(id);
    };
    const server = createMcpServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const httpServer = app.listen(config.port, async () => {
  logger.info(`${APP_NAME} v${VERSION_LABEL} listening on http://0.0.0.0:${config.port}`);
  logger.info(`  UI  : http://localhost:${config.port}/`);
  logger.info(`  MCP : http://localhost:${config.port}/mcp`);
  await tryRestoreSession();
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} — shutting down`);
  httpServer.close();
  await closeBrowser();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
