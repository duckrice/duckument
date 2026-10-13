import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { addItemsToPdf, type ExportEnv, type Matrix } from "../src/export";
import type { Item } from "../src/model";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const BASELINE = 11;

async function open(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, fontExtraProperties: true }).promise;
}

async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const upright = doc.addPage([595, 842]);
  upright.drawText("original", { x: 50, y: 800, size: 10 });
  doc.getForm().createTextField("name").addToPage(upright, { x: 50, y: 700, width: 200, height: 20 });

  // Rotated, cropped and with an offset origin: the awkward case for coordinates.
  const sideways = doc.addPage([842, 595]);
  sideways.setRotation(degrees(90));
  sideways.setMediaBox(-20, -30, 842, 595);
  sideways.setCropBox(10, 15, 700, 500);

  doc.addPage([400, 400]).setRotation(degrees(180));
  doc.addPage([400, 300]).setRotation(degrees(270));
  return doc.save();
}

function env(doc: pdfjs.PDFDocumentProxy): ExportEnv {
  return {
    async pageTransform(index) {
      const page = await doc.getPage(index + 1);
      return page.getViewport({ scale: 1 }).transform as Matrix;
    },
    baseline: () => BASELINE,
  };
}

describe("addItemsToPdf", () => {
  it("places text where it was shown, on every page rotation", async () => {
    const original = await sample();
    const source = await open(original);
    const items: Item[] = [0, 1, 2, 3].map((page) => ({
      id: `t${page}`,
      type: "text",
      page,
      x: 100,
      y: 150,
      text: `Hei på deg ${page}\nlinje to`,
      font: "sans",
      size: 12,
      bold: false,
      italic: false,
      color: "#000000",
    }));

    const result = await open(await addItemsToPdf(original, items, env(source)));
    expect(result.numPages).toBe(4);

    for (let index = 0; index < 4; index++) {
      const page = await result.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const runs = content.items.filter((run) => "str" in run && run.str.length > 0) as {
        str: string;
        transform: number[];
      }[];

      const first = runs.find((run) => run.str === `Hei på deg ${index}`);
      const second = runs.find((run) => run.str === "linje to");
      expect(first, `page ${index + 1}`).toBeDefined();
      expect(second, `page ${index + 1}`).toBeDefined();

      const [x1, y1] = viewport.convertToViewportPoint(first!.transform[4], first!.transform[5]);
      expect(x1).toBeCloseTo(100, 3);
      expect(y1).toBeCloseTo(150 + BASELINE, 3);
      const [x2, y2] = viewport.convertToViewportPoint(second!.transform[4], second!.transform[5]);
      expect(x2).toBeCloseTo(100, 3);
      expect(y2).toBeCloseTo(150 + BASELINE + 12 * 1.2, 3);
    }
  });

  it("keeps the original content and form values filled in through pdf.js", async () => {
    const source = await open(await sample());
    const widgets = (await (await source.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Widget");
    expect(widgets).toHaveLength(1);
    source.annotationStorage.setValue(widgets[0].id, { value: "Kari Nordmann" });
    const filled = await source.saveDocument();

    const items: Item[] = [
      { id: "r", type: "rect", page: 0, x: 40, y: 40, w: 100, h: 50, stroke: "#ff0000", fill: null, strokeWidth: 2 },
      { id: "a", type: "arrow", page: 0, x1: 10, y1: 10, x2: 80, y2: 90, stroke: "#0000ff", strokeWidth: 1.5 },
      { id: "c", type: "check", page: 0, x: 10, y: 10, w: 14, h: 14, stroke: "#000000", strokeWidth: 1.5 },
      { id: "p", type: "pen", page: 0, x: 5, y: 5, w: 50, h: 20, points: [0, 0, 0.5, 1, 1, 0.2], stroke: "#000000", strokeWidth: 1 },
      { id: "s", type: "image", page: 0, x: 300, y: 600, w: 120, h: 40, src: PNG_1PX },
      { id: "s2", type: "image", page: 1, x: 30, y: 60, w: 120, h: 40, src: PNG_1PX },
    ];
    const result = await open(await addItemsToPdf(filled, items, env(source)));

    const page = await result.getPage(1);
    const text = (await page.getTextContent()).items.map((run) => ("str" in run ? run.str : "")).join(" ");
    expect(text).toContain("original");
    const field = (await page.getAnnotations()).find((a) => a.subtype === "Widget");
    expect(field?.fieldValue).toBe("Kari Nordmann");

    const ops = await page.getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.paintImageXObject);
  });

  const FONT_DIR = "C:/Windows/Fonts";

  it.skipIf(!existsSync(`${FONT_DIR}/calibrib.ttf`))("embeds a system font and covers replaced text", async () => {
    const original = await sample();
    const source = await open(original);
    const loaded: string[] = [];
    const items: Item[] = [
      {
        id: "t",
        type: "text",
        page: 0,
        x: 50,
        y: 30,
        text: "Søknad – æøå ÆØÅ",
        font: "calibri",
        size: 20,
        bold: true,
        italic: false,
        color: "#000000",
        cover: { x: 48, y: 28, w: 120, h: 24, color: "#ffffff" },
      },
      // Only a cover: the original text is being deleted.
      { id: "d", type: "text", page: 0, x: 0, y: 0, text: "", font: "sans", size: 10, bold: false, italic: false, color: "#000000", cover: { x: 0, y: 0, w: 10, h: 10, color: "#ffeecc" } },
    ];
    const bytes = await addItemsToPdf(original, items, {
      ...env(source),
      async loadFont(file) {
        loaded.push(file);
        return new Uint8Array(readFileSync(`${FONT_DIR}/${file}`));
      },
    });
    expect(loaded).toEqual(["calibrib.ttf"]);
    // A subset is embedded, not the whole font file.
    expect(bytes.length).toBeLessThan(original.length + 60_000);

    const page = await (await open(bytes)).getPage(1);
    const content = await page.getTextContent();
    const run = content.items.find((r) => "str" in r && r.str.startsWith("Søknad")) as { str: string; fontName: string };
    expect(run.str).toBe("Søknad – æøå ÆØÅ");
    await page.getOperatorList();
    expect(page.commonObjs.get(run.fontName).name).toMatch(/Calibri-Bold/);
  });

  it("returns the input untouched when there is nothing to add", async () => {
    const original = await sample();
    const source = await open(original);
    expect(await addItemsToPdf(original, [], env(source))).toBe(original);
  });
});
