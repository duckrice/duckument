import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { flattenForm } from "../src/compress";

/**
 * A form as many real ones are (found with forms from the web): a text field with an answer but
 * no look of its own, a box whose looks don't say which is "on", and a well-made field.
 */
async function realisticForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const name = form.createTextField("name");
  name.setText("Kari Nordmann");
  name.addToPage(page, { x: 40, y: 220, width: 200, height: 24, font });
  const city = form.createTextField("city");
  city.setText("Bergen");
  city.addToPage(page, { x: 40, y: 180, width: 200, height: 24, font });
  const box = form.createCheckBox("agree");
  box.addToPage(page, { x: 40, y: 140, width: 16, height: 16 });
  // Taken off as real forms lack them: the name's look, and the box's states.
  name.acroField.getWidgets()[0].dict.delete(PDFName.of("AP"));
  const boxAp = box.acroField.getWidgets()[0].dict.lookup(PDFName.of("AP"));
  (boxAp as import("pdf-lib").PDFDict).set(PDFName.of("N"), doc.context.obj({}));
  box.acroField.getWidgets()[0].dict.delete(PDFName.of("AS"));
  return doc.save({ updateFieldAppearances: false });
}

describe("flattening a real-world form", () => {
  it("doesn't fail on fields without a look of their own, and leaves no field behind", async () => {
    const flat = await flattenForm(await realisticForm());
    const pdf = await pdfjs.getDocument({ data: flat.slice(), verbosity: 0 }).promise;
    const page = await pdf.getPage(1);
    expect((await page.getAnnotations()).length).toBe(0);
    // Both answers are now part of the page, the one that had no look too.
    const text = (await page.getTextContent()).items.map((t) => ("str" in t ? t.str : "")).join(" ");
    expect(text).toContain("Kari Nordmann");
    expect(text).toContain("Bergen");
  });
});
