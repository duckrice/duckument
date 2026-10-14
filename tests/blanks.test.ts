import { describe, expect, it } from "vitest";
import { blankAt, detectBlanks, type PagePixels } from "../src/blanks";

const SCALE = 2;

/** A white page, in points, that can be drawn on with dark rectangles. */
class Page {
  readonly image: PagePixels;

  constructor(width: number, height: number) {
    const w = width * SCALE;
    const h = height * SCALE;
    this.image = { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h };
  }

  fill(x: number, y: number, w: number, h: number, luma = 0) {
    const { data, width } = this.image;
    for (let py = Math.round(y * SCALE); py < Math.round((y + h) * SCALE); py++) {
      for (let px = Math.round(x * SCALE); px < Math.round((x + w) * SCALE); px++) {
        const i = (py * width + px) * 4;
        data[i] = data[i + 1] = data[i + 2] = luma;
      }
    }
    return this;
  }

  /** The outline of a rectangle. */
  frame(x: number, y: number, w: number, h: number, t = 0.5) {
    return this.fill(x, y, w, t).fill(x, y + h - t, w, t).fill(x, y, t, h).fill(x + w - t, y, t, h);
  }

  /** A row of blobs standing in for a line of text whose baseline is at `y`. */
  text(x: number, y: number, w: number, size = 10) {
    for (let cx = x; cx < x + w; cx += size * 0.6) this.fill(cx, y - size * 0.7, size * 0.4, size * 0.7);
    return this;
  }

  blanks() {
    return detectBlanks(this.image, SCALE);
  }
}

