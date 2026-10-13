// Works out which available font a piece of the document's text is set in.
// Font names inside PDFs can't be relied on (they are often abbreviated,
// made up by the program that wrote the file, or missing), so the name is
// only one clue. The others are the style recorded inside an embedded font
// and, most telling, how wide the text is: the same words set in the right
// font and style come out the same width.

import { FONTS, type FontClass, type FontDef, type FontGuess } from "./fonts";

export interface FontEvidence {
  /** The font's name in the PDF, possibly with a subset prefix; may be empty. */
  name: string;
  /** Set by pdf.js for some fonts; absence means nothing. */
  bold?: boolean;
  italic?: boolean;
  serif?: boolean;
  mono?: boolean;
  /** The embedded font file, if pdf.js kept it. */
  data?: Uint8Array | null;
}

/** The width of `text` at a size of 1 in the given font and style. */
export type Measure = (def: FontDef, bold: boolean, italic: boolean, text: string) => number;

/** A piece of text in the font being identified, with its width in the document at a font size of 1. */
export interface Sample {
  text: string;
  width: number;
}

const BOLD = /bold|black|heavy|demi|cmbx|ecbx|medi(?!um)|(^|[-_ ,])bd/i;
const ITALIC = /ital|obli|slant|kursiv|cursiv|cmti|cmsl|cmmi|ecti|ecsl|(^|[-_ ,])it($|[-_ ,\d])/i;
const SERIF_NAME = /roman|serif|times|garamond|minion|palatin|century|georgia|cambria|bookman|baskerville|caslon|didot|bodoni|^cm(r|ti|bx|sl|mi|bxti|csc)\d|^lmroman|^ec(rm|ti|bx|sl)\d|^sfrm/i;
const SANS_NAME = /sans|helvet|arial|gothic|grotesk|futura|univers|frutiger|verdana|tahoma|calibri|segoe|roboto|^cmss|^lmsans/i;
const MONO_NAME = /mono|courier|consol|typewriter|^cmtt|^lmmono/i;

/**
 * Width difference, as a share of the width, below which a text set in a
 * candidate font counts as a match. Telling the styles of a known family
 * apart can be looser than picking a family out of all of them, where
 * different designs sometimes come out nearly as wide as each other.
 */
const SAME_STYLE = 0.025;
const SAME_FAMILY = 0.012;
/** With little text to go on, a family has to fit almost exactly. */
const SAME_FAMILY_FEW = 0.004;
/** How many pieces of text make a coincidental fit unlikely, and the most that are worth measuring. */
const ENOUGH_SAMPLES = 3;
const MAX_SAMPLES = 6;
/** Added for a candidate that lacks a style the evidence says the font has; larger than either limit above, so such a candidate is never accepted. */
const STYLE_PENALTY = 0.04;
/** Shorter text than this says too little about its font. */
const MIN_SAMPLE = 5;

const STYLES: [boolean, boolean][] = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];

/** Reads bold and italic from the tables of a TrueType or OpenType font file. */
export function sfntStyle(data: Uint8Array | null | undefined): { bold: boolean; italic: boolean } | null {
  if (!data || data.length < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = view.getUint32(0);
  // 0x00010000 and "true" are TrueType, "OTTO" is OpenType with PostScript outlines.
  if (kind !== 0x00010000 && kind !== 0x74727565 && kind !== 0x4f54544f) return null;

  let bold = false;
  let italic = false;
  let found = false;
  const tables = view.getUint16(4);
  for (let i = 0; i < tables; i++) {
    const entry = 12 + i * 16;
    if (entry + 16 > data.length) break;
    const tag = String.fromCharCode(data[entry], data[entry + 1], data[entry + 2], data[entry + 3]);
    const offset = view.getUint32(entry + 8);
    const has = (bytes: number) => offset + bytes <= data.length;
    if (tag === "head" && has(46)) {
      const macStyle = view.getUint16(offset + 44);
      bold ||= (macStyle & 1) !== 0;
      italic ||= (macStyle & 2) !== 0;
      found = true;
    } else if (tag === "OS/2" && has(64)) {
      const selection = view.getUint16(offset + 62);
      bold ||= view.getUint16(offset + 4) >= 600 || (selection & 32) !== 0;
      italic ||= (selection & 1) !== 0;
      found = true;
    } else if (tag === "post" && has(8)) {
      italic ||= view.getInt32(offset + 4) !== 0;
      found = true;
    }
  }
  return found ? { bold, italic } : null;
}

/**
 * @param texts text set in the font, the piece being edited first. A candidate
 *   has to fit all of them, which different designs rarely do by chance.
 * @param candidates the fonts that can be used
 */
export function identifyFont(evidence: FontEvidence, texts: Sample[], candidates: FontDef[], measure: Measure): FontGuess {
  const plain = evidence.name.replace(/^[A-Z]{6}\+/, "");
  const key = plain.toLowerCase().replace(/[^a-z0-9]/g, "");
  const inFile = sfntStyle(evidence.data);
  const bold = BOLD.test(plain) || !!evidence.bold || !!inFile?.bold;
  const italic = ITALIC.test(plain) || !!evidence.italic || !!inFile?.italic;
  const mono = !!evidence.mono || MONO_NAME.test(plain);

  // What the name, or pdf.js, says about the general shape of the letters.
  const shape: FontClass | null = mono ? "mono" : SERIF_NAME.test(plain) || evidence.serif ? "serif" : SANS_NAME.test(plain) ? "sans" : null;

  const named = candidates.find((def) => def.match.test(key));
  const samples = texts
    .map((sample) => ({ text: sample.text.trim(), width: sample.width }))
    .filter((sample) => sample.text.length >= MIN_SAMPLE && sample.width > 0)
    .slice(0, MAX_SAMPLES);
  if (samples.length) {
    const pool = named ? [named] : candidates.filter((def) => !def.nameOnly && (!shape || def.fallback === shape));
    let best: (FontGuess & { score: number }) | null = null;
    for (const def of pool) {
      for (const [b, i] of STYLES) {
        let error = 0;
        for (const sample of samples) error = Math.max(error, Math.abs(measure(def, b, i, sample.text) - sample.width) / sample.width);
        // Evidence of a style rules out candidates without it; a style nothing
        // points to has to earn its place by fitting slightly better.
        const score = error + (bold && !b ? STYLE_PENALTY : 0) + (italic && !i ? STYLE_PENALTY : 0) + (!bold && b ? 0.0005 : 0) + (!italic && i ? 0.0005 : 0);
        if (!best || score < best.score) best = { font: def.id, bold: b, italic: i, score };
      }
    }
    const limit = named ? SAME_STYLE : samples.length >= ENOUGH_SAMPLES ? SAME_FAMILY : SAME_FAMILY_FEW;
    if (best && best.score < limit) return { font: best.font, bold: best.bold, italic: best.italic };
  }

  if (named) return { font: named.id, bold, italic };
  // Nothing installed matches: settle for the right general shape.
  if (shape) return { font: shape, bold, italic };

  // No clue in the name either; take whichever standard font is nearest in width.
  let nearest = "sans";
  if (samples.length) {
    let least = Infinity;
    for (const def of FONTS.slice(0, 3)) {
      const error = Math.abs(measure(def, bold, italic, samples[0].text) - samples[0].width);
      if (error < least) {
        least = error;
        nearest = def.id;
      }
    }
  }
  return { font: nearest, bold, italic };
}
