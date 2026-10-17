#!/usr/bin/env node
// Write the code blocks of a saved reply (output/*.json) to files, without the
// code ever passing through an LLM's context.
// A block is written when its first line is a comment `# file: <name>` or
// `// file: <name>`; that marker line is dropped.
//   node scripts/extract-code.mjs output/<reply>.json <outDir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const [jsonFile, outDir] = process.argv.slice(2);
if (!jsonFile || !outDir) {
  console.error("usage: extract-code.mjs <reply.json> <outDir>");
  process.exit(1);
}

const { codeBlocks } = JSON.parse(readFileSync(jsonFile, "utf8"));
mkdirSync(outDir, { recursive: true });

let written = 0;
for (const { code } of codeBlocks) {
  const [first, ...rest] = code.replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "").split("\n");
  const m = first.match(/^\s*(?:#|\/\/)\s*file:\s*(\S+)\s*$/);
  if (!m) continue;
  const name = basename(m[1]); // never write outside outDir
  writeFileSync(join(outDir, name), rest.join("\n").replace(/^\n+/, "").trimEnd() + "\n");
  console.log(`wrote ${join(outDir, name)} (${code.length} chars)`);
  written++;
}
if (!written) { console.error("no `# file:` blocks found"); process.exit(1); }
