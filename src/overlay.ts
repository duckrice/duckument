// Draws the added items on top of the pages and the handles around the
// selected one. Item coordinates are PDF points; the page's overlay element is
// scaled as a whole, so nothing here needs to know the zoom level.

import { h, svg } from "./dom";
import { NOTE_SIZE, isLine, isMarkup, type Box, type Item, type NoteItem, type TextItem } from "./model";
import { markBars, paints, svgPath } from "./shapes";
import type { Store } from "./store";
import { cssFont, linesOf } from "./textmetrics";
import type { Viewer } from "./viewer";
import { STAMP_LINE, STAMP_PAD } from "./stamps";

type ItemElement = HTMLElement | SVGSVGElement;

interface Rendered {
  el: ItemElement;
  item: Item | null;
  /** The patch hiding the original text, for text that replaces some. */
  cover: HTMLElement | null;
  /** What a highlight, underline or strike-through paints, blended with the page. */
  paint: HTMLElement | null;
}

const BOX_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** Extra stroke width, in points, that makes thin lines easier to grab. */
const HIT_SLOP = 8;

export class Overlay {
  /** The text item being typed into, if any. */
  editingId: string | null = null;
  /** Called when Tab is pressed while typing; `back` is true with Shift. */
  onTab: ((item: TextItem, back: boolean) => void) | null = null;

