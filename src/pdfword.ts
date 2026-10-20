// Turns a PDF into a Word document (.docx). A PDF only knows where each
// piece of text sits on the page, so the document has to be worked out:
// lines from pieces on the same baseline, columns, paragraphs from evenly
// spaced lines, headings from larger or bold text, lists from their bullets
// and numbers, tables from text set in aligned columns. Pictures come along
// where they stood; headers, footers and page numbers that repeat on every
// page are left out, as Word adds its own.
//
// The same file is in DuckWriter (src/convert/pdf.ts, opening a PDF) and
// Duckument (src/pdfword.ts, Save as Word); change both together.

import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

// ---- what is read from the PDF --------------------------------------------------

/** A piece of text as pdf.js gives it, in points from the page's top left. */
export interface TextBit {
  text: string;
  x: number;
  /** The baseline. */
  base: number;
  w: number;
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  link?: string;
}

export interface PictureBit {
  png: Uint8Array;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageText {
  width: number;
  height: number;
  bits: TextBit[];
  pictures: PictureBit[];
}

// ---- what the document is made of ------------------------------------------------

export interface Run {
  text: string;
  size: number;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  sup?: boolean;
  sub?: boolean;
  link?: string;
}

export type Block =
  | { kind: "paragraph"; runs: Run[]; heading?: number; list?: "bullet" | "number"; level?: number; align?: "center" | "right" | "justify" }
  | { kind: "table"; rows: Run[][][] }
  | { kind: "picture"; png: Uint8Array; w: number; h: number };

/** The page size and margins for the Word document, in points. */
export interface PageSetup {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The whole conversion: a PDF opened with pdf.js in, the bytes of a .docx out. */
export async function pdfToDocx(pdf: PDFDocumentProxy): Promise<Uint8Array> {
  const pages = await readPages(pdf);
  return writeDocx(layout(pages), pageSetup(pages));
}

// ---- reading -------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const BOLD = /bold|black|heavy|demi|semib|cmbx|(^|[-_ ,])bd($|[-_ ,])/i;
const ITALIC = /ital|obli|slant|kursiv|cursiv|cmti|cmsl|(^|[-_ ,])it($|[-_ ,\d])/i;

// pdf.js's operator numbers (OPS) for the drawing commands that matter here.
const OP_SAVE = 10;
const OP_RESTORE = 11;
const OP_TRANSFORM = 12;
const OP_IMAGE = 85;
const OP_INLINE_IMAGE = 86;

export async function readPages(pdf: PDFDocumentProxy): Promise<PageText[]> {
  const pages: PageText[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const flip = viewport.transform as Matrix;
    // The operator list loads the fonts (for their names) and finds the pictures.
    const [content, ops, annotations] = await Promise.all([page.getTextContent(), page.getOperatorList(), page.getAnnotations()]);
    const links = annotations
      .filter((a) => a.subtype === "Link" && typeof a.url === "string")
      .map((a) => {
        const [x1, y1] = apply(flip, a.rect[0], a.rect[1]);
        const [x2, y2] = apply(flip, a.rect[2], a.rect[3]);
        return { url: a.url as string, left: Math.min(x1, x2), right: Math.max(x1, x2), top: Math.min(y1, y2), bottom: Math.max(y1, y2) };
      });

    const fonts = new Map<string, { font: string; bold: boolean; italic: boolean }>();
    const fontOf = (id: string) => {
      let info = fonts.get(id);
      if (!info) {
        let name = "";
        let bold = false;
        let italic = false;
        try {
          if (page.commonObjs.has(id)) {
            const font = page.commonObjs.get(id) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean };
            name = font.name ?? "";
            bold = !!font.bold || !!font.black;
            italic = !!font.italic;
          }
        } catch {
          // A font pdf.js could not load: plain text, then.
        }
        info = { font: familyName(name), bold: bold || BOLD.test(name), italic: italic || ITALIC.test(name) };
        fonts.set(id, info);
      }
      return info;
    };

    const bits: TextBit[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const m = multiply(flip, item.transform as Matrix);
      const size = Math.hypot(m[2], m[3]);
      if (size < 1) continue;
      const bit: TextBit = { text: item.str, x: m[4], base: m[5], w: item.width, size, ...fontOf(item.fontName) };
      const cx = bit.x + bit.w / 2;
      const cy = bit.base - size / 3;
      const link = links.find((l) => cx >= l.left && cx <= l.right && cy >= l.top - 1 && cy <= l.bottom + 1);
      if (link) bit.link = link.url;
      bits.push(bit);
    }

    pages.push({ width: viewport.width, height: viewport.height, bits, pictures: await readPictures(page, ops, flip) });
    page.cleanup();
  }
  return pages;
}

/** Strips a font's subset prefix and style, and spaces its name out: ABCDEF+TimesNewRomanPS-BoldMT → Times New Roman. */
export function familyName(name: string): string {
  let family = name.replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0];
  family = family.replace(/(PSMT|PS|MT)$/, "").replace(/(Bold|Italic|Oblique|Regular|Roman)+$/i, (m) => (/^roman$/i.test(m) && /times/i.test(family) ? m : ""));
  const known: Record<string, string> = { Helvetica: "Arial", Times: "Times New Roman", TimesRoman: "Times New Roman", Courier: "Courier New", Symbol: "Symbol" };
  if (known[family]) return known[family];
  // Names a program made up (F1, T1_0, TT2) don't help Word.
  if (!/^[A-Za-z][A-Za-z]{2,}/.test(family) || /^(F|T|TT|C)\d/i.test(family)) return "";
  return family.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim();
}

