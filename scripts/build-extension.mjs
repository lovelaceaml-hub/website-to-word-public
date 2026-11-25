import { cp, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "build", "extension");
const deps = join(root, "node_modules");
const assets = new Map([
  ["Readability.js", "@mozilla/readability/Readability.js"],
  ["docx.js", "docx/build/index.umd.js"],
  ["pdfmake.js", "pdfmake/build/pdfmake.min.js"],
  ["vfs_fonts.js", "pdfmake/build/vfs_fonts.js"],
]);
const notices = new Map([
  ["readability.txt", "@mozilla/readability/LICENSE.md"],
  ["docx.txt", "docx/LICENSE"],
  ["pdfmake.txt", "pdfmake/LICENSE"],
]);

await cp(join(root, "extension"), output, { recursive: true });
for (const [folder, entries] of [["vendor", assets], ["notices", notices]]) {
  for (const [name, input] of entries) {
    const artifact = join(output, folder, name);
    await mkdir(dirname(artifact), { recursive: true });
    await copyFile(join(deps, input), artifact);
  }
}
console.log("Load build/extension in Chrome.");
