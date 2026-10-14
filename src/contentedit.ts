// Removes text from a PDF page for real, not just by painting over it. The
// page's drawing instructions are read, the letters that fall inside the given
// areas are found, and the instructions that draw them are rewritten without
// those letters, with spacing that keeps all the other letters exactly where
// they were.
//
// Handled: text drawn directly on the page, in simple fonts (one byte per
// letter) and composite fonts with the Identity encoding (two bytes per
// letter, which is how most programs embed fonts today). Anything else in an
// area (text inside a reusable drawing, other composite fonts) makes that area
// "not removed", and the caller falls back to painting over it.

import { Encodings, Font as StandardFont, type IFontNames } from "@pdf-lib/standard-fonts";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFDocument } from "pdf-lib";

type Matrix = [number, number, number, number, number, number];
type Rect = [number, number, number, number]; // x1, y1, x2, y2 in PDF user space

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** a × b, as PDF composes matrices (apply a, then b). */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// ---- reading content streams ------------------------------------------------

type Operand = number | boolean | null | string | Uint8Array | Operand[] | { dict: true };

/** One instruction: its operands, its name, and where its bytes are in the stream. */
export interface Op {
  op: string;
  operands: Operand[];
  start: number;
  end: number;
}

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITER = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));
const isRegular = (b: number) => !WHITE.has(b) && !DELIMITER.has(b);

/** Splits a content stream into instructions. Strings come back as raw bytes. */
export function parseContent(bytes: Uint8Array): Op[] {
  const ops: Op[] = [];
  let pos = 0;
  let operands: Operand[] = [];
  let opStart = -1;
  const stack: Operand[][] = [];

  const skipSpace = () => {
    while (pos < bytes.length) {
      const b = bytes[pos];
      if (WHITE.has(b)) pos++;
      else if (b === 37) {
        // % comment to the end of the line
        while (pos < bytes.length && bytes[pos] !== 10 && bytes[pos] !== 13) pos++;
      } else break;
    }
  };
  const push = (value: Operand, start: number) => {
    if (stack.length) stack[stack.length - 1].push(value);
    else {
      if (opStart < 0) opStart = start;
      operands.push(value);
    }
  };

  const literal = (): Uint8Array => {
    const out: number[] = [];
    let depth = 1;
    pos++; // (
    while (pos < bytes.length) {
      const b = bytes[pos++];
      if (b === 92) {
        const e = bytes[pos++];
        if (e === 110) out.push(10);
        else if (e === 114) out.push(13);
        else if (e === 116) out.push(9);
        else if (e === 98) out.push(8);
        else if (e === 102) out.push(12);
        else if (e === 13) {
          if (bytes[pos] === 10) pos++;
        } else if (e === 10) {
          // line continuation
        } else if (e >= 48 && e <= 55) {
          let n = e - 48;
          for (let k = 0; k < 2 && bytes[pos] >= 48 && bytes[pos] <= 55; k++) n = n * 8 + (bytes[pos++] - 48);
          out.push(n & 255);
        } else out.push(e);
      } else if (b === 40) {
        depth++;
        out.push(b);
      } else if (b === 41) {
        if (--depth === 0) break;
        out.push(b);
      } else out.push(b);
    }
    return Uint8Array.from(out);
  };

  const hex = (): Uint8Array => {
    pos++; // <
    let digits = "";
    while (pos < bytes.length && bytes[pos] !== 62) {
      const c = String.fromCharCode(bytes[pos++]);
      if (/[0-9a-fA-F]/.test(c)) digits += c;
    }
    pos++; // >
    if (digits.length % 2) digits += "0";
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    return out;
  };

  /** Skips a << ... >> dictionary (only seen in marked-content properties and inline images). */
  const skipDict = () => {
    let depth = 0;
    while (pos < bytes.length) {
      if (bytes[pos] === 60 && bytes[pos + 1] === 60) {
        depth++;
        pos += 2;
      } else if (bytes[pos] === 62 && bytes[pos + 1] === 62) {
        depth--;
        pos += 2;
        if (depth === 0) return;
      } else if (bytes[pos] === 40) literal();
      else pos++;
    }
  };

  while (true) {
    skipSpace();
    if (pos >= bytes.length) break;
    const start = pos;
    const b = bytes[pos];
    if (b === 40) push(literal(), start);
    else if (b === 60 && bytes[pos + 1] === 60) {
      skipDict();
      push({ dict: true }, start);
    } else if (b === 60) push(hex(), start);
    else if (b === 91) {
      if (!stack.length && opStart < 0) opStart = start;
      stack.push([]);
      pos++;
    } else if (b === 93) {
      pos++;
      const array = stack.pop() ?? [];
      push(array, start);
    } else if (b === 47) {
      pos++;
      const nameStart = pos;
      while (pos < bytes.length && isRegular(bytes[pos])) pos++;
      push(new TextDecoder("latin1").decode(bytes.subarray(nameStart, pos)), start);
    } else {
      const wordStart = pos;
      while (pos < bytes.length && isRegular(bytes[pos])) pos++;
      if (pos === wordStart) {
        pos++; // a stray delimiter
        continue;
      }
      const word = new TextDecoder("latin1").decode(bytes.subarray(wordStart, pos));
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push(Number(word), start);
      else if (word === "true" || word === "false") push(word === "true", start);
      else if (word === "null") push(null, start);
      else {
        if (word === "BI") {
          // An inline image: its data is binary, up to "EI" on its own.
          while (pos < bytes.length) {
            if (bytes[pos] === 73 && bytes[pos + 1] === 68 && WHITE.has(bytes[pos + 2]) && WHITE.has(bytes[pos - 1])) {
              pos += 3;
              break;
            }
            pos++;
          }
          while (pos < bytes.length) {
            if (WHITE.has(bytes[pos - 1]) && bytes[pos] === 69 && bytes[pos + 1] === 73 && (pos + 2 >= bytes.length || WHITE.has(bytes[pos + 2]))) {
              pos += 2;
              break;
            }
            pos++;
          }
        }
        ops.push({ op: word, operands, start: opStart < 0 ? wordStart : opStart, end: pos });
        operands = [];
        opStart = -1;
      }
    }
  }
  return ops;
}

