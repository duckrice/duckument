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
  /**
   * Set when this text replaces text that was already in the document: the
   * area of the original that is painted over, the colour to paint it, and
   * what the original said.
   */
  cover?: Box & { color: string; original: string };
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

export type Item = TextItem | ShapeItem | LineItem | MarkItem | PenItem | ImageItem;
export type BoxItem = ShapeItem | MarkItem | PenItem | ImageItem;

export const LINE_HEIGHT = 1.2;

export function isLine(item: Item): item is LineItem {
  return item.type === "line" || item.type === "arrow";
}

export function isBoxItem(item: Item): item is BoxItem {
  return item.type !== "text" && !isLine(item);
}

let counter = 0;
export function newId(): string {
  return `${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export function translate<T extends Item>(item: T, dx: number, dy: number): T {
  if (isLine(item)) {
    return { ...item, x1: item.x1 + dx, y1: item.y1 + dy, x2: item.x2 + dx, y2: item.y2 + dy };
  }
  const boxed = item as Exclude<Item, LineItem>;
  return { ...boxed, x: boxed.x + dx, y: boxed.y + dy } as T;
}
