import { describe, expect, it } from "vitest";
import { findInPieces, normalizeQuery, type TextPiece } from "../src/findtext";

const pieces = (...parts: (string | [string, boolean])[]): TextPiece[] =>
  parts.map((part) => (typeof part === "string" ? { str: part, eol: false } : { str: part[0], eol: part[1] }));

describe("findInPieces", () => {
  it("finds every occurrence, ignoring case", () => {
    const text = pieces("The Needle and the needle", "stack of NEEDLES");
    expect(findInPieces(text, "needle").map((m) => [m.start.piece, m.start.offset, m.end.piece, m.end.offset])).toEqual([
      [0, 4, 0, 10],
      [0, 19, 0, 25],
      [1, 9, 1, 15],
    ]);
  });

  it("matches across pieces and line breaks", () => {
    const text = pieces(["Apply the delta", true], ["wye transformation", false]);
    const [match] = findInPieces(text, "delta wye");
    expect(match).toEqual({ start: { piece: 0, offset: 10 }, end: { piece: 1, offset: 3 } });
    expect(findInPieces(pieces("Bergen", "Oslo"), "nOs")).toEqual([{ start: { piece: 0, offset: 5 }, end: { piece: 1, offset: 2 } }]);
  });

  it("treats any run of spaces as one", () => {
    expect(findInPieces(pieces("two   spaces"), "two spaces")).toHaveLength(1);
    expect(findInPieces(pieces("two spaces"), "  two    spaces ")).toHaveLength(1);
  });

  it("handles Norwegian letters", () => {
    expect(findInPieces(pieces("Blåbærsyltetøy fra Ålesund"), "BLÅBÆR")).toHaveLength(1);
    expect(findInPieces(pieces("Ålesund"), "alesund")).toHaveLength(0);
  });

  it("finds nothing for an empty search", () => {
    expect(findInPieces(pieces("anything"), "   ")).toEqual([]);
    expect(normalizeQuery("  Mixed  Case ")).toBe("mixed case");
  });
});
