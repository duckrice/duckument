// Draws the added items on top of the pages and the handles around the
// selected one. Item coordinates are PDF points; the page's overlay element is
// scaled as a whole, so nothing here needs to know the zoom level.

import { h, svg } from "./dom";
import { isLine, type Box, type Item, type TextItem } from "./model";
import { paints, svgPath } from "./shapes";
import type { Store } from "./store";
import { cssFont } from "./textmetrics";
import type { Viewer } from "./viewer";

type ItemElement = HTMLElement | SVGSVGElement;

interface Rendered {
  el: ItemElement;
  item: Item | null;
}

const BOX_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** Extra stroke width, in points, that makes thin lines easier to grab. */
const HIT_SLOP = 8;

export class Overlay {
  /** The text item being typed into, if any. */
  editingId: string | null = null;

  private rendered = new Map<string, Rendered>();
  private selection = h("div", { class: "selection" });
  private boxHandles = BOX_HANDLES.map((name) => h("div", { class: `handle ${name}`, "data-handle": name }));
  private lineHandles = ["p1", "p2"].map((name) => h("div", { class: "handle", "data-handle": name }));
  private editor = h("textarea", { class: "text-editor", spellcheck: "false", rows: 1, wrap: "off" });
  private sizer = h("span", { class: "text-sizer" });