// ---- fonts ------------------------------------------------------------------

interface FontInfo {
  twoByte: boolean;
  /** Advance of a letter code, in text space units at size 1. */
  width(code: number): number;
  /** False when the letters can't be measured reliably. */
  supported: boolean;
}

const STANDARD = new Set([
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats",
]);

let winAnsiNames: Map<number, string> | null = null;
function winAnsiName(code: number): string | undefined {
  if (!winAnsiNames) {
    winAnsiNames = new Map();
    for (const point of Encodings.WinAnsi.supportedCodePoints) {
      const { code: c, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(point);
      winAnsiNames.set(c, name);
    }
  }
  return winAnsiNames.get(code);
}

const num = (value: unknown, fallback = 0) => (value instanceof PDFNumber ? value.asNumber() : fallback);

function fontInfo(font: PDFDict): FontInfo {
  const subtype = font.lookup(PDFName.of("Subtype"));
  const unsupported: FontInfo = { twoByte: false, width: () => 0, supported: false };

  if (subtype === PDFName.of("Type0")) {
    const encoding = font.lookup(PDFName.of("Encoding"));
    if (encoding !== PDFName.of("Identity-H")) return { ...unsupported, twoByte: true };
    const descendants = font.lookup(PDFName.of("DescendantFonts"), PDFArray);
    const cid = descendants.lookup(0, PDFDict);
    const defaultWidth = num(cid.lookup(PDFName.of("DW")), 1000);
    const widths = new Map<number, number>();
    const w = cid.lookup(PDFName.of("W"));
    if (w instanceof PDFArray) {
      const list = w.asArray().map((item) => cid.context.lookup(item));
      for (let i = 0; i < list.length; ) {
        const first = num(list[i]);
        const next = list[i + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((value, k) => widths.set(first + k, num(cid.context.lookup(value))));
          i += 2;
        } else {
          const last = num(next);
          const width = num(list[i + 2]);
          for (let c = first; c <= last; c++) widths.set(c, width);
          i += 3;
        }
      }
    }
    return { twoByte: true, width: (code) => (widths.get(code) ?? defaultWidth) / 1000, supported: true };
  }

  // Simple fonts: one byte per letter.
  const scale = subtype === PDFName.of("Type3") ? num(font.lookup(PDFName.of("FontMatrix"), PDFArray).lookup(0)) : 0.001;
  const widths = font.lookup(PDFName.of("Widths"));
  if (widths instanceof PDFArray) {
    const first = num(font.lookup(PDFName.of("FirstChar")));
    const descriptor = font.lookup(PDFName.of("FontDescriptor"));
    const missing = descriptor instanceof PDFDict ? num(descriptor.lookup(PDFName.of("MissingWidth"))) : 0;
    const values = widths.asArray().map((value) => num(font.context.lookup(value)));
    return {
      twoByte: false,
      width: (code) => (values[code - first] ?? missing) * scale,
      supported: true,
    };
  }
  // The 14 standard fonts may leave their widths out.
  const base = font.lookup(PDFName.of("BaseFont"));
  const name = base instanceof PDFName ? base.decodeText() : "";
  if (!STANDARD.has(name)) return unsupported;
  const metrics = StandardFont.load(name as IFontNames);
  const differences = new Map<number, string>();
  const encoding = font.lookup(PDFName.of("Encoding"));
  if (encoding instanceof PDFDict) {
    const list = encoding.lookup(PDFName.of("Differences"));
    if (list instanceof PDFArray) {
      let code = 0;
      for (const item of list.asArray()) {
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) differences.set(code++, item.decodeText());
      }
    }
  }
  return {
    twoByte: false,
    width: (code) => {
      const glyph = differences.get(code) ?? winAnsiName(code);
      return glyph ? ((metrics.getWidthOfGlyph(glyph) as number | undefined) ?? 0) / 1000 : 0;
    },
    supported: true,
  };
}

