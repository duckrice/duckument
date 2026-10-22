// Writes the user's additions into the PDF's page content.

import fontkit from "@pdf-lib/fontkit";
import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFOperator,
  PDFName,
  PDFPage,
  StandardFonts,
  appendBezierCurve,
  beginText,
  closePath,
  concatTransformationMatrix,
  degrees,
  drawObject,
  endText,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingColor,
  setFontAndSize,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingColor,
  setTextMatrix,
  showText,
  stroke,
  setGraphicsState,
  beginMarkedContent,
  endMarkedContent,
  PDFHexString,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { fontDef, fontFile, type FontClass } from "./fonts";
import { LINE_HEIGHT, NOTE_SIZE, isMarkup, type ImageItem, type Item, type MarkupItem, type NoteItem, type PageRef, type TextItem } from "./model";
import { removeTextFromPage } from "./contentedit";
import { MARK, NOTE_FLAG, attach, type SavedPage } from "./editdata";
import { layoutText } from "./paragraphs";
import { markBars, paints, type Paint } from "./shapes";

export type Matrix = [number, number, number, number, number, number];

export interface ExportEnv {
  /**
   * For a page index, the matrix that maps PDF user space to the displayed
   * page at scale 1 (pdf.js `viewport.transform`).
   */
  pageTransform(page: number): Matrix | Promise<Matrix>;
  /** Distance from the top of a text item to the baseline of its first line. */
  baseline(item: TextItem): number;
  /** Renders text the font can't encode (emoji, some scripts) as a picture. */
  rasterizeText?(item: TextItem): Promise<ImageItem | null>;
  /** Reads a font file from the system's Fonts folder; null if it isn't there. */
  loadFont?(file: string): Promise<Uint8Array | null>;
  /**
   * Width of text in points as the screen measures it, so paragraphs wrap the
   * same way in the file. Without it, the embedded font's widths are used.
   */
  measure?(item: TextItem, text: string): number;
  /** Told how many edited pieces of text could only be painted over, not removed. */
  onCoverOnly?(count: number): void;
  /**
   * Encrypts the edits to store in the file (see editdata.ts), given what the
   * pages were like; without it the edits are only drawn.
   */
  seal?(pages: Omit<SavedPage, "extra">[]): Promise<{ blob: Uint8Array; keyId: string }>;
}

export class EncryptedPdfError extends Error {
  constructor() {
    super("This PDF is password-protected, so added content can't be saved into it yet.");
  }
}

const STANDARD: Record<FontClass, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  // regular, bold, italic, bold italic
  sans: [
    StandardFonts.Helvetica,
    StandardFonts.HelveticaBold,
    StandardFonts.HelveticaOblique,
    StandardFonts.HelveticaBoldOblique,
  ],
  serif: [
    StandardFonts.TimesRoman,
    StandardFonts.TimesRomanBold,
    StandardFonts.TimesRomanItalic,
    StandardFonts.TimesRomanBoldItalic,
  ],
  mono: [
    StandardFonts.Courier,
    StandardFonts.CourierBold,
    StandardFonts.CourierOblique,
    StandardFonts.CourierBoldOblique,
  ],
};

