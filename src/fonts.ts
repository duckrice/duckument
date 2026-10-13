// The fonts text can be set in. The three standard PDF fonts need nothing
// embedded; the others are fonts that ship with Windows and are embedded from
// the Fonts folder when saving, so text keeps the look of the document.

export type FontClass = "sans" | "serif" | "mono";

export interface FontDef {
  id: string;
  label: string;
  /** Font families used on screen, most specific first. */
  css: string;
  /** The standard PDF font used when the real one can't be embedded. */
  fallback: FontClass;
  /** Files in the Windows Fonts folder: regular, bold, italic, bold italic. */
  files?: [string, string, string, string];
  /**
   * Recognises this family from a font name inside a PDF, lower-cased with
   * everything but letters and digits removed ("timesnewromanpsboldmt").
   */
  match: RegExp;
}

const CSS_CLASS: Record<FontClass, string> = {
  // System fonts that share the standard fonts' metrics, so text lands in the
  // same place on screen and in the file.
  sans: 'Arial, Helvetica, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};

function system(
  label: string,
  fallback: FontClass,
  files: [string, string, string, string],
  match: RegExp,
): FontDef {
  return { id: label.toLowerCase().replace(/[^a-z0-9]/g, ""), label, css: `"${label}", ${CSS_CLASS[fallback]}`, fallback, files, match };
}

export const FONTS: FontDef[] = [
  { id: "sans", label: "Helvetica", css: CSS_CLASS.sans, fallback: "sans", match: /^helvetica|^nimbussans/ },
  { id: "serif", label: "Times", css: CSS_CLASS.serif, fallback: "serif", match: /^times(?!newroman)|^nimbusroman/ },
  { id: "mono", label: "Courier", css: CSS_CLASS.mono, fallback: "mono", match: /^courier(?!new)|^nimbusmono/ },
  system("Arial", "sans", ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"], /^arial(?!narrow|black|rounded)|^liberationsans(?!narrow)|^arimo/),
  system("Calibri", "sans", ["calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf"], /^calibri|^carlito/),
  system("Candara", "sans", ["Candara.ttf", "Candarab.ttf", "Candarai.ttf", "Candaraz.ttf"], /^candara/),
  system("Comic Sans MS", "sans", ["comic.ttf", "comicbd.ttf", "comici.ttf", "comicz.ttf"], /^comicsans/),
  system("Consolas", "mono", ["consola.ttf", "consolab.ttf", "consolai.ttf", "consolaz.ttf"], /^consolas/),
  system("Constantia", "serif", ["constan.ttf", "constanb.ttf", "constani.ttf", "constanz.ttf"], /^constantia/),
  system("Corbel", "sans", ["corbel.ttf", "corbelb.ttf", "corbeli.ttf", "corbelz.ttf"], /^corbel/),
  system("Courier New", "mono", ["cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf"], /^couriernew|^liberationmono|^cousine/),
  system("Georgia", "serif", ["georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf"], /^georgia/),
  system("Segoe UI", "sans", ["segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf"], /^segoeui(?!symbol|emoji|historic)/),
  // Tahoma has no italic files; italic falls back to the upright ones.
  system("Tahoma", "sans", ["tahoma.ttf", "tahomabd.ttf", "tahoma.ttf", "tahomabd.ttf"], /^tahoma/),
  system("Times New Roman", "serif", ["times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"], /^timesnewroman|^liberationserif|^tinos/),
  system("Trebuchet MS", "sans", ["trebuc.ttf", "trebucbd.ttf", "trebucit.ttf", "trebucbi.ttf"], /^trebuchet/),
  system("Verdana", "sans", ["verdana.ttf", "verdanab.ttf", "verdanai.ttf", "verdanaz.ttf"], /^verdana/),
];

const BY_ID = new Map(FONTS.map((font) => [font.id, font]));

export function fontDef(id: string): FontDef {
  return BY_ID.get(id) ?? FONTS[0];
}

export function fontFile(def: FontDef, bold: boolean, italic: boolean): string | null {
  return def.files ? def.files[(bold ? 1 : 0) + (italic ? 2 : 0)] : null;
}

export interface FontGuess {
  font: string;
  bold: boolean;
  italic: boolean;
}

/**
 * Picks the closest available font for a font name found in a PDF, such as
 * "ABCDEF+Calibri-BoldItalic". `fontClass` is what the PDF says about the
 * font's general shape, used when the name isn't one we know.
 */
export function guessFont(name: string, fontClass: FontClass, usable: (def: FontDef) => boolean): FontGuess {
  const plain = name.replace(/^[A-Z]{6}\+/, "");
  const key = plain.toLowerCase().replace(/[^a-z0-9]/g, "");
  const def = FONTS.find((font) => font.match.test(key) && usable(font));
  return {
    font: def?.id ?? fontClass,
    bold: /bold|black|heavy|semibold|demi/i.test(plain),
    italic: /italic|oblique/i.test(plain),
  };
}

const installed = new Map<string, boolean>();

/** Whether a font family is installed, judged by whether text set in it measures differently from the fallback. */
export function isInstalled(def: FontDef): boolean {
  if (!def.files) return true;
  let known = installed.get(def.id);
  if (known === undefined) {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const sample = "mmmmmmmmmmlliWQ@ 0123456789";
    known = ["monospace", "serif"].some((generic) => {
      ctx.font = `40px ${generic}`;
      const plain = ctx.measureText(sample).width;
      ctx.font = `40px "${def.label}", ${generic}`;
      return ctx.measureText(sample).width !== plain;
    });
    installed.set(def.id, known);
  }
  return known;
}
