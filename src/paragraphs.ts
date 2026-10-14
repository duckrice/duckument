// Paragraphs: finding them among a page's lines of text, and laying out
// edited paragraph text in lines again. The same layout is used on screen and
// in the saved file, so both break the lines in the same places.

import type { TextRun } from "./textruns";

export interface Paragraph {
  /** One run per line, top to bottom. */
  runs: TextRun[];
  /** Left edge of the lines (the first line may be indented further). */
  x: number;
  /** How far the first line is indented. */
  indent: number;
  /** The column width the lines are wrapped to. */
  width: number;
  /** Distance between baselines, as a multiple of the font size. */
  lineHeight: number;
  justified: boolean;
}

/**
 * Groups lines that belong together: the same font and size, evenly spaced,
 * starting at the same left edge (allowing a first-line indent).
 */
export function findParagraphs(runs: TextRun[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let lines: TextRun[] = [];

  const finish = () => {
    if (lines.length >= 2) {
      const x = Math.min(...lines.slice(1).map((r) => r.baseX));
      const rights = lines.map((r) => r.baseX + r.width);
      const right = Math.max(...rights);
      const gaps = lines.slice(1).map((r, i) => r.baseline - lines[i].baseline);
      const lineHeight = gaps.reduce((a, b) => a + b, 0) / gaps.length / lines[0].size;
      // Justified: every line but the last reaches the right edge.
      const justified = lines.length >= 3 && rights.slice(0, -1).every((r) => right - r < 1.5);
      paragraphs.push({
        runs: lines,
        x,
        indent: Math.max(0, lines[0].baseX - x),
        width: right - x + 0.5,
        lineHeight,
        justified,
      });
    }
    lines = [];
  };

  for (const run of runs) {
    const previous = lines[lines.length - 1];
    if (previous) {
      const sameStyle = run.fontName === previous.fontName && Math.abs(run.size - previous.size) < previous.size * 0.02;
      const gap = run.baseline - previous.baseline;
      const evenGap = gap > previous.size * 0.9 && gap < previous.size * 1.9;
      const established = lines.length >= 2 ? lines[1].baseline - lines[0].baseline : gap;
      const sameGap = Math.abs(gap - established) < previous.size * 0.15;
      // The second line sets the left edge; the first may be indented from it.
      const left = lines.length >= 2 ? lines[1].baseX : run.baseX;
      const aligned = Math.abs(run.baseX - left) < 1.5 && (lines.length >= 2 || (previous.baseX >= run.baseX - 1.5 && previous.baseX - run.baseX < previous.size * 4));
      if (sameStyle && evenGap && sameGap && aligned) {
        lines.push(run);
        continue;
      }
      finish();
    }
    lines = [run];
  }
  finish();
  return paragraphs;
}

/** A paragraph's lines joined into one text; a hyphen breaking a word at a line end is dropped. */
export function paragraphText(paragraph: Paragraph): string {
  return paragraph.runs.reduce((text, run, i) => {
    if (i === 0) return run.text;
    if (/[a-zæøåäöü]-$/i.test(text) && /^[a-zæøåäöü]/.test(run.text)) return text.slice(0, -1) + run.text;
    return `${text} ${run.text}`;
  }, "");
}

export interface LaidOutLine {
  text: string;
  /** Left of the line, from the item's left edge (the first line's indent). */
  x: number;
  /** For a justified line, where each word starts, from the line's left; null otherwise. */
  words: { text: string; x: number }[] | null;
}

export interface WrapStyle {
  text: string;
  width?: number;
  indent?: number;
  align?: "left" | "justify";
}

/**
 * Breaks text into lines. Without a width every "\n" is a line; with one, the
 * words wrap to it, and justified lines (all but the last of each paragraph)
 * spread their words to the full width.
 */
export function layoutText(item: WrapStyle, measure: (text: string) => number): LaidOutLine[] {
  const paragraphs = item.text.split("\n");
  if (!item.width) return paragraphs.map((text) => ({ text, x: 0, words: null }));

  const out: LaidOutLine[] = [];
  paragraphs.forEach((paragraph, p) => {
    const words = paragraph.split(/ +/).filter((word, _i, all) => word || all.length === 1);
    const lines: string[][] = [];
    let line: string[] = [];
    for (const word of words) {
      const first = out.length === 0 && lines.length === 0;
      const available = item.width! - (first && p === 0 ? item.indent ?? 0 : 0);
      const candidate = [...line, word].join(" ");
      if (line.length && measure(candidate) > available + 0.01) {
        lines.push(line);
        line = [word];
      } else line.push(word);
    }
    lines.push(line);

    lines.forEach((words, i) => {
      const indent = out.length === 0 ? item.indent ?? 0 : 0;
      const text = words.join(" ");
      const last = i === lines.length - 1;
      let placed: LaidOutLine["words"] = null;
      if (item.align === "justify" && !last && words.length > 1) {
        const widths = words.map(measure);
        const spare = item.width! - indent - widths.reduce((a, b) => a + b, 0);
        const gap = spare / (words.length - 1);
        let x = 0;
        placed = words.map((word, k) => {
          const at = { text: word, x };
          x += widths[k] + gap;
          return at;
        });
      }
      out.push({ text, x: indent, words: placed });
    });
  });
  return out;
}
