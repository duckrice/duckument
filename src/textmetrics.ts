import { LINE_HEIGHT, type FontFamily, type ImageItem, type TextItem } from "./model";

// The standard PDF fonts aren't installed as such; these system fonts share
// their metrics, so text lands in the same place on screen and in the file.
const CSS_FAMILY: Record<FontFamily, string> = {
  sans: 'Arial, Helvetica, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};

type TextStyle = Pick<TextItem, "font" | "size" | "bold" | "italic">;

export function cssFont(style: TextStyle, scale = 1): string {
  const variant = (style.italic ? "italic " : "") + (style.bold ? "bold " : "");
  return `${variant}${style.size * scale}px/${LINE_HEIGHT} ${CSS_FAMILY[style.font]}`;
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

/** Draws a text item as a picture, for characters the standard PDF fonts lack. */
export async function rasterizeText(item: TextItem): Promise<ImageItem | null> {
  const scale = 4;
  const lines = item.text.split("\n");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = cssFont(item, scale);
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) / scale;
  const height = lines.length * item.size * LINE_HEIGHT;
  if (width <= 0) return null;

  canvas.width = Math.ceil(width * scale) + 2;
  canvas.height = Math.ceil(height * scale) + 2;
  ctx.font = cssFont(item, scale);
  ctx.fillStyle = item.color;
  const first = baseline(item);
  lines.forEach((line, i) => ctx.fillText(line, 0, (first + i * item.size * LINE_HEIGHT) * scale));
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
