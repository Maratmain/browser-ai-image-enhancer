import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, ".build");
const dist = join(root, "dist");
const compileOnly = process.argv.includes("--compile-only");

await rm(build, { recursive: true, force: true });
if (!compileOnly) await rm(dist, { recursive: true, force: true });
const compiler = spawnSync("tsc", ["-p", join(root, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
});
if (compiler.status !== 0) process.exit(compiler.status ?? 1);
if (compileOnly) process.exit(0);

await mkdir(dist, { recursive: true });

async function copyJavaScriptTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyJavaScriptTree(from, to);
    } else if (extname(entry.name) === ".js") {
      await cp(from, to);
    }
  }
}

await copyJavaScriptTree(join(build, "src"), join(dist, "src"));
await copyJavaScriptTree(join(build, "demo"), join(dist, "demo"));
await copyJavaScriptTree(join(build, "benchmark"), join(dist, "benchmark"));
await cp(join(root, "public"), dist, { recursive: true, force: true });
await cp(join(root, "demo", "index.html"), join(dist, "index.html"));
await cp(join(root, "demo", "styles.css"), join(dist, "demo", "styles.css"));
await cp(join(root, "benchmark", "index.html"), join(dist, "benchmark", "index.html"));
await cp(join(root, "benchmark", "styles.css"), join(dist, "benchmark", "styles.css"));

const manifest = {};
async function hashTree(directory) {
  const crypto = await import("node:crypto");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await hashTree(absolute);
    } else {
      const data = await readFile(absolute);
      manifest[relative(dist, absolute).replaceAll("\\", "/")] = {
        bytes: data.length,
        sha256: crypto.createHash("sha256").update(data).digest("hex")
      };
    }
  }
}
await hashTree(dist);
await writeFile(join(dist, "asset-manifest.json"), JSON.stringify(manifest, null, 2));

const total = Object.values(manifest).reduce((sum, item) => sum + item.bytes, 0);
console.log(`Built ${Object.keys(manifest).length} files (${total} bytes before manifest).`);