// ---- following the text through the page --------------------------------------

interface Glyph {
  bytes: Uint8Array;
  /** Distance the letter moves the pen, in text space (character and word spacing included). */
  advance: number;
  /** Middle of the letter on the page, in user space. */
  centre: [number, number];
}

interface TextShow {
  op: Op;
  /** The operand items in order: letters, and TJ's own spacing numbers. */
  parts: (Glyph | number)[];
  fontSize: number;
  scaleX: number;
  supported: boolean;
}

interface TextState {
  ctm: Matrix;
  font: FontInfo | null;
  fontSize: number;
  charSpace: number;
  wordSpace: number;
  scaleX: number;
  leading: number;
  rise: number;
}

/** Collects every text-drawing instruction in a stream, with where each of its letters is. */
function traceText(ops: Op[], resources: PDFDict | undefined, ctm: Matrix, forms: (form: PDFStream, ctm: Matrix) => void): TextShow[] {
  const shows: TextShow[] = [];
  const fonts = resources?.lookup(PDFName.of("Font"));
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  const fontCache = new Map<string, FontInfo | null>();
  const loadFont = (name: string): FontInfo | null => {
    if (!fontCache.has(name)) {
      let info: FontInfo | null = null;
      try {
        const dict = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(name)) : undefined;
        if (dict instanceof PDFDict) info = fontInfo(dict);
      } catch {
        info = null;
      }
      fontCache.set(name, info);
    }
    return fontCache.get(name)!;
  };

  let state: TextState = { ctm, font: null, fontSize: 0, charSpace: 0, wordSpace: 0, scaleX: 1, leading: 0, rise: 0 };
  const saved: TextState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const n = (v: Operand | undefined) => (typeof v === "number" ? v : 0);

  const show = (op: Op, items: Operand[]) => {
    const font = state.font;
    const parts: (Glyph | number)[] = [];
    const supported = !!font && font.supported;
    for (const item of items) {
      if (typeof item === "number") {
        // Moves the pen back by item/1000 of the font size.
        tm = multiply([1, 0, 0, 1, (-item / 1000) * state.fontSize * state.scaleX, 0], tm);
        parts.push(item);
        continue;
      }
      if (!(item instanceof Uint8Array)) continue;
      const step = font?.twoByte ? 2 : 1;
      for (let i = 0; i + step <= item.length; i += step) {
        const code = step === 2 ? (item[i] << 8) | item[i + 1] : item[i];
        const width = font ? font.width(code) : 0;
        const space = step === 1 && code === 32 ? state.wordSpace : 0;
        const advance = (width * state.fontSize + state.charSpace + space) * state.scaleX;
        const trm = multiply(tm, state.ctm);
        const centre = apply(trm, (width * state.fontSize * state.scaleX) / 2, state.rise + state.fontSize * 0.35);
        parts.push({ bytes: item.subarray(i, i + step), advance, centre });
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
      }
    }
    shows.push({ op, parts, fontSize: state.fontSize, scaleX: state.scaleX, supported });
  };

  for (const op of ops) {
    const a = op.operands;
    switch (op.op) {
      case "q":
        saved.push({ ...state });
        break;
      case "Q":
        state = saved.pop() ?? state;
        break;
      case "cm":
        state.ctm = multiply(a.map(n) as Matrix, state.ctm);
        break;
      case "BT":
        tm = tlm = IDENTITY;
        break;
      case "Tf":
        state.font = loadFont(String(a[0]));
        state.fontSize = n(a[1]);
        break;
      case "Tc":
        state.charSpace = n(a[0]);
        break;
      case "Tw":
        state.wordSpace = n(a[0]);
        break;
      case "Tz":
        state.scaleX = n(a[0]) / 100;
        break;
      case "TL":
        state.leading = n(a[0]);
        break;
      case "Ts":
        state.rise = n(a[0]);
        break;
      case "Tm":
        tm = tlm = a.map(n) as Matrix;
        break;
      case "Td":
        tm = tlm = multiply([1, 0, 0, 1, n(a[0]), n(a[1])], tlm);
        break;
      case "TD":
        state.leading = -n(a[1]);
        tm = tlm = multiply([1, 0, 0, 1, n(a[0]), n(a[1])], tlm);
        break;
      case "T*":
        tm = tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
        break;
      case "Tj":
        show(op, [a[0]]);
        break;
      case "TJ":
        show(op, Array.isArray(a[0]) ? a[0] : []);
        break;
      case "'":
        tm = tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
        show(op, [a[0]]);
        break;
      case '"':
        state.wordSpace = n(a[0]);
        state.charSpace = n(a[1]);
        tm = tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
        show(op, [a[2]]);
        break;
      case "Do": {
        const xobject = xobjects instanceof PDFDict ? xobjects.lookup(PDFName.of(String(a[0]))) : undefined;
        if (xobject instanceof PDFStream && xobject.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Form")) {
          const matrix = xobject.dict.lookup(PDFName.of("Matrix"));
          const m = matrix instanceof PDFArray ? (matrix.asArray().map((v) => num(v)) as Matrix) : IDENTITY;
          forms(xobject, multiply(m, state.ctm));
        }
        break;
      }
    }
  }
  return shows;
}

