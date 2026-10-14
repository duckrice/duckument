import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { addItemsToPdf, type ExportEnv, type Matrix } from "../src/export";
import type { Item } from "../src/model";
import { markBars, mergeLineBoxes } from "../src/shapes";

describe("markup geometry", () => {
  it("joins the pieces of a line of selected text into one box per line", () => {
    const merged = mergeLineBoxes([
      { x: 100, y: 50, w: 40, h: 12 },
      { x: 10, y: 50.5, w: 60, h: 11 },
      { x: 70.5, y: 50, w: 29, h: 12 },
      { x: 10, y: 70, w: 80, h: 12 },
    ]);
    expect(merged).toEqual([
      { x: 10, y: 50, w: 130, h: 12 },
      { x: 10, y: 70, w: 80, h: 12 },
    ]);
  });

  it("keeps separate words on a line separate when far apart", () => {
    expect(mergeLineBoxes([{ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 0, w: 10, h: 10 }])).toHaveLength(2);
  });

  it("draws underlines low and strike-throughs through the middle", () => {
    const base = { id: "m", page: 0, rects: [{ x: 10, y: 100, w: 50, h: 20 }], color: "#ff0000", text: "word" };
    expect(markBars({ ...base, type: "highlight" })).toEqual(base.rects);
    const [under] = markBars({ ...base, type: "underline" });
    const [strike] = markBars({ ...base, type: "strike" });
    expect(under.y + under.h / 2).toBeCloseTo(118.4, 5);
    expect(strike.y + strike.h / 2).toBeCloseTo(111, 5);
    expect(under.w).toBe(50);
  });
});

async function sample(rotate = 0) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawText("Mark this text", { x: 50, y: 200, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  if (rotate) page.setRotation(degrees(rotate));
  return doc.save();
}

async function envFor(bytes: Uint8Array): Promise<ExportEnv> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  return {
    pageTransform: async (index) => (await pdf.getPage(index + 1)).getViewport({ scale: 1 }).transform as Matrix,
    baseline: () => 10,
  };
}

describe("saving markups and notes", () => {
  it("blends highlights into the page like a highlighter", async () => {
    const bytes = await sample();
    const items: Item[] = [{ id: "h", type: "highlight", page: 0, rects: [{ x: 48, y: 86, w: 100, h: 18 }], color: "#ffe14d", text: "Mark this text" }];
    const out = await addItemsToPdf(bytes, items, await envFor(bytes));
    const doc = await PDFDocument.load(out);
    const resources = doc.getPage(0).node.Resources()!;
    const states = resources.lookup(await import("pdf-lib").then((m) => m.PDFName.of("ExtGState")));
    expect(String(states)).toContain("/Multiply");
    // The page text is still there and readable.
    const pdf = await pdfjs.getDocument({ data: out, verbosity: 0 }).promise;
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
    expect(text).toContain("Mark this text");
  });

  it("saves notes as standard comments any reader can open, in the right place", async () => {
    for (const rotate of [0, 90]) {
      const bytes = await sample(rotate);
      const items: Item[] = [
        { id: "n", type: "note", page: 0, x: 30, y: 40, text: "Husk å signere her – æøå", color: "#ffd43b" },
        { id: "empty", type: "note", page: 0, x: 80, y: 40, text: "  ", color: "#ffd43b" },
      ];
      const out = await addItemsToPdf(bytes, items, await envFor(bytes));
      const page = await (await pdfjs.getDocument({ data: out, verbosity: 0 }).promise).getPage(1);
      const notes = (await page.getAnnotations()).filter((a) => a.subtype === "Text");
      expect(notes, `rotation ${rotate}`).toHaveLength(1);
      expect(notes[0].contentsObj.str).toBe("Husk å signere her – æøå");
      const viewport = page.getViewport({ scale: 1 });
      const [x1, y1, x2, y2] = notes[0].rect;
      const a = viewport.convertToViewportPoint(x1, y1);
      const b = viewport.convertToViewportPoint(x2, y2);
      expect(Math.min(a[0], b[0])).toBeCloseTo(30, 3);
      expect(Math.min(a[1], b[1])).toBeCloseTo(40, 3);
      expect(Math.abs(a[0] - b[0])).toBeCloseTo(18, 3);
    }
  });
});
