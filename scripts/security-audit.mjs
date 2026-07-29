import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const ignoredDirectories = new Set([".git", ".build", "node_modules", ".venv", "__pycache__", "training/data", "training/runs"]);
const textExtensions = new Set([
  ".ts", ".js", ".mjs", ".py", ".html", ".css", ".md", ".json", ".yml", ".yaml", ".txt", ".log", ".sh", ".toml", ".ini", ".xml", ""
]);
const sensitiveFilename = /^(?:\.env(?:\..+)?|id_rsa|id_ed25519|credentials(?:\..+)?|.*\.(?:pem|p12|pfx|key|kdbx))$/i;
const findings = [];
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
  ["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["generic bearer token", /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}\b/i],
  ["embedded password", /\b(?:password|passwd|api[_-]?key|client[_-]?secret)\s*[:=]\s*["'][^"']{8,}["']/i],
  ["local macOS path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["local Windows path", /[A-Za-z]:\\Users\\[^\\\s]+\\/],
  ["local Linux home path", /\/home\/[A-Za-z0-9._-]+\//],
  ["container working path", /\/mnt\/data\//],
  ["email address", /\b[A-Z0-9._%+-]+@(?!example\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i]
];

function isIgnoredPath(absolute) {
  const relativePath = relative(root, absolute).replaceAll("\\", "/");
  return [...ignoredDirectories].some((ignored) => relativePath === ignored || relativePath.startsWith(`${ignored}/`));
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (isIgnoredPath(absolute)) continue;
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (sensitiveFilename.test(entry.name) && entry.name !== ".env.example") {
      findings.push({ file: path, issue: "sensitive filename" });
    }
    if (!textExtensions.has(extname(entry.name))) continue;
    const text = await readFile(absolute, "utf8").catch(() => "");
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) findings.push({ file: path, issue: label });
    }
  }
}

await walk(root);

let gitHistoryChecked = false;
try {
  await access(join(root, ".git"), constants.F_OK);
  const tracked = spawnSync("git", ["rev-list", "--objects", "--all"], { cwd: root, encoding: "utf8" });
  gitHistoryChecked = tracked.status === 0;
  if (tracked.status === 0) {
    const suspicious = tracked.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2)[1])
      .filter((name) => name !== undefined && sensitiveFilename.test(name));
    for (const file of suspicious) findings.push({ file, issue: "sensitive filename in Git history" });
  }
} catch {
  gitHistoryChecked = false;
}

const unique = [...new Map(findings.map((finding) => [`${finding.file}:${finding.issue}`, finding])).values()];
const report = {
  generatedAt: new Date().toISOString(),
  status: unique.length === 0 ? "PASS" : "FAIL",
  gitHistoryChecked,
  checkedFor: patterns.map(([name]) => name),
  findings: unique
};
await writeFile("SECURITY_AUDIT.json", JSON.stringify(report, null, 2));
await writeFile("docs/security-audit.json", JSON.stringify(report, null, 2));
const securityMarkdown = [
  "# Security audit report",
  "",
  `**Status:** ${report.status}`,
  "",
  `Findings: **${unique.length}**`,
  "",
  `Git history checked: **${gitHistoryChecked ? "yes" : "no — this delivery is a clean directory without .git history"}**`,
  "",
  "The scanner checks current text files and sensitive filenames for private keys, common tokens, embedded credentials, email addresses and local filesystem paths.",
  ""
].join("\n");
await writeFile("docs/security-report.md", securityMarkdown);
console.log(`Security audit: ${report.status} (${unique.length} finding(s))`);
if (unique.length > 0) {
  for (const finding of unique) console.error(`${finding.file}: ${finding.issue}`);
  process.exit(1);
}
