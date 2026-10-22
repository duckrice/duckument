// Stamps, as Acrobat's: a word in a coloured frame, a little tilted, put in
// the top-right corner of the page being read, optionally with today's date.
// Each is a text item, so it can be moved, changed or deleted like any other.

import type { TextItem } from "./model";

/** The frame's line width, and its distance from the text, in points. */
export const STAMP_LINE = 3;
export const STAMP_PAD = 5;

/** The ready-made stamps and their colours. */
export const STAMPS: [string, string][] = [
  ["APPROVED", "#15803d"],
  ["REVIEWED", "#1d4ed8"],
  ["RECEIVED", "#1d4ed8"],
  ["DRAFT", "#6b7280"],
  ["CONFIDENTIAL", "#b91c1c"],
  ["REJECTED", "#b91c1c"],
  ["GODKJENT", "#15803d"],
  ["MOTTATT", "#1d4ed8"],
];

/** A stamp for a page of this (displayed) size, near its top-right corner. */
export function stampItem(page: { width: number; height: number }, index: number, words: string, color: string, date: string | null, id: string): TextItem {
  const text = date ? `${words}\n${date}` : words;
  const size = 22;
  // Roughly as wide as bold Helvetica sets the longest line.
  const wide = Math.max(...text.split("\n").map((line) => line.length)) * size * 0.68;
  return {
    id,
    page: index,
    type: "text",
    x: Math.max(STAMP_PAD * 2, Math.round(page.width - wide - 56)),
    y: 56,
    text,
    font: "helvetica",
    size,
    bold: true,
    italic: false,
    color,
    angle: 6,
    frame: true,
  };
}
