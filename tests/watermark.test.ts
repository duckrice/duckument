import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { addItemsToPdf, type Matrix } from "../src/export";
import { watermarkItems } from "../src/watermark";

let n = 0;
const id = () => `w${n++}`;
const options = { text: "DRAFT", size: 80, angle: 45, opacity: 0.25, color: "#888888", font: "helvetica" };

describe("watermarks", () => {
  it("sit with their middle on the middle of each page", () => {
    const [item] = watermarkItems([{ width: 595, height: 842 }], options, id);
    const w = 5 * 80 * 0.62;
    const h = 80 * 1.2;
    const t = Math.PI / 4;
    // The text's middle, after turning it about its top-left corner.
    const mx = item.x + (w / 2) * Math.cos(t) + (h / 2) * Math.sin(t);
    const my = item.y - (w / 2) * Math.sin(t) + (h / 2) * Math.cos(t);
    expect(Math.abs(mx - 297.5)).toBeLessThan(0.2);
    expect(Math.abs(my - 421)).toBeLessThan(0.2);
    expect(item).toMatchObject({ angle: 45, opacity: 0.25, bold: true });
  });

  it("are saved turned and see-through, as real text", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const bytes = await doc.save();
    const source = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const env = {
      pageTransform: async (i: number) => (await source.getPage(i + 1)).getViewport({ scale: 1 }).transform as Matrix,
      baseline: () => 64,
    };
    const out = await addItemsToPdf(bytes, watermarkItems([{ width: 595, height: 842 }], options, id), env);
    const saved = await PDFDocument.load(out);
    const states = saved.getPage(0).node.Resources()!.lookup(PDFName.of("ExtGState"), PDFDict);
    const alphas = states.values().map((ref) => saved.context.lookup(ref, PDFDict).get(PDFName.of("ca"))?.toString());
    expect(alphas).toContain("0.25");
    const page = await (await pdfjs.getDocument({ data: out.slice() }).promise).getPage(1);
    const text = await page.getTextContent();
    const piece = text.items.find((i) => "str" in i && i.str === "DRAFT") as { transform: number[] } | undefined;
    expect(piece).toBeDefined();
    // Turned 45°: the text's direction has equal parts across and up.
    const [a, b] = piece!.transform;
    expect(Math.abs(a - b)).toBeLessThan(0.01 * Math.abs(a));
  });
});
