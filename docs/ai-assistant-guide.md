# Using copilot-bridge from an AI assistant

For Claude, Kiro, Continue and other MCP-capable assistants. Read this once, then call the tools.

## What it is

copilot-bridge gives you four MCP tools that forward prompts to Microsoft Copilot through the user's signed-in Edge. Copilot is a second model. Use it for a second opinion, for drafting bulk text or config, or to save your own output tokens. It is slower than a direct model call (it types into a web page and waits for streaming) and answers one request at a time.

Endpoint: `http://localhost:3100/mcp` (Streamable HTTP).

## Before the first call

1. Call `get_status`. Continue only if `auth` is `ready`.
2. If `auth` is `unauthenticated`, `error` or `edgeReachable` is `false`, stop and tell the user: start the bridge with `scripts/run.sh` / `scripts\run.bat` (pick Node.js or Docker in the menu), and sign in to Copilot in the dedicated Edge window. Do not retry in a loop.
3. If `queue.inFlight` is `true`, another client is waiting on Copilot. Your call will queue behind it.

## Tools

| Tool | Use it to | Key parameters |
|---|---|---|
| `ask_copilot` | Ask one question or give one task | `prompt`, `newChat`, `systemPrompt`, `format`, `save`, `maxChars` |
| `ask_copilot_batch` | Run up to 10 prompts in order | `prompts`, `newChatEach`, `stopOnError` |
| `review_code` | Review, explain or rewrite code | `instruction`, `code` or `files`, `focus`, `minSeverity`, `outputFormat` |
| `get_status` | Check health before and after failures | `refresh` |

Shared by the prompt tools: `timeoutMs`, `retries`, `dryRun`, `maxChars`, `includeSources`, `save`. Full tables are in the [README](../README.md#mcp-tool-reference).

## Rules that save time and tokens

- **Conversation state.** By default each call continues the same Copilot thread. Set `newChat: true` when the topic changes, otherwise earlier context leaks into the answer.
- **Large answers.** Pass `save: ["json"]` and a small `maxChars`. The full reply goes to `output/` and you read only what you need. Pull code out of a saved reply with `node scripts/extract-code.mjs output/<reply>.json <outDir>`.
- **Machine-readable output.** Use `format: "json"` on `ask_copilot`, or `outputFormat: "findings-json"` / `"patch"` on `review_code`. If the block is missing the tool returns the raw text with a note, so check before parsing.
- **Check the prompt first.** `dryRun: true` returns the exact text that would be sent. Use it when building a long prompt.
- **Long tasks.** Raise `timeoutMs` for a long answer; use `retries: 1` for flaky runs. Retries start a new chat.
- **Independent questions.** Use `ask_copilot_batch` with `newChatEach: true`.
- **One call at a time.** Calls are serialized. Do not fan out parallel calls expecting a speed-up.

## Examples

Ask a question:

```json
{ "tool": "ask_copilot", "arguments": { "prompt": "Explain TCP vs UDP in 5 bullets", "newChat": true, "maxChars": 1500 } }
```

Review a file for security issues and get structured findings:

```json
{
  "tool": "review_code",
  "arguments": {
    "instruction": "Review this file",
    "code": "<file content>",
    "language": "TypeScript",
    "filename": "src/index.ts",
    "focus": ["security", "bugs"],
    "minSeverity": "medium",
    "outputFormat": "findings-json"
  }
}
```

Several independent prompts:

```json
{ "tool": "ask_copilot_batch", "arguments": { "prompts": ["Summarize MCP", "Summarize CDP"], "newChatEach": true } }
```

## Errors

| Message | Meaning | What to do |
|---|---|---|
| `Bridge not authenticated` | No signed-in Copilot session | Ask the user to start the bridge and sign in; then `get_status` with `refresh: true` |
| `Copilot did not respond within …ms` | Timeout | Retry once with a larger `timeoutMs`; if it repeats, call `get_status` |
| `Copilot chat input not found` / selector timeout | The Copilot page changed or is not on a chat | Tell the user; `GET /debug/dom` shows the inputs on the live page |
| `Provide code or files.` | `review_code` called without code | Pass `code` or `files` |
| Connection refused | Bridge not running | Ask the user to run `scripts/run.sh` / `scripts\run.bat` |

## Limits to respect

- The bridge scrapes the Copilot web page. It is not an official API and can break when the page changes.
- Saved files and prompts may contain repository content. Do not send secrets; the user's Microsoft account policies apply to everything you send.
- Personal productivity use only.

## Setting up the client

Config files for each editor are in [editor-setup-vscode-kiro.md](editor-setup-vscode-kiro.md). Suggested Kiro `autoApprove`: `get_status`; leave the prompt tools on confirmation if the user wants to review what leaves the machine.
