/**
 * MCP server definition.
 *
 * Tools: ask_copilot, review_code, get_status
 * The server is transport-agnostic; callers wire in the transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { askCopilot, getAuthStatus, getRuntimeStats, probeBrowser, recheckSession } from "./browser.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { APP_NAME, COMMIT, VERSION } from "./version.js";
import {
  FOCUS_AREAS,
  SEVERITIES,
  buildReviewPrompt,
  firstBlockOfLanguage,
  firstJsonBlock,
  withJsonInstruction,
  withSystemPrompt,
} from "./prompts.js";
import { formatForClient, saveReply, type CopilotReply } from "./reply.js";

/** Output options shared by ask_copilot and review_code. */
const outputOptions = {
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Truncate the returned text to this many characters (saves tokens). Saved files stay complete."),
  includeSources: z
    .boolean()
    .optional()
    .default(false)
    .describe("Append the list of cited source URLs (omitted by default to save tokens)."),
  save: z
    .array(z.enum(["md", "html", "json"]))
    .optional()
    .describe(
      "Also save the full reply to disk: md (Markdown), html (styled page), json (prompt, markdown, " +
        "codeBlocks with language and parsed JSON, sources). The file paths are appended to the result."
    ),
};

/** Call options shared by every tool that sends a prompt. */
const callOptions = {
  timeoutMs: z
    .number()
    .int()
    .min(5_000)
    .max(900_000)
    .optional()
    .describe("Max wait for the reply in ms (default: the server's RESPONSE_TIMEOUT_MS)."),
  retries: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .default(0)
    .describe("Extra attempts if the call fails or times out (default 0)."),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe("Return the exact prompt that would be sent, without contacting Copilot."),
};

interface CallOpts {
  timeoutMs?: number;
  retries: number;
}

/** askCopilot with retries; each retry runs in a fresh chat so a half-typed prompt cannot linger. */
async function askWithRetry(prompt: string, newChat: boolean, call: CallOpts): Promise<CopilotReply> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= call.retries; attempt++) {
    try {
      return await askCopilot(prompt, { newChat: newChat || attempt > 0, timeoutMs: call.timeoutMs });
    } catch (err) {
      lastErr = err;
      logger.error(`attempt ${attempt + 1}/${call.retries + 1} failed:`, err instanceof Error ? err.message : err);
    }
  }
  throw lastErr;
}

