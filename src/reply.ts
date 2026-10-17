/**
 * Reply extraction and output.
 *
 * Turns the last Copilot answer into
 *   - compact Markdown (no citation chips, UI labels or feedback footer),
 *   - clean standalone-able HTML,
 *   - structured code blocks (language + raw code, JSON parsed when valid),
 *   - the list of cited sources,
 * and can save any of these to disk.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";

export interface CodeBlock {
  language: string;
  code: string;
  /** Present when the block is valid JSON */
  parsed?: unknown;
}

export interface Source {
  name: string;
  url: string;
}

export interface CopilotReply {
  markdown: string;
  html: string;
  codeBlocks: CodeBlock[];
  sources: Source[];
}

export type SaveFormat = "md" | "html" | "json";

export const REPLY_SELECTOR = [
  // copilot.cloud.microsoft (M365/work accounts)
  '[data-testid="copilot-message-reply-div"]',
  '[data-testid="copilot-message-div"]',
  // copilot.microsoft.com (consumer)
  '[data-testid="markdown-reply"]',
].join(", ");

// ---------------------------------------------------------------------------
// In-page extraction (serialised into the browser — must be self-contained)
// ---------------------------------------------------------------------------
function extractInPage(selector: string) {
  const replies = document.querySelectorAll(selector);
  const root = replies[replies.length - 1] as HTMLElement | undefined;
  if (!root) return null;

  const sources: { name: string; url: string }[] = [];
  const codeBlocks: { language: string; code: string }[] = [];

  const isCitation = (el: Element) =>
    el.matches('[class*="BebopCitation"], [data-citation-group-id]');

  const collectCitation = (el: Element) => {
    try {
      const list = JSON.parse(el.getAttribute("data-grouped-citations") ?? "[]");
      for (const c of list) {
        if (c.url && !sources.some((s) => s.url === c.url)) {
          sources.push({ name: c.name ?? c.url, url: c.url });
        }
      }
    } catch { /* ignore malformed citation data */ }
  };

  const readCode = (block: Element) => {
    const label = block.querySelector('[data-testid="one-copilot-code-identity"]')?.textContent?.trim() ?? "";
    const language = /^plain\s*text$/i.test(label) ? "text" : label.toLowerCase();
    const lines = [...block.querySelectorAll("[data-line-index]")].map((l) => l.textContent ?? "");
    const code = lines.length ? lines.join("\n") : (block.querySelector('[role="textbox"]')?.textContent ?? "");
    // The editor uses no-break spaces on blank/indent lines; they break parsers (e.g. terraform)
    return { language, code: code.replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "") };
  };

  // ---- Markdown -----------------------------------------------------------
  const inline = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? "").replace(/\s+/g, " ");
    if (!(n instanceof Element)) return "";
    if (isCitation(n)) { collectCitation(n); return ""; }
    return md(n);
  };
  const children = (el: Element) => [...el.childNodes].map(inline).join("");

  const list = (el: Element, ordered: boolean, depth: number): string => {
    const pad = "  ".repeat(depth);
    let i = 0;
    const items = [...el.children].filter((c) => c.tagName === "LI").map((li) => {
      i++;
      const marker = ordered ? `${i}.` : "-";
      const nested: string[] = [];
      const text = [...li.childNodes].map((c) => {
        if (c instanceof Element && (c.tagName === "UL" || c.tagName === "OL")) {
          nested.push(list(c, c.tagName === "OL", depth + 1));
          return "";
        }
        return inline(c);
      }).join("").replace(/\s+/g, " ").trim();
      return `${pad}${marker} ${text}` + (nested.length ? "\n" + nested.join("\n") : "");
    });
    return items.join("\n");
  };

  const table = (el: Element): string => {
    const rows = [...el.querySelectorAll("tr")].map((tr) =>
      [...tr.children].map((c) => children(c).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim())
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const fmt = (r: string[]) => "| " + Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ") + " |";
    return [fmt(rows[0]), "| " + Array(width).fill("---").join(" | ") + " |", ...rows.slice(1).map(fmt)].join("\n");
  };

  const md = (el: Element): string => {
    if (isCitation(el)) { collectCitation(el); return ""; }
    const tag = el.tagName;
    if (["BUTTON", "SVG", "STYLE", "SCRIPT"].includes(tag.toUpperCase())) return "";
    if (el.matches(".scriptor-component-code-block")) {
      const b = readCode(el);
      codeBlocks.push(b);
      return "\n\n```" + b.language + "\n" + b.code + "\n```\n\n";
    }
    switch (tag) {
      case "P": return children(el).trim() + "\n\n";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
        return "#".repeat(Number(tag[1])) + " " + children(el).trim() + "\n\n";
      case "STRONG": case "B": { const t = children(el); return t.trim() ? `**${t.trim()}**` : t; }
      case "EM": case "I": { const t = children(el); return t.trim() ? `*${t.trim()}*` : t; }
      case "CODE": return "`" + (el.textContent ?? "") + "`";
      case "PRE": {
        const code = el.textContent ?? "";
        codeBlocks.push({ language: "text", code });
        return "\n\n```\n" + code + "\n```\n\n";
      }
      case "A": {
        const href = el.getAttribute("href");
        const t = children(el).trim();
        return href && t ? `[${t}](${href})` : t;
      }
      case "UL": return "\n" + list(el, false, 0) + "\n\n";
      case "OL": return "\n" + list(el, true, 0) + "\n\n";
      case "TABLE": return "\n\n" + table(el) + "\n\n";
      case "BLOCKQUOTE":
        return children(el).trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
      case "HR": return "\n\n---\n\n";
      case "BR": return "\n";
      default: {
        const t = children(el);
        return /^(DIV|SECTION|ARTICLE)$/.test(tag) ? "\n" + t + "\n" : t;
      }
    }
  };

  const markdown = md(root)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // ---- Clean HTML (no classes/styles/ids, code blocks become <pre><code>) --
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".scriptor-component-code-block").forEach((block) => {
    const { language, code } = readCode(block);
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    if (language) codeEl.className = "language-" + language;
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    block.replaceWith(pre);
  });
  clone.querySelectorAll('button, svg, style, script, [class*="BebopCitation"], [data-citation-group-id]').forEach((n) => n.remove());
  clone.querySelectorAll("*").forEach((n) => {
    for (const a of [...n.attributes]) {
      if (!(n.tagName === "A" && a.name === "href") && !(n.tagName === "CODE" && a.name === "class")) {
        n.removeAttribute(a.name);
      }
    }
  });
  clone.querySelectorAll("p, div, span").forEach((n) => {
    if (!n.textContent?.trim() && !n.querySelector("pre, img, table")) n.remove();
  });

  // Drop whitespace-only text nodes left by the removed wrappers (keep <pre> intact)
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const blank: Node[] = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent?.trim() && !t.parentElement?.closest("pre")) blank.push(t);
  }
  blank.forEach((t) => t.parentNode?.removeChild(t));

  return { markdown, html: clone.innerHTML.trim(), codeBlocks, sources };
}

