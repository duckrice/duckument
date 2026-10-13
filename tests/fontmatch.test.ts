import { existsSync, readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { describe, expect, it } from "vitest";
import { identifyFont, sfntStyle, type Measure } from "../src/fontmatch";
import { FONTS, type FontDef } from "../src/fonts";

const DIR = "C:/Windows/Fonts";
const windowsFonts = existsSync(`${DIR}/timesi.ttf`) && existsSync(`${DIR}/arial.ttf`) && existsSync(`${DIR}/calibri.ttf`);

// The standard PDF fonts share their metrics with these.
const STANDARD_FILES: Record<string, string[]> = {
  sans: ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"],
  serif: ["times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"],
  mono: ["cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf"],
};

type Font = { unitsPerEm: number; glyphsForString(text: string): { advanceWidth: number }[] };
const loaded = new Map<string, Font>();
const read = (file: string) => new Uint8Array(readFileSync(`${DIR}/${file}`));

/** Text width at size 1, from the font file itself. */
function widthIn(file: string, text: string): number {
  let font = loaded.get(file);
  if (!font) loaded.set(file, (font = fontkit.create(read(file)) as unknown as Font));
  return font.glyphsForString(text).reduce((sum, glyph) => sum + glyph.advanceWidth, 0) / font.unitsPerEm;
}

const measure: Measure = (def: FontDef, bold, italic, text) =>
  widthIn((def.files ?? STANDARD_FILES[def.id])[(bold ? 1 : 0) + (italic ? 2 : 0)], text);

const TEXT = "The delta to wye transformation simplifies the network.";
const MORE = ["Replace each resistor with its equivalent.", "Workshop 4: Solutions & Hints (2026)", "R1 = 10 ohm, R2 = 22 ohm, R3 = 47 ohm"];
const identify = (name: string, file: string | null, extra: object = {}, text: string | string[] = TEXT, stretch = 1) =>
  identifyFont(
    { name, ...extra },
    [text].flat().map((t) => ({ text: t, width: file ? widthIn(file, t) * stretch : 0 })),
    FONTS,
    measure,
  );

describe.skipIf(!windowsFonts)("identifyFont", () => {
  it("recognises fonts by the names PDFs usually give them", () => {
    expect(identify("ABCDEF+Calibri-BoldItalic", "calibriz.ttf")).toEqual({ font: "calibri", bold: true, italic: true });
    expect(identify("TimesNewRomanPS-ItalicMT", "timesi.ttf")).toEqual({ font: "timesnewroman", bold: false, italic: true });
    expect(identify("TimesNewRoman,Italic", "timesi.ttf")).toEqual({ font: "timesnewroman", bold: false, italic: true });
    expect(identify("ArialMT", "arial.ttf")).toEqual({ font: "arial", bold: false, italic: false });
    expect(identify("Times-Italic", "timesi.ttf")).toEqual({ font: "serif", bold: false, italic: true });
    expect(identify("CourierNewPS-BoldMT", "courbd.ttf")).toEqual({ font: "couriernew", bold: true, italic: false });
  });

  it("recognises a font from the width of its text when the name says nothing", () => {
    // Names like these are made up by the program that wrote the PDF.
    expect(identify("TT5o00", "timesi.ttf")).toEqual({ font: "serif", bold: false, italic: true });
    expect(identify("F3", "timesbi.ttf")).toEqual({ font: "serif", bold: true, italic: true });
    expect(identify("", "calibri.ttf")).toEqual({ font: "calibri", bold: false, italic: false });
    expect(identify("XYZABC+T1", "georgiab.ttf")).toEqual({ font: "georgia", bold: true, italic: false });
    expect(identify("C2_0", "verdanab.ttf")).toEqual({ font: "verdana", bold: true, italic: false });
  });

  it("takes the style from the embedded font where the widths can't tell", () => {
    // Verdana's and Arial's italics are exactly as wide as their upright letters.
    expect(identify("C2_0", "verdanai.ttf")).toEqual({ font: "verdana", bold: false, italic: false });
    expect(identify("C2_0", "verdanai.ttf", { data: read("verdanai.ttf") })).toEqual({ font: "verdana", bold: false, italic: true });
    expect(identify("C2_0", "ariali.ttf", { data: read("ariali.ttf") })).toEqual({ font: "sans", bold: false, italic: true });
  });

  it("is not fooled by another font that happens to be as wide", () => {
    // Every installed family and style, identified from four lines with no usable name.
    for (const def of FONTS.filter((font) => font.files && !font.nameOnly)) {
      for (const [index, file] of def.files!.entries()) {
        if (def.files!.indexOf(file) !== index) continue; // Tahoma reuses its upright files
        // The name is useless, but the font is embedded, as it nearly always is then.
        const guess = identify("F1", file, { data: read(file) }, [TEXT, ...MORE]);
        const expected = { font: def.id, bold: index % 2 === 1, italic: index >= 2 };
        // Arial, Times New Roman and Courier New are the standard fonts' twins.
        const twin = { arial: "sans", timesnewroman: "serif", couriernew: "mono" }[def.id];
        expect([expected, { ...expected, font: twin }], file).toContainEqual(guess);
      }
    }
  });

  it("finds the style from the text even when the name leaves it out", () => {
    expect(identify("TimesNewRoman", "timesi.ttf")).toEqual({ font: "timesnewroman", bold: false, italic: true });
    expect(identify("ABCDEF+Calibri", "calibrib.ttf")).toEqual({ font: "calibri", bold: true, italic: false });
  });

  it("goes by the name and the font's own flags when the width can't settle it", () => {
    // Justified text is stretched, so no font matches its width.
    expect(identify("TimesNewRomanPS-ItalicMT", "timesi.ttf", {}, TEXT, 1.09)).toEqual({ font: "timesnewroman", bold: false, italic: true });
    // Too short to measure.
    expect(identify("Arial-BoldMT", "arialbd.ttf", {}, "Yes")).toEqual({ font: "arial", bold: true, italic: false });
    expect(identify("F7", "timesi.ttf", { data: read("timesi.ttf") }, "Yes")).toMatchObject({ italic: true });
    expect(identify("F7", null, { bold: true, serif: true })).toEqual({ font: "serif", bold: true, italic: false });
  });

  it("keeps the general shape and style of fonts that aren't installed", () => {
    // Computer Modern, from LaTeX: wider than anything here.
    expect(identify("CMTI10", "timesi.ttf", {}, TEXT, 1.2)).toEqual({ font: "serif", bold: false, italic: true });
    expect(identify("CMBX12", "timesbd.ttf", {}, TEXT, 1.25)).toEqual({ font: "serif", bold: true, italic: false });
    expect(identify("NimbusRomNo9L-ReguItal", "timesi.ttf")).toEqual({ font: "serif", bold: false, italic: true });
    expect(identify("XYZABC+Frutiger-Bold", "arialbd.ttf", {}, TEXT, 1.15)).toEqual({ font: "sans", bold: true, italic: false });
    expect(identify("CMTT10", "cour.ttf", {}, TEXT, 0.87)).toEqual({ font: "mono", bold: false, italic: false });
  });

  it("only offers fonts that can be used", () => {
    const standardOnly = FONTS.filter((def) => !def.files);
    const samples = [{ text: TEXT, width: widthIn("calibrib.ttf", TEXT) }];
    expect(identifyFont({ name: "Calibri-Bold" }, samples, standardOnly, measure)).toEqual({ font: "sans", bold: true, italic: false });
  });
});

describe.skipIf(!windowsFonts)("sfntStyle", () => {
  it("reads bold and italic from a font file", () => {
    expect(sfntStyle(read("times.ttf"))).toEqual({ bold: false, italic: false });
    expect(sfntStyle(read("timesi.ttf"))).toEqual({ bold: false, italic: true });
    expect(sfntStyle(read("timesbd.ttf"))).toEqual({ bold: true, italic: false });
    expect(sfntStyle(read("calibriz.ttf"))).toEqual({ bold: true, italic: true });
  });

  it("returns null for anything that isn't a font file", () => {
    expect(sfntStyle(null)).toBeNull();
    expect(sfntStyle(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sfntStyle(new Uint8Array(64))).toBeNull();
  });
});
