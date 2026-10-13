// Pointer and keyboard handling for adding, moving and resizing items.

import { blankAt, type Blank } from "./blanks";
import { h, isTyping } from "./dom";
import { guessFont, isInstalled } from "./fonts";
import {
  LINE_HEIGHT,
  isLine,
  newId,
  translate,
  type Box,
  type Item,
  type PenItem,
  type TextItem,
} from "./model";
import type { Overlay } from "./overlay";
import { isDesktop } from "./platform";
import type { Settings } from "./settings";
import type { Store, Tool } from "./store";
import { baseline, cssFont } from "./textmetrics";
import { runAt, type TextRun } from "./textruns";
import type { PageView, Viewer } from "./viewer";

interface Point {
  x: number;
  y: number;
}

type Drag =
  | { kind: "move"; view: PageView; start: Point; client: Point; orig: Item; moved: boolean }
  | { kind: "resize"; view: PageView; handle: string; orig: Item; box: Box }
  | { kind: "create"; view: PageView; start: Point; id: string }
  | { kind: "pen"; view: PageView; points: number[]; id: string };

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  t: "text",
  e: "edit",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
  p: "pen",
  c: "check",
  x: "cross",
  w: "whiteout",
};

/** Pixels the pointer must travel before a press on an item becomes a move. */
const MOVE_THRESHOLD = 3;
const MIN_SIZE = 4;

