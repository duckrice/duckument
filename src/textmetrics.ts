import { fontDef } from "./fonts";
import { LINE_HEIGHT, type ImageItem, type TextItem } from "./model";
import { layoutText } from "./paragraphs";

type TextStyle = Pick<TextItem, "font" | "size" | "bold" | "italic"> & { lineHeight?: number };

export function cssFont(style: TextStyle, scale = 1): string {
  const variant = (style.italic ? "italic " : "") + (style.bold ? "bold " : "");
  return `${variant}${style.size * scale}px/${style.lineHeight ?? LINE_HEIGHT} ${fontDef(style.font).css}`;
}

const baselines = new Map<string, number>();

/** Distance from the top of a text item to its first baseline, as the browser lays it out. */
export function baseline(style: TextStyle): number {
  const key = cssFont(style);
  let value = baselines.get(key);
  if (value === undefined) {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;white-space:pre;padding:0;border:0";
    probe.style.font = key;
    // An empty inline-block sits with its bottom edge on the baseline.
    const marker = document.createElement("span");
    marker.style.cssText = "display:inline-block;width:0;height:0";
    probe.append("x", marker);
    document.body.append(probe);
    value = marker.getBoundingClientRect().bottom - probe.getBoundingClientRect().top;
    probe.remove();
    baselines.set(key, value);
  }
  return value;
}

let measurer: CanvasRenderingContext2D | null = null;

/**
 * Width of `text` in points, set the way items are shown: without kerning or
 * ligatures, which is also how the saved PDF places the letters.
 */
export function measureWidth(style: TextStyle, text: string): number {
  measurer ??= document.createElement("canvas").getContext("2d")!;
  // Measured at a large size for precision, then scaled down.
  measurer.font = cssFont({ ...style, size: 100 });
  measurer.fontKerning = "none";
  (measurer as CanvasRenderingContext2D & { textRendering: string }).textRendering = "optimizeSpeed";
  return (measurer.measureText(text).width * style.size) / 100;
}

/** The lines a text item is shown in. */
export function linesOf(item: TextItem) {
  return layoutText(item, (text) => measureWidth(item, text));
}

/** Draws a text item as a picture, for characters the standard PDF fonts lack. */
export async function rasterizeText(item: TextItem): Promise<ImageItem | null> {
  const scale = 4;
  const lines = linesOf(item);
  const lineHeight = item.size * (item.lineHeight ?? LINE_HEIGHT);
  const width = item.width ?? Math.max(...lines.map((line) => line.x + measureWidth(item, line.text)));
  const height = lines.length * lineHeight;
  if (width <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale) + 2;
  canvas.height = Math.ceil(height * scale) + 2;
  const ctx = canvas.getContext("2d")!;
  ctx.font = cssFont(item, scale);
  ctx.fontKerning = "none";
  ctx.fillStyle = item.color;
  const first = baseline(item);
  lines.forEach((line, i) => {
    const y = (first + i * lineHeight) * scale;
    if (line.words) for (const word of line.words) ctx.fillText(word.text, (line.x + word.x) * scale, y);
    else ctx.fillText(line.text, line.x * scale, y);
  });
  return {
    id: item.id,
    type: "image",
    page: item.page,
    x: item.x,
    y: item.y,
    w: canvas.width / scale,
    h: canvas.height / scale,
    src: canvas.toDataURL("image/png"),
  };
}
