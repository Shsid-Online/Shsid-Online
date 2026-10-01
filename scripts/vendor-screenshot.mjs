import { mkdir, copyFile } from "node:fs/promises";
await mkdir(new URL("../public/vendor/", import.meta.url), { recursive: true });
await copyFile(new URL("../node_modules/html2canvas/dist/html2canvas.esm.js", import.meta.url), new URL("../public/vendor/html2canvas.js", import.meta.url));
await copyFile(new URL("../node_modules/html2canvas/LICENSE", import.meta.url), new URL("../public/vendor/html2canvas.LICENSE", import.meta.url));
