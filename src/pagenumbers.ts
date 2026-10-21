// Page numbers, as Acrobat's Header & Footer adds them: a number on every
// page, put there as ordinary text, so each can still be moved, changed or
// deleted, and all of them undone in one step.

import { LINE_HEIGHT, type TextItem } from "./model";

export type NumberFormat = "page-of" | "number" | "slash";
export type NumberPlace = "bottom-center" | "bottom-right" | "top-right";

export interface PageNumberOptions {
  format: NumberFormat;
  place: NumberPlace;
  size: number;
  /** The number on the first page counted. */
  start: number;
  /** Leave the first page without a number (a title page). */
  skipFirst: boolean;
  font: string;
  color: string;
}

/** How far from the page's edge, in points (about 1.3 cm). */
const MARGIN = 36;

export function numberText(format: NumberFormat, n: number, total: number): string {
  return format === "page-of" ? `Page ${n} of ${total}` : format === "slash" ? `${n} / ${total}` : String(n);
}

/** The page numbers as text items, for pages of these sizes (as displayed: turned pages have width and height swapped). */
export function pageNumberItems(pages: { width: number; height: number }[], options: PageNumberOptions, newId: () => string): TextItem[] {
  const first = options.skipFirst ? 1 : 0;
  const total = pages.length - first + options.start - 1;
  return pages.flatMap((page, index) => {
    if (index < first) return [];
    const text = numberText(options.format, index - first + options.start, total);
    // Roughly as wide as Helvetica sets it; the box sizes itself to the text when shown.
    const width = text.length * options.size * 0.52;
    const height = options.size * LINE_HEIGHT;
    const x = options.place === "bottom-center" ? (page.width - width) / 2 : page.width - MARGIN - width;
    const y = options.place === "top-right" ? MARGIN - height / 2 : page.height - MARGIN - height / 2;
    return [{ id: newId(), page: index, type: "text" as const, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, text, font: options.font, size: options.size, bold: false, italic: false, color: options.color }];
  });
}