export async function extractReply(page: Page): Promise<CopilotReply | null> {
  const raw = await page.evaluate(extractInPage, REPLY_SELECTOR);
  if (!raw) return null;
  return {
    markdown: raw.markdown,
    html: raw.html,
    sources: raw.sources,
    codeBlocks: raw.codeBlocks.map((b) => withParsedJson(b)),
  };
}

function withParsedJson(b: { language: string; code: string }): CodeBlock {
  if (b.language === "json" || /^\s*[[{]/.test(b.code)) {
    try { return { ...b, parsed: JSON.parse(b.code) }; } catch { /* not JSON */ }
  }
  return b;
}

// ---------------------------------------------------------------------------
// Formatting for the tool result
// ---------------------------------------------------------------------------
export function formatForClient(
  reply: CopilotReply,
  opts: { maxChars?: number; includeSources?: boolean }
): string {
  let text = reply.markdown;
  if (opts.maxChars && text.length > opts.maxChars) {
    const cut = text.length - opts.maxChars;
    text = text.slice(0, opts.maxChars).trimEnd() + `\n\n[…truncated ${cut} chars]`;
  }
  if (opts.includeSources && reply.sources.length) {
    text += "\n\nSources:\n" + reply.sources.map((s) => `- ${s.name}: ${s.url}`).join("\n");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "/app/output";
/** Host-side path of the OUTPUT_DIR bind mount, shown to the user. */
const HOST_OUTPUT_DIR = process.env.HOST_OUTPUT_DIR;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderHtmlPage(prompt: string, reply: CopilotReply, createdAt: string): string {
  const sources = reply.sources.length
    ? `<h2>Sources</h2><ul>${reply.sources
        .map((s) => `<li><a href="${escapeHtml(s.url)}">${escapeHtml(s.name)}</a></li>`)
        .join("")}</ul>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Copilot reply</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 16px;color:#1b1b1b}
  .prompt{background:#f3f4f6;border-left:4px solid #2563eb;padding:.6rem 1rem;border-radius:4px;white-space:pre-wrap}
  .meta{color:#6b7280;font-size:.85rem}
  pre{background:#0f172a;color:#e2e8f0;padding:1rem;border-radius:6px;overflow:auto}
  code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}
  :not(pre)>code{background:#f3f4f6;padding:1px 5px;border-radius:4px}
  table{border-collapse:collapse}td,th{border:1px solid #d1d5db;padding:4px 10px}
  @media (prefers-color-scheme:dark){body{background:#111;color:#e5e5e5}.prompt{background:#1f2937}:not(pre)>code{background:#1f2937}td,th{border-color:#374151}}
</style></head><body>
<p class="meta">${escapeHtml(createdAt)}</p>
<div class="prompt">${escapeHtml(prompt)}</div>
<main>${reply.html}</main>
${sources}
</body></html>
`;
}

export function saveReply(
  prompt: string,
  reply: CopilotReply,
  formats: SaveFormat[]
): string[] {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const createdAt = new Date().toISOString();
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "reply";
  const base = `${createdAt.replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}-${slug}`;

  const saved: string[] = [];
  for (const fmt of new Set(formats)) {
    const file = `${base}.${fmt}`;
    let content: string;
    if (fmt === "md") {
      content = `# ${prompt.split("\n")[0].slice(0, 120)}\n\n_${createdAt}_\n\n${reply.markdown}\n` +
        (reply.sources.length ? "\n## Sources\n" + reply.sources.map((s) => `- [${s.name}](${s.url})`).join("\n") + "\n" : "");
    } else if (fmt === "html") {
      content = renderHtmlPage(prompt, reply, createdAt);
    } else {
      content = JSON.stringify({ prompt, createdAt, ...reply }, null, 2) + "\n";
    }
    writeFileSync(join(OUTPUT_DIR, file), content);
    saved.push(join(HOST_OUTPUT_DIR ?? OUTPUT_DIR, file));
  }
  return saved;
}
