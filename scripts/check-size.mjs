import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve("dist");
const limit = 10_000_000;
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else files.push({ path: relative(root, absolute).replaceAll("\\", "/"), bytes: (await stat(absolute)).size });
  }
}

await walk(root);
files.sort((left, right) => right.bytes - left.bytes);
const localBytes = files.reduce((sum, file) => sum + file.bytes, 0);

let remoteAssets = [];
try {
  const manifest = JSON.parse(await readFile(join(root, "assets", "remote-assets.json"), "utf8"));
  remoteAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
} catch {
  remoteAssets = [];
}

const remoteBytes = remoteAssets.reduce((sum, asset) => {
  const bytes = Number(asset.declaredBytes);
  return sum + (Number.isFinite(bytes) && bytes > 0 ? bytes : 0);
}, 0);
const total = localBytes + remoteBytes;
const report = {
  generatedAt: new Date().toISOString(),
  limitBytes: limit,
  localBytes,
  remoteBytes,
  totalBytes: total,
  passed: total <= limit,
  largestLocalFiles: files.slice(0, 20),
  remoteAssets
};

await writeFile("SIZE_REPORT.json", JSON.stringify(report, null, 2));
await writeFile("docs/size-report.json", JSON.stringify(report, null, 2));
const sizeMarkdown = [
  "# Production size report",
  "",
  `**Status:** ${report.passed ? "PASS" : "FAIL"}`,
  "",
  `- Local deploy files: **${localBytes.toLocaleString("en-US")} bytes**`,
  `- Declared lazy remote assets: **${remoteBytes.toLocaleString("en-US")} bytes**`,
  `- Counted total: **${total.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} bytes**`,
  "",
  "The HEIC decoder is counted even though it is fetched only when native HEIC decoding fails.",
  "",
  "## Largest local files",
  "",
  "| File | Bytes |",
  "|---|---:|",
  ...files.slice(0, 15).map((file) => `| ${file.path} | ${file.bytes} |`),
  ""
].join("\n");
await writeFile("docs/size-report.md", sizeMarkdown);
console.log(`Production size: ${total} / ${limit} bytes (${localBytes} local + ${remoteBytes} declared remote)`);
for (const file of files.slice(0, 15)) console.log(`${String(file.bytes).padStart(9)}  ${file.path}`);
for (const asset of remoteAssets) console.log(`${String(asset.declaredBytes).padStart(9)}  remote: ${asset.name}`);
if (total > limit) {
  console.error(`Size limit exceeded by ${total - limit} bytes.`);
  process.exit(1);
}
