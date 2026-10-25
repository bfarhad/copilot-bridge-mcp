/**
 * Browser automation layer.
 *
 * Authentication strategy
 * ───────────────────────
 * Chromium is launched with a persistent profile directory.
 * On first start (or when POST /auth/sync is called) the Edge/Chrome Cookies
 * SQLite file is copied from the host-mounted profile into the container
 * profile.  Chromium decrypts those cookies using the Linux v10 scheme
 * (AES-128-CBC, fixed key "peanuts") which matches what Edge writes on macOS
 * for session cookies — no macOS keychain access needed.
 *
 * If the host profile volume is not available (e.g. the user prefers not to
 * mount it), CDP extraction from a running Edge instance is supported as a
 * fallback when CDP_ENDPOINT is set.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { existsSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { extractReply, REPLY_SELECTOR, type CopilotReply } from "./reply.js";
import {
  copyHostCookies,
  extractViaCDP,
  getExtractedCookies,
  clearExtractedCookies,
} from "./cookies.js";

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------
const SEL = {
  // copilot.cloud.microsoft uses a SPAN[role=textbox], not a textarea
  chatInput: [
    '[role="textbox"][aria-label="Message Copilot"]',
    '#m365-chat-editor-target-element',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="copilot" i]',
    'textarea[placeholder*="ask" i]',
    '[role="textbox"]',
    '[data-testid*="composer"]',
    '[contenteditable][aria-label]',
  ].join(", "),
  submitButton: [
    'button[aria-label="Submit message"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button[type="submit"]',
  ].join(", "),
  stopButton: [
    'button[aria-label="Stop responding"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
    '[data-testid*="stop"]',
  ].join(", "),
};

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------
export type AuthStatus = "unauthenticated" | "syncing" | "ready" | "error";

let _status: AuthStatus = "unauthenticated";
let _statusMessage = "Not authenticated yet.";

/** What the user has to do to get a session, depending on how the bridge reaches Copilot. */
export function signInHint(): string {
  return config.cdpEndpoint
    ? "Sign in to Copilot in the dedicated Edge window (opened by scripts/run.sh or run.bat), make sure the CDP proxy is running in Docker mode, then click Re-check on http://localhost:3100."
    : "Run scripts/edge-login.sh, sign in to Copilot, then scripts/sync-cookies.mjs.";
}

export function getAuthStatus(): { status: AuthStatus; message: string } {
  return { status: _status, message: _statusMessage };
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
let context: BrowserContext | null = null;
let cdpBrowser: Browser | null = null;
let page: Page | null = null;

const PROFILE_DIR = process.env.PROFILE_DIR ?? "/app/profile";

// ---------------------------------------------------------------------------
// Executable path resolver (handles glob patterns like /ms-playwright/*/chrome)
// ---------------------------------------------------------------------------
async function resolveExecutablePath(): Promise<string | undefined> {
  const raw = config.executablePath;
  if (!raw) return undefined;
  if (!raw.includes("*")) return raw;

  try {
    const { execSync } = await import("node:child_process");
    const found = execSync(
      `find /ms-playwright -name "chrome" -type f 2>/dev/null | head -1`
    )
      .toString()
      .trim();
    if (found) {
      logger.debug(`Resolved Chromium executable: ${found}`);
      return found;
    }
  } catch {
    // ignore
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Browser context lifecycle
// ---------------------------------------------------------------------------

/** Remove all Chromium singleton lock files from the profile directory. */
function clearProfileLocks(): void {
  const cleanDirs = [PROFILE_DIR, join(PROFILE_DIR, "Default")];
  const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  for (const dir of cleanDirs) {
    for (const name of lockFiles) {
      const p = join(dir, name);
      try {
        lstatSync(p); // throws ENOENT if absent — works for symlinks too
        rmSync(p, { force: true });
        logger.debug(`Removed stale lock: ${p}`);
      } catch {
        // not present — nothing to do
      }
    }
  }
}

async function ensureContext(): Promise<BrowserContext> {
  if (context) return context;

  // CDP mode: drive the user's already-signed-in Edge instead of our own Chromium
  if (config.cdpEndpoint) {
    logger.info(`Attaching to Edge via CDP: ${config.cdpEndpoint}`);
    cdpBrowser = await chromium.connectOverCDP(config.cdpEndpoint);
    context = cdpBrowser.contexts()[0] ?? (await cdpBrowser.newContext());
    return context;
  }

  // Always clear stale locks before launch — the volume may carry them
  // from a previous container (different hostname = "another computer" error)
  clearProfileLocks();

  const executablePath = await resolveExecutablePath();
  logger.info(
    `Launching Chromium — headless=${config.headless} profile=${PROFILE_DIR} exe=${executablePath ?? "auto"}`
  );

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      // Tells Chromium to proceed even if it thinks the profile is in use
      "--no-process-singleton-locks",
    ],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"],
  });

  // Inject in-memory cookies if we have any (CDP extraction path)
  const cdpCookies = getExtractedCookies();
  if (cdpCookies.length > 0) {
    await context.addCookies(cdpCookies);
    clearExtractedCookies();
    logger.info(`Injected ${cdpCookies.length} cookies from CDP extraction`);
  }

  return context;
}

