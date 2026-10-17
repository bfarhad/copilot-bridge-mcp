import { config } from "./config.js";

type Level = "debug" | "info" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, error: 2 };

function log(level: Level, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const ts = new Date().toISOString();
  const fn = level === "error" ? console.error : console.log;
  fn(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug: (...a: unknown[]) => log("debug", ...a),
  info: (...a: unknown[]) => log("info", ...a),
  error: (...a: unknown[]) => log("error", ...a),
};
