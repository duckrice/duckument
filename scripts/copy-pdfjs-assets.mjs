// pdf.js loads character maps, fallback fonts and image decoders at runtime,
// so they have to be served next to the app instead of being bundled.
// Its form-field styles ship inside the full viewer stylesheet; only that
// part is extracted so the rest of the viewer's CSS doesn't leak into the app.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "public", "pdfjs");

rmSync(to, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(from, dir), join(to, dir), { recursive: true });
}

const css = readFileSync(join(from, "web", "pdf_viewer.css"), "utf8");
// The text layer (for selecting text) comes right before the form layer.
const start = css.indexOf("\n.textLayer {");
const end = css.indexOf("\n:root {\n  --xfa-", start);
if (start < 0 || end < 0) {
  throw new Error("pdf_viewer.css layout changed: cannot find the annotation layer styles");
}
mkdirSync(join(root, "src", "generated"), { recursive: true });
writeFileSync(join(root, "src", "generated", "annotation-layer.css"), css.slice(start + 1, end) + "\n");
