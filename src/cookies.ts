/**
 * Cookie extractor.
 *
 * Reads the Chromium/Edge "Cookies" SQLite database that is mounted from the
 * host at HOST_PROFILE_DIR and returns Playwright-compatible cookie objects
 * filtered to Microsoft/Copilot domains.
 *
 * The cookie values in the DB are encrypted with the OS keychain on macOS
 * (AES-128-CBC, key derived from "Chrome Safe Storage" or "Microsoft Edge
 * Safe Storage").  Rather than trying to decrypt them inside the container
 * (which has no access to the macOS keychain), we rely on the fact that
 * Playwright's persistent context shares the same Chromium storage backend —
 * we copy the raw SQLite file into the container profile and let Chromium
 * decrypt them itself when it starts.
 *
 * Flow:
 *   1. cp /host-profile/Cookies → /app/profile/Default/Cookies   (raw copy)
 *   2. launchPersistentContext("/app/profile") — Chromium decrypts on open
 *   3. goto copilot.microsoft.com — already authenticated
 *
 * This works because:
 *  - The persistent profile dir IS the Chrome user data dir
 *  - Chromium reads and decrypts its own Cookies file using the host key
 *    — but inside Docker on Linux there is no macOS keychain, so Chromium
 *    falls back to the empty-passphrase Linux DPAPI (v10 prefix) for cookies
 *    originally encrypted on macOS (v10 prefix = AES-128-CBC with fixed key
 *    "peanuts").  This is the well-known "v10" cookie encryption used on
 *    Linux / containers and does NOT require keychain access.
 *
 * On macOS the cookies are encrypted with the "v10" scheme OR the newer
 * "v20" scheme (hardware-backed).  Edge on macOS uses "v10" by default for
 * all Copilot/Microsoft session cookies which makes this approach work.
 *
 * If cookies are v20 (hardware-backed) they cannot be extracted this way —
 * the fallback is to export them via the DevTools Protocol from the running
 * Edge process (CDP approach, see extractViaCDP).
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

// Where the host Edge profile is mounted (read-only)
const HOST_PROFILE = process.env.HOST_PROFILE_DIR ?? "/host-profile";

// Where our container Chromium profile lives
const CONTAINER_PROFILE = process.env.PROFILE_DIR ?? "/app/profile";

// Microsoft domains we care about
const MS_DOMAINS = [
  ".microsoft.com",
  ".live.com",
  ".microsoftonline.com",
  ".bing.com",
  "copilot.microsoft.com",
  "copilot.cloud.microsoft",
];

export interface CookieCopyResult {
  ok: boolean;
  message: string;
  cookieFileCopied: boolean;
}

/**
 * Copy the Edge/Chrome Cookies SQLite file from the host profile into the
 * container's Chromium profile directory so Chromium can decrypt and use it.
 */
export async function copyHostCookies(): Promise<CookieCopyResult> {
  const srcCookies = join(HOST_PROFILE, "Cookies");

  if (!existsSync(HOST_PROFILE)) {
    return {
      ok: false,
      cookieFileCopied: false,
      message:
        `Host profile not found at ${HOST_PROFILE}. ` +
        "Make sure HOST_PROFILE_DIR is set and the volume is mounted.",
    };
  }

  if (!existsSync(srcCookies)) {
    return {
      ok: false,
      cookieFileCopied: false,
      message: `Cookies file not found at ${srcCookies}.`,
    };
  }

  // Chromium expects cookies at: <UserDataDir>/Default/Cookies
  // Our PROFILE_DIR IS the UserDataDir, so we need Default/ subdir
  const defaultDir = join(CONTAINER_PROFILE, "Default");
  if (!existsSync(defaultDir)) {
    mkdirSync(defaultDir, { recursive: true });
    logger.debug(`Created ${defaultDir}`);
  }

  const destCookies = join(defaultDir, "Cookies");

  try {
    copyFileSync(srcCookies, destCookies);
    logger.info(`Copied Cookies file: ${srcCookies} → ${destCookies}`);
    return { ok: true, cookieFileCopied: true, message: "Cookies file copied successfully." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, cookieFileCopied: false, message: `Failed to copy Cookies: ${msg}` };
  }
}

/**
 * Alternative: extract cookies via CDP from a running Edge instance.
 * Used when HOST_PROFILE_DIR is not available.
 *
 * Requires Edge to be running with --remote-debugging-port=9222 on the host
 * and CDP_ENDPOINT to be set in the environment.
 */
export async function extractViaCDP(cdpEndpoint: string): Promise<CookieCopyResult> {
  // We use Playwright's connectOverCDP to pull cookies from the live browser
  const { chromium } = await import("playwright-core");

  try {
    logger.info(`Connecting to live browser via CDP: ${cdpEndpoint}`);
    const browser = await chromium.connectOverCDP(cdpEndpoint);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      await browser.close();
      return { ok: false, cookieFileCopied: false, message: "No browser contexts found via CDP." };
    }

    const ctx = contexts[0];
    const allCookies = await ctx.cookies();

    // Filter to Microsoft domains
    const msCookies = allCookies.filter((c) =>
      MS_DOMAINS.some((d) => c.domain.includes(d.replace(/^\./, "")))
    );

    logger.info(`Extracted ${msCookies.length} Microsoft cookies via CDP`);
    await browser.close();

    // Store for injection — we'll return them via a module-level variable
    // that browser.ts reads when setting up the context.
    _extractedCookies = msCookies;

    return {
      ok: true,
      cookieFileCopied: false,
      message: `Extracted ${msCookies.length} cookies via CDP.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, cookieFileCopied: false, message: `CDP extraction failed: ${msg}` };
  }
}

// In-memory cookies extracted via CDP (used by browser.ts)
let _extractedCookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" }> = [];

export function getExtractedCookies() {
  return _extractedCookies;
}

export function clearExtractedCookies() {
  _extractedCookies = [];
}