async function readPictures(page: PDFPageProxy, ops: { fnArray: number[]; argsArray: unknown[][] }, flip: Matrix): Promise<PictureBit[]> {
  if (typeof document === "undefined" && typeof OffscreenCanvas === "undefined") return [];
  const found: PictureBit[] = [];
  const stack: Matrix[] = [];
  let ctm = flip;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OP_SAVE) stack.push(ctm);
    else if (fn === OP_RESTORE) ctm = stack.pop() ?? flip;
    else if (fn === OP_TRANSFORM) ctm = multiply(ctm, args as unknown as Matrix);
    else if (fn === OP_IMAGE || fn === OP_INLINE_IMAGE) {
      const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      // Specks and lines drawn as pictures aren't pictures.
      if (box.w < 8 || box.h < 8) continue;
      try {
        const image = fn === OP_INLINE_IMAGE ? args[0] : await pictureObject(page, args[0] as string);
        const png = await toPng(image as PdfImage);
        if (png) found.push({ png, ...box });
      } catch (error) {
        console.warn("A picture in the PDF could not be read", error);
      }
    }
  }
  return found;
}

function pictureObject(page: PDFPageProxy, id: string): Promise<unknown> {
  const objs = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => objs.get(id, resolve));
}

interface PdfImage {
  width: number;
  height: number;
  bitmap?: ImageBitmap;
  data?: Uint8ClampedArray | Uint8Array;
  /** 1: one bit grey, 2: RGB, 3: RGBA. */
  kind?: number;
}

async function toPng(image: PdfImage | null): Promise<Uint8Array | null> {
  if (!image?.width || !image.height) return null;
  const { width, height } = image;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  if (image.bitmap) ctx.drawImage(image.bitmap, 0, 0);
  else if (image.data) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const src = image.data;
    if (image.kind === 3) rgba.set(src.subarray(0, rgba.length));
    else if (image.kind === 2) for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) [rgba[j], rgba[j + 1], rgba[j + 2], rgba[j + 3]] = [src[i], src[i + 1], src[i + 2], 255];
    else {
      const rowBytes = (width + 7) >> 3;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const on = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          rgba.fill(on ? 255 : 0, (y * width + x) * 4, (y * width + x) * 4 + 3);
          rgba[(y * width + x) * 4 + 3] = 255;
        }
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else return null;
  const blob = "convertToBlob" in canvas ? await canvas.convertToBlob({ type: "image/png" }) : await new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// ---- working out the document ------------------------------------------------------

/** Text on one line, with no wide gap in it. */
interface Segment {
  bits: TextBit[];
  x: number;
  right: number;
  base: number;
  /** The size most of its text is set in. */
  size: number;
}

interface Line {
  segs: Segment[];
  x: number;
  right: number;
  base: number;
  size: number;
  page: number;
}

