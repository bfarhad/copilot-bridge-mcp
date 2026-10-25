/**
 * Single source of truth for the release version: the `version` field of
 * package.json. The build commit comes from the GIT_SHA environment variable,
 * which the Dockerfile and the run scripts set; it is "dev" otherwise.
 */
import { readFileSync } from "node:fs";

// package.json sits one level above both src/ (tsx) and dist/ (compiled).
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

export const APP_NAME = "copilot-bridge";
export const VERSION = pkg.version;
export const COMMIT = (process.env.GIT_SHA ?? "dev").slice(0, 7);

/** Human-readable form, e.g. "0.2.0 (a1b2c3d)". */
export const VERSION_LABEL = COMMIT === "dev" ? VERSION : `${VERSION} (${COMMIT})`;