describe("detectBlanks", () => {
  it("finds the space above an underline, next to its label", () => {
    const blanks = new Page(400, 200).text(40, 100, 50).fill(100, 101, 200, 0.5).blanks();
    expect(blanks).toHaveLength(1);
    const [blank] = blanks;
    expect(blank.kind).toBe("line");
    expect(blank.x).toBeCloseTo(100, 0);
    expect(blank.w).toBeCloseTo(200, 0);
    expect(blank.y + blank.h).toBeCloseTo(101, 0);
    expect(blank.h).toBeGreaterThanOrEqual(10);
  });

  it("keeps underlines stacked above each other as separate lines", () => {
    const page = new Page(400, 200);
    for (let row = 0; row < 3; row++) page.text(40, 60 + row * 34, 50).fill(110, 62 + row * 34, 250, 0.5);
    const blanks = page.blanks();
    expect(blanks.map((b) => b.kind)).toEqual(["line", "line", "line"]);
    expect(blanks.map((b) => Math.round(b.y + b.h))).toEqual([62, 96, 130]);
    for (const blank of blanks) expect(blank.h).toBeLessThanOrEqual(18);
  });

  it("ignores underlined text and rules directly under a paragraph", () => {
    const page = new Page(400, 200);
    page.text(40, 60, 200).fill(40, 61.5, 200, 0.5);
    page.text(40, 120, 300).fill(40, 124, 300, 0.5);
    expect(page.blanks()).toEqual([]);
  });

  it("treats each empty cell of a table as a box and skips filled ones", () => {
    const page = new Page(400, 200);
    // Two rows of three cells; the first row holds headings.
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) page.frame(40 + col * 100, 40 + row * 24, 100.5, 24.5);
    }
    for (let col = 0; col < 3; col++) page.text(46 + col * 100, 57, 60);
    const blanks = page.blanks();
    expect(blanks.map((b) => b.kind)).toEqual(["box", "box", "box"]);
    expect(blanks.map((b) => Math.round(b.x))).toEqual([41, 141, 241]);
    for (const blank of blanks) {
      expect(blank.y).toBeCloseTo(64.5, 0);
      expect(blank.h).toBeCloseTo(23.5, 0);
      expect(blank.w).toBeCloseTo(99.5, 0);
    }
  });

  it("recognises small squares as checkboxes, but not the space above a frame", () => {
    const page = new Page(400, 200);
    page.frame(50, 80, 12, 12, 0.75).text(70, 90, 80);
    page.frame(50, 120, 300, 60);
    const blanks = page.blanks();
    expect(blanks.map((b) => b.kind)).toEqual(["checkbox", "box"]);
    expect(blanks[0].x).toBeCloseTo(50.75, 0);
    expect(blanks[0].w).toBeCloseTo(10.5, 0);
    expect(blanks[1].h).toBeCloseTo(59, 0);
  });

  it("skips filled shapes", () => {
    const page = new Page(400, 200);
    page.fill(40, 60, 200, 30); // a solid bar
    expect(page.blanks()).toEqual([]);
  });

  it("finds dotted and dashed lines, with or without a label", () => {
    const page = new Page(400, 300);
    page.text(40, 60, 40);
    for (let x = 90; x < 300; x += 3) page.fill(x, 60, 1.2, 1.2); // Name: ...........
    for (let x = 90; x < 300; x += 7) page.fill(x, 120, 4, 0.7); // - - - - -
    const blanks = page.blanks();
    expect(blanks.map((b) => b.kind)).toEqual(["line", "line"]);
    expect(blanks[0].x).toBeCloseTo(90, 0);
    expect(blanks[0].x + blanks[0].w).toBeCloseTo(299, 0);
    expect(blanks[0].y + blanks[0].h).toBeCloseTo(60, 0);
    expect(blanks[1].y + blanks[1].h).toBeCloseTo(120, 0);
  });

  it("does not mistake lines of small letters for dots", () => {
    // Letter-like shapes: tops of round letters with strokes going down.
    const page = new Page(400, 200);
    for (let x = 40; x < 300; x += 5) page.fill(x, 80, 3.5, 0.7).fill(x, 80, 0.7, 5).fill(x + 2.8, 80, 0.7, 5);
    expect(page.blanks()).toEqual([]);
  });

  it("finds shaded fields without an outline, but not shading with something in it", () => {
    const page = new Page(400, 300);
    page.fill(100, 50, 200, 20, 235); // empty grey field
    page.fill(100, 100, 200, 60, 238).text(110, 130, 80); // shaded panel holding text
    const blanks = page.blanks();
    expect(blanks).toHaveLength(1);
    expect(blanks[0]).toMatchObject({ kind: "box" });
    expect(blanks[0].x).toBeCloseTo(100, 0);
    expect(blanks[0].w).toBeCloseTo(200, 0);
    expect(blanks[0].h).toBeCloseTo(20, 0);
  });

  it("does not take a photo for a shaded field", () => {
    const page = new Page(400, 300);
    const { data, width } = page.image;
    // Noisy pale pixels, like a light photograph.
    for (let y = 100; y < 200; y++) {
      for (let x = 100; x < 300; x++) {
        const i = (y * 2 * width + x * 2) * 4;
        const v = 205 + ((x * 7 + y * 13) % 37);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const j = i + (dy * width + dx) * 4;
          data[j] = v;
          data[j + 1] = v - 10;
          data[j + 2] = v - 20;
        }
      }
    }
    expect(page.blanks()).toEqual([]);
  });

  it("lists blanks in reading order", () => {
    const page = new Page(400, 300);
    page.fill(220, 201, 120, 0.5).fill(40, 200, 120, 0.5).fill(40, 100, 120, 0.5);
    expect(page.blanks().map((b) => [Math.round(b.x), Math.round(b.y + b.h)])).toEqual([
      [40, 100],
      [40, 200],
      [220, 201],
    ]);
  });
});

describe("blankAt", () => {
  it("accepts a click just under an underline", () => {
    const blanks = new Page(400, 200).fill(100, 101, 200, 0.5).blanks();
    expect(blankAt(blanks, 150, 95)).toBe(blanks[0]);
    expect(blankAt(blanks, 150, 103)).toBe(blanks[0]);
    expect(blankAt(blanks, 150, 60)).toBeNull();
    expect(blankAt(null, 150, 95)).toBeNull();
  });
});