type Flow = { kind: "line"; line: Line; key: number[] } | { kind: "picture"; picture: PictureBit; key: number[] };

const text = (seg: Segment) => seg.bits.map((b) => b.text).join(" ");
const mainSize = (bits: TextBit[]) => {
  const weight = new Map<number, number>();
  for (const b of bits) weight.set(Math.round(b.size * 2) / 2, (weight.get(Math.round(b.size * 2) / 2) ?? 0) + b.text.length);
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
};

/** The pieces of a page in lines, top to bottom, each split where there's a wide gap. */
export function linesOf(bits: TextBit[], page: number): Line[] {
  const sorted = [...bits].sort((a, b) => a.base - b.base || a.x - b.x);
  const rows: TextBit[][] = [];
  for (const bit of sorted) {
    const row = rows[rows.length - 1];
    // Superscripts sit a little higher, but on the same line.
    if (row && Math.abs(bit.base - row[0].base) < 0.5 * Math.max(bit.size, row[0].size)) row.push(bit);
    else rows.push([bit]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    const segs: Segment[] = [];
    for (const bit of row) {
      const seg = segs[segs.length - 1];
      if (seg && bit.x - seg.right < 1.8 * Math.max(bit.size, seg.size)) {
        seg.bits.push(bit);
        seg.right = Math.max(seg.right, bit.x + bit.w);
      } else segs.push({ bits: [bit], x: bit.x, right: bit.x + bit.w, base: bit.base, size: bit.size });
    }
    for (const seg of segs) {
      seg.size = mainSize(seg.bits);
      seg.base = seg.bits.find((b) => Math.abs(b.size - seg.size) < 0.3)?.base ?? seg.base;
    }
    const size = Math.max(...segs.map((s) => s.size));
    return { segs, x: segs[0].x, right: Math.max(...segs.map((s) => s.right)), base: segs[0].base, size, page };
  });
}

const zoneKey = (line: Line) => line.segs.map(text).join(" ").replace(/\d+/g, "#").trim().toLowerCase();

/** Lines at the very top or bottom that repeat on most pages (running heads, page numbers). */
function repeatedEdges(pages: PageText[], lines: Line[][]): Set<Line> {
  const inZone = (line: Line, height: number) => line.base < height * 0.09 || line.base > height * 0.92;
  const counts = new Map<string, number>();
  lines.forEach((pageLines, i) => {
    const seen = new Set(pageLines.filter((l) => inZone(l, pages[i].height)).map(zoneKey));
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const drop = new Set<Line>();
  lines.forEach((pageLines, i) => {
    for (const line of pageLines) {
      if (!inZone(line, pages[i].height)) continue;
      const key = zoneKey(line);
      const pageNumber = /^(page\s*)?#(\s*(of|\/)\s*#)?$|^[-–]\s*#\s*[-–]$/.test(key);
      if (pageNumber || (pages.length >= 2 && (counts.get(key) ?? 0) >= Math.max(2, pages.length * 0.5))) drop.add(line);
    }
  });
  return drop;
}

/** The page's lines and pictures in reading order: in two columns, the left one first. */
function readingOrder(page: PageText, lines: Line[], n: number): Flow[] {
  const half = page.width / 2;
  const segs = lines.flatMap((l) => l.segs.map((s) => ({ s, l })));
  const left = segs.filter(({ s }) => s.right < half + 4);
  const right = segs.filter(({ s }) => s.x > half - 4);
  const twoColumns = left.length >= 6 && right.length >= 6 && left.length + right.length >= segs.length * 0.8 && Math.max(...left.map(({ s }) => s.right)) < Math.min(...right.map(({ s }) => s.x));
  const flow: Flow[] = [];
  if (!twoColumns) {
    for (const line of lines) flow.push({ kind: "line", line, key: [n, 0, 0, line.base] });
  } else {
    // Text across both columns (a title, a wide table) splits the page into bands.
    const wide = lines.filter((l) => l.segs.some((s) => s.x < half - 4 && s.right > half + 4));
    const bandOf = (y: number) => wide.filter((w) => w.base < y).length;
    for (const line of wide) flow.push({ kind: "line", line, key: [n, bandOf(line.base), 0, line.base] });
    for (const line of lines) {
      if (wide.includes(line)) continue;
      // Each column's text becomes its own line.
      for (const seg of line.segs) {
        const own: Line = { ...line, segs: [seg], x: seg.x, right: seg.right, size: seg.size };
        flow.push({ kind: "line", line: own, key: [n, bandOf(line.base), seg.x < half ? 1 : 2, line.base] });
      }
    }
  }
  for (const picture of page.pictures) {
    // A picture behind the whole page is a background, unless the page is only that (a scan).
    if (picture.w * picture.h > page.width * page.height * 0.8 && lines.length) continue;
    const column = twoColumns && picture.x + picture.w < half + 4 ? 1 : twoColumns && picture.x > half - 4 ? 2 : 0;
    flow.push({ kind: "picture", picture, key: [n, 0, column, picture.y + picture.h] });
  }
  return flow.sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return 0;
  });
}