  private rendered = new Map<string, Rendered>();
  private selection = h("div", { class: "selection" });
  private boxHandles = BOX_HANDLES.map((name) => h("div", { class: `handle ${name}`, "data-handle": name }));
  private lineHandles = ["p1", "p2"].map((name) => h("div", { class: "handle", "data-handle": name }));
  private editor = h("textarea", { class: "text-editor", spellcheck: "false", rows: 1, wrap: "off" });
  /** The comment of the selected note. */
  private notePopup = h("div", { class: "note-popup" });
  private noteText = h("textarea", { class: "note-text", placeholder: "Write a comment", rows: 4 });
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
      } else if (event.key === "Tab") {
        const item = this.editingItem();
        if (item && this.onTab) {
          event.preventDefault();
          this.onTab(item, event.shiftKey);
        }
      }
    });
    this.editor.addEventListener("blur", () => this.finishEdit());
    this.notePopup.append(this.noteText);
    this.noteText.addEventListener("input", () => {
      const note = this.store.selected;
      if (note?.type === "note") this.store.replace({ ...note, text: this.noteText.value });
    });
    this.noteText.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.noteText.blur();
      }
    });
    this.noteText.addEventListener("blur", () => this.finishNote());
    // Presses inside the comment box are for the text, not the page underneath.
    this.notePopup.addEventListener("pointerdown", (event) => event.stopPropagation());
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
        record.cover?.remove();
        record.paint?.remove();
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
        record = { el: this.create(item), item: null, cover: null, paint: null };
        this.rendered.set(item.id, record);
      }
      if (record.item !== item) {
        this.update(record.el, item);
        this.updateCover(record, item);
        this.updatePaint(record, item);
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
    if (isMarkup(item)) return h("div", { class: "item markup", "data-id": item.id });
    if (item.type === "note") return h("div", { class: "item note", "data-id": item.id, title: "Comment", html: NOTE_ICON });
    return svg("svg", { class: "item shape", "data-id": item.id, width: 1, height: 1 });
  }

  private update(el: ItemElement, item: Item) {
    if (item.type === "text") {
      const style = (el as HTMLElement).style;
      style.left = `${item.x}px`;
      style.top = `${item.y}px`;
      style.font = cssFont(item);
      style.color = item.color;
      style.transformOrigin = item.angle ? "0 0" : "";
      style.transform = item.angle ? `rotate(${-item.angle}deg)` : "";
      style.opacity = item.opacity !== undefined ? String(item.opacity) : "";
      style.outline = item.frame ? `${STAMP_LINE}px solid ${item.color}` : "";
      style.outlineOffset = item.frame ? `${STAMP_PAD}px` : "";
      style.borderRadius = item.frame ? "2px" : "";
      const wrapped = item.width !== undefined;
      el.classList.toggle("paragraph", wrapped);
      style.width = wrapped ? `${item.width}px` : "";
      style.textIndent = wrapped && item.indent ? `${item.indent}px` : "";
      style.textAlign = wrapped && item.align === "justify" ? "justify" : "";
      // A trailing zero-width space keeps an empty last line from collapsing.
      if (this.editingId === item.id) this.sizer.textContent = `${item.text}​`;
      else if (wrapped) {
        // The same lines the saved file will have.
        el.replaceChildren(
          ...linesOf(item).map((line) =>
            h("div", { class: `line${line.words ? " spread" : ""}`, style: line.x ? `padding-left:${line.x}px` : "" }, line.text || "​"),
          ),
        );
      } else el.textContent = item.text;
    } else if (isMarkup(item)) {
      // Transparent boxes that take the pointer; the colour is painted in the page's blend layer.
      el.replaceChildren(
        ...item.rects.map((r) => h("div", { class: "markup-hit", style: `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px` })),
      );
    } else if (item.type === "note") {
      const style = (el as HTMLElement).style;
      style.left = `${item.x}px`;
      style.top = `${item.y}px`;
      style.color = item.color;
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

  private updateCover(record: Rendered, item: Item) {
    const cover = item.type === "text" ? item.cover : undefined;
    const host = this.viewer.pages[item.page]?.covers;
    if (!cover || !host) {
      record.cover?.remove();
      record.cover = null;
      return;
    }
    record.cover ??= h("div", { class: "cover" });
    if (record.cover.parentNode !== host) host.append(record.cover);
    record.cover.style.cssText = `left:${cover.x}px;top:${cover.y}px;width:${cover.w}px;height:${cover.h}px;background:${cover.color}`;
  }

  private updatePaint(record: Rendered, item: Item) {
    const host = this.viewer.pages[item.page]?.marks;
    if (!isMarkup(item) || !host) {
      record.paint?.remove();
      record.paint = null;
      return;
    }
    record.paint ??= h("div", { class: "markup-paint" });
    if (record.paint.parentNode !== host) host.append(record.paint);
    record.paint.replaceChildren(
      ...markBars(item).map((b) =>
        h("div", { style: `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background:${item.color}` }),
      ),
    );
  }

  /** The item's bounding box in page points. */
  box(item: Item): Box {
    if (isLine(item)) {
      const x = Math.min(item.x1, item.x2);
      const y = Math.min(item.y1, item.y2);
      return { x, y, w: Math.abs(item.x2 - item.x1), h: Math.abs(item.y2 - item.y1) };
    }
    if (isMarkup(item)) {
      const left = Math.min(...item.rects.map((r) => r.x));
      const top = Math.min(...item.rects.map((r) => r.y));
      const right = Math.max(...item.rects.map((r) => r.x + r.w));
      const bottom = Math.max(...item.rects.map((r) => r.y + r.h));
      return { x: left, y: top, w: right - left, h: bottom - top };
    }
    if (item.type === "note") return { x: item.x, y: item.y, w: NOTE_SIZE, h: NOTE_SIZE };
    if (item.type === "text") {
      const el = this.rendered.get(item.id)?.el;
      const rect = el?.getBoundingClientRect();
      const scale = this.viewer.scale;
      // On a page turned sideways the text's box is measured sideways too.
      const turned = (this.viewer.pages[item.page]?.ref.rotation ?? 0) % 180 !== 0;
      const w = rect ? (turned ? rect.height : rect.width) / scale : 0;
      const h = rect ? (turned ? rect.width : rect.height) / scale : item.size;
      return { x: item.x, y: item.y, w, h };
    }
    return { x: item.x, y: item.y, w: item.w, h: item.h };
  }

  private syncSelection() {
    const item = this.store.selected;
    const chrome = item && this.viewer.pages[item.page]?.chrome;
    this.syncNotePopup(item?.type === "note" ? item : null);
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
    // Marks follow the text they were made on, and notes are a fixed size: neither is resized.
    const fixed = isMarkup(item) || item.type === "note";
    this.selection.className = `selection box${cornersOnly ? " corners-only" : ""}${fixed ? " fixed" : ""}${
      this.editingId === item.id ? " editing" : ""
    }`;
    style.left = `${box.x}px`;
    style.top = `${box.y}px`;
    style.width = `${box.w}px`;
    style.height = `${box.h}px`;
    if (this.boxHandles[0].parentNode !== this.selection) this.selection.replaceChildren(...this.boxHandles);
  }

  // ---- notes ----------------------------------------------------------------

  private syncNotePopup(note: NoteItem | null) {
    const chrome = note && this.viewer.pages[note.page]?.chrome;
    if (!note || !chrome) {
      if (this.notePopup.isConnected) this.notePopup.remove();
      return;
    }
    if (this.notePopup.parentNode !== chrome) chrome.append(this.notePopup);
    // Beside the icon, on whichever side keeps it on the page.
    const view = this.viewer.pages[note.page];
    const { offsetWidth: w, offsetHeight: h } = this.notePopup;
    const right = note.x + NOTE_SIZE + 6;
    const left = right + w > view.width ? Math.max(0, note.x - 6 - w) : right;
    this.notePopup.style.left = `${left}px`;
    this.notePopup.style.top = `${Math.max(0, Math.min(note.y, view.height - h))}px`;
    this.notePopup.style.borderColor = note.color;
    if (document.activeElement !== this.noteText) this.noteText.value = note.text;
  }

  /** Puts the cursor in the comment of a note, which must be selected. */
  editNote(id: string) {
    this.store.select(id);
    this.syncSelection();
    this.noteText.focus({ preventScroll: true });
    this.noteText.setSelectionRange(this.noteText.value.length, this.noteText.value.length);
  }

  /** A note left empty is removed; anything else becomes an undo step. */
  private finishNote() {
    const note = this.store.selected;
    if (note?.type === "note" && !note.text.trim()) this.store.remove(note.id);
    this.store.commit();
  }

  // ---- text editing -------------------------------------------------------

  private editingItem(): TextItem | undefined {
    const item = this.editingId ? this.store.get(this.editingId) : undefined;
    return item?.type === "text" ? item : undefined;
  }

  /** @param caret where to put the cursor: a character index, "all" to select everything, or the end. */
  startEdit(id: string, caret: number | "all" | "end" = "end") {
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
    // A paragraph wraps while typing; a plain text item only breaks at Enter.
    this.editor.wrap = item.width !== undefined ? "soft" : "off";
    el.replaceChildren(this.sizer, this.editor);
    this.editor.focus({ preventScroll: true });
    if (caret === "all") this.editor.select();
    else {
      const index = caret === "end" ? item.text.length : Math.min(caret, item.text.length);
      this.editor.setSelectionRange(index, index);
    }
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
      // Text replacing part of the document stays even when emptied: that is
      // how the original is deleted. Opening it without changing it is a no-op.
      const untouched = item.cover && !this.store.isCommitted(id) && text === item.cover.original;
      if (untouched || (!text && !item.cover)) this.store.remove(id);
      else if (text !== item.text) this.store.replace({ ...item, text });
      // Emptied text has nothing to show a selection around.
      if (!text) this.store.select(null);
    }
    this.store.commit();
    this.sync();
  }
}

/** A speech bubble, filled with the note's colour. */
const NOTE_ICON =
  '<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="currentColor" stroke="rgb(0 0 0 / 0.55)" stroke-width="1.2"/><path d="M7 8h10M7 12h7" stroke="rgb(0 0 0 / 0.55)" stroke-width="1.5" stroke-linecap="round"/></svg>';
