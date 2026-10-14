import { existsSync, readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { parseContent, removeTextFromPage } from "../src/contentedit";

type Run = { str: string; x: number; y: number };

async function runsOf(bytes: Uint8Array): Promise<Run[]> {
  const page = await (await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise).getPage(1);
  return (await page.getTextContent()).items
    .filter((item) => "str" in item && item.str.trim())
    .map((item) => {
      const t = item as { str: string; transform: number[] };
      return { str: t.str, x: t.transform[4], y: t.transform[5] };
    });
}

const text = async (bytes: Uint8Array) => (await runsOf(bytes)).map((r) => r.str).join(" ");

/** Where each word starts on the page, by reading the page with pdf.js one word at a time. */
async function wordPositions(bytes: Uint8Array) {
  const page = await (await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise).getPage(1);
  const content = await page.getTextContent({ disableCombineTextItems: true } as never);
  return content.items.filter((i) => "str" in i && i.str.trim()).map((i) => (i as { transform: number[] }).transform[4]);
}

/** Removes the text in a rectangle and returns the new PDF and the result. */
async function removeIn(bytes: Uint8Array, rect: [number, number, number, number]) {
  const doc = await PDFDocument.load(bytes);
  const [result] = removeTextFromPage(doc, doc.getPage(0), [rect]);
  return { bytes: await doc.save(), removed: result };
}

/** A page whose content stream is exactly `content`, with Helvetica as /F1. */
async function rawPage(content: string, extra?: (doc: PDFDocument) => Promise<void> | void) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.node.setFontDictionary(PDFName.of("F1"), font.ref);
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(content)));
  await extra?.(doc);
  return doc.save();
}

describe("parseContent", () => {
  it("splits a content stream into instructions with their operands", () => {
    const ops = parseContent(new TextEncoder().encode("q 1 0 0 1 10 20 cm BT /F1 12 Tf (a\\(b\\)c) Tj [<0041> -20 (x)] TJ ET Q % comment\n"));
    expect(ops.map((op) => op.op)).toEqual(["q", "cm", "BT", "Tf", "Tj", "TJ", "ET", "Q"]);
    expect(ops[3].operands).toEqual(["F1", 12]);
    expect(new TextDecoder().decode(ops[4].operands[0] as Uint8Array)).toBe("a(b)c");
    const array = ops[5].operands[0] as unknown[];
    expect(array).toHaveLength(3);
    expect(array[1]).toBe(-20);
  });

  it("steps over inline images", () => {
    const ops = parseContent(new TextEncoder().encode("BI /W 2 /H 1 /BPC 8 /CS /G ID \u0000EI\u00ff EI Q"));
    expect(ops.map((op) => op.op)).toEqual(["BI", "Q"]);
  });
});

describe("removeTextFromPage", () => {
  it("takes words out of the middle of a line and leaves the rest exactly in place", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText("Keep this. Remove me. Keep that.", { x: 40, y: 200, size: 12, font });
    page.drawText("Another line stays.", { x: 40, y: 180, size: 12, font });
    const before = await doc.save();
    const start = 40 + font.widthOfTextAtSize("Keep this. ", 12);
    const end = 40 + font.widthOfTextAtSize("Keep this. Remove me.", 12);
    const { bytes, removed } = await removeIn(before, [start - 0.5, 195, end + 0.5, 212]);

    expect(removed).toBe(true);
    const after = await text(bytes);
    expect(after).not.toContain("Remove");
    expect(after).toContain("Keep this.");
    expect(after).toContain("Keep that.");
    expect(after).toContain("Another line stays.");
    // "Keep that." starts where it did.
    const keep = (await runsOf(bytes)).find((r) => r.str.includes("that"))!;
    const expectedX = 40 + font.widthOfTextAtSize("Keep this. Remove me. ", 12);
    const startOfThat = keep.str.startsWith("Keep that") ? keep.x : keep.x + font.widthOfTextAtSize(keep.str.slice(0, keep.str.indexOf("Keep that")), 12);
    expect(startOfThat).toBeCloseTo(expectedX, 1);
  });

  it("handles spacing numbers, character spacing and the ' operator", async () => {
    const content = "BT /F1 12 Tf 14 TL 2 Tc 40 200 Td [(Hel) -150 (lo Wor) 80 (ld)] TJ (Next line here) ' ET";
    const before = await rawPage(content);
    const positions = await wordPositions(before);
    // Remove "lo Wor": it starts after "Hel" plus the -150 spacing.
    const { bytes, removed } = await removeIn(before, [40 + 3 * 2 + 20.5, 195, 40 + 66, 212]);
    expect(removed).toBe(true);
    const after = await text(bytes);
    expect(after).not.toContain("Wor");
    expect(after).toContain("Hel");
    expect(after).toContain("ld");
    expect(after).toContain("Next line here");
    // Everything that stayed starts where it did.
    const kept = await wordPositions(bytes);
    for (const x of kept) expect(positions.some((p) => Math.abs(p - x) < 0.05)).toBe(true);
  });

  it.skipIf(!existsSync("C:/Windows/Fonts/calibri.ttf"))("works with embedded fonts that use two bytes per letter", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync("C:/Windows/Fonts/calibri.ttf"), { subset: true });
    const page = doc.addPage([400, 300]);
    page.drawText("Søknad om medlemskap i klubben", { x: 40, y: 200, size: 14, font });
    const before = await doc.save();
    const start = 40 + font.widthOfTextAtSize("Søknad om ", 14);
    const end = 40 + font.widthOfTextAtSize("Søknad om medlemskap", 14);
    const { bytes, removed } = await removeIn(before, [start - 0.5, 195, end + 0.5, 214]);
    expect(removed).toBe(true);
    const after = await text(bytes);
    expect(after).not.toContain("medlemskap");
    expect(after).toContain("Søknad om");
    expect(after).toContain("i klubben");
  });

  it("removes nothing outside the area and says so when the area is empty", async () => {
    const before = await rawPage("BT /F1 12 Tf 40 200 Td (Untouched) Tj ET");
    const { bytes, removed } = await removeIn(before, [300, 10, 390, 30]);
    expect(removed).toBe(true);
    expect(await text(bytes)).toBe("Untouched");
  });

  it("reports text it can't remove: text inside a reusable drawing", async () => {
    const before = await rawPage("q /Fm1 Do Q", (doc) => {
      const page = doc.getPage(0);
      const resources = doc.context.obj({ Font: page.node.Resources()!.lookup(PDFName.of("Font")) });
      const form = doc.context.flateStream("BT /F1 12 Tf 40 200 Td (In a form) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 300], Resources: resources });
      page.node.setXObject(PDFName.of("Fm1"), doc.context.register(form));
    });
    const { bytes, removed } = await removeIn(before, [35, 195, 120, 212]);
    expect(removed).toBe(false);
    expect(await text(bytes)).toContain("In a form");
  });
});