const BULLET = /^\s*([•●▪◦‣∙·○■□➢►*–-])\s+/;
const NUMBER = /^\s*(\(?(\d{1,3}|[a-z]|[ivx]{1,5})[.)])\s+/i;

function listMarker(line: Line): { kind: "bullet" | "number"; length: number } | null {
  const first = text(line.segs[0]);
  const bullet = BULLET.exec(first);
  if (bullet) return { kind: "bullet", length: bullet[0].length };
  const number = NUMBER.exec(first);
  // "a." or "i." alone in prose is unusual; numbers like 1. and a) start lists.
  if (number && (/^\(?\d/.test(number[1]) || /\)$/.test(number[1]) || /^[a-h]\.$/.test(number[1]))) return { kind: "number", length: number[0].length };
  return null;
}

/** Turns a line's text into runs, marking raised and lowered text and joining same-style pieces. */
function runsOf(seg: Segment): Run[] {
  const runs: Run[] = [];
  let previous: TextBit | null = null;
  for (const bit of seg.bits) {
    const small = bit.size < seg.size * 0.85;
    const sup = small && bit.base < seg.base - seg.size * 0.15;
    const sub = small && bit.base > seg.base + seg.size * 0.08;
    let str = bit.text;
    // A gap wider than a thin space between pieces is a space.
    if (previous && bit.x - (previous.x + previous.w) > 0.18 * seg.size && !/\s$/.test(previous.text) && !/^\s/.test(str)) str = ` ${str}`;
    const run: Run = { text: str, size: sup || sub ? seg.size : Math.round(bit.size * 2) / 2, ...(bit.font ? { font: bit.font } : {}), ...(bit.bold ? { bold: true } : {}), ...(bit.italic ? { italic: true } : {}), ...(sup ? { sup: true } : {}), ...(sub ? { sub: true } : {}), ...(bit.link ? { link: bit.link } : {}) };
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, run)) last.text += run.text;
    else runs.push(run);
    previous = bit;
  }
  return runs;
}

const sameStyle = (a: Run, b: Run) => a.size === b.size && a.font === b.font && !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.sup === !!b.sup && !!a.sub === !!b.sub && a.link === b.link;

interface Draft {
  lines: Line[];
  runs: Run[];
  list?: "bullet" | "number";
  /** Where a list item's text starts, which its following lines line up with. */
  textX: number;
  markerX: number;
  bold: boolean;
}

const allBold = (line: Line) => line.segs.every((s) => s.bits.every((b) => b.bold));
const endsSentence = (s: string) => /[.!?:;)"”]\s*$/.test(s);