const cdpModeMessage = () =>
  "Cookie import is not used in CDP mode: the bridge drives your signed-in Edge directly. " + signInHint();

// ---------------------------------------------------------------------------
// Auth sync  — called on startup and via POST /auth/sync
// ---------------------------------------------------------------------------
export async function syncAuth(): Promise<{ ok: boolean; message: string }> {
  if (config.cdpEndpoint) return { ok: false, message: cdpModeMessage() };
  _status = "syncing";
  _statusMessage = "Syncing cookies…";

  // Try host profile copy first
  const hostResult = await copyHostCookies();
  if (hostResult.ok) {
    logger.info(hostResult.message);
    // Reset context so Chromium re-reads the new cookie file on next launch
    await resetContext();
  } else {
    logger.info(`Host profile copy: ${hostResult.message}`);

    // Fallback: CDP extraction from running Edge
    if (config.cdpEndpoint) {
      const cdpResult = await extractViaCDP(config.cdpEndpoint);
      if (!cdpResult.ok) {
        _status = "error";
        _statusMessage = cdpResult.message;
        return { ok: false, message: cdpResult.message };
      }
      logger.info(cdpResult.message);
      await resetContext();
    } else {
      _status = "unauthenticated";
      _statusMessage =
        hostResult.message +
        " Set HOST_PROFILE_DIR or CDP_ENDPOINT to enable cookie sync.";
      return { ok: false, message: _statusMessage };
    }
  }

  // Now open Copilot and verify the session works
  return verifySession();
}

/**
 * Import already-decrypted cookies (exported from a real Edge via CDP on the
 * host — see scripts/sync-cookies.mjs) into the Chromium profile, then verify.
 */
export async function importCookies(
  cookies: Parameters<BrowserContext["addCookies"]>[0]
): Promise<{ ok: boolean; message: string }> {
  // In CDP mode the context is the user's own Edge: importing would write cookies into it.
  if (config.cdpEndpoint) return { ok: false, message: cdpModeMessage() };
  _status = "syncing";
  _statusMessage = "Importing cookies…";
  try {
    await resetContext();
    const ctx = await ensureContext();
    // Session cookies (no expiry) would be dropped when Chromium restarts;
    // give them a lifetime so they persist in the profile across restarts.
    const persistUntil = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await ctx.addCookies(
      cookies.map((c) => ({
        ...c,
        expires: c.expires && c.expires > 0 ? c.expires : persistUntil,
      }))
    );
    logger.info(`Imported ${cookies.length} cookies`);
    return await verifySession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    _status = "error";
    _statusMessage = `Cookie import failed: ${msg}`;
    logger.error(_statusMessage);
    return { ok: false, message: _statusMessage };
  }
}

const isCopilotUrl = (u: string) =>
  u.includes("copilot.microsoft.com") || u.includes("copilot.cloud.microsoft") || u.includes("copilot.com");

/** In CDP mode reuse an open Copilot tab (keeps the user's chat/session); otherwise open one. */
async function openCopilotPage(ctx: BrowserContext): Promise<Page> {
  if (config.cdpEndpoint) {
    const existing = ctx.pages().find((pg) => isCopilotUrl(pg.url()) && pg.url().includes("/chat"));
    if (existing) return existing;
  }
  const p = await ctx.newPage();
  await p.goto(config.copilotUrl, { waitUntil: "domcontentloaded", timeout: config.selectorTimeoutMs });
  await p.waitForTimeout(3000);
  return p;
}

