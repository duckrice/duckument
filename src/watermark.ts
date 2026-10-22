// Watermarks, as Acrobat adds them: big see-through words (DRAFT,
// CONFIDENTIAL) across the middle of every page. Each is a text item turned
// and faded, so it can still be moved or changed, and all undone at once.

import { LINE_HEIGHT, type TextItem } from "./model";

export interface WatermarkOptions {
  text: string;
  size: number;
  /** How far it's turned, counter-clockwise, in degrees. */
  angle: number;
  /** 0 (invisible) to 1. */
  opacity: number;
  color: string;
  font: string;
}

/** A watermark for each page, its middle on the page's middle (pages as displayed). */
export function watermarkItems(pages: { width: number; height: number }[], o: WatermarkOptions, newId: () => string): TextItem[] {
  // Roughly as wide as a bold sans-serif sets it.
  const w = o.text.length * o.size * 0.62;
  const h = o.size * LINE_HEIGHT;
  const t = (o.angle * Math.PI) / 180;
  // The text's top-left corner, so that once turned about that corner its middle is the page's.
  const dx = (w / 2) * Math.cos(t) + (h / 2) * Math.sin(t);
  const dy = (-w / 2) * Math.sin(t) + (h / 2) * Math.cos(t);
  return pages.map((page, index) => ({
    id: newId(),
    page: index,
    type: "text" as const,
    x: Math.round((page.width / 2 - dx) * 10) / 10,
    y: Math.round((page.height / 2 - dy) * 10) / 10,
    text: o.text,
    font: o.font,
    size: o.size,
    bold: true,
    italic: false,
    color: o.color,
    angle: o.angle,
    opacity: o.opacity,
  }));
}