/** Works out the document's paragraphs, headings, lists, tables and pictures. */
export function layout(pages: PageText[]): Block[] {
  const pageLines = pages.map((p, i) => linesOf(p.bits, i));
  const drop = repeatedEdges(pages, pageLines);
  const flow = pages.flatMap((page, i) => readingOrder(page, pageLines[i].filter((l) => !drop.has(l)), i));

  // Column edges, for telling short (last) lines and centred lines apart.
  const edges = new Map<string, { left: number; right: number }>();
  const edgeKey = (f: Flow) => `${f.key[0]}:${f.key[2]}`;
  for (const f of flow) {
    if (f.kind !== "line") continue;
    const e = edges.get(edgeKey(f)) ?? { left: Infinity, right: -Infinity };
    edges.set(edgeKey(f), { left: Math.min(e.left, f.line.x), right: Math.max(e.right, f.line.right) });
  }

  const blocks: (Block | Draft)[] = [];
  let draft: Draft | null = null;
  let draftEdge = { left: 0, right: 0 };
  const finish = () => {
    if (draft) blocks.push(draft);
    draft = null;
  };

  for (let i = 0; i < flow.length; i++) {
    const f = flow[i];
    if (f.kind === "picture") {
      finish();
      blocks.push({ kind: "picture", png: f.picture.png, w: f.picture.w, h: f.picture.h });
      continue;
    }
    // Several lines in a row with text in aligned columns: a table.
    const table = tableAt(flow, i);
    if (table) {
      finish();
      blocks.push({ kind: "table", rows: table.rows });
      i = table.end - 1;
      continue;
    }
    const line = f.line;
    const edge = edges.get(edgeKey(f))!;
    const marker = listMarker(line);
    const joined: Line = line.segs.length > 1 ? { ...line, segs: [{ ...line.segs[0], bits: line.segs.flatMap((s) => s.bits), right: line.right }] } : line;
    if (draft && continues(draft, joined, marker, draftEdge, edge)) {
      addLine(draft, joined);
      continue;
    }
    finish();
    const seg = joined.segs[0];
    const runs = runsOf(seg);
    if (marker) {
      // The marker itself is Word's to draw.
      runs[0] = { ...runs[0], text: runs[0].text.replace(/^\s+/, "").slice(marker.length).replace(/^\s+/, "") };
      if (!runs[0].text && runs.length > 1) runs.shift();
    }
    const textBit = marker ? seg.bits.find((b, k) => k > 0 && b.x > seg.x + 2) : undefined;
    draft = { lines: [joined], runs, list: marker?.kind, markerX: joined.x, textX: textBit?.x ?? joined.x + joined.size * 1.5, bold: allBold(joined) };
    draftEdge = edge;
  }
  finish();

  return finishBlocks(blocks, edges.size ? [...edges.values()] : []);
}

