// Scanned pages made searchable, as Acrobat's "Recognize text": each page without text is drawn
// as a picture, Windows' own OCR reads it, and the words go into the PDF as invisible text in
// their places, so they can be found and copied. Pages that have text are left as they are.

import { PDFDocument, PDFNumber, PDFOperator, PDFOperatorNames, StandardFonts, TextRenderingMode, beginText, endText, popGraphicsState, pushGraphicsState, setFontAndSize, setTextRenderingMode, showText } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";

/** A word Windows found: its text and box in the picture's pixels (x, y, width, height). */
export type OcrWord = [string, number, number, number, number];

/** The longest side of the picture a page is read from, in pixels (about 300 dpi for A4). */
const LONGEST = 3200;

/**
 * The PDF with invisible text on its scanned pages. `pdf` is the same PDF opened in pdf.js (to draw
 * the pages); `read` gives the words in a PNG. Returns the new PDF and how many pages got text.
 */
export async function makeSearchable(bytes: Uint8Array, pdf: PDFDocumentProxy, read: (png: Uint8Array) => Promise<OcrWord[]>, progress?: (done: number, total: number) => void): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const known = new Set(font.getCharacterSet());
  const pages = doc.getPages();
  let done = 0;
  for (let i = 0; i < pdf.numPages && i < pages.length; i++) {
    progress?.(i, pdf.numPages);
    const page = await pdf.getPage(i + 1);
    const text = await page.getTextContent();
    // Already has text (not a scan, or read before): nothing to do.
    if (text.items.some((item) => "str" in item && item.str.trim())) continue;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, LONGEST / Math.max(base.width, base.height)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const png = new Uint8Array(await (await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The page could not be drawn."))), "image/png"))).arrayBuffer());
    const words = await read(png);
    if (!words.length) continue;
    const target = pages[i];
    const name = target.node.newFontDictionary(font.name, font.ref);
    const ops: PDFOperator[] = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const [word, x, y, w, h] of words) {
      const clean = [...word].map((ch) => (known.has(ch.codePointAt(0)!) ? ch : "?")).join("");
      if (!clean.trim()) continue;
      // shortcut: on a turned page the words are placed in their boxes but run the page's way, not the text's.
      const [x1, y1] = viewport.convertToPdfPoint(x, y + h);
      const [x2, y2] = viewport.convertToPdfPoint(x + w, y);
      const height = Math.abs(y2 - y1);
      const size = Math.max(1, height * 0.85);
      const natural = font.widthOfTextAtSize(clean, size);
      // Stretched to the word's width, so selecting it covers the word on the page.
      const stretch = natural > 0 ? (Math.abs(x2 - x1) / natural) * 100 : 100;
      ops.push(
        setFontAndSize(name, size),
        PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(Math.round(stretch * 100) / 100)]),
        PDFOperator.of(PDFOperatorNames.SetTextMatrix, [1, 0, 0, 1, Math.min(x1, x2), Math.min(y1, y2) + height * 0.2].map((n) => PDFNumber.of(Math.round(n * 100) / 100))),
        showText(font.encodeText(`${clean} `)),
      );
    }
    ops.push(endText(), popGraphicsState());
    target.pushOperators(...ops);
    done++;
  }
  progress?.(pdf.numPages, pdf.numPages);
  return { bytes: done ? await doc.save() : bytes, pages: done };
}
