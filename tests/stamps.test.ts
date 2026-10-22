import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { addItemsToPdf, type Matrix } from "../src/export";
import { stampItem } from "../src/stamps";

describe("stamps", () => {
  it("go near the top-right corner, framed, with the date under the words", () => {
    const item = stampItem({ width: 595, height: 842 }, 0, "APPROVED", "#15803d", "22 Oct 2026", "s1");
    expect(item).toMatchObject({ text: "APPROVED\n22 Oct 2026", frame: true, color: "#15803d", y: 56 });
    expect(item.x).toBeGreaterThan(297);
    expect(item.x + 11 * 22 * 0.68).toBeLessThan(595);
  });

  it("are saved as real words inside a drawn frame", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const bytes = await doc.save();
    const source = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const env = {
      pageTransform: async (i: number) => (await source.getPage(i + 1)).getViewport({ scale: 1 }).transform as Matrix,
      baseline: () => 18,
    };
    const out = await addItemsToPdf(bytes, [stampItem({ width: 595, height: 842 }, 0, "RECEIVED", "#1d4ed8", null, "s2")], env);
    const page = await (await pdfjs.getDocument({ data: out.slice() }).promise).getPage(1);
    const words = (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
    expect(words).toContain("RECEIVED");
    // The frame: a stroked path in the stamp's colour.
    const ops = await page.getOperatorList();
    const stroked = ops.fnArray.some((fn, i) => fn === pdfjs.OPS.stroke || (fn === pdfjs.OPS.constructPath && ops.argsArray[i][0] === pdfjs.OPS.stroke));
    expect(stroked).toBe(true);
  });
});