function continues(d: Draft, line: Line, marker: ReturnType<typeof listMarker>, edge: { left: number; right: number }, lineEdge: { left: number; right: number }): boolean {
  if (marker) return false;
  const last = d.lines[d.lines.length - 1];
  const size = last.size;
  if (Math.abs(line.size - size) > size * 0.12) return false;
  if (allBold(line) !== d.bold) return false;
  const lastText = d.runs.map((r) => r.text).join("");
  if (line.page !== last.page || lineEdge !== edge) {
    // Over a page or column break: only a sentence that clearly carries on.
    const first = text(line.segs[0]);
    return !endsSentence(lastText) && /^[a-zæøåäöüé(]/.test(first);
  }
  const gap = line.base - last.base;
  if (gap <= 0 || gap > size * 1.75) return false;
  if (d.lines.length >= 2) {
    const usual = d.lines[1].base - d.lines[0].base;
    if (Math.abs(gap - usual) > size * 0.35) return false;
  }
  // A line that stopped well short of the edge ended its paragraph.
  if (edge.right - last.right > Math.max(size * 6, (edge.right - edge.left) * 0.2) && (endsSentence(lastText) || d.lines.length === 1)) return false;
  const left = d.list ? d.textX : d.lines.length >= 2 ? d.lines[1].x : line.x;
  if (d.list) return Math.abs(line.x - d.textX) < size * 1.2;
  if (d.lines.length === 1) return Math.abs(line.x - last.x) < size * 4 || line.x < last.x;
  return Math.abs(line.x - left) < size * 1.2;
}

function addLine(d: Draft, line: Line) {
  const runs = runsOf(line.segs[0]);
  const last = d.runs[d.runs.length - 1];
  // A word broken over two lines with a hyphen is joined again.
  if (/\p{L}-$/u.test(last.text) && /^\p{Ll}/u.test(runs[0].text)) last.text = last.text.slice(0, -1);
  else if (!/\s$/.test(last.text)) runs[0] = { ...runs[0], text: ` ${runs[0].text}` };
  for (const run of runs) {
    const end = d.runs[d.runs.length - 1];
    if (sameStyle(end, run)) end.text += run.text;
    else d.runs.push(run);
  }
  d.lines.push(line);
}

/** A table starting at flow[i]: two or more lines with the same columns. */
function tableAt(flow: Flow[], i: number): { rows: Run[][][]; end: number } | null {
  const first = flow[i];
  if (first.kind !== "line" || first.line.segs.length < 2) return null;
  const starts = first.line.segs.map((s) => s.x);
  const tolerance = first.line.size * 1.5;
  const rows: Run[][][] = [];
  let j = i;
  for (; j < flow.length; j++) {
    const f = flow[j];
    if (f.kind !== "line" || f.line.page !== first.line.page || f.line.segs.length < 2) break;
    const cells: Run[][] = starts.map(() => []);
    let fits = true;
    for (const seg of f.line.segs) {
      const column = starts.findIndex((x, k) => Math.abs(seg.x - x) < tolerance || (seg.x > x && (k === starts.length - 1 || seg.right < starts[k + 1])));
      if (column < 0) {
        fits = false;
        break;
      }
      cells[column].push(...runsOf(seg));
    }
    if (!fits) break;
    rows.push(cells);
  }
  return rows.length >= 2 ? { rows, end: j } : null;
}

function finishBlocks(blocks: (Block | Draft)[], edges: { left: number; right: number }[]): Block[] {
  const drafts = blocks.filter((b): b is Draft => "lines" in b);
  // The body text's size: the one most of the text is in.
  const body = mainSize(drafts.flatMap((d) => d.lines.flatMap((l) => l.segs.flatMap((s) => s.bits))));
  const headingSizes = [...new Set(drafts.filter((d) => !d.list && isHeadingSize(d, body)).map((d) => Math.round(d.lines[0].size)))].sort((a, b) => b - a);
  const listLeft = Math.min(...drafts.filter((d) => d.list).map((d) => d.markerX));
  const columnWidth = edges.length ? Math.max(...edges.map((e) => e.right - e.left)) : 500;

  return blocks.map((b): Block => {
    if (!("lines" in b)) return b;
    const size = b.lines[0].size;
    const words = b.runs.map((r) => r.text).join("").trim();
    let heading: number | undefined;
    if (!b.list && isHeadingSize(b, body)) heading = Math.min(3, headingSizes.indexOf(Math.round(size)) + 1);
    else if (!b.list && b.bold && b.lines.length === 1 && words.length < 90 && !/[.,;]$/.test(words)) heading = Math.min(4, headingSizes.length + 1);
    const level = b.list ? Math.max(0, Math.min(8, Math.round((b.markerX - listLeft) / 18))) : undefined;
    return { kind: "paragraph", runs: b.runs, ...(heading ? { heading } : {}), ...(b.list ? { list: b.list, level } : {}), ...alignment(b, columnWidth) };
  });
}

const isHeadingSize = (d: Draft, body: number) => d.lines[0].size >= body * 1.18 && d.runs.reduce((n, r) => n + r.text.length, 0) < 250;

function alignment(d: Draft, columnWidth: number): { align?: "center" | "right" | "justify" } {
  const lefts = d.lines.map((l) => l.x);
  const rights = d.lines.map((l) => l.right);
  const centres = d.lines.map((l) => (l.x + l.right) / 2);
  const size = d.lines[0].size;
  const minLeft = Math.min(...lefts);
  // Justified: three or more lines whose right edges (all but the last) line up exactly.
  if (d.lines.length >= 3 && rights.slice(0, -1).every((r) => Math.abs(r - rights[0]) < 1.5) && new Set(lefts.slice(1).map(Math.round)).size === 1) return { align: "justify" };
  // Centred: lines of different lengths sharing a middle, set in from the left.
  const narrow = rights.every((r, i) => r - lefts[i] < columnWidth * 0.85);
  if (narrow && d.lines.length >= 2 && centres.every((c) => Math.abs(c - centres[0]) < size * 0.6) && lefts.some((l) => Math.abs(l - minLeft) > size)) return { align: "center" };
  return {};
}

/** Word's page: the PDF's first page size, and margins from where its text sits. */
export function pageSetup(pages: PageText[]): PageSetup {
  const first = pages[0] ?? { width: 595, height: 842, bits: [], pictures: [] };
  const bits = pages.flatMap((p) => p.bits);
  const clamp = (v: number) => Math.round(Math.max(36, Math.min(108, v)));
  if (!bits.length) return { width: first.width, height: first.height, left: 72, right: 72, top: 72, bottom: 72 };
  const left = Math.min(...bits.map((b) => b.x));
  const right = Math.max(...bits.map((b) => b.x + b.w));
  const top = Math.min(...bits.map((b) => b.base - b.size));
  const bottom = Math.max(...bits.map((b) => b.base));
  return { width: first.width, height: first.height, left: clamp(left), right: clamp(first.width - right), top: clamp(top), bottom: clamp(first.height - bottom) };
}

// ---- writing the .docx -----------------------------------------------------------

const twips = (pt: number) => Math.round(pt * 20);
const BULLETS = ["•", "◦", "▪"];
const NUMBER_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];