const errorResult = (prefix: string, err: unknown) => ({
  content: [{ type: "text" as const, text: `${prefix}${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

interface OutputOpts {
  maxChars?: number;
  includeSources?: boolean;
  save?: ("md" | "html" | "json")[];
}

function buildResult(prompt: string, reply: CopilotReply, opts: OutputOpts) {
  let text = formatForClient(reply, opts);
  if (opts.save?.length) {
    try {
      const files = saveReply(prompt, reply, opts.save);
      text += "\n\nSaved:\n" + files.map((f) => `- ${f}`).join("\n");
    } catch (err) {
      text += `\n\n[save failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
  return { content: [{ type: "text" as const, text }] };
}


/** Replace the reply text with the parsed JSON / diff block when the reply contains one. */
function shapeReply(reply: CopilotReply, kind: "json" | "diff"): CopilotReply {
  if (kind === "json") {
    const parsed = firstJsonBlock(reply);
    if (parsed !== undefined) return { ...reply, markdown: JSON.stringify(parsed, null, 2) };
  } else {
    const diff = firstBlockOfLanguage(reply, "diff");
    if (diff) return { ...reply, markdown: diff };
  }
  return { ...reply, markdown: `[no ${kind} block found in the reply; raw text follows]\n\n${reply.markdown}` };
}

async function statusPayload(refresh: boolean) {
  if (refresh) await recheckSession();
  const auth = getAuthStatus();
  return {
    status: "ok",
    name: APP_NAME,
    version: VERSION,
    commit: COMMIT,
    uptime: Math.round(process.uptime()),
    auth: auth.status,
    authMessage: auth.message,
    browser: await probeBrowser(),
    queue: getRuntimeStats(),
    config: {
      copilotUrl: config.copilotUrl,
      responseTimeoutMs: config.responseTimeoutMs,
      selectorTimeoutMs: config.selectorTimeoutMs,
    },
    node: process.versions.node,
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: APP_NAME,
    version: VERSION,
  });

  // -----------------------------------------------------------------------
  // Tool: ask_copilot
  // -----------------------------------------------------------------------
  server.tool(
    "ask_copilot",
    "Send a prompt to Microsoft Copilot using an authenticated browser session and return the response.",
    {
      prompt: z.string().min(1).describe("The message to send to Copilot"),
      newChat: z
        .boolean()
        .optional()
        .default(false)
        .describe("Start a new conversation thread (default: continue current thread)"),
      systemPrompt: z
        .string()
        .optional()
        .describe("Role or standing instruction placed before the prompt, e.g. 'You are a senior Terraform reviewer.'"),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .default("markdown")
        .describe("'json' asks Copilot for a single JSON block and returns it parsed and pretty-printed."),
      ...callOptions,
      ...outputOptions,
    },
    async ({ prompt, newChat, systemPrompt, format, timeoutMs, retries, dryRun, ...opts }) => {
      logger.info(`ask_copilot called — newChat=${newChat}, prompt length=${prompt.length}`);

      let full = withSystemPrompt(prompt, systemPrompt);
      if (format === "json") full = withJsonInstruction(full);
      if (dryRun) return textResult(full);

      try {
        const reply = await askWithRetry(full, newChat, { timeoutMs, retries });
        return buildResult(prompt, format === "json" ? shapeReply(reply, "json") : reply, opts);
      } catch (err) {
        logger.error("ask_copilot failed:", err instanceof Error ? err.message : err);
        return errorResult("Error communicating with Copilot: ", err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // Tool: ask_copilot_batch — several prompts, one after another
  // -----------------------------------------------------------------------
  server.tool(
    "ask_copilot_batch",
    [
      "Send up to 10 prompts to Copilot one after another and return all answers in order.",
      "By default they share one conversation, so later prompts can refer to earlier answers.",
    ].join(" "),
    {
      prompts: z.array(z.string().min(1)).min(1).max(10).describe("Prompts to send, in order."),
      newChat: z.boolean().optional().default(false).describe("Start a new thread before the first prompt."),
      newChatEach: z
        .boolean()
        .optional()
        .default(false)
        .describe("Start a new thread for every prompt (independent questions)."),
      stopOnError: z.boolean().optional().default(true).describe("Stop at the first failure (default true)."),
      systemPrompt: z.string().optional().describe("Role or standing instruction placed before every prompt."),
      ...callOptions,
      ...outputOptions,
    },
    async ({ prompts, newChat, newChatEach, stopOnError, systemPrompt, timeoutMs, retries, dryRun, ...opts }) => {
      logger.info(`ask_copilot_batch called — ${prompts.length} prompts`);
      const full = prompts.map((p) => withSystemPrompt(p, systemPrompt));
      if (dryRun) return textResult(full.map((p, i) => `### Prompt ${i + 1}\n${p}`).join("\n\n"));

      const sections: string[] = [];
      let failed = false;
      for (let i = 0; i < full.length; i++) {
        try {
          const reply = await askWithRetry(full[i], newChatEach || (newChat && i === 0), { timeoutMs, retries });
          sections.push(`### Answer ${i + 1}\n${buildResult(prompts[i], reply, opts).content[0].text}`);
        } catch (err) {
          failed = true;
          sections.push(`### Answer ${i + 1}\n[failed: ${err instanceof Error ? err.message : String(err)}]`);
          if (stopOnError) break;
        }
      }
      const result = textResult(sections.join("\n\n"));
      return failed ? { ...result, isError: true } : result;
    }
  );

  // -----------------------------------------------------------------------
  // Tool: review_code
  // Sends code + instructions to Copilot and returns review/suggestions.
  // -----------------------------------------------------------------------
  server.tool(
    "review_code",
    [
      "Send code to Microsoft Copilot for review, explanation, or modification.",
      "Pass one file as `code`, or several as `files`; describe what you want in `instruction`.",
      "Use `focus` and `minSeverity` to narrow a review, and `outputFormat` for machine-readable findings or a unified diff.",
    ].join(" "),
    {
      instruction: z
        .string()
        .min(1)
        .describe(
          "What you want Copilot to do — e.g. 'review this for bugs', 'explain what this does', 'refactor to use async/await'"
        ),
      code: z.string().min(1).optional().describe("The code to send: a full file or a snippet. Use `files` for several."),
      files: z
        .array(
          z.object({
            filename: z.string().optional().describe("e.g. 'browser.ts'"),
            language: z.string().optional().describe("e.g. 'TypeScript'"),
            code: z.string().min(1),
          })
        )
        .max(10)
        .optional()
        .describe("Several files to review together (up to 10). Combine with or instead of `code`."),
      language: z.string().optional().describe("Language of `code`, e.g. 'TypeScript', 'Python'."),
      filename: z.string().optional().describe("Filename of `code`, e.g. 'browser.ts'."),
      focus: z
        .array(z.enum(FOCUS_AREAS))
        .optional()
        .describe("What to look for: bugs, security, performance, tests, style, readability."),
      minSeverity: z
        .enum(SEVERITIES)
        .optional()
        .describe("Report only findings at or above this severity (default: all)."),
      outputFormat: z
        .enum(["markdown", "findings-json", "patch"])
        .optional()
        .default("markdown")
        .describe(
          "markdown: normal answer. findings-json: JSON array of {file, line, severity, title, suggestion}. patch: unified diff."
        ),
      newChat: z
        .boolean()
        .optional()
        .default(false)
        .describe("Start a fresh conversation instead of continuing the current thread."),
      ...callOptions,
      ...outputOptions,
    },
    async ({ instruction, code, files, language, filename, focus, minSeverity, outputFormat, newChat, timeoutMs, retries, dryRun, ...opts }) => {
      const all = [...(code ? [{ code, language, filename }] : []), ...(files ?? [])];
      if (all.length === 0) return errorResult("", new Error("Provide `code` or `files`."));
      logger.info(`review_code called — instruction="${instruction.slice(0, 60)}…", files=${all.length}`);

      const prompt = buildReviewPrompt({ instruction, files: all, focus, minSeverity, format: outputFormat });
      if (dryRun) return textResult(prompt);

      try {
        let reply = await askWithRetry(prompt, newChat, { timeoutMs, retries });
        if (outputFormat === "findings-json") reply = shapeReply(reply, "json");
        if (outputFormat === "patch") reply = shapeReply(reply, "diff");
        return buildResult(instruction, reply, opts);
      } catch (err) {
        logger.error("review_code failed:", err instanceof Error ? err.message : err);
        return errorResult("Error: ", err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // Tool: get_status
  // Same data as the resource but accessible as a tool call — tools are
  // always re-fetched per session so this works even when the resource
  // list is stale in the client.
  // -----------------------------------------------------------------------
  server.tool(
    "get_status",
    "Get the status of the copilot-bridge server: version, authentication, Edge reachability, open Copilot tab, queue length and call statistics.",
    {
      refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe("Re-check the Copilot session now (waits for running prompts, then loads the page)."),
    },
    async ({ refresh }) => textResult(JSON.stringify(await statusPayload(refresh), null, 2))
  );

  // -----------------------------------------------------------------------
  // Resource: status
  // -----------------------------------------------------------------------
  server.resource(
    "status",
    "copilot-bridge://status",
    { mimeType: "application/json" },
    async () => ({
      contents: [{ uri: "copilot-bridge://status", text: JSON.stringify(await statusPayload(false)) }],
    })
  );

  return server;
}
