import { cp, mkdir, writeFile } from "node:fs/promises";

await mkdir("docs", { recursive: true });
await cp("dist", "docs", { recursive: true, force: true });
await writeFile("docs/.nojekyll", "");
console.log("GitHub Pages payload staged in docs/ without deleting reports.");
