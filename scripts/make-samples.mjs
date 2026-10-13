// Generates PDFs for trying the app during development:
//   npm run samples, then open http://localhost:1420/?src=/samples/form.pdf
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFHexString, StandardFonts, beginText, degrees, endText, rgb, setFontAndSize, setTextMatrix, showText } from "pdf-lib";

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

// A non-fillable form in a Windows font: blanks to detect and text to edit.
async function letter() {
  const fonts = "C:/Windows/Fonts";
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const has = existsSync(`${fonts}/calibri.ttf`);
  const regular = has ? await doc.embedFont(readFileSync(`${fonts}/calibri.ttf`)) : await doc.embedFont(StandardFonts.Helvetica);
  const bold = has ? await doc.embedFont(readFileSync(`${fonts}/calibrib.ttf`)) : await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  const black = rgb(0, 0, 0);

  page.drawRectangle({ x: 0, y: 772, width: 595, height: 70, color: rgb(0.11, 0.25, 0.55) });
  page.drawText("Membership application", { x: 50, y: 798, size: 24, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Riverside Tennis Club, founded 1987", { x: 50, y: 740, size: 12, font: regular });
  page.drawText("Please complete this form in block letters and return it by 31 March.", { x: 50, y: 720, size: 11, font: regular, color: rgb(0.3, 0.3, 0.3) });

  ["First name:", "Last name:", "Address:", "Email:"].forEach((label, i) => {
    const y = 670 - i * 34;
    page.drawText(label, { x: 50, y, size: 11, font: regular });
    page.drawLine({ start: { x: 125, y: y - 2 }, end: { x: 420, y: y - 2 }, thickness: 0.6 });
  });

  page.drawText("Membership type", { x: 50, y: 520, size: 12, font: bold });
  ["Adult", "Junior", "Family"].forEach((label, i) => {
    const x = 50 + i * 110;
    page.drawRectangle({ x, y: 492, width: 12, height: 12, borderWidth: 0.8, borderColor: black });
    page.drawText(label, { x: x + 18, y: 494, size: 11, font: regular });
  });

  page.drawText("Emergency contacts", { x: 50, y: 450, size: 12, font: bold });
  const cols = [50, 220, 390, 545];
  for (let row = 0; row < 4; row++) {
    const y = 420 - row * 24;
    for (let c = 0; c < 3; c++) {
      page.drawRectangle({ x: cols[c], y, width: cols[c + 1] - cols[c], height: 24, borderWidth: 0.6, borderColor: black });
    }
  }
  ["Name", "Relationship", "Phone"].forEach((label, c) => page.drawText(label, { x: cols[c] + 6, y: 428, size: 10, font: bold }));

  page.drawText("Anything we should know?", { x: 50, y: 310, size: 11, font: regular });
  page.drawRectangle({ x: 50, y: 220, width: 495, height: 80, borderWidth: 0.6, borderColor: black });

  page.drawText("Date:", { x: 50, y: 150, size: 11, font: regular });
  page.drawLine({ start: { x: 85, y: 148 }, end: { x: 200, y: 148 }, thickness: 0.6 });
  page.drawText("Signature:", { x: 250, y: 150, size: 11, font: regular });
  page.drawLine({ start: { x: 305, y: 148 }, end: { x: 545, y: 148 }, thickness: 0.6 });
  writeFileSync(join(out, "letter.pdf"), await doc.save());
}

// Text in Windows fonts stored the awkward ways real PDFs store them: under
// made-up names, and by name only without the font inside the file.
async function fonts() {
  const dir = "C:/Windows/Fonts";
  if (!existsSync(`${dir}/timesi.ttf`)) return;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([595, 420]);
  let y = 380;
  const embedded = async (file, customName, lines) => {
    const font = await doc.embedFont(readFileSync(`${dir}/${file}`), { subset: true, customName });
    for (const line of lines) {
      page.drawText(line, { x: 40, y, size: 13, font });
      y -= 22;
    }
    y -= 12;
  };
  await embedded("timesi.ttf", "TT5o00", ["The delta to wye transformation", "simplifies a resistor network", "into one that is easy to solve."]);
  await embedded("calibrib.ttf", "C2_1", ["Workshop 4: worked solutions", "Hand in before Friday at noon"]);
  await embedded("ariali.ttf", "F7", ["Hint: start from the outer loop", "and work towards the source."]);

  const hex = (text) => PDFHexString.of([...text].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  const byName = (baseFont, text) => {
    const ref = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "TrueType", BaseFont: baseFont, Encoding: "WinAnsiEncoding" }));
    const key = page.node.newFontDictionary("N", ref);
    page.pushOperators(beginText(), setFontAndSize(key, 13), setTextMatrix(1, 0, 0, 1, 40, y), showText(hex(text)), endText());
    y -= 22;
  };
  byName("TimesNewRomanPS-BoldItalicMT", "Named only, bold italic Times New Roman");
  byName("TimesNewRoman,Italic", "Named only, italic with a comma");
  writeFileSync(join(out, "fonts.pdf"), await doc.save());
}

await form();
await flat();
await letter();
await fonts();
console.log(`Wrote samples to ${out}`);
