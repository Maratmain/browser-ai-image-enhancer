import { cp, mkdir, writeFile } from "node:fs/promises";

const text = `# Third-party licenses

## Production runtime

The application core, Worker protocol, ML inference runtime, WebGL2 processor, CPU fallback and BMP decoder are project-owned source code released under the MIT License.

### heic-to 1.5.2

- Purpose: lazy HEIC/HEIF software decoding when the browser cannot decode the image natively.
- Loading: fetched only after the user selects a HEIC/HEIF file and native decoding fails.
- Pinned module: \`heic-to@1.5.2/dist/next/heic-to.js\`.
- License: LGPL-3.0-or-later.
- Upstream source: https://github.com/hoppergee/heic-to
- Package metadata: https://www.npmjs.com/package/heic-to/v/1.5.2

The decoder is loaded as a replaceable runtime library and is not modified by this project. Copies of the LGPL v3 and GPL v3 license texts are included in \`licenses/\` and the deploy archive.

## Training-only packages

Training-only Python packages are not included in the deploy archive. Their pinned versions are listed in \`training/requirements.txt\` and remain governed by their respective licenses.
`;
await writeFile("THIRD_PARTY_LICENSES.md", text);
await mkdir("public/licenses", { recursive: true });
await cp("licenses/heic-to-LGPL-3.0.txt", "public/licenses/heic-to-LGPL-3.0.txt");
await cp("licenses/GPL-3.0.txt", "public/licenses/GPL-3.0.txt");
await cp("THIRD_PARTY_LICENSES.md", "public/THIRD_PARTY_LICENSES.md");
console.log("License report generated and deploy license texts staged.");
