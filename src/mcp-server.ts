/**
 * MCP server definition.
 *
 * Tools: ask_copilot, review_code, get_status
 * The server is transport-agnostic; callers wire in the transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { askCopilot, closeBrowser, getAuthStatus } from "./browser.js";
import { logger } from "./logger.js";
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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "copilot-bridge",
    version: "0.1.0",
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
      ...outputOptions,
    },
    async ({ prompt, newChat, ...opts }) => {
      logger.info(`ask_copilot called — newChat=${newChat}, prompt length=${prompt.length}`);

      try {
        return buildResult(prompt, await askCopilot(prompt, { newChat }), opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("ask_copilot failed:", message);
        return {
          content: [
            {
              type: "text",
              text: `Error communicating with Copilot: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Tool: review_code
  // Sends code + instructions to Copilot and returns review/suggestions.
  // Kiro passes the current file content and a question; Copilot responds
  // with analysis, suggested edits, or explanations.
  // -----------------------------------------------------------------------
  server.tool(
    "review_code",
    [
      "Send code to Microsoft Copilot for review, explanation, or modification.",
      "Pass the file content as `code`, describe what you want in `instruction`.",
      "Copilot returns its response as plain text — suggested changes, explanations, or a rewritten version.",
      "Use `language` and `filename` to give Copilot context about what it is reading.",
    ].join(" "),
    {
      instruction: z
        .string()
        .min(1)
        .describe(
          "What you want Copilot to do — e.g. 'review this for bugs', 'explain what this does', 'refactor to use async/await'"
        ),
      code: z
        .string()
        .min(1)
        .describe("The code to send. Can be a full file or a selected snippet."),
      language: z
        .string()
        .optional()
        .describe("Programming language, e.g. 'TypeScript', 'Python'. Helps Copilot format its response."),
      filename: z
        .string()
        .optional()
        .describe("Original filename, e.g. 'browser.ts'. Gives Copilot additional context."),
      newChat: z
        .boolean()
        .optional()
        .default(false)
        .describe("Start a fresh conversation instead of continuing the current thread."),
      ...outputOptions,
    },
    async ({ instruction, code, language, filename, newChat, ...opts }) => {
      logger.info(`review_code called — instruction="${instruction.slice(0, 60)}…", code length=${code.length}`);

      // Build a well-structured prompt so Copilot understands the context
      const langLine = language ? `Language: ${language}` : "";
      const fileLine = filename ? `File: ${filename}` : "";
      const header = [langLine, fileLine].filter(Boolean).join(" | ");

      const prompt = [
        header,
        "",
        "```" + (language?.toLowerCase() ?? ""),
        code,
        "```",
        "",
        instruction,
      ]
        .filter((l, i) => !(i === 0 && !header)) // drop empty header line
        .join("\n");

      try {
        return buildResult(instruction, await askCopilot(prompt, { newChat }), opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("review_code failed:", message);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
  // Same data as the resource but accessible as a tool call — tools are
  // always re-fetched per session so this works even when the resource
  // list is stale in the client.
  // -----------------------------------------------------------------------
  server.tool(
    "get_status",
    "Get the current status of the copilot-bridge server including authentication state.",
    {},
    async () => {
      const auth = getAuthStatus();
      const payload = {
        status: "ok",
        name: "copilot-bridge",
        version: "0.1.0",
        uptime: Math.round(process.uptime()),
        auth: auth.status,
        authMessage: auth.message,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  // -----------------------------------------------------------------------
  // Resource: status
  // -----------------------------------------------------------------------
  server.resource(
    "status",
    "copilot-bridge://status",
    { mimeType: "application/json" },
    async () => {
      const auth = getAuthStatus();
      return {
        contents: [
          {
            uri: "copilot-bridge://status",
            text: JSON.stringify({
              status: "ok",
              name: "copilot-bridge",
              version: "0.1.0",
              uptime: Math.round(process.uptime()),
              auth: auth.status,
              authMessage: auth.message,
            }),
          },
        ],
      };
    }
  );

  return server;
}
