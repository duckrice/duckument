import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { restore, seal, storableItems } from "../src/editdata";
import { assemblePdf, type ExportEnv, type Matrix } from "../src/export";
import type { Item, PageRef } from "../src/model";
import { pagesOf } from "../src/pageops";

async function sample() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) doc.addPage([400, 300]).drawText(`Original page ${i}`, { x: 40, y: 250, size: 14, font });
  return doc.save();
}

async function envFor(bytes: Uint8Array, pages: PageRef[], items: Item[]): Promise<ExportEnv> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  return {
    pageTransform: async (index) => (await pdf.getPage(pages[index].index + 1)).getViewport({ scale: 1 }).transform as Matrix,
    baseline: () => 10,
    seal: (saved) => seal({ v: 1, pages: saved.map((page, i) => ({ ...page, extra: pages[i].rotation })), items: storableItems(items) }),
  };
}

const items: Item[] = [
  { id: "t", type: "text", page: 1, x: 50, y: 100, text: "Added text", font: "sans", size: 12, bold: false, italic: false, color: "#000000" },
  { id: "r", type: "rect", page: 0, x: 20, y: 20, w: 50, h: 30, stroke: "#ff0000", fill: null, strokeWidth: 2 },
  { id: "n", type: "note", page: 0, x: 200, y: 50, text: "A comment", color: "#ffd43b" },
  {
    id: "e",
    type: "text",
    page: 0,
    x: 40,
    y: 40,
    text: "Replacement",
    font: "sans",
    size: 14,
    bold: false,
    italic: false,
    color: "#000000",
    cover: { x: 38, y: 36, w: 140, h: 20, color: "#ffffff", original: "Original page 1" },
  },
];

const textOf = async (bytes: Uint8Array) => {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) out.push((await (await pdf.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" "));
  return out;
};

describe("keeping edits editable", () => {
  it("restores the edits, takes Duckument's drawing back off, and keeps removed text out", async () => {
    const original = await sample();
    const pages = pagesOf("0", 2).map((page, i) => ({ ...page, rotation: i === 1 ? 90 : 0 }));
    const saved = await assemblePdf(new Map([["0", original]]), "0", pages, items, await envFor(original, pages, items));

    // Any reader sees the finished pages.
    const [first, second] = await textOf(saved);
    expect(first).toContain("Replacement");
    expect(first).not.toContain("Original page 1");
    expect(second).toContain("Added text");

    const back = await restore(saved);
    expect(back).not.toBeNull();
    expect(back!.items.map((i) => i.id)).toEqual(["t", "r", "n", "e"]);
    expect(back!.rotations).toEqual([0, 90]);
    expect(JSON.stringify(back!.items)).not.toContain("Original page 1");

    // Without Duckument's drawing, the pages hold only what was there before (minus the removed text).
    const [cleanFirst, cleanSecond] = await textOf(back!.bytes);
    expect(cleanFirst).not.toContain("Replacement");
    expect(cleanSecond).not.toContain("Added text");
    expect(cleanSecond).toContain("Original page 2");
    const cleaned = await PDFDocument.load(back!.bytes);
    expect(cleaned.getPage(1).getRotation().angle).toBe(0);
    const pdf = await pdfjs.getDocument({ data: back!.bytes.slice(), verbosity: 0 }).promise;
    const comments = (await (await pdf.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Text");
    expect(comments).toHaveLength(0);
  });

  it("opens other files as they are", async () => {
    expect(await restore(await sample())).toBeNull();
  });

  it("ignores the stored edits once another program has rearranged the pages", async () => {
    const original = await sample();
    const pages = pagesOf("0", 2);
    const saved = await assemblePdf(new Map([["0", original]]), "0", pages, items, await envFor(original, pages, items));
    const doc = await PDFDocument.load(saved);
    doc.removePage(1);
    expect(await restore(await doc.save())).toBeNull();
  });
});