  constructor(
    private store: Store,
    private viewer: Viewer,
  ) {
    this.editor.addEventListener("input", () => {
      const item = this.editingItem();
      if (item) this.store.replace({ ...item, text: this.editor.value });
    });
    this.editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.finishEdit();
      }
    });
    this.editor.addEventListener("blur", () => this.finishEdit());
    store.subscribe(() => this.sync());
  }

  /** Forgets every element; call when the pages have been rebuilt. */
  clear() {
    this.editingId = null;
    this.rendered.clear();
    this.selection.remove();
  }

  sync() {
    const ids = new Set(this.store.items.map((item) => item.id));
    for (const [id, record] of this.rendered) {
      if (!ids.has(id)) {
        record.el.remove();
        this.rendered.delete(id);
      }
    }

    // Keep each page's elements in the same order as the items, so what
    // overlaps what on screen matches the saved file.
    const cursors = new Map<HTMLElement, Element | null>();
    for (const item of this.store.items) {
      const host = this.viewer.pages[item.page]?.items;
      if (!host) continue;
      let record = this.rendered.get(item.id);
      if (!record) {
        record = { el: this.create(item), item: null };
        this.rendered.set(item.id, record);
      }
      if (record.item !== item) {
        this.update(record.el, item);
        record.item = item;
      }
      const cursor = cursors.has(host) ? cursors.get(host)! : host.firstElementChild;
      if (record.el === cursor) cursors.set(host, cursor.nextElementSibling);
      else {
        host.insertBefore(record.el, cursor);
        cursors.set(host, cursor);
      }
    }
    this.syncSelection();
  }

  private create(item: Item): ItemElement {
    if (item.type === "text") return h("div", { class: "item text", "data-id": item.id });
    if (item.type === "image") return h("img", { class: "item image", "data-id": item.id, draggable: "false" });
    return svg("svg", { class: "item shape", "data-id": item.id, width: 1, height: 1 });
  }

  private update(el: ItemElement, item: Item) {
    if (item.type === "text") {
      const style = (el as HTMLElement).style;
      style.left = `${item.x}px`;
      style.top = `${item.y}px`;
      style.font = cssFont(item);
      style.color = item.color;
      // A trailing zero-width space keeps an empty last line from collapsing.
      if (this.editingId === item.id) this.sizer.textContent = `${item.text}​`;
      else el.textContent = item.text;
    } else if (item.type === "image") {
      const img = el as HTMLImageElement;
      img.style.left = `${item.x}px`;
      img.style.top = `${item.y}px`;
      img.style.width = `${item.w}px`;
      img.style.height = `${item.h}px`;
      if (img.getAttribute("src") !== item.src) img.src = item.src;
    } else {
      const nodes: SVGPathElement[] = [];
      for (const paint of paints(item)) {
        const d = svgPath(paint.cmds);
        const join = paint.round ? "round" : "miter";
        nodes.push(
          svg("path", {
            d,
            fill: paint.fill ?? "none",
            stroke: paint.stroke ?? "none",
            "stroke-width": paint.width,
            "stroke-linecap": paint.round ? "round" : "butt",
            "stroke-linejoin": join,
            "pointer-events": "none",
          }),
          // Invisible, wider copy that receives the pointer.
          svg("path", {
            d,
            fill: paint.fill ? "transparent" : "none",
            stroke: "transparent",
            "stroke-width": paint.width + HIT_SLOP,
            "stroke-linecap": "round",
            "stroke-linejoin": join,
            "pointer-events": paint.fill ? "all" : "stroke",
          }),
        );
      }
      el.replaceChildren(...nodes);
    }
  }

  /** The item's bounding box in page points. */
  box(item: Item): Box {
    if (isLine(item)) {
      const x = Math.min(item.x1, item.x2);
      const y = Math.min(item.y1, item.y2);
      return { x, y, w: Math.abs(item.x2 - item.x1), h: Math.abs(item.y2 - item.y1) };
    }
    if (item.type === "text") {
      const el = this.rendered.get(item.id)?.el;
      const rect = el?.getBoundingClientRect();
      const scale = this.viewer.scale;
      return { x: item.x, y: item.y, w: rect ? rect.width / scale : 0, h: rect ? rect.height / scale : item.size };
    }
    return { x: item.x, y: item.y, w: item.w, h: item.h };
  }

  private syncSelection() {
    const item = this.store.selected;
    const chrome = item && this.viewer.pages[item.page]?.chrome;
    if (!item || !chrome) {
      this.selection.remove();
      return;
    }
    if (this.selection.parentNode !== chrome) chrome.append(this.selection);

    const style = this.selection.style;
    if (isLine(item)) {
      this.selection.className = "selection line";
      style.left = style.top = "0";
      style.width = style.height = "0";
      this.lineHandles[0].style.cssText = `left:${item.x1}px;top:${item.y1}px`;
      this.lineHandles[1].style.cssText = `left:${item.x2}px;top:${item.y2}px`;
      if (this.lineHandles[0].parentNode !== this.selection) this.selection.replaceChildren(...this.lineHandles);
      return;
    }

    const box = this.box(item);
    const cornersOnly = item.type === "text" || item.type === "image" || item.type === "check" || item.type === "cross";
    this.selection.className = `selection box${cornersOnly ? " corners-only" : ""}${
      this.editingId === item.id ? " editing" : ""
    }`;
    style.left = `${box.x}px`;
    style.top = `${box.y}px`;
    style.width = `${box.w}px`;
    style.height = `${box.h}px`;
    if (this.boxHandles[0].parentNode !== this.selection) this.selection.replaceChildren(...this.boxHandles);
  }

  // ---- text editing -------------------------------------------------------

  private editingItem(): TextItem | undefined {
    const item = this.editingId ? this.store.get(this.editingId) : undefined;
    return item?.type === "text" ? item : undefined;
  }

  startEdit(id: string, selectAll = false) {
    if (this.editingId === id) return;
    this.finishEdit();
    const item = this.store.get(id);
    const el = this.rendered.get(id)?.el;
    if (item?.type !== "text" || !el) return;

    this.editingId = id;
    this.store.select(id);
    el.classList.add("editing");
    this.sizer.textContent = `${item.text}​`;
    this.editor.value = item.text;
    el.replaceChildren(this.sizer, this.editor);
    this.editor.focus({ preventScroll: true });
    if (selectAll) this.editor.select();
    else this.editor.setSelectionRange(item.text.length, item.text.length);
    this.syncSelection();
  }

  /** Ends typing. Text left empty is removed; anything else becomes an undo step. */
  finishEdit() {
    const item = this.editingItem();
    const id = this.editingId;
    if (!id) return;
    this.editingId = null;

    const record = this.rendered.get(id);
    if (record) {
      record.el.classList.remove("editing");
      // Forces the element to be redrawn as plain text.
      record.item = null;
    }
    if (item) {
      const text = item.text.replace(/\s+$/, "");
      if (!text) this.store.remove(id);
      else if (text !== item.text) this.store.replace({ ...item, text });
    }
    this.store.commit();
    this.sync();
  }
}
