#!/usr/bin/env node
// Export Microsoft/Copilot cookies from the Edge started by edge-login.sh (CDP)
// and push them into the running copilot-bridge container.
import { chromium } from "playwright-core";

const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const BRIDGE = process.env.BRIDGE_URL ?? "http://localhost:3100";
const DOMAINS = ["microsoft.com", "live.com", "microsoftonline.com", "bing.com", "copilot.com", "microsoft.net", "msn.com"];

const browser = await chromium.connectOverCDP(CDP).catch((e) => {
  console.error(`Cannot reach Edge at ${CDP} — run scripts/edge-login.sh first.\n${e.message}`);
  process.exit(1);
});
const cookies = (await browser.contexts()[0].cookies()).filter((c) =>
  DOMAINS.some((d) => c.domain.replace(/^\./, "").endsWith(d))
);
await browser.close();
console.log(`Exported ${cookies.length} cookies from Edge`);

const res = await fetch(`${BRIDGE}/auth/cookies`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cookies }),
});
const body = await res.json();
console.log(res.ok ? "✓" : "✗", body.message);
process.exit(res.ok ? 0 : 1);
