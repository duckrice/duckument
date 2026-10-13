// Finds places meant to be written in on a page that has no real form fields:
// blank space sitting on a line ("Name: ______"), empty boxes and table cells,
// and small squares meant to be ticked. It works on a picture of the page, so
// it doesn't matter whether a line was drawn, typed as underscores or scanned.

import type { Box } from "./model";

export interface Blank extends Box {
  /** `line`: space above an underline. `box`: an empty frame. `checkbox`: a small square to tick. */
  kind: "line" | "box" | "checkbox";
}

export interface PagePixels {
  /** RGBA, row by row. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

// All in PDF points.
const MIN_LINE = 6; // shortest horizontal stroke considered
const MAX_THICKNESS = 4; // thicker than this is a filled shape, not a line
const MIN_HEIGHT = 7; // blank space needed above a line to write in
const MIN_TEXT_WIDTH = 24;
const LINE_FIELD_HEIGHT = 18; // how much of the space above an underline is offered
const CHECKBOX_MIN = 5;
const CHECKBOX_MAX = 22;
const MAX_BLANKS = 500;

/** Darker than this (0..255) counts as ink. */
const INK_LUMA = 200;

/**
 * @param pixelsPerPoint resolution of `image`; results are returned in points.
 */
export function detectBlanks(image: PagePixels, pixelsPerPoint: number): Blank[] {
  const { data, width: W, height: H } = image;
  const s = pixelsPerPoint;
  const ink = new Uint8Array(W * H);
  // For every pixel, how many blank pixels lie directly above it and including it.
  const clearAbove = new Uint16Array(W * H);
  for (let y = 0, i = 0, p = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++, p += 4) {
      const luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      if (luma < INK_LUMA && data[p + 3] > 128) ink[i] = 1;
      else clearAbove[i] = y > 0 ? Math.min(65535, clearAbove[i - W] + 1) : 1;
    }
  }

  const minRun = Math.round(MIN_LINE * s);
  const minHeight = Math.round(MIN_HEIGHT * s);
  const maxThickness = Math.round(MAX_THICKNESS * s);
  const blanks: Blank[] = [];

  /** Share of ink in column `x` between rows `top` (inclusive) and `bottom` (exclusive). */
  const columnInk = (x: number, top: number, bottom: number) => {
    if (x < 0 || x >= W || bottom <= top) return 0;
    let n = 0;
    for (let y = top; y < bottom; y++) n += ink[y * W + x];
    return n / (bottom - top);
  };
  /** Whether a vertical stroke runs along rows top..bottom at, or a pixel or two beside, column `x`. */
  const wall = (x: number, dir: -1 | 1, top: number, bottom: number) =>
    Math.max(columnInk(x, top, bottom), columnInk(x + dir, top, bottom), columnInk(x + 2 * dir, top, bottom)) > 0.8;
  /** How far ink continues downwards from (x, y). */
  const inkBelow = (x: number, y: number, limit: number) => {
    let n = 0;
    while (n < limit && y + n < H && ink[(y + n) * W + x]) n++;
    return n;
  };

  for (let y = 1; y < H && blanks.length < MAX_BLANKS; y++) {
    const row = y * W;
    let x = 0;
    while (x < W) {
      if (!ink[row + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < W && ink[row + x]) x++;
      const end = x; // exclusive
      if (end - start < minRun) continue;

      // Walk along the stroke, collecting stretches with enough clear space above.
      let c = start;
      while (c < end) {
        if (clearAbove[row - W + c] < minHeight) {
          c++;
          continue;
        }
        const left = c;
        let clear = 65535;
        while (c < end && clearAbove[row - W + c] >= minHeight) {
          clear = Math.min(clear, clearAbove[row - W + c]);
          c++;
        }
        const right = c; // exclusive
        if (right - left < CHECKBOX_MIN * s) continue;
        if (inkBelow((left + right) >> 1, y, maxThickness + 1) > maxThickness) continue;

        const top = y - clear; // first clear row
        let ceiling = 0;
        if (top > 0) for (let i = left; i < right; i++) ceiling += ink[(top - 1) * W + i];
        const closedAbove = top > 0 && ceiling >= 0.9 * (right - left);
        const closedLeft = wall(left - 1, -1, top, y);
        const closedRight = wall(right, 1, top, y);

        const w = (right - left) / s;
        const h = clear / s;
        const box = { x: left / s, y: top / s, w, h };
        if (
          closedAbove &&
          closedLeft &&
          closedRight &&
          w <= CHECKBOX_MAX &&
          h <= CHECKBOX_MAX &&
          h >= CHECKBOX_MIN &&
          w / h > 0.6 &&
          w / h < 1.7
        ) {
          blanks.push({ ...box, kind: "checkbox" });
        } else if (w >= MIN_TEXT_WIDTH) {
          // A frame has at least one side as well as a top; underlines stacked
          // one above the other only have each other.
          if (closedAbove && (closedLeft || closedRight)) {
            blanks.push({ ...box, kind: "box" });
          } else {
            // A stroke with sides hanging down from its ends is the top edge of
            // a frame; the space above it is not somewhere to write.
            const hang = Math.round(5 * s);
            const isTopEdge = inkBelow(start, y, hang) >= hang || inkBelow(end - 1, y, hang) >= hang;
            if (!isTopEdge) {
              const height = Math.min(h, LINE_FIELD_HEIGHT);
              blanks.push({ x: box.x, y: y / s - height, w, h: height, kind: "line" });
            }
          }
        }
      }
    }
  }

  // Reading order: top to bottom, then left to right within a row.
  return blanks.sort((a, b) => {
    const rowA = a.y + a.h;
    const rowB = b.y + b.h;
    return Math.abs(rowA - rowB) > 6 ? rowA - rowB : a.x - b.x;
  });
}

export function blankAt(blanks: Blank[] | null, x: number, y: number): Blank | null {
  if (!blanks) return null;
  // A click slightly below an underline still means that line.
  for (const blank of blanks) {
    const slack = blank.kind === "line" ? 3 : 0;
    if (x >= blank.x && x <= blank.x + blank.w && y >= blank.y && y <= blank.y + blank.h + slack) return blank;
  }
  return null;
}
