// Generates PDFs for trying the app during development:
//   npm run samples, then open http://localhost:1420/?src=/samples/form.pdf
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");
mkdirSync(out, { recursive: true });

async function form() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  const f = doc.getForm();
  page.drawText("Application form", { x: 50, y: 780, size: 22, font: bold });
  const rows = ["Full name", "Address", "Email", "Phone"];
  rows.forEach((label, i) => {
    const y = 720 - i * 44;
    page.drawText(label, { x: 50, y: y + 6, size: 11, font });
    f.createTextField(`field.${label}`).addToPage(page, { x: 150, y, width: 300, height: 22, borderWidth: 1 });
  });
  page.drawText("I agree to the terms", { x: 76, y: 530, size: 11, font });
  f.createCheckBox("agree").addToPage(page, { x: 50, y: 526, width: 16, height: 16 });
  page.drawText("Country", { x: 50, y: 486, size: 11, font });
  const country = f.createDropdown("country");
  country.addOptions(["Norway", "Sweden", "Denmark"]);
  country.addToPage(page, { x: 150, y: 480, width: 160, height: 22 });
  page.drawText("Comments", { x: 50, y: 440, size: 11, font });
  const comments = f.createTextField("comments");
  comments.enableMultiline();
  comments.addToPage(page, { x: 150, y: 360, width: 300, height: 90 });
  page.drawText("Signature", { x: 50, y: 250, size: 11, font });
  page.drawLine({ start: { x: 150, y: 246 }, end: { x: 400, y: 246 }, thickness: 0.8 });
  page.drawText("Date", { x: 50, y: 200, size: 11, font });
  page.drawLine({ start: { x: 150, y: 196 }, end: { x: 300, y: 196 }, thickness: 0.8 });
  writeFileSync(join(out, "form.pdf"), await doc.save());
}

async function flat() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let n = 1; n <= 12; n++) {
    const landscape = n === 3;
    const page = doc.addPage(landscape ? [842, 595] : [595, 842]);
    if (n === 4) page.setRotation(degrees(90));
    const { width, height } = page.getSize();
    page.drawText(`Contract, page ${n}`, { x: 50, y: height - 70, size: 20, font });
    for (let line = 0; line < 22; line++) {
      page.drawText("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.", {
        x: 50,
        y: height - 110 - line * 18,
        size: 11,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
    }
    page.drawText("Name:", { x: 50, y: 130, size: 11, font });
    page.drawLine({ start: { x: 90, y: 128 }, end: { x: 300, y: 128 }, thickness: 0.7 });
    page.drawText("Signature:", { x: 50, y: 90, size: 11, font });
    page.drawLine({ start: { x: 110, y: 88 }, end: { x: 300, y: 88 }, thickness: 0.7 });
    page.drawRectangle({ x: width - 120, y: 80, width: 14, height: 14, borderWidth: 0.8, borderColor: rgb(0, 0, 0) });
    page.drawText("Yes", { x: width - 100, y: 83, size: 11, font });
  }
  writeFileSync(join(out, "flat.pdf"), await doc.save());
}

await form();
await flat();
console.log(`Wrote samples to ${out}`);
