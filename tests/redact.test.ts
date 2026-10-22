import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { addItemsToPdf, type Matrix } from "../src/export";
import type { Item } from "../src/model";

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

async function textOf(bytes: Uint8Array, page: number) {
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const content = await (await doc.getPage(page)).getTextContent();
  return content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
}

describe("redaction", () => {
  it("takes the text under the boxes out of the file, on that page only", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText("Password: hunter2", { x: 50, y: 790, size: 12, font });
    doc.addPage([595, 842]).drawText("Nothing secret here", { x: 50, y: 790, size: 12, font });
    const bytes = await doc.save();
    const source = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const asked: number[] = [];
    const env = {
      pageTransform: async (i: number) => (await source.getPage(i + 1)).getViewport({ scale: 1 }).transform as Matrix,
      baseline: () => 10,
      redact: async (page: number) => {
        asked.push(page);
        return { src: PNG_1PX, w: 595, h: 842 };
      },
    };
    const items: Item[] = [{ id: "r", page: 0, type: "rect", x: 40, y: 40, w: 200, h: 20, stroke: null, fill: "#000000", strokeWidth: 0, redact: true }];
    const out = await addItemsToPdf(bytes, items, env);
    expect(asked).toEqual([0]);
    expect(await textOf(out, 1)).not.toContain("hunter2");
    expect(await textOf(out, 2)).toContain("Nothing secret here");
    const saved = await PDFDocument.load(out);
    expect(saved.getPageCount()).toBe(2);
  });
});
