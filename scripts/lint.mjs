import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(".");
const include = new Set([".ts", ".js", ".mjs", ".py", ".html", ".css", ".md", ".json"]);
const ignored = new Set([".git", ".build", "dist", "node_modules", ".venv", "checkpoints", "generated"]);
const failures = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (include.has(extname(entry.name))) {
      const text = await readFile(absolute, "utf8");
      const path = relative(root, absolute);
      const unfinishedMarker = new RegExp("\\b(?:TO" + "DO|FIX" + "ME)\\b");
      if (unfinishedMarker.test(text)) failures.push(`${path}: unfinished marker`);
      if (/(?<!\.)\beval\b\s*\(|new\s+Function\s*\(/.test(text)) failures.push(`${path}: forbidden dynamic code execution`);
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (/[ \t]+$/.test(line)) failures.push(`${path}:${index + 1}: trailing whitespace`);
      });
    }
  }
}
await walk(root);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Source hygiene checks passed.");