function children(runs: Run[]): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  const textRun = (r: Run, link = false) =>
    new TextRun({
      text: r.text,
      size: Math.round(r.size * 2),
      ...(r.font ? { font: r.font } : {}),
      ...(r.bold ? { bold: true } : {}),
      ...(r.italic ? { italics: true } : {}),
      ...(r.sup ? { superScript: true } : {}),
      ...(r.sub ? { subScript: true } : {}),
      ...(link ? { style: "Hyperlink" } : {}),
    });
  for (let i = 0; i < runs.length; i++) {
    const link = runs[i].link;
    if (!link) {
      out.push(textRun(runs[i]));
      continue;
    }
    const linked: TextRun[] = [];
    while (i < runs.length && runs[i].link === link) linked.push(textRun(runs[i++], true));
    i--;
    out.push(new ExternalHyperlink({ link, children: linked }));
  }
  return out;
}

export async function writeDocx(blocks: Block[], page: PageSetup): Promise<Uint8Array> {
  const textWidth = page.width - page.left - page.right;
  let instance = 0;
  let inList = false;
  const body = blocks.map((b) => {
    if (b.kind !== "paragraph" || !b.list) inList = false;
    if (b.kind === "picture") {
      // Word measures pictures in pixels at 96 to the inch; no wider than the text.
      const scale = Math.min(1, textWidth / b.w);
      return new Paragraph({ children: [new ImageRun({ type: "png", data: b.png, transformation: { width: Math.round(b.w * scale * (96 / 72)), height: Math.round(b.h * scale * (96 / 72)) } })] });
    }
    if (b.kind === "table") {
      const columns = Math.max(...b.rows.map((r) => r.length));
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map(
          (cells) =>
            new TableRow({
              children: Array.from({ length: columns }, (_, k) => new TableCell({ children: [new Paragraph({ children: children(cells[k] ?? []) })] })),
            }),
        ),
      });
    }
    // Each list gets its own numbering, so a new list starts at 1 again.
    if (b.list && !inList) instance++;
    inList = !!b.list;
    return new Paragraph({
      children: children(b.runs),
      ...(b.heading ? { heading: HEADINGS[b.heading - 1] } : {}),
      ...(b.list ? { numbering: { reference: b.list === "bullet" ? "bullets" : "numbers", level: b.level ?? 0, instance } } : {}),
      ...(b.align ? { alignment: b.align === "center" ? AlignmentType.CENTER : b.align === "right" ? AlignmentType.RIGHT : AlignmentType.JUSTIFIED } : {}),
      spacing: { after: b.list ? 40 : 120 },
    });
  });

  const levels = (kind: "bullet" | "number") =>
    Array.from({ length: 9 }, (_, level) => ({
      level,
      format: kind === "bullet" ? LevelFormat.BULLET : NUMBER_FORMATS[level % 3],
      text: kind === "bullet" ? BULLETS[level % 3] : `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: twips(18 * (level + 1)), hanging: twips(18) } } },
    }));

  const doc = new Document({
    numbering: { config: [{ reference: "bullets", levels: levels("bullet") }, { reference: "numbers", levels: levels("number") }] },
    sections: [
      {
        properties: { page: { size: { width: twips(page.width), height: twips(page.height) }, margin: { left: twips(page.left), right: twips(page.right), top: twips(page.top), bottom: twips(page.bottom) } } },
        children: body.length ? body : [new Paragraph({})],
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
