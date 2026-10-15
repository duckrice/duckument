// Generates PDFs for trying the app during development:
//   npm run samples, then open http://localhost:1420/?src=/samples/form.pdf
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFHexString, StandardFonts, beginText, degrees, endText, rgb, setFontAndSize, setTextMatrix, showText } from "pdf-lib";

// Ligatures would turn "ti" into one letter that pdf.js shows with a gap.
const NO_LIGATURES = { features: { liga: false } };

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
  const regular = has ? await doc.embedFont(readFileSync(`${fonts}/calibri.ttf`), NO_LIGATURES) : await doc.embedFont(StandardFonts.Helvetica);
  const bold = has ? await doc.embedFont(readFileSync(`${fonts}/calibrib.ttf`), NO_LIGATURES) : await doc.embedFont(StandardFonts.HelveticaBold);
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
  const page = doc.addPage([595, 520]);
  let y = 480;
  const embedded = async (file, customName, lines) => {
    const font = await doc.embedFont(readFileSync(`${dir}/${file}`), { ...NO_LIGATURES, subset: true, customName });
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
  byName("TimesNewRomanPS-ItalicMT", "Named only, the usual italic name");
  byName("Times New Roman,Italic", "Named only, with spaces in the name");
  y -= 12;
  await embedded("timesi.ttf", undefined, ["Embedded under its real name"]);
  page.drawText("One of the standard fonts, Times-Italic", { x: 40, y, size: 13, font: await doc.embedFont(StandardFonts.TimesRomanItalic) });
  writeFileSync(join(out, "fonts.pdf"), await doc.save());
}

// A long document, to check that the page sidebar stays quick.
async function long() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 300; n++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${n}`, { x: 220, y: 420, size: 60, font });
    page.drawRectangle({ x: 40, y: 40, width: 515, height: 762, borderWidth: 2, borderColor: rgb(0.2, 0.3, 0.7) });
  }
  writeFileSync(join(out, "long.pdf"), await doc.save());
}

// Fifty pages of text with known words to search for.
async function search() {
  const doc = await PDFDocument.create();
  const dir = "C:/Windows/Fonts";
  doc.registerFontkit(fontkit);
  // A font with Norwegian letters; Helvetica has them too, as a fallback.
  const font = existsSync(`${dir}/arial.ttf`) ? await doc.embedFont(readFileSync(`${dir}/arial.ttf`), { ...NO_LIGATURES, subset: true }) : await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 50; n++) {
    const page = doc.addPage([595, 842]);
    const lines = [`Page ${n} of the search sample`, "Lorem ipsum dolor sit amet, consectetur adipiscing elit."];
    if ([3, 17].includes(n)) lines.push("There is a needle in this haystack.");
    if (n === 42) lines.push("A needle here, and another needle there.");
    if (n === 10) lines.push("Blåbærsyltetøy fra Ålesund");
    if (n === 25) lines.push("Apply the delta", "wye transformation to the network.");
    lines.forEach((line, i) => page.drawText(line, { x: 60, y: 760 - i * 22, size: 13, font }));
  }
  writeFileSync(join(out, "search.pdf"), await doc.save());
}

// Dotted, dashed and shaded fields.
async function dotted() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Name:", { x: 50, y: 700, size: 11, font });
  page.drawText(".".repeat(70), { x: 90, y: 700, size: 11, font });
  page.drawText("Address:", { x: 50, y: 660, size: 11, font });
  page.drawLine({ start: { x: 105, y: 658 }, end: { x: 420, y: 658 }, thickness: 0.6, dashArray: [4, 3] });
  page.drawText("Email:", { x: 50, y: 610, size: 11, font });
  page.drawRectangle({ x: 95, y: 600, width: 300, height: 22, color: rgb(0.9, 0.93, 0.98) });
  page.drawText("Phone:", { x: 50, y: 570, size: 11, font });
  page.drawRectangle({ x: 95, y: 560, width: 200, height: 22, color: rgb(0.92, 0.92, 0.92) });
  // A shaded panel with text in it is not a field.
  page.drawRectangle({ x: 50, y: 400, width: 495, height: 100, color: rgb(0.94, 0.94, 0.94) });
  page.drawText("Please read the terms before signing this form.", { x: 60, y: 450, size: 11, font });
  writeFileSync(join(out, "dotted.pdf"), await doc.save());
}

// Paragraphs of running text, one justified, to edit.
async function paragraphs() {
  const dir = "C:/Windows/Fonts";
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const has = existsSync(`${dir}/times.ttf`);
  const font = has ? await doc.embedFont(readFileSync(`${dir}/times.ttf`), { ...NO_LIGATURES, subset: true }) : await doc.embedFont(StandardFonts.TimesRoman);
  const bold = has ? await doc.embedFont(readFileSync(`${dir}/timesbd.ttf`), { ...NO_LIGATURES, subset: true }) : await doc.embedFont(StandardFonts.TimesRomanBold);
  const page = doc.addPage([595, 842]);
  page.drawText("Workshop 4: Delta to wye transformation", { x: 60, y: 760, size: 18, font: bold });
  const text =
    "A delta network of three resistors can be replaced by an equivalent wye network, and the other way round. " +
    "This makes it possible to simplify circuits that contain neither series nor parallel connections, " +
    "such as the bridge circuit in the exercise below. Each wye resistor equals the product of the two adjacent " +
    "delta resistors divided by the sum of all three.";
  // Lay the paragraph out justified, word by word, as a word processor would.
  const width = 470;
  const size = 12;
  const words = text.split(" ");
  const lines = [];
  let line = [];
  for (const word of words) {
    if (line.length && font.widthOfTextAtSize([...line, word].join(" "), size) > width) {
      lines.push(line);
      line = [];
    }
    line.push(word);
  }
  lines.push(line);
  lines.forEach((ws, i) => {
    const y = 720 - i * 15;
    if (i === lines.length - 1) {
      page.drawText(ws.join(" "), { x: 60, y, size, font });
      return;
    }
    const natural = ws.reduce((sum, w) => sum + font.widthOfTextAtSize(w, size), 0);
    const gap = (width - natural) / (ws.length - 1);
    let x = 60;
    for (const w of ws) {
      page.drawText(w, { x, y, size, font });
      x += font.widthOfTextAtSize(w, size) + gap;
    }
  });
  page.drawText("Exercise 1: Find the equivalent resistance between A and B.", { x: 60, y: 600, size, font });
  writeFileSync(join(out, "paragraphs.pdf"), await doc.save());
}

await form();
await flat();
await long();
await search();
await dotted();
await paragraphs();
await letter();
await fonts();
console.log(`Wrote samples to ${out}`);
