import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildRuns, runAt } from "../src/textruns";

async function runsOf(build: (doc: PDFDocument) => Promise<void>) {
  const doc = await PDFDocument.create();
  await build(doc);
  const pdf = await pdfjs.getDocument({ data: await doc.save(), useSystemFonts: false }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  return { runs: buildRuns(content.items, content.styles, viewport.transform), viewport };
}

describe("buildRuns", () => {
  it("gives one run per line of text, placed where the page shows it", async () => {
    const { runs } = await runsOf(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      page.drawText("Hello there, world", { x: 40, y: 250, size: 12, font });
      page.drawText("Second line", { x: 40, y: 230, size: 18, font });
    });
    expect(runs.map((run) => run.text)).toEqual(["Hello there, world", "Second line"]);

    const [first, second] = runs;
    expect(first.baseX).toBeCloseTo(40, 3);
    expect(first.baseline).toBeCloseTo(50, 3);
    expect(first.size).toBeCloseTo(12, 3);
    expect(second.size).toBeCloseTo(18, 3);
    expect(second.baseline).toBeCloseTo(70, 3);
    expect(first.fontClass).toBe("sans");

    // The box to paint over reaches from above the capitals to below the descenders.
    expect(first.y).toBeLessThan(50 - 12 * 0.7);
    expect(first.y + first.h).toBeGreaterThan(50 + 12 * 0.2);
    expect(first.width).toBeGreaterThan(90);
    expect(first.w).toBeCloseTo(first.width + 2, 6);
    expect(runAt(runs, 60, 46)).toBe(first);
    expect(runAt(runs, 60, 66)).toBe(second);
    expect(runAt(runs, 300, 46)).toBeNull();
  });

  it("keeps columns and different fonts apart", async () => {
    const { runs } = await runsOf(async (doc) => {
      const regular = await doc.embedFont(StandardFonts.TimesRoman);
      const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
      const page = doc.addPage([400, 300]);
      page.drawText("Name", { x: 40, y: 250, size: 11, font: regular });
      page.drawText("Phone", { x: 240, y: 250, size: 11, font: regular });
      page.drawText("Total:", { x: 40, y: 200, size: 11, font: bold });
      page.drawText("42 kr", { x: 72, y: 200, size: 11, font: regular });
    });
    expect(runs.map((run) => run.text)).toEqual(["Name", "Phone", "Total:", "42 kr"]);
    expect(runs.every((run) => run.fontClass === "serif")).toBe(true);
  });

  it("follows the page rotation and leaves sideways text alone", async () => {
    const { runs, viewport } = await runsOf(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      page.setRotation(degrees(90));
      // Upright when the rotated page is displayed.
      page.drawText("Reads normally", { x: 100, y: 50, size: 12, font, rotate: degrees(90) });
      page.drawText("Reads sideways", { x: 40, y: 250, size: 12, font });
    });
    expect(runs.map((run) => run.text)).toEqual(["Reads normally"]);
    const [x, y] = viewport.convertToViewportPoint(100, 50);
    expect(runs[0].baseX).toBeCloseTo(x, 3);
    expect(runs[0].baseline).toBeCloseTo(y, 3);
  });
});
