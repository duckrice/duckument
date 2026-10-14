import { describe, expect, it } from "vitest";
import { findParagraphs, layoutText, paragraphText } from "../src/paragraphs";
import type { TextRun } from "../src/textruns";

const run = (text: string, baseX: number, baseline: number, width: number, size = 10, fontName = "f1"): TextRun => ({
  text,
  baseX,
  baseline,
  width,
  size,
  fontName,
  fontClass: "serif",
  x: baseX - 1,
  y: baseline - size * 0.93,
  w: width + 2,
  h: size * 1.2,
});

describe("findParagraphs", () => {
  it("groups evenly spaced lines with the same left edge and font", () => {
    const runs = [
      run("Heading", 40, 50, 60, 16, "bold"),
      run("The first line of a paragraph that", 52, 80, 300),
      run("goes on to a second line and a", 40, 92, 312),
      run("short last line.", 40, 104, 120),
      run("A lone line further down", 40, 160, 200),
    ];
    const [paragraph, ...rest] = findParagraphs(runs);
    expect(rest).toHaveLength(0);
    expect(paragraph.runs.map((r) => r.text)).toEqual([
      "The first line of a paragraph that",
      "goes on to a second line and a",
      "short last line.",
    ]);
    expect(paragraph.x).toBe(40);
    expect(paragraph.indent).toBe(12);
    expect(paragraph.lineHeight).toBeCloseTo(1.2, 5);
    expect(paragraph.justified).toBe(true);
    expect(paragraph.width).toBeCloseTo(312.5, 5);
  });

  it("does not join lines in different fonts or with uneven spacing", () => {
    expect(findParagraphs([run("One", 40, 80, 100), run("Two", 40, 92, 100, 10, "other")])).toEqual([]);
    expect(findParagraphs([run("One", 40, 80, 100), run("Two", 40, 92, 100), run("Far", 40, 130, 100)])[0].runs).toHaveLength(2);
  });

  it("joins the lines, mending words hyphenated at a line end", () => {
    const paragraph = findParagraphs([run("A trans-", 40, 80, 100), run("formation of the", 40, 92, 100), run("network", 40, 104, 60)])[0];
    expect(paragraphText(paragraph)).toBe("A transformation of the network");
  });
});

describe("layoutText", () => {
  // Every character 5 points wide.
  const measure = (text: string) => text.length * 5;

  it("wraps words to the width", () => {
    const lines = layoutText({ text: "aaa bbb ccc ddd", width: 40 }, measure);
    expect(lines.map((l) => l.text)).toEqual(["aaa bbb", "ccc ddd"]);
    expect(lines.every((l) => l.words === null)).toBe(true);
  });

  it("spreads all but the last line of a justified paragraph", () => {
    const lines = layoutText({ text: "aa bb cc dd ee", width: 52, align: "justify" }, measure);
    expect(lines.map((l) => l.text)).toEqual(["aa bb cc", "dd ee"]);
    const [first] = lines;
    expect(first.words!.map((w) => w.x)).toEqual([0, 21, 42]);
    expect(lines[1].words).toBeNull();
  });

  it("indents the first line and keeps explicit line breaks", () => {
    const lines = layoutText({ text: "aaa bbb ccc\nddd", width: 40, indent: 10 }, measure);
    expect(lines.map((l) => [l.text, l.x])).toEqual([
      ["aaa", 10],
      ["bbb ccc", 0],
      ["ddd", 0],
    ]);
  });

  it("without a width, only line breaks start new lines", () => {
    expect(layoutText({ text: "one long line\nsecond" }, measure).map((l) => l.text)).toEqual(["one long line", "second"]);
  });
});
