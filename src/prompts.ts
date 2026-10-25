/**
 * Prompt construction for the MCP tools. Pure functions, no browser access,
 * so they can be checked with dryRun without a Copilot session.
 */
import type { CopilotReply } from "./reply.js";

export const FOCUS_AREAS = ["bugs", "security", "performance", "tests", "style", "readability"] as const;
export type FocusArea = (typeof FOCUS_AREAS)[number];

const FOCUS_TEXT: Record<FocusArea, string> = {
  bugs: "logic errors, edge cases and error handling",
  security: "security problems (injection, secrets, unsafe input handling, authentication)",
  performance: "performance and resource use",
  tests: "missing or weak tests; suggest concrete test cases",
  style: "style and consistency with common conventions of the language",
  readability: "naming, structure and readability",
};

export const SEVERITIES = ["info", "low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type ReviewFormat = "markdown" | "findings-json" | "patch";

export interface ReviewFile {
  filename?: string;
  language?: string;
  code: string;
}

/** Prepend a role / standing instruction to a prompt. */
export function withSystemPrompt(prompt: string, systemPrompt?: string): string {
  return systemPrompt ? `${systemPrompt.trim()}\n\n${prompt}` : prompt;
}

/** Ask for a single JSON block so the reply can be parsed. */
export function withJsonInstruction(prompt: string): string {
  return `${prompt}\n\nReply with only valid JSON in a single \`\`\`json code block, with no text outside the block.`;
}

export function buildReviewPrompt(args: {
  instruction: string;
  files: ReviewFile[];
  focus?: FocusArea[];
  minSeverity?: Severity;
  format?: ReviewFormat;
}): string {
  const parts: string[] = [];
  for (const f of args.files) {
    const header = [f.language && `Language: ${f.language}`, f.filename && `File: ${f.filename}`]
      .filter(Boolean)
      .join(" | ");
    if (header) parts.push(header);
    parts.push("```" + (f.language?.toLowerCase() ?? ""), f.code, "```", "");
  }
  parts.push(args.instruction);

  if (args.focus?.length) {
    parts.push(`Focus on: ${args.focus.map((a) => FOCUS_TEXT[a]).join("; ")}.`);
  }
  if (args.minSeverity && args.minSeverity !== "info") {
    parts.push(`Report only findings of severity ${args.minSeverity} or higher.`);
  }
  if (args.format === "findings-json") {
    parts.push(
      "Reply with only a JSON array in a single ```json code block. Each item: " +
        '{"file": string, "line": number or null, "severity": "info"|"low"|"medium"|"high", ' +
        '"title": string, "suggestion": string}. Use [] if there are no findings.'
    );
  } else if (args.format === "patch") {
    parts.push(
      "Reply with only the proposed changes as a unified diff in a single ```diff code block, " +
        "with file names matching the ones above."
    );
  }
  return parts.join("\n");
}

/** First parsed JSON block of a reply, or undefined. */
export function firstJsonBlock(reply: CopilotReply): unknown | undefined {
  return reply.codeBlocks.find((b) => b.parsed !== undefined)?.parsed;
}

/** First code block with the given language (for diffs). */
export function firstBlockOfLanguage(reply: CopilotReply, language: string): string | undefined {
  return reply.codeBlocks.find((b) => b.language.toLowerCase() === language)?.code;
}
