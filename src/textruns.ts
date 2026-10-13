// Turns the text pdf.js finds on a page into "runs": stretches of text on one
// line in one font, which is the unit the Edit text tool replaces.

import type { FontClass } from "./fonts";
import type { Box } from "./model";

/** A run's box is the area that has to be painted over to hide it. */
export interface TextRun extends Box {
  text: string;
  /** Where its baseline starts, in page points as displayed. */
  baseX: number;
  baseline: number;
  size: number;
  /** pdf.js's internal name for the font, for looking up the real one. */
  fontName: string;
  fontClass: FontClass;
}

interface TextChunk {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

interface FontStyle {
  fontFamily?: string;
  ascent?: number;
  descent?: number;
}

function multiply(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * @param items `items` of pdf.js's `getTextContent()`
 * @param styles its `styles`
 * @param viewTransform the page's `viewport.transform` at scale 1
 */
export function buildRuns(items: unknown[], styles: Record<string, FontStyle>, viewTransform: number[]): TextRun[] {
  const runs: TextRun[] = [];
  let current: (TextRun & { end: number }) | null = null;

  const finish = () => {
    if (current && current.text.trim()) {
      const { end, ...run } = current;
      run.text = run.text.replace(/\s+$/, "");
      run.w = end - run.baseX + 2;
      runs.push(run);
    }
    current = null;
  };

  for (const raw of items) {
    const chunk = raw as Partial<TextChunk>;
    if (typeof chunk.str !== "string" || !chunk.transform || !chunk.fontName) continue;
    const m = multiply(viewTransform, chunk.transform);
    const size = Math.hypot(m[2], m[3]);
    // Only upright, left-to-right text can be replaced by a text box.
    const upright = m[0] > 0 && m[3] < 0 && Math.abs(m[1]) < 0.02 * m[0] && Math.abs(m[2]) < 0.02 * -m[3];
    if (!upright || size < 3) {
      finish();
      continue;
    }
    const x = m[4];
    const baseline = m[5];
    const width = chunk.width ?? 0;
    // pdf.js reports a wide gap (a tab stop, the next table column) as a
    // stretch of white space; what follows is a separate piece of text.
    if (!chunk.str.trim() && width > 0.8 * size) {
      finish();
      continue;
    }

    if (current && current.fontName === chunk.fontName && Math.abs(current.size - size) < 0.02 * size && Math.abs(current.baseline - baseline) < 0.1 * size) {
      const gap = x - current.end;
      if (gap > -0.3 * size && gap < 0.8 * size) {
        // pdf.js leaves out the spaces that are only a gap in the file.
        const needsSpace = gap > 0.15 * size && !/\s$/.test(current.text) && !/^\s/.test(chunk.str);
        current.text += (needsSpace ? " " : "") + chunk.str;
        current.end = Math.max(current.end, x + width);
        continue;
      }
    }
    finish();
    if (!chunk.str) continue;

    const style: FontStyle = styles[chunk.fontName] ?? {};
    const ascent = clamp(style.ascent || 0.9, 0.75, 0.9) + 0.03;
    const descent = clamp(Math.abs(style.descent || 0.22), 0.2, 0.3);
    const family = style.fontFamily ?? "";
    current = {
      text: chunk.str,
      baseX: x,
      baseline,
      size,
      fontName: chunk.fontName,
      fontClass: family.includes("mono") ? "mono" : family.includes("sans") ? "sans" : "serif",
      x: x - 1,
      y: baseline - ascent * size,
      w: 0,
      h: (ascent + descent) * size,
      end: x + width,
    };
  }
  finish();
  return runs;
}

export function runAt(runs: TextRun[] | null, x: number, y: number): TextRun | null {
  if (!runs) return null;
  for (const run of runs) {
    if (x >= run.x && x <= run.x + run.w && y >= run.y && y <= run.y + run.h) return run;
  }
  return null;
}