async function verifySession(): Promise<{ ok: boolean; message: string }> {
  logger.info("Verifying Copilot session…");
  try {
    const ctx = await ensureContext();
    const p = await openCopilotPage(ctx);
    page = p;

    const url = p.url();
    const title = await p.title().catch(() => "");
    logger.info(`Session check — current URL: ${url} | title: "${title}"`);

    const onAuthWall =
      url.includes("login.microsoft") ||
      url.includes("login.live") ||
      url.includes("account.live") ||
      url.includes("/oauth") ||
      url.includes("/auth/") ||
      // copilot.com shows "Sign in" page without redirecting to login.microsoft.com
      title.toLowerCase().includes("sign in");

    const onCopilot =
      url.includes("copilot.microsoft.com") ||
      url.includes("copilot.cloud.microsoft") ||
      url.includes("copilot.com");

    let hasInput = false;
    if (!onAuthWall && onCopilot) {
      hasInput = await p
        .locator(SEL.chatInput)
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
    }

    if (onAuthWall || !onCopilot || !hasInput) {
      _status = "unauthenticated";
      _statusMessage =
        "No Copilot session — the page shows a sign-in screen or no chat input. " + signInHint();
      // Never close the tab in CDP mode: it is the user's own and may be where they are signing in.
      if (!config.cdpEndpoint) await p.close().catch(() => {});
      page = null;
      return { ok: false, message: _statusMessage };
    }

    _status = "ready";
    _statusMessage = config.cdpEndpoint ? "Authenticated — Copilot is signed in in Edge" : "Authenticated — cookies active";
    logger.info("Session verified ✓");
    return { ok: true, message: _statusMessage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    _status = "error";
    _statusMessage = `Session verification failed: ${msg}`;
    logger.error(_statusMessage);
    page = null;
    return { ok: false, message: _statusMessage };
  }
}

/** Tear down the current browser context so it re-launches with fresh cookies. */
async function resetContext(): Promise<void> {
  if (config.cdpEndpoint) {
    // Detach only — leave the user's Edge and its tabs alone
    page = null;
    context = null;
    if (cdpBrowser) await cdpBrowser.close().catch(() => {});
    cdpBrowser = null;
    return;
  }
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  page = null;
  context = null;
  clearProfileLocks();
}

// ---------------------------------------------------------------------------
// On-startup restore attempt
// ---------------------------------------------------------------------------
export async function tryRestoreSession(): Promise<void> {
  // Check if there's anything worth restoring — if the profile is empty
  // (no Cookies file) skip the launch entirely to avoid holding a lock
  const cookiesFile = join(PROFILE_DIR, "Default", "Cookies");
  if (!config.cdpEndpoint && !existsSync(cookiesFile)) {
    logger.info("No cookie file in profile — skipping session restore");
    _status = "unauthenticated";
    _statusMessage = `No session found. ${signInHint()}`;
    return;
  }

  logger.info("Attempting to restore session from existing profile…");
  const result = await verifySession();
  if (!result.ok) {
    logger.info("No valid session in profile — call POST /auth/sync to import cookies");
    await resetContext();
    _status = "unauthenticated";
    _statusMessage = `No session found. ${signInHint()}`;
  }
}

// ---------------------------------------------------------------------------
// Ensure a usable page
// ---------------------------------------------------------------------------
async function getReadyPage(): Promise<Page> {
  // In CDP mode the session can appear (or recover) without any bridge action, e.g. after
  // the user signs in or Edge restarts, so look again instead of staying in a stale state.
  if (_status !== "ready" && config.cdpEndpoint && _status !== "syncing") await verifySession();
  if (_status !== "ready") {
    throw new Error(`Bridge not authenticated (status: ${_status}). ${_statusMessage}`);
  }

  if (page && !page.isClosed()) {
    const u = page.url();
    if (
      u.includes("copilot.microsoft.com") ||
      u.includes("copilot.cloud.microsoft") ||
      u.includes("copilot.com")
    ) {
      return page;
    }
  }

  const ctx = await ensureContext();
  page = await openCopilotPage(ctx);
  return page;
}

// ---------------------------------------------------------------------------
// Core interaction
// ---------------------------------------------------------------------------
// All clients (Kiro, VS Code, Claude Code…) share ONE Copilot tab. Without
// serialisation a second client's new-chat navigation or typing clobbers the
// first one's prompt and the wrong answer is returned. Calls therefore run
// strictly one at a time, each including its own new-chat reset.
let queue: Promise<unknown> = Promise.resolve();

export interface AskOptions {
  newChat?: boolean;
  /** Overrides RESPONSE_TIMEOUT_MS for this call. */
  timeoutMs?: number;
}

const stats = {
  calls: 0,
  errors: 0,
  totalMs: 0,
  waiting: 0,
  inFlight: false,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
};

/** Counters and queue state for get_status. */
export function getRuntimeStats() {
  return {
    queued: stats.waiting,
    inFlight: stats.inFlight,
    calls: stats.calls,
    errors: stats.errors,
    avgLatencyMs: stats.calls - stats.errors > 0 ? Math.round(stats.totalMs / (stats.calls - stats.errors)) : null,
    lastSuccessAt: stats.lastSuccessAt,
    lastError: stats.lastError,
  };
}

export function askCopilot(prompt: string, opts: AskOptions = {}): Promise<CopilotReply> {
  stats.waiting++;
  const run = queue.then(async () => {
    stats.waiting--;
    stats.inFlight = true;
    stats.calls++;
    const started = Date.now();
    try {
      const reply = await askCopilotExclusive(prompt, opts);
      stats.totalMs += Date.now() - started;
      stats.lastSuccessAt = new Date().toISOString();
      return reply;
    } catch (err) {
      stats.errors++;
      stats.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      stats.inFlight = false;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Edge reachability and tab state, without sending a prompt. */
export async function probeBrowser(): Promise<{
  mode: "cdp" | "cookies";
  edgeReachable: boolean | null;
  edgeVersion: string | null;
  tabOpen: boolean;
  tabUrl: string | null;
}> {
  let edgeReachable: boolean | null = null;
  let edgeVersion: string | null = null;
  if (config.cdpEndpoint) {
    try {
      const res = await fetch(new URL("/json/version", config.cdpEndpoint), { signal: AbortSignal.timeout(3_000) });
      edgeReachable = res.ok;
      if (res.ok) edgeVersion = ((await res.json()) as { Browser?: string }).Browser ?? null;
    } catch {
      edgeReachable = false;
    }
  }
  const tabOpen = !!page && !page.isClosed();
  return {
    mode: config.cdpEndpoint ? "cdp" : "cookies",
    edgeReachable,
    edgeVersion,
    tabOpen,
    tabUrl: tabOpen ? page!.url() : null,
  };
}

/** Re-check the Copilot session (queued behind running prompts) and update the auth state. */
export function recheckSession(): Promise<{ ok: boolean; message: string }> {
  const run = queue.then(() => verifySession());
  queue = run.catch(() => undefined);
  return run;
}

async function askCopilotExclusive(
  prompt: string,
  opts: AskOptions
): Promise<CopilotReply> {
  const timeoutMs = opts.timeoutMs ?? config.responseTimeoutMs;
  if (opts.newChat) {
    await resetForNewChat().catch(() => { /* non-fatal */ });
  }
  const p = await getReadyPage();

  logger.debug("Waiting for chat input…");
  const inputLocator = p.locator(SEL.chatInput).first();
  // Wait up to the full selector timeout; copilot.com SPA can be slow to mount
  await inputLocator.waitFor({ state: "visible", timeout: config.selectorTimeoutMs });
  // Extra settling time after the input appears (avoids stale element errors)
  await p.waitForTimeout(500);

  // Replies already on the page — the new answer is the one after these
  const before = await p.locator(REPLY_SELECTOR).count().catch(() => 0);

  await inputLocator.click();
  await clearInput(p);
  await typePrompt(p, prompt);

  const submitLocator = p.locator(SEL.submitButton).first();
  if (await submitLocator.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await submitLocator.click();
  } else {
    await inputLocator.press("Enter");
  }
  logger.debug("Prompt submitted, waiting for response…");

  const done = await waitForStreamingToFinish(p, before, timeoutMs);
  if (!done) {
    throw new Error(`Copilot did not respond within ${timeoutMs}ms`);
  }

  const reply = await extractReply(p);
  if (!reply || !reply.markdown) throw new Error("Copilot replied but the answer could not be read");
  logger.debug(`Response: ${reply.markdown.length} chars, ${reply.codeBlocks.length} code blocks`);
  return reply;
}

/** Select-all + delete — works for textareas and contenteditable editors alike. */
async function clearInput(p: Page): Promise<void> {
  await p.keyboard.press("ControlOrMeta+A");
  await p.keyboard.press("Backspace");
}

/**
 * Insert the prompt in one go per line. Typing key by key is slow for long
 * prompts, and a bare "\n" would press Enter and submit mid-prompt, so lines
 * are joined with Shift+Enter instead.
 */
async function typePrompt(p: Page, prompt: string): Promise<void> {
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await p.keyboard.press("Shift+Enter");
    if (lines[i]) await p.keyboard.insertText(lines[i]);
  }
}

async function waitForStreamingToFinish(p: Page, before: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // Strategy A: stop button lifecycle
  try {
    const stop = p.locator(SEL.stopButton).first();
    await stop.waitFor({ state: "visible", timeout: 10_000 });
    logger.debug("Stop button visible — waiting for response to finish…");
    await stop.waitFor({ state: "hidden", timeout: timeoutMs });
    return true;
  } catch { /* fall through */ }

  // Strategy B: stable text — use the full candidate list, not just REPLY_SELECTOR
  logger.debug("Falling back to stable-text polling…");
  let last = "";
  let since = Date.now();
  while (Date.now() < deadline) {
    await p.waitForTimeout(500);
    const cur = await extractLastResponse(p).catch(() => "");
    // Only count text that is longer than what was there before we submitted
    if (cur.length > last.length) { last = cur; since = Date.now(); }
    else if (Date.now() - since > 3_000 && cur.length > 0) return true;
  }
  return false;
}

async function extractLastResponse(p: Page): Promise<string> {
  const candidates = [
    // copilot.cloud.microsoft — real selectors confirmed from live DOM
    '[data-testid="copilot-message-reply-div"]',
    '[data-testid="copilot-message-div"]',
    // copilot.microsoft.com (consumer)
    '[data-testid="markdown-reply"]',
    // generic fallbacks
    '[class*="CopilotMessage"]',
    '[class*="assistant"]',
    '[class*="bot-message"]',
    '[role="article"]',
    '[class*="message"]',
    "article",
  ];
  for (const sel of candidates) {
    const els = p.locator(sel);
    const n = await els.count().catch(() => 0);
    if (n > 0) return (await els.nth(n - 1).textContent()) ?? "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Close browser for a new chat thread — resets page/context but keeps auth state. */
export async function resetForNewChat(): Promise<void> {
  if (config.cdpEndpoint && page && !page.isClosed()) {
    await page.goto(config.copilotUrl, { waitUntil: "domcontentloaded", timeout: config.selectorTimeoutMs });
    await page.waitForTimeout(2000);
    return;
  }
  await resetContext();
  // Keep _status as "ready" — cookies are still in the profile
  // Next call to getReadyPage() will re-launch Chromium and re-open Copilot
}

/** Full shutdown — called on SIGTERM/SIGINT only. */
export async function closeBrowser(): Promise<void> {
  await resetContext();
  _status = "unauthenticated";
}

/** Dump live DOM info from the current page — used by GET /debug/dom */
export async function debugPage(): Promise<object> {
  if (!page || page.isClosed()) {
    return { error: "No page open", status: _status };
  }
  const url = page.url();
  const title = await page.title().catch(() => "");
  const inputs = await page.evaluate(() => {
    const els = [
      ...document.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]'),
    ];
    return els.map((e) => ({
      tag: e.tagName,
      placeholder: e.getAttribute("placeholder"),
      ariaLabel: e.getAttribute("aria-label"),
      role: e.getAttribute("role"),
      id: e.id,
      dataTestId: e.getAttribute("data-testid"),
      class: e.className?.toString().slice(0, 80),
      visible: (e as HTMLElement).offsetParent !== null,
    }));
  }).catch(() => []);

  // Also dump candidate message containers to help fix extractLastResponse
  const messages = await page.evaluate(() => {
    const candidates = [
      '[data-testid*="message"]',
      '[class*="message"]',
      '[class*="response"]',
      '[class*="assistant"]',
      '[class*="chat"]',
      "article",
      '[role="article"]',
      '[role="listitem"]',
    ];
    const results: object[] = [];
    for (const sel of candidates) {
      const els = [...document.querySelectorAll(sel)].slice(0, 3);
      for (const e of els) {
        results.push({
          sel,
          tag: e.tagName,
          id: e.id,
          dataTestId: e.getAttribute("data-testid"),
          ariaLabel: e.getAttribute("aria-label"),
          class: e.className?.toString().slice(0, 80),
          textSnippet: e.textContent?.trim().slice(0, 120),
        });
      }
    }
    return results;
  }).catch(() => []);

  return { url, title, inputs, messages };
}
