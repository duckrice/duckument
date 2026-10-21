import { describe, expect, it } from "vitest";
import { numberText, pageNumberItems } from "../src/pagenumbers";

let n = 0;
const id = () => `n${n++}`;
const a4 = { width: 595, height: 842 };
const base = { size: 10, start: 1, skipFirst: false, font: "helvetica", color: "#000000" } as const;

describe("page numbers", () => {
  it("are written as Acrobat offers them", () => {
    expect([numberText("page-of", 2, 9), numberText("number", 2, 9), numberText("slash", 2, 9)]).toEqual(["Page 2 of 9", "2", "2 / 9"]);
  });

  it("go on every page, near the bottom in the middle", () => {
    const items = pageNumberItems([a4, a4, a4], { ...base, format: "page-of", place: "bottom-center" }, id);
    expect(items.map((i) => [i.page, i.text])).toEqual([
      [0, "Page 1 of 3"],
      [1, "Page 2 of 3"],
      [2, "Page 3 of 3"],
    ]);
    const { x, y } = items[0];
    expect(Math.abs(x + ("Page 1 of 3".length * 10 * 0.52) / 2 - 595 / 2)).toBeLessThan(1);
    expect(y).toBeGreaterThan(780);
  });

  it("can leave out a title page and start at another number", () => {
    const items = pageNumberItems([a4, a4, a4], { ...base, format: "number", place: "top-right", skipFirst: true, start: 5 }, id);
    expect(items.map((i) => [i.page, i.text])).toEqual([
      [1, "5"],
      [2, "6"],
    ]);
    expect(items[0].y).toBeLessThan(60);
  });
});
