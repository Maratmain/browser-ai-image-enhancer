import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";

const built = spawnSync(process.execPath, [new URL("./build.mjs", import.meta.url).pathname], { stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname, "dist", "5173"], {
  stdio: "inherit"
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
