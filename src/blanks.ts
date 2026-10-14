// Finds places meant to be written in on a page that has no real form fields:
// blank space sitting on a line ("Name: ______" or "Name: ........"), empty
// boxes and table cells, shaded fields without an outline, and small squares
// meant to be ticked. It works on a picture of the page, so it doesn't matter
// whether a line was drawn, typed as underscores or dots, or scanned.

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
// Dotted and dashed lines: the dots or dashes, and the gaps between them.
const MAX_DASH = 12;
const MAX_DOT_THICKNESS = 2.5;
const MAX_DOT_GAP = 5;
const MIN_DOTS = 5;
/** Clear space a dot needs below it, which the strokes of letters don't have. */
const DOT_CLEARANCE = 2.5;
// Shaded fields.
const MIN_SHADED_HEIGHT = 10;
const MAX_SHADED_HEIGHT = 300;

/** Darker than this (0..255) counts as ink. */
const INK_LUMA = 200;
/** Paler than ink, but with a channel below this, counts as shading. */
const TINT_BELOW = 245;

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

  /** Whether (a, y)..(b, y) is the top of a dot or dash: thin, nothing above it, and clear below it. */
  const isDot = (a: number, b: number, y: number) => {
    const middle = (a + b) >> 1;
    if (clearAbove[(y - 1) * W + middle] < minHeight) return false;
    const thickness = inkBelow(middle, y, Math.round(MAX_DOT_THICKNESS * s) + 1);
    if (thickness > MAX_DOT_THICKNESS * s) return false;
    const below = y + thickness;
    const until = Math.min(H, below + Math.round(DOT_CLEARANCE * s));
    for (let yy = below; yy < until; yy++) {
      for (let xx = Math.max(0, a - 1); xx <= Math.min(W - 1, b); xx++) if (ink[yy * W + xx]) return false;
    }
    return true;
  };

  for (let y = 1; y < H && blanks.length < MAX_BLANKS; y++) {
    const row = y * W;
    const runs: [number, number][] = [];
    for (let x = 0; x < W; ) {
      if (!ink[row + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < W && ink[row + x]) x++;
      runs.push([start, x]);
    }

    for (const [start, end] of runs) if (end - start >= minRun) stroke(y, start, end);

    // Dots or dashes in a row, evenly spaced, make a line too.
    let chain: [number, number][] = [];
    const finishChain = () => {
      if (chain.length >= MIN_DOTS) {
        const gaps = chain.slice(1).map(([a], i) => a - chain[i][1]);
        const even = Math.max(...gaps) <= 2.5 * Math.min(...gaps) + 2;
        const start = chain[0][0];
        const end = chain[chain.length - 1][1];
        if (even && end - start >= MIN_TEXT_WIDTH * s) stroke(y, start, end);
      }
      chain = [];
    };
    for (const [start, end] of runs) {
      const dot = end - start <= MAX_DASH * s && isDot(start, end, y);
      if (!dot) {
        finishChain();
        continue;
      }
      const last = chain[chain.length - 1];
      if (last && start - last[1] > MAX_DOT_GAP * s) finishChain();
      chain.push([start, end]);
    }
    finishChain();
  }

  findShadedFields(image, s, ink, blanks);

  // Reading order: top to bottom, then left to right within a row.
  return blanks.sort((a, b) => {
    const rowA = a.y + a.h;
    const rowB = b.y + b.h;
    return Math.abs(rowA - rowB) > 6 ? rowA - rowB : a.x - b.x;
  });

  /** Looks for writing space above a horizontal stroke from (start, y) to (end, y). */
  function stroke(y: number, start: number, end: number) {
    const row = y * W;
    {
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
}

/**
 * Finds evenly shaded rectangles with nothing in them and no outline: the
 * pale grey or blue fields some forms use instead of lines.
 */
function findShadedFields(image: PagePixels, s: number, ink: Uint8Array, blanks: Blank[]) {
  const { data, width: W, height: H } = image;
  const minWidth = Math.round(MIN_TEXT_WIDTH * s);
  const tinted = (i: number) => {
    const p = i * 4;
    return !ink[i] && Math.min(data[p], data[p + 1], data[p + 2]) < TINT_BELOW;
  };
  const sameColour = (i: number, j: number) => {
    const p = i * 4;
    const q = j * 4;
    return Math.abs(data[p] - data[q]) <= 10 && Math.abs(data[p + 1] - data[q + 1]) <= 10 && Math.abs(data[p + 2] - data[q + 2]) <= 10;
  };
  /** Share of tinted pixels along a row or column segment. */
  const tintShare = (x0: number, y0: number, dx: number, dy: number, count: number) => {
    let n = 0;
    let total = 0;
    for (let k = 0; k < count; k++) {
      const x = x0 + dx * k;
      const y = y0 + dy * k;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      total++;
      n += tinted(y * W + x) ? 1 : 0;
    }
    return total ? n / total : 0;
  };

  interface Area {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    colour: number;
  }
  let open: Area[] = [];
  const close = (area: Area) => {
    const w = area.x1 - area.x0;
    const h = area.y1 - area.y0 + 1;
    if (h < MIN_SHADED_HEIGHT * s || h > MAX_SHADED_HEIGHT * s || w > 0.95 * W) return;
    // Its edges must be where the shading ends, not where something interrupts it.
    if (tintShare(area.x0, area.y0 - 1, 1, 0, w) > 0.3 || tintShare(area.x0, area.y1 + 1, 1, 0, w) > 0.3) return;
    if (tintShare(area.x0 - 2, area.y0, 0, 1, h) > 0.3 || tintShare(area.x1 + 1, area.y0, 0, 1, h) > 0.3) return;
    const box = { x: area.x0 / s, y: area.y0 / s, w: w / s, h: h / s };
    // Bordered boxes with a tint are found already, as boxes.
    const overlaps = blanks.some(
      (b) => Math.min(b.x + b.w, box.x + box.w) - Math.max(b.x, box.x) > box.w * 0.5 && Math.min(b.y + b.h, box.y + box.h) - Math.max(b.y, box.y) > box.h * 0.5,
    );
    if (!overlaps && blanks.length < MAX_BLANKS) blanks.push({ ...box, kind: "box" });
  };

  for (let y = 0; y < H; y++) {
    const row = y * W;
    const next: Area[] = [];
    for (let x = 0; x < W; ) {
      if (!tinted(row + x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < W && tinted(row + x) && sameColour(row + start, row + x)) x++;
      if (x - start < minWidth) continue;
      const continued = open.find((a) => Math.abs(a.x0 - start) <= 2 && Math.abs(a.x1 - x) <= 2 && sameColour(a.colour, row + start));
      if (continued) {
        continued.y1 = y;
        next.push(continued);
        open = open.filter((a) => a !== continued);
      } else next.push({ x0: start, x1: x, y0: y, y1: y, colour: row + start });
    }
    // Areas that stopped on this row are finished.
    for (const area of open) close(area);
    open = next;
  }
  for (const area of open) close(area);
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