// ---- rewriting ----------------------------------------------------------------

const hexOf = (bytes: number[]) => "<" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("") + ">";
const fmt = (value: number) => String(Math.round(value * 10000) / 10000);

/** The instruction rewritten without the removed letters, as a TJ with spacing in their place. */
function rewrite(show: TextShow, removed: Set<Glyph>): string {
  const out: string[] = [];
  let kept: number[] = [];
  let gap = 0;
  const flushKept = () => {
    if (kept.length) out.push(hexOf(kept));
    kept = [];
  };
  const flushGap = () => {
    if (gap) out.push(fmt((-gap * 1000) / (show.fontSize * show.scaleX)));
    gap = 0;
  };
  for (const part of show.parts) {
    if (typeof part === "number") {
      flushKept();
      flushGap();
      out.push(fmt(part));
    } else if (removed.has(part)) {
      flushKept();
      gap += part.advance;
    } else {
      flushGap();
      kept.push(...part.bytes);
    }
  }
  flushKept();
  flushGap();
  const array = `[${out.join(" ")}] TJ`;
  const a = show.op.operands;
  if (show.op.op === "'") return `T* ${array}`;
  if (show.op.op === '"') return `${fmt(a[0] as number)} Tw ${fmt(a[1] as number)} Tc T* ${array}`;
  return array;
}

