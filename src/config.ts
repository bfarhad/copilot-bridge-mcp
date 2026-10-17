/**
 * Central configuration — values come from environment variables so the
 * Docker container can be tuned without a rebuild.
 */
export const config = {
  /** HTTP port the MCP server listens on */
  port: Number(process.env.PORT ?? 3100),

  /** Chrome/Chromium executable path inside the container (installed by Playwright) */
  executablePath: process.env.BROWSER_EXECUTABLE_PATH ?? undefined,

  /**
   * CDP endpoint of an already-running browser (e.g. Edge with
   * --remote-debugging-port=9222).  When set, the server attaches to that
   * browser instead of launching its own.
   */
  cdpEndpoint: process.env.CDP_ENDPOINT ?? undefined,

  /** Copilot entry URL — work/M365 accounts land on copilot.cloud.microsoft/chat */
  copilotUrl: process.env.COPILOT_URL ?? "https://copilot.cloud.microsoft/chat",

  /** Run Chromium in headless mode (default true; set to "false" to debug) */
  headless: (process.env.HEADLESS ?? "true") !== "false",

  /**
   * How long (ms) to wait for the Copilot response to finish streaming
   * before giving up.
   */
  responseTimeoutMs: Number(process.env.RESPONSE_TIMEOUT_MS ?? 120_000),

  /** How long (ms) to wait for DOM elements before timing out */
  selectorTimeoutMs: Number(process.env.SELECTOR_TIMEOUT_MS ?? 30_000),

  /** Log level: "debug" | "info" | "error" */
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "error",
};
