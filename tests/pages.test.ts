import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { assemblePdf, type ExportEnv, type Matrix } from "../src/export";
import type { Item, PageRef } from "../src/model";
import { blankPage, deletePages, insertPages, itemsFor, movePages, pagesOf, rotatePages } from "../src/pageops";
import type { DocState } from "../src/store";

const mark = (page: number): Item => ({ id: `m${page}`, type: "check", page, x: 10, y: 10, w: 12, h: 12, stroke: "#000000", strokeWidth: 1 });

function state(count: number): DocState {
  const pages = pagesOf("0", count);
  return { pages, items: pages.map((_, i) => mark(i)) };
}
const order = (s: DocState) => s.pages.map((page) => page.index);
const marks = (s: DocState) => s.items.map((item) => `${item.id}@${item.page}`);

describe("page operations", () => {
  it("moves pages and the items on them", () => {
    const s = state(5);
    const moved = movePages(s, [s.pages[3].id, s.pages[4].id], 1);
    expect(order(moved)).toEqual([0, 3, 4, 1, 2]);
    expect(marks(moved)).toEqual(["m0@0", "m1@3", "m2@4", "m3@1", "m4@2"]);
    expect(order(movePages(s, [s.pages[0].id], 5))).toEqual([1, 2, 3, 4, 0]);
    expect(movePages(s, [s.pages[2].id], 2)).toBe(s);
  });

  it("deletes pages and what was on them, but never the last page", () => {
    const s = state(4);
    const left = deletePages(s, [s.pages[1].id, s.pages[2].id]);
    expect(order(left)).toEqual([0, 3]);
    expect(marks(left)).toEqual(["m0@0", "m3@1"]);
    expect(deletePages(s, s.pages.map((page) => page.id))).toBe(s);
  });

  it("turns pages a quarter at a time, either way", () => {
    const s = state(2);
    const once = rotatePages(s, [s.pages[1].id], 90);
    expect(once.pages.map((page) => page.rotation)).toEqual([0, 90]);
    expect(rotatePages(once, [s.pages[1].id], -180).pages[1].rotation).toBe(270);
    expect(rotatePages(once, [s.pages[1].id], 270).pages[1].rotation).toBe(0);
    expect(once.items).toBe(s.items);
  });

  it("inserts pages, pushing later items along", () => {
    const s = state(3);
    const added = insertPages(s, 1, [blankPage(100, 200), ...pagesOf("1", 2)]);
    expect(added.pages.map((page) => (page.blank ? "blank" : `${page.source}:${page.index}`))).toEqual(["0:0", "blank", "1:0", "1:1", "0:1", "0:2"]);
    expect(marks(added)).toEqual(["m0@0", "m1@4", "m2@5"]);
  });

  it("picks out the items for a set of pages, renumbered", () => {
    const s = state(4);
    expect(itemsFor(s, [s.pages[1].id, s.pages[3].id]).map((item) => `${item.id}@${item.page}`)).toEqual(["m1@0", "m3@1"]);
  });
});

// ---- saving rearranged documents --------------------------------------------

async function makePdf(label: string, count: number, options: { rotate?: number; field?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([400, 600]);
    page.drawText(`${label} page ${i + 1}`, { x: 40, y: 540, size: 20, font });
    if (options.rotate) page.setRotation(degrees(options.rotate));
    if (options.field) doc.getForm().createTextField(`${label}.field${i + 1}`).addToPage(page, { x: 40, y: 400, width: 200, height: 24 });
  }
  return doc.save();
}

const open = (bytes: Uint8Array) => pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;

async function describePdf(bytes: Uint8Array) {
  const pdf = await open(bytes);
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const text = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join("").trim();
    const fields = (await page.getAnnotations()).filter((a) => a.subtype === "Widget").map((a) => a.fieldName);
    out.push({ text, rotate: page.rotate, size: page.view.slice(2).join("x"), fields });
  }
  return out;
}

/** Page transforms as the viewer would report them, read from the source PDFs. */
async function envFor(sources: Map<string, Uint8Array>, pages: PageRef[]): Promise<ExportEnv> {
  const docs = new Map<string, pdfjs.PDFDocumentProxy>();
  for (const [id, bytes] of sources) docs.set(id, await open(bytes));
  return {
    async pageTransform(index) {
      const ref = pages[index];
      if (ref.blank) return [1, 0, 0, -1, 0, ref.blank.height];
      const page = await docs.get(ref.source)!.getPage(ref.index + 1);
      return page.getViewport({ scale: 1 }).transform as Matrix;
    },
    baseline: () => 10,
  };
}

describe("assemblePdf", () => {
  it("returns the file untouched when nothing changed", async () => {
    const bytes = await makePdf("A", 3);
    const pages = pagesOf("0", 3);
    expect(await assemblePdf(new Map([["0", bytes]]), "0", pages, [], await envFor(new Map([["0", bytes]]), pages))).toBe(bytes);
  });

  it("reorders, turns, deletes, inserts blank pages and merges another PDF", async () => {
    const a = await makePdf("A", 3, { field: true });
    const b = await makePdf("B", 2, { rotate: 90 });
    const sources = new Map([
      ["0", a],
      ["1", b],
    ]);
    const [a1, a2, a3] = pagesOf("0", 3);
    const [b1, b2] = pagesOf("1", 2);
    const blank = blankPage(300, 300);
    // A3, B2 turned, blank, A1 turned twice; A2 and B1 left out.
    const pages: PageRef[] = [a3, { ...b2, rotation: 90 }, blank, { ...a1, rotation: 180 }];
    void a2;
    void b1;
    const items: Item[] = [mark(0), mark(2)];
    const out = await assemblePdf(sources, "0", pages, items, await envFor(sources, pages));

    expect(await describePdf(out)).toEqual([
      { text: "A page 3", rotate: 0, size: "400x600", fields: ["A.field3"] },
      { text: "B page 2", rotate: 180, size: "400x600", fields: [] },
      { text: "", rotate: 0, size: "300x300", fields: [] },
      { text: "A page 1", rotate: 180, size: "400x600", fields: ["A.field1"] },
    ]);
    // The field on the deleted page is gone from the form as well.
    const form = (await PDFDocument.load(out)).getForm();
    expect(form.getFields().map((field) => field.getName()).sort()).toEqual(["A.field1", "A.field3"]);
  });

  it("draws items on the pages they belong to after rearranging", async () => {
    const a = await makePdf("A", 2);
    const sources = new Map([["0", a]]);
    const [p1, p2] = pagesOf("0", 2);
    const pages = [p2, { ...p1, rotation: 90 }];
    const text: Item = { id: "t", type: "text", page: 1, x: 50, y: 60, text: "On the first page", font: "sans", size: 12, bold: false, italic: false, color: "#000000" };
    const out = await assemblePdf(sources, "0", pages, [text], await envFor(sources, pages));
    const pdf = await open(out);
    const second = await pdf.getPage(2);
    const words = (await second.getTextContent()).items.map((item) => ("str" in item ? item.str : ""));
    expect(words).toContain("On the first page");
    expect(words).toContain("A page 1");
    // Drawn where it was placed on the page before turning, so it turns with the page.
    const run = (await second.getTextContent()).items.find((item) => "str" in item && item.str === "On the first page") as { transform: number[] };
    const upright = second.getViewport({ scale: 1, rotation: 0 });
    const [x, y] = upright.convertToViewportPoint(run.transform[4], run.transform[5]);
    expect(x).toBeCloseTo(50, 3);
    expect(y).toBeCloseTo(70, 3);
  });
});