const inside = (rect: Rect, [x, y]: [number, number]) => x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];

/**
 * Removes the text inside `rects` (PDF user space) from a page. Returns, for
 * each rect, whether its text was removed (true) or couldn't be (false); a
 * rect with no text in it counts as removed.
 */
export function removeTextFromPage(doc: PDFDocument, page: PDFPage, rects: Rect[]): boolean[] {
  const result = rects.map(() => true);
  const found = rects.map(() => 0);
  if (!rects.length) return result;

  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (const ref of contents.asArray()) {
      const stream = doc.context.lookup(ref);
      if (stream instanceof PDFRawStream) streams.push(stream);
    }
  } else if (contents instanceof PDFRawStream) streams.push(contents);
  else if (contents) return rects.map(() => false);

  // The page's instructions as one stream, the way readers run them.
  const parts = streams.map((stream) => decodePDFRawStream(stream).decode());
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    bytes[offset + part.length] = 10;
    offset += part.length + 1;
  }

  const resources = page.node.Resources();
  const ops = parseContent(bytes);
  const shows = traceText(ops, resources, IDENTITY, (form, ctm) => {
    // Text inside a reusable drawing can't be changed here without changing it
    // everywhere it is used; if any of it is in an area, that area falls back.
    if (!(form instanceof PDFRawStream)) return;
    try {
      const formOps = parseContent(decodePDFRawStream(form).decode());
      const formResources = form.dict.lookup(PDFName.of("Resources"));
      for (const show of traceText(formOps, formResources instanceof PDFDict ? formResources : resources, ctm, () => {})) {
        for (const part of show.parts) {
          if (typeof part === "number") continue;
          rects.forEach((rect, i) => {
            if (inside(rect, part.centre)) result[i] = false;
          });
        }
      }
    } catch {
      // Unreadable drawing: nothing known to be in the way.
    }
  });

  const edits: { start: number; end: number; text: string }[] = [];
  for (const show of shows) {
    const removed = new Set<Glyph>();
    for (const part of show.parts) {
      if (typeof part === "number") continue;
      rects.forEach((rect, i) => {
        if (!inside(rect, part.centre)) return;
        found[i]++;
        if (show.supported && show.fontSize && show.scaleX) removed.add(part);
        else result[i] = false;
      });
    }
    if (removed.size) edits.push({ start: show.op.start, end: show.op.end, text: rewrite(show, removed) });
  }
  if (!edits.length) return result;

  // Splice the rewritten instructions in; everything else stays byte for byte.
  const chunks: Uint8Array[] = [];
  let at = 0;
  const encoder = new TextEncoder();
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    chunks.push(bytes.subarray(at, edit.start), encoder.encode(edit.text));
    at = edit.end;
  }
  chunks.push(bytes.subarray(at));
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let o = 0;
  for (const chunk of chunks) {
    out.set(chunk, o);
    o += chunk.length;
  }
  const stream = doc.context.flateStream(out);
  page.node.set(PDFName.of("Contents"), doc.context.register(stream) as PDFRef);
  return result;
}
