// Everything the user adds to a document. Coordinates are in PDF points in
// the page as displayed (rotation applied), origin top-left, y pointing down.

interface ItemBase {
  id: string;
  /** Zero-based page index. */
  page: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextItem extends ItemBase {
  type: "text";
  x: number;
  y: number;
  text: string;
  /** A font id from fonts.ts. */
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  /** Turned counter-clockwise about its top-left corner, in degrees (watermarks). */
  angle?: number;
  /** See-through: 0 to 1 (watermarks). */
  opacity?: number;
  /**
   * Set when this text replaces text that was already in the document: the
   * area of the original that is painted over, the colour to paint it, and
   * what the original said.
   */
  cover?: Box & { color: string; original: string };
  /** For a paragraph: the width its words wrap to (without it, only "\n" breaks lines). */
  width?: number;
  /** How far a paragraph's first line is indented. */
  indent?: number;
  align?: "left" | "justify";
  /** Distance between baselines as a multiple of the size; LINE_HEIGHT when not set. */
  lineHeight?: number;
}

export interface ShapeItem extends ItemBase, Box {
  type: "rect" | "ellipse";
  stroke: string | null;
  fill: string | null;
  strokeWidth: number;
}

export interface LineItem extends ItemBase {
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export interface MarkItem extends ItemBase, Box {
  type: "check" | "cross";
  stroke: string;
  strokeWidth: number;
}

export interface PenItem extends ItemBase, Box {
  type: "pen";
  /** Flat x,y pairs, each normalised to 0..1 inside the box. */
  points: number[];
  stroke: string;
  strokeWidth: number;
}

export interface ImageItem extends ItemBase, Box {
  type: "image";
  /** PNG or JPEG data URL. */
  src: string;
}

export type MarkKind = "highlight" | "underline" | "strike";

/** A highlight, underline or strike-through over a stretch of the document's text. */
export interface MarkupItem extends ItemBase {
  type: MarkKind;
  /** One box per line of marked text. */
  rects: Box[];
  color: string;
  /** The text that was marked. */
  text: string;
}

/** A sticky note: an icon on the page with a comment behind it. */
export interface NoteItem extends ItemBase {
  type: "note";
  /** Top left of the icon. */
  x: number;
  y: number;
  text: string;
  color: string;
}

/** Size of a note's icon, in points. */
export const NOTE_SIZE = 18;

export type Item = TextItem | ShapeItem | LineItem | MarkItem | PenItem | ImageItem | MarkupItem | NoteItem;
export type BoxItem = ShapeItem | MarkItem | PenItem | ImageItem;

export const LINE_HEIGHT = 1.2;

export function isLine(item: Item): item is LineItem {
  return item.type === "line" || item.type === "arrow";
}

export function isMarkup(item: Item): item is MarkupItem {
  return item.type === "highlight" || item.type === "underline" || item.type === "strike";
}

export function isBoxItem(item: Item): item is BoxItem {
  return item.type !== "text" && item.type !== "note" && !isLine(item) && !isMarkup(item);
}

let counter = 0;
export function newId(): string {
  return `${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export function translate<T extends Item>(item: T, dx: number, dy: number): T {
  if (isLine(item)) {
    return { ...item, x1: item.x1 + dx, y1: item.y1 + dy, x2: item.x2 + dx, y2: item.y2 + dy };
  }
  if (isMarkup(item)) {
    return { ...item, rects: item.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) };
  }
  const boxed = item as Exclude<Item, LineItem | MarkupItem>;
  return { ...boxed, x: boxed.x + dx, y: boxed.y + dy } as T;
}

/** One page of the document as the user has arranged it. */
export interface PageRef {
  /** Stays the same while pages move around. */
  id: string;
  /** Which PDF the page comes from (see Viewer.sources), and which of its pages. */
  source: string;
  index: number;
  /** How far the user has turned it, clockwise: 0, 90, 180 or 270. */
  rotation: number;
  /** Set for an inserted empty page: its size in points. */
  blank?: { width: number; height: number };
}