function resizeBox(box: Box, handle: string, p: Point, keepAspect: boolean): Box {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (handle.includes("w")) left = Math.min(p.x, right - MIN_SIZE);
  if (handle.includes("e")) right = Math.max(p.x, left + MIN_SIZE);
  if (handle.includes("n")) top = Math.min(p.y, bottom - MIN_SIZE);
  if (handle.includes("s")) bottom = Math.max(p.y, top + MIN_SIZE);
  if (keepAspect && handle.length === 2 && box.w > 0 && box.h > 0) {
    const factor = Math.max((right - left) / box.w, (bottom - top) / box.h);
    const w = box.w * factor;
    const height = box.h * factor;
    if (handle.includes("w")) left = right - w;
    else right = left + w;
    if (handle.includes("n")) top = bottom - height;
    else bottom = top + height;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Snaps `p` to the nearest 45° direction as seen from `from`. */
function snapAngle(from: Point, p: Point): Point {
  const dx = p.x - from.x;
  const dy = p.y - from.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(dx, dy);
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

function penItem(base: Omit<PenItem, "x" | "y" | "w" | "h" | "points">, absolute: number[]): PenItem {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < absolute.length; i += 2) {
    minX = Math.min(minX, absolute[i]);
    maxX = Math.max(maxX, absolute[i]);
    minY = Math.min(minY, absolute[i + 1]);
    maxY = Math.max(maxY, absolute[i + 1]);
  }
  // A perfectly straight stroke would otherwise have a zero-sized box.
  const w = Math.max(maxX - minX, 0.01);
  const height = Math.max(maxY - minY, 0.01);
  const points = absolute.map((v, i) => (i % 2 === 0 ? (v - minX) / w : (v - minY) / height));
  return { ...base, x: minX, y: minY, w, h: height, points };
}

let measure: CanvasRenderingContext2D | null = null;

/** The character position in a text item's first line nearest to page coordinate `x`. */
function caretIndex(item: TextItem, x: number): number {
  measure ??= document.createElement("canvas").getContext("2d")!;
  measure.font = cssFont(item);
  const line = item.text.split("\n")[0];
  const target = x - item.x;
  let before = 0;
  for (let i = 1; i <= line.length; i++) {
    const width = measure.measureText(line.slice(0, i)).width;
    if (width > target) return target - before < width - target ? i - 1 : i;
    before = width;
  }
  return line.length;
}

export class Interaction {
  tool: Tool = "select";

  private drag: Drag | null = null;
  private pending: { src: string; w: number; h: number } | null = null;
  private ghost = h("img", { class: "place-ghost", draggable: "false" });
  private clipboard: Item | null = null;
  private markSize = 13;

  constructor(
    private store: Store,
    private viewer: Viewer,
    private overlay: Overlay,
    private settings: Settings,
    private onToolChange: () => void,
  ) {
    const root = viewer.container;
    root.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    root.addEventListener("pointermove", (event) => this.onPointerMove(event));
    root.addEventListener("pointerup", (event) => this.onPointerUp(event));
    root.addEventListener("pointercancel", (event) => this.onPointerUp(event));
    root.addEventListener("pointerleave", () => this.ghost.remove());
    root.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    // Clicks on the page must not steal focus from the text being typed;
    // real inputs (form fields, the text editor) keep their normal behaviour.
    root.addEventListener("mousedown", (event) => {
      if (!isTyping(event.target) && this.viewer.pageFromElement(event.target as Element)) event.preventDefault();
    });
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("paste", (event) => this.onPaste(event));
    overlay.onTab = (item, back) => this.tabFrom(item, back);
    root.dataset.tool = this.tool;
  }

  setTool(tool: Tool) {
    this.overlay.finishEdit();
    if (tool !== "place") {
      this.pending = null;
      this.ghost.remove();
    }
    // With a tool active the options bar describes what it will add next.
    if (tool !== "select") this.store.select(null);
    this.tool = tool;
    this.viewer.container.dataset.tool = tool;
    this.viewer.setAssist(tool === "text" || tool === "check" || tool === "cross" ? "blanks" : tool === "edit" ? "runs" : null);
    this.onToolChange();
  }

  /** Lets the user click where a picture (a signature, usually) should go. `width` is in points. */
  placeImage(src: string, width: number, height: number) {
    this.pending = { src, w: width, h: height };
    this.ghost.src = src;
    this.setTool("place");
  }

  // ---- pointer ------------------------------------------------------------

  private onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".text-editor")) return;

    const view = this.viewer.pageFromElement(target);
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    const selected = this.store.selected;
    if (handle && selected && view) {
      this.overlay.finishEdit();
      const orig = this.store.get(selected.id)!;
      this.begin(event, { kind: "resize", view, handle, orig, box: this.overlay.box(orig) });
      return;
    }

    this.overlay.finishEdit();
    if (!isTyping(target) && document.activeElement instanceof HTMLElement && isTyping(document.activeElement)) {
      document.activeElement.blur();
    }
    if (!view) {
      if (!isTyping(target)) this.store.select(null);
      return;
    }

    const p = this.viewer.pointOn(view, event.clientX, event.clientY);
    const id = target.closest<HTMLElement | SVGElement>(".item")?.dataset.id;
    const hit = id ? this.store.get(id) : undefined;
    const base = { id: newId(), page: view.index };
    const { stroke, strokeWidth } = this.settings;

    switch (this.tool) {
      case "select":
        if (hit) {
          this.store.select(hit.id);
          this.begin(event, {
            kind: "move",
            view,
            start: p,
            client: { x: event.clientX, y: event.clientY },
            orig: hit,
            moved: false,
          });
        } else {
          this.store.select(null);
        }
        return;

      case "text": {
        if (hit?.type === "text") {
          this.overlay.startEdit(hit.id);
          return;
        }
        const field = this.formFieldAt(event.clientX, event.clientY);
        if (field) {
          this.store.select(null);
          if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) field.click();
          else field.focus();
          return;
        }
        const blank = blankAt(view.blanks, p.x, p.y);
        if (blank?.kind === "checkbox") this.toggleMark(view, blank, "check");
        else if (blank) this.fillBlank(view, blank);
        else this.newText(view, p.x, p.y - (this.settings.fontSize * LINE_HEIGHT) / 2, this.settings.fontSize);
        return;
      }

      case "edit": {
        // Text that was replaced earlier is edited again, not replaced twice.
        const replaced = this.store.items.find(
          (item): item is TextItem =>
            item.type === "text" &&
            !!item.cover &&
            item.page === view.index &&
            p.x >= item.cover.x &&
            p.x <= item.cover.x + item.cover.w &&
            p.y >= item.cover.y &&
            p.y <= item.cover.y + item.cover.h,
        );
        const target = hit?.type === "text" ? hit : replaced;
        const run = target ? null : runAt(view.runs, p.x, p.y);
        if (target) this.overlay.startEdit(target.id, caretIndex(target, p.x));
        else if (run) this.editRun(view, run, p.x);
        else this.store.select(null);
        return;
      }

      case "check":
      case "cross": {
        const box = blankAt(view.blanks, p.x, p.y);
        if (box?.kind === "checkbox") {
          this.toggleMark(view, box, this.tool);
          return;
        }
        const size = this.markSize;
        this.store.add({
          ...base,
          type: this.tool,
          x: p.x - size / 2,
          y: p.y - size / 2,
          w: size,
          h: size,
          stroke,
          strokeWidth,
        });
        this.store.commit();
        this.store.select(base.id);
        return;
      }

      case "place": {
        if (!this.pending) return;
        const { src, w, h: height } = this.pending;
        this.store.add({ ...base, type: "image", x: p.x - w / 2, y: p.y - height / 2, w, h: height, src });
        this.store.commit();
        this.setTool("select");
        this.store.select(base.id);
        return;
      }

      case "rect":
      case "ellipse":
        this.store.add({ ...base, type: this.tool, x: p.x, y: p.y, w: 0, h: 0, stroke, fill: this.settings.fill, strokeWidth });
        break;
      case "whiteout":
        this.store.add({ ...base, type: "rect", x: p.x, y: p.y, w: 0, h: 0, stroke: null, fill: "#ffffff", strokeWidth: 0 });
        break;
      case "line":
      case "arrow":
        this.store.add({ ...base, type: this.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, stroke, strokeWidth });
        break;
      case "pen":
        this.store.select(null);
        this.store.add(penItem({ ...base, type: "pen", stroke, strokeWidth }, [p.x, p.y]));
        this.begin(event, { kind: "pen", view, points: [p.x, p.y], id: base.id });
        return;
    }
    this.store.select(null);
    this.begin(event, { kind: "create", view, start: p, id: base.id });
  }

  private newText(view: PageView, x: number, y: number, size: number) {
    const { font, bold, italic, textColor: color } = this.settings;
    const item: TextItem = { id: newId(), page: view.index, type: "text", x, y, text: "", font, size, bold, italic, color };
    this.store.add(item);
    this.overlay.startEdit(item.id);
  }

  /** Starts typing in a detected blank, or carries on with what is already written there. */
  private fillBlank(view: PageView, blank: Blank) {
    const existing = this.store.items.find(
      (item): item is TextItem =>
        item.type === "text" && !item.cover && item.page === view.index && blankAt([blank], item.x + 1, item.y + item.size * 0.6) !== null,
    );
    if (existing) {
      this.overlay.startEdit(existing.id);
      return;
    }
    const { font, bold, italic } = this.settings;
    let size = this.settings.fontSize;
    let x = blank.x + 3;
    let y = blank.y + 3;
    if (blank.kind === "line") {
      // Sit just above the line, the way handwriting would.
      size = Math.min(size, Math.max(6, Math.floor(blank.h * 0.95)));
      x = blank.x + 2;
      y = blank.y + blank.h - Math.max(1.5, size * 0.18) - baseline({ font, size, bold, italic });
    } else if (blank.h < size * LINE_HEIGHT * 2.2) {
      // A box for one line: centre the text in it.
      size = Math.min(size, Math.max(6, Math.floor(blank.h * 0.75)));
      y = blank.y + (blank.h - size * LINE_HEIGHT) / 2;
    }
    this.newText(view, x, y, size);
    document.activeElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Ticks a detected checkbox, or clears it if it is already ticked. */
  private toggleMark(view: PageView, box: Blank, type: "check" | "cross") {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const existing = this.store.items.find(
      (item) =>
        (item.type === "check" || item.type === "cross") &&
        item.page === view.index &&
        Math.abs(item.x + item.w / 2 - cx) < box.w / 2 &&
        Math.abs(item.y + item.h / 2 - cy) < box.h / 2,
    );
    if (existing) {
      this.store.remove(existing.id);
    } else {
      const size = Math.min(box.w, box.h) * 0.9;
      const strokeWidth = Math.min(this.settings.strokeWidth, Math.max(0.8, size / 8));
      this.store.add({ id: newId(), page: view.index, type, x: cx - size / 2, y: cy - size / 2, w: size, h: size, stroke: this.settings.stroke, strokeWidth });
    }
    this.store.select(null);
    this.store.commit();
  }

  /** Tab while typing: move on to the next blank on the page (or the previous one). */
  private tabFrom(item: TextItem, back: boolean) {
    const view = this.viewer.pages[item.page];
    const blanks = (view?.blanks ?? []).filter((blank) => blank.kind !== "checkbox");
    const current = item.cover ? null : blankAt(blanks, item.x + 1, item.y + item.size * 0.6);
    let index: number;
    if (current) {
      index = blanks.indexOf(current) + (back ? -1 : 1);
    } else {
      const after = blanks.findIndex((blank) => blank.y + blank.h > item.y + item.size);
      index = back ? (after < 0 ? blanks.length : after) - 1 : after;
    }
    this.overlay.finishEdit();
    if (view && !item.cover && blanks[index]) this.fillBlank(view, blanks[index]);
  }

  /** Replaces a piece of the document's own text with an editable copy of it. */
  private editRun(view: PageView, run: TextRun, x: number) {
    const { background, ink } = this.viewer.sampleColors(view, run);
    const guess = guessFont(this.viewer.fontName(view, run.fontName), run.fontClass, (def) => !def.files || (isDesktop && isInstalled(def)));
    const style = { ...guess, size: Math.round(run.size * 100) / 100 };
    const item: TextItem = {
      id: newId(),
      page: view.index,
      type: "text",
      x: run.baseX,
      y: run.baseline - baseline(style),
      text: run.text,
      ...style,
      color: ink,
      cover: { x: run.x, y: run.y, w: run.w, h: run.h, color: background, original: run.text },
    };
    this.store.add(item);
    this.overlay.startEdit(item.id, caretIndex(item, x));
  }

  private begin(event: PointerEvent, drag: Drag) {
    this.drag = drag;
    this.viewer.container.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private formFieldAt(clientX: number, clientY: number): HTMLElement | null {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      if (el instanceof HTMLElement && el.matches("input, textarea, select") && el.closest(".annotationLayer")) return el;
    }
    return null;
  }

  private onPointerMove(event: PointerEvent) {
    if (this.tool === "place" && this.pending) this.moveGhost(event);
    const drag = this.drag;
    if (!drag) return;
    const p = this.viewer.pointOn(drag.view, event.clientX, event.clientY);

    if (drag.kind === "move") {
      if (!drag.moved && Math.hypot(event.clientX - drag.client.x, event.clientY - drag.client.y) < MOVE_THRESHOLD) return;
      drag.moved = true;
      this.store.replace(translate(drag.orig, p.x - drag.start.x, p.y - drag.start.y));
    } else if (drag.kind === "resize") {
      this.store.replace(this.resized(drag, p, event.shiftKey));
    } else if (drag.kind === "create") {
      const item = this.store.get(drag.id);
      if (!item) return;
      if (isLine(item)) {
        const end = event.shiftKey ? snapAngle(drag.start, p) : p;
        this.store.replace({ ...item, x2: end.x, y2: end.y });
      } else if (item.type === "rect" || item.type === "ellipse") {
        let w = Math.abs(p.x - drag.start.x);
        let height = Math.abs(p.y - drag.start.y);
        if (event.shiftKey) w = height = Math.max(w, height);
        this.store.replace({
          ...item,
          x: p.x < drag.start.x ? drag.start.x - w : drag.start.x,
          y: p.y < drag.start.y ? drag.start.y - height : drag.start.y,
          w,
          h: height,
        });
      }
    } else {
      const item = this.store.get(drag.id);
      if (item?.type !== "pen") return;
      // Coalesced events carry the positions the browser skipped between frames.
      const samples = event.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event]) {
        const q = this.viewer.pointOn(drag.view, sample.clientX, sample.clientY);
        drag.points.push(q.x, q.y);
      }
      const { id, page, type, stroke, strokeWidth } = item;
      this.store.replace(penItem({ id, page, type, stroke, strokeWidth }, drag.points));
    }
  }

  private resized(drag: Extract<Drag, { kind: "resize" }>, p: Point, shift: boolean): Item {
    const { orig, handle, box } = drag;
    if (isLine(orig)) {
      const first = handle === "p1";
      const other = first ? { x: orig.x2, y: orig.y2 } : { x: orig.x1, y: orig.y1 };
      const end = shift ? snapAngle(other, p) : p;
      return first ? { ...orig, x1: end.x, y1: end.y } : { ...orig, x2: end.x, y2: end.y };
    }
    if (orig.type === "text") {
      // Dragging a corner scales the font; the opposite corner stays put.
      const target = resizeBox(box, handle, p, true);
      const size = Math.min(300, Math.max(4, Math.round(((orig.size * target.h) / box.h) * 2) / 2));
      const factor = size / orig.size;
      return {
        ...orig,
        size,
        x: handle.includes("w") ? box.x + box.w - box.w * factor : box.x,
        y: handle.includes("n") ? box.y + box.h - box.h * factor : box.y,
      };
    }
    const keepAspect = orig.type === "image" || orig.type === "check" || orig.type === "cross" ? !shift : shift;
    return { ...orig, ...resizeBox(box, handle, p, keepAspect) };
  }

  private onPointerUp(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.viewer.container.hasPointerCapture(event.pointerId)) {
      this.viewer.container.releasePointerCapture(event.pointerId);
    }

    if (drag.kind === "create") {
      const item = this.store.get(drag.id);
      const box = item && this.overlay.box(item);
      if (!item || !box || Math.max(box.w, box.h) < 3) {
        this.store.remove(drag.id);
        this.store.commit();
        return;
      }
      this.store.commit();
      this.setTool("select");
      this.store.select(item.id);
      return;
    }
    if (drag.kind === "resize") {
      const item = this.store.get(drag.orig.id);
      if (item?.type === "check" || item?.type === "cross") this.markSize = item.w;
    }
    this.store.commit();
  }

  private onDoubleClick(event: MouseEvent) {
    const id = (event.target as Element).closest<HTMLElement>(".item.text")?.dataset.id;
    if (id && !this.overlay.editingId) this.overlay.startEdit(id, "all");
  }

  private moveGhost(event: PointerEvent) {
    const pending = this.pending!;
    const scale = this.viewer.scale;
    if (!this.ghost.isConnected) document.body.append(this.ghost);
    const style = this.ghost.style;
    style.width = `${pending.w * scale}px`;
    style.height = `${pending.h * scale}px`;
    style.left = `${event.clientX - (pending.w * scale) / 2}px`;
    style.top = `${event.clientY - (pending.h * scale) / 2}px`;
  }

  // ---- keyboard and clipboard ---------------------------------------------

  private onKeyDown(event: KeyboardEvent) {
    if (isTyping(event.target) || document.querySelector("dialog[open]")) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const selected = this.store.selected;

    if (event.ctrlKey || event.metaKey) {
      if (key === "z") event.shiftKey ? this.store.redo() : this.store.undo();
      else if (key === "y") this.store.redo();
      else if (key === "c" && selected) this.clipboard = selected;
      else if (key === "x" && selected) {
        this.clipboard = selected;
        this.deleteSelected();
      } else if (key === "d" && selected) this.pasteItem(selected);
      else return;
      event.preventDefault();
      return;
    }
    if (event.altKey) return;

    if (key === "Delete" || key === "Backspace") {
      this.deleteSelected();
    } else if (key === "Escape") {
      if (this.tool !== "select") this.setTool("select");
      else this.store.select(null);
    } else if (key === "Enter" && selected?.type === "text") {
      this.overlay.startEdit(selected.id, "all");
    } else if (key.startsWith("Arrow") && selected) {
      const step = event.shiftKey ? 10 : 1;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      this.store.replace(translate(selected, dx, dy));
      this.store.commit();
    } else if (TOOL_KEYS[key] && this.viewer.pdf) {
      this.setTool(TOOL_KEYS[key]);
    } else {
      return;
    }
    event.preventDefault();
  }

  deleteSelected() {
    const id = this.store.selectedId;
    if (!id) return;
    this.overlay.finishEdit();
    this.store.remove(id);
    this.store.commit();
  }

  private pasteItem(source: Item) {
    const page = this.viewer.currentPage;
    const offset = source.page === page ? 12 : 0;
    const copy = translate({ ...source, id: newId(), page } as Item, offset, offset);
    this.store.add(copy);
    this.store.commit();
    this.store.select(copy.id);
    // Pasting again steps on from the copy rather than stacking on top of it.
    this.clipboard = copy;
  }

  private onPaste(event: ClipboardEvent) {
    if (isTyping(event.target) || !this.viewer.pdf || document.querySelector("dialog[open]")) return;
    const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) {
      event.preventDefault();
      void imageFromBlob(file).then((image) => image && this.placeImage(image.src, image.w, image.h));
    } else if (this.clipboard) {
      event.preventDefault();
      this.pasteItem(this.clipboard);
    }
  }
}

/**
 * Reads a picture and returns it as a PNG data URL with a size in points that
 * fits comfortably on a page.
 */
export async function imageFromBlob(blob: Blob, maxWidth = 240): Promise<{ src: string; w: number; h: number } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  const limit = 2000;
  const shrink = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * shrink);
  canvas.height = Math.round(bitmap.height * shrink);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const w = Math.min(maxWidth, canvas.width * 0.75);
  return { src: canvas.toDataURL("image/png"), w, h: (w * canvas.height) / canvas.width };
}