function color(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function apply([a, b, c, d, e, f]: Matrix, x: number, y: number): [number, number] {
  return [a * x + c * y + e, b * x + d * y + f];
}

/** A date as PDFs write it: D:YYYYMMDDHHmmSS. */
function pdfDate(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `D:${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function paintOps(p: Paint): PDFOperator[] {
  if (!p.cmds.length || (!p.stroke && !p.fill)) return [];
  const ops: PDFOperator[] = [pushGraphicsState()];
  if (p.fill) ops.push(setFillingColor(color(p.fill)));
  if (p.stroke) {
    ops.push(
      setStrokingColor(color(p.stroke)),
      setLineWidth(p.width),
      setLineCap(p.round ? LineCapStyle.Round : LineCapStyle.Butt),
      setLineJoin(p.round ? LineJoinStyle.Round : LineJoinStyle.Miter),
    );
  }
  for (const c of p.cmds) {
    if (c[0] === "M") ops.push(moveTo(c[1], c[2]));
    else if (c[0] === "L") ops.push(lineTo(c[1], c[2]));
    else if (c[0] === "C") ops.push(appendBezierCurve(c[1], c[2], c[3], c[4], c[5], c[6]));
    else ops.push(closePath());
  }
  ops.push(p.fill && p.stroke ? fillAndStroke() : p.fill ? fill() : stroke());
  ops.push(popGraphicsState());
  return ops;
}

class Writer {
  private fonts = new Map<StandardFonts, PDFFont>();
  /** Embedded system fonts by file name; null for files that couldn't be used. */
  private systemFonts = new Map<string, PDFFont | null>();
  private images = new Map<string, PDFImage>();
  /** A graphics state that blends colour into the page like a highlighter. */
  private multiply: PDFRef | null = null;
  private charsets = new Map<PDFFont, Set<number>>();

  constructor(
    private doc: PDFDocument,
    private env: ExportEnv,
  ) {}

  private async systemFont(file: string): Promise<PDFFont | null> {
    let font = this.systemFonts.get(file);
    if (font === undefined) {
      font = null;
      try {
        const bytes = await this.env.loadFont!(file);
        if (bytes) {
          if (!this.systemFonts.size) this.doc.registerFontkit(fontkit);
          // Only the characters actually used are embedded. Ligatures are off
          // to match the screen, where they are off too (see styles.css).
          font = await this.doc.embedFont(bytes, { subset: true, features: { liga: false, clig: false } });
        }
      } catch (error) {
        console.warn(`Could not embed ${file}`, error);
      }
      this.systemFonts.set(file, font);
    }
    return font;
  }

  private async font(item: TextItem): Promise<PDFFont> {
    const def = fontDef(item.font);
    const file = fontFile(def, item.bold, item.italic);
    if (file && this.env.loadFont) {
      const font = await this.systemFont(file);
      if (font) return font;
    }
    const name = STANDARD[def.fallback][(item.bold ? 1 : 0) + (item.italic ? 2 : 0)];
    let font = this.fonts.get(name);
    if (!font) {
      font = await this.doc.embedFont(name);
      this.fonts.set(name, font);
    }
    return font;
  }

  private async image(src: string): Promise<PDFImage> {
    let image = this.images.get(src);
    if (!image) {
      const bytes = dataUrlBytes(src);
      image = src.startsWith("data:image/jpeg") ? await this.doc.embedJpg(bytes) : await this.doc.embedPng(bytes);
      this.images.set(src, image);
    }
    return image;
  }

  private async imageOps(page: PDFPage, item: ImageItem): Promise<PDFOperator[]> {
    const name = page.node.newXObject("Img", (await this.image(item.src)).ref);
    return [
      pushGraphicsState(),
      // Images are drawn into a unit square with y up; the page space here has y down.
      concatTransformationMatrix(item.w, 0, 0, -item.h, item.x, item.y + item.h),
      drawObject(name),
      popGraphicsState(),
    ];
  }

  /** Text turned about its top-left corner and made see-through, for watermarks. */
  private turned(page: PDFPage, item: TextItem, ops: PDFOperator[]): PDFOperator[] {
    const faded = item.opacity !== undefined && item.opacity < 1;
    if (!item.angle && !faded) return ops;
    const out: PDFOperator[] = [pushGraphicsState()];
    if (faded) {
      const state = this.doc.context.register(this.doc.context.obj({ Type: "ExtGState", ca: item.opacity, CA: item.opacity }));
      out.push(setGraphicsState(page.node.newExtGState("Fade", state)));
    }
    if (item.angle) {
      // On the page as displayed (y down), counter-clockwise about (x, y).
      const t = (item.angle * Math.PI) / 180;
      const [cos, sin] = [Math.cos(t), Math.sin(t)];
      out.push(concatTransformationMatrix(cos, -sin, sin, cos, item.x - (cos * item.x + sin * item.y), item.y - (-sin * item.x + cos * item.y)));
    }
    return [...out, ...ops, popGraphicsState()];
  }

  private async textOps(page: PDFPage, item: TextItem): Promise<PDFOperator[]> {
    const font = await this.font(item);
    let known = this.charsets.get(font);
    if (!known) this.charsets.set(font, (known = new Set(font.getCharacterSet())));
    const measure = (text: string) => (this.env.measure ? this.env.measure(item, text) : font.widthOfTextAtSize(text, item.size));
    const lines = layoutText(item, measure);
    const encodable = lines.every((line) => [...line.text].every((ch) => known.has(ch.codePointAt(0)!)));
    if (!encodable) {
      const picture = await this.env.rasterizeText?.(item);
      if (picture) return this.imageOps(page, picture);
    }

    const name = page.node.newFontDictionary(font.name, font.ref);
    const first = item.y + this.env.baseline(item);
    const ops: PDFOperator[] = [
      pushGraphicsState(),
      setFillingColor(color(item.color)),
      beginText(),
      setFontAndSize(name, item.size),
    ];
    // Drop anything the font can't encode instead of failing the whole save.
    const clean = (text: string) => (encodable ? text : [...text].filter((ch) => known.has(ch.codePointAt(0)!)).join(""));
    const lineHeight = item.size * (item.lineHeight ?? LINE_HEIGHT);
    lines.forEach((line, i) => {
      const y = first + i * lineHeight;
      // A justified line places each word, spreading them to the full width.
      const pieces = line.words ?? [{ text: line.text, x: 0 }];
      for (const piece of pieces) {
        const text = clean(piece.text);
        if (!text) continue;
        ops.push(setTextMatrix(1, 0, 0, -1, item.x + line.x + piece.x, y), showText(font.encodeText(text)));
      }
    });
    ops.push(endText(), popGraphicsState());
    return ops;
  }

  /** A highlight, underline or strike-through, blended so the text under it stays readable. */
  private markupOps(page: PDFPage, item: MarkupItem): PDFOperator[] {
    this.multiply ??= this.doc.context.register(this.doc.context.obj({ Type: "ExtGState", BM: "Multiply" }));
    const name = page.node.newExtGState("Mul", this.multiply);
    const ops: PDFOperator[] = [pushGraphicsState(), setGraphicsState(name), setFillingColor(color(item.color))];
    for (const { x, y, w, h } of markBars(item)) ops.push(moveTo(x, y), lineTo(x + w, y), lineTo(x + w, y + h), lineTo(x, y + h), closePath());
    ops.push(fill(), popGraphicsState());
    return ops;
  }

  /** A sticky note becomes a standard PDF comment, which any reader can open. */
  private addNote(page: PDFPage, note: NoteItem, toPdf: Matrix) {
    const corners = [
      apply(toPdf, note.x, note.y),
      apply(toPdf, note.x + NOTE_SIZE, note.y),
      apply(toPdf, note.x, note.y + NOTE_SIZE),
      apply(toPdf, note.x + NOTE_SIZE, note.y + NOTE_SIZE),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const n = parseInt(note.color.slice(1), 16);
    const annotation = this.doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      Contents: PDFHexString.fromText(note.text),
      Name: "Comment",
      C: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255],
      // Print, don't zoom, don't rotate: the usual flags for a comment icon.
      F: 28,
      Open: false,
      M: PDFString.of(pdfDate()),
      // Lets Duckument tell its own comments from others when the file is reopened.
      [NOTE_FLAG]: true,
    });
    page.node.addAnnot(this.doc.context.register(annotation));
  }

  /**
   * @param removed ids of edited text whose original was taken out of the page
   *   for real; those need no cover.
   */
  async write(page: PDFPage, index: number, items: Item[], removed: Set<string> = new Set()) {
    const ops: PDFOperator[] = [];
    const notes: NoteItem[] = [];
    // Everything that hides original text goes down first, so one replacement's
    // cover can't paint over the new text of its neighbour.
    for (const item of items) {
      if (item.type !== "text" || !item.cover || removed.has(item.id)) continue;
      const { x, y, w, h, color: fillColor } = item.cover;
      ops.push(
        pushGraphicsState(),
        setFillingColor(color(fillColor)),
        moveTo(x, y),
        lineTo(x + w, y),
        lineTo(x + w, y + h),
        lineTo(x, y + h),
        closePath(),
        fill(),
        popGraphicsState(),
      );
    }
    for (const item of items) {
      if (item.type === "text") {
        if (item.text) ops.push(...this.turned(page, item, await this.textOps(page, item)));
      } else if (item.type === "image") ops.push(...(await this.imageOps(page, item)));
      else if (isMarkup(item)) ops.push(...this.markupOps(page, item));
      else if (item.type === "note") notes.push(item);
      else for (const p of paints(item)) ops.push(...paintOps(p));
    }
    if (!ops.length && !notes.length) return;
    const toPdf = invert(await this.env.pageTransform(index));
    // Tagged, so Duckument can take its own drawing back off when it reopens the file.
    if (ops.length) {
      page.pushOperators(beginMarkedContent(MARK), pushGraphicsState(), concatTransformationMatrix(...toPdf), ...ops, popGraphicsState(), endMarkedContent());
    }
    for (const note of notes) if (note.text.trim()) this.addNote(page, note, toPdf);
  }
}

/** Returns a copy of `pdf` with `items` drawn onto its pages. */
export async function addItemsToPdf(pdf: Uint8Array, items: Item[], env: ExportEnv): Promise<Uint8Array> {
  if (!items.length) return pdf;
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new EncryptedPdfError();

  const pages = doc.getPages();
  const writer = new Writer(doc, env);
  const byPage = new Map<number, Item[]>();
  for (const item of items) {
    if (item.page < 0 || item.page >= pages.length) continue;
    let list = byPage.get(item.page);
    if (!list) byPage.set(item.page, (list = []));
    list.push(item);
  }
  for (const [index, list] of byPage) await writer.write(pages[index], index, list);
  return doc.save();
}

/** The PDF a set of pages comes from, with its filled-in form fields already written into it. */
export type SourceBytes = Map<string, Uint8Array>;

/**
 * Builds the saved PDF: the pages as arranged (from the document's own PDF,
 * other PDFs merged in, or blank), turned as the user turned them, with the
 * items drawn on. The document's own PDF is the base, so its form fields,
 * bookmarks and properties carry over.
 *
 * @param primary id of the document's own PDF in `sources`
 */
export async function assemblePdf(sources: SourceBytes, primary: string, pages: PageRef[], items: Item[], env: ExportEnv): Promise<Uint8Array> {
  const base = sources.get(primary)!;
  const doc = await PDFDocument.load(base, { ignoreEncryption: true, updateMetadata: false });
  const originals = doc.getPages();
  const unchanged = pages.length === originals.length && pages.every((page, i) => page.source === primary && page.index === i && !page.blank);
  if (unchanged && !items.length && pages.every((page) => page.rotation === 0) && !env.seal) return base;
  if (doc.isEncrypted) throw new EncryptedPdfError();

  let finalPages: PDFPage[];
  if (unchanged) {
    finalPages = originals;
  } else {
    // Pages from other PDFs are copied in, one PDF at a time.
    const copied = new Map<string, PDFPage>();
    for (const [id, bytes] of sources) {
      if (id === primary) continue;
      const wanted = [...new Set(pages.filter((page) => page.source === id && !page.blank).map((page) => page.index))];
      if (!wanted.length) continue;
      const other = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      if (other.isEncrypted) throw new EncryptedPdfError();
      const pagesCopied = await doc.copyPages(other, wanted);
      wanted.forEach((index, i) => copied.set(`${id}:${index}`, pagesCopied[i]));
    }

    finalPages = pages.map((page) => {
      if (page.blank) {
        const blank = PDFPage.create(doc);
        blank.setSize(page.blank.width, page.blank.height);
        return blank;
      }
      return page.source === primary ? originals[page.index] : copied.get(`${page.source}:${page.index}`)!;
    });

    // Form fields that only lived on deleted pages go too.
    const kept = new Set(finalPages);
    const removed = originals.filter((page) => !kept.has(page));
    if (removed.length && doc.catalog.has(PDFName.of("AcroForm"))) {
      const removedRefs = new Set(removed.map((page) => page.ref.toString()));
      const form = doc.getForm();
      for (const field of form.getFields()) {
        const widgets = field.acroField.getWidgets();
        if (widgets.length && widgets.every((widget) => removedRefs.has(String(widget.P())))) form.removeField(field);
      }
    }

    for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
    for (const page of finalPages) doc.addPage(page);
  }

  // What each page was like before the user's turning, for restoring the edits later.
  const saved = finalPages.map((page) => ({ rotate: page.getRotation().angle, width: page.getMediaBox().width, height: page.getMediaBox().height }));
  pages.forEach((page, i) => {
    if (page.rotation) finalPages[i].setRotation(degrees((finalPages[i].getRotation().angle + page.rotation) % 360));
  });

  const writer = new Writer(doc, env);
  const byPage = new Map<number, Item[]>();
  for (const item of items) {
    if (item.page < 0 || item.page >= finalPages.length) continue;
    let list = byPage.get(item.page);
    if (!list) byPage.set(item.page, (list = []));
    list.push(item);
  }
  let coverOnly = 0;
  for (const [index, list] of byPage) {
    // Text that was edited is taken out of the page itself where possible.
    const edited = list.filter((item): item is TextItem => item.type === "text" && !!item.cover);
    const removed = new Set<string>();
    if (edited.length) {
      const toPdf = invert(await env.pageTransform(index));
      const rects = edited.map((item) => {
        const { x, y, w, h } = item.cover!;
        const corners = [apply(toPdf, x, y), apply(toPdf, x + w, y), apply(toPdf, x, y + h), apply(toPdf, x + w, y + h)];
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number];
      });
      let results: boolean[];
      try {
        results = removeTextFromPage(doc, finalPages[index], rects);
      } catch (error) {
        console.warn("Could not remove text from the page; painting over it instead", error);
        results = rects.map(() => false);
      }
      edited.forEach((item, i) => {
        if (results[i]) removed.add(item.id);
        else coverOnly++;
      });
    }
    await writer.write(finalPages[index], index, list, removed);
  }
  if (coverOnly) env.onCoverOnly?.(coverOnly);
  if (env.seal) {
    const { blob, keyId } = await env.seal(saved);
    attach(doc, blob, keyId);
  }
  return doc.save();
}
