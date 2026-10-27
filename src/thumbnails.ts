// The page sidebar: a small picture of every page, to jump around, select
// pages, drag them into a new order, and turn, delete, add or save them.

import type { PDFPageProxy } from "pdfjs-dist";
import { h } from "./dom";
import { icon } from "./icons";
import type { PageRef } from "./model";
import type { Store } from "./store";
import type { Viewer } from "./viewer";

/** What the sidebar works on; DocTab provides it. */
export interface ThumbnailHost {
  store: Store;
  viewer: Viewer;
  rotatePages(ids: string[], degrees: number): void;
  deletePages(ids: string[]): void;
  movePages(ids: string[], to: number): void;
  insertBlankPage(at: number): void;
  addPdf(at: number): Promise<void>;
  extractPages(ids: string[]): Promise<void>;
}

/** Width of a thumbnail picture in CSS pixels. */
const WIDTH = 116;

interface Thumb {
  el: HTMLElement;
  picture: HTMLElement;
  number: HTMLElement;
  /** Identifies what the current picture shows, to know when to redraw it. */
  drawn: string;
}

export class Thumbnails {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private thumbs = new Map<string, Thumb>();
  private selected = new Set<string>();
  /** Where a Shift-click range starts. */
  private anchor: string | null = null;
  private observer: IntersectionObserver;
  private visible = new Set<string>();
  private drawing = false;
  private indicator = h("div", { class: "thumb-drop" });

  constructor(private host: ThumbnailHost) {
    const button = (name: Parameters<typeof icon>[0], title: string, onclick: () => void) =>
      h("button", { type: "button", class: "tb small", title, onclick, html: icon(name, 16) });
    const tools = h(
      "div",
      { class: "thumb-tools" },
      button("rotateLeft", "Turn left", () => host.rotatePages(this.targets(), -90)),
      button("rotateRight", "Turn right", () => host.rotatePages(this.targets(), 90)),
      button("trash", "Delete pages (Del)", () => this.deleteTargets()),
      button("pageAdd", "Insert a blank page", () => host.insertBlankPage(this.insertionPoint())),
      button("merge", "Add pages from another PDF", () => void host.addPdf(this.insertionPoint())),
      button("extract", "Save the selected pages as a new PDF", () => void host.extractPages(this.targets())),
    );
    this.list = h("div", { class: "thumb-list", tabindex: 0, role: "listbox", "aria-label": "Pages", "aria-multiselectable": "true" });
    this.el = h("aside", { class: "thumbs" }, tools, this.list);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.id!;
          if (entry.isIntersecting) this.visible.add(id);
          else this.visible.delete(id);
        }
        void this.drawNext();
      },
      { root: this.list, rootMargin: "200px 0px" },
    );

    this.list.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.list.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  /** The selected pages, or the current one when none are selected, in document order. */
  private targets(): string[] {
    const pages = this.host.store.pages;
    const chosen = pages.filter((page) => this.selected.has(page.id)).map((page) => page.id);
    if (chosen.length) return chosen;
    const current = pages[this.host.viewer.currentPage];
    return current ? [current.id] : [];
  }

  /** New pages go after the last selected page, or after the current one. */
  private insertionPoint(): number {
    const pages = this.host.store.pages;
    const ids = this.targets();
    const last = Math.max(...ids.map((id) => pages.findIndex((page) => page.id === id)));
    return last < 0 ? pages.length : last + 1;
  }

  private deleteTargets() {
    const ids = this.targets();
    this.host.deletePages(ids);
    for (const id of ids) this.selected.delete(id);
  }

  /** Brings the sidebar in line with the document's pages. */
  update() {
    const pages = this.host.store.pages;
    const seen = new Set<string>();
    let cursor = this.list.firstElementChild;
    pages.forEach((ref, index) => {
      seen.add(ref.id);
      let thumb = this.thumbs.get(ref.id);
      if (!thumb) {
        thumb = this.create(ref);
        this.thumbs.set(ref.id, thumb);
        this.observer.observe(thumb.el);
      }
      const view = this.host.viewer.pages[index];
      // The picture keeps the page's shape, turned as the user turned it.
      const size = view ? { w: view.width, h: view.height } : { w: 595, h: 842 };
      const turned = ref.rotation % 180 !== 0;
      const aspect = turned ? size.w / size.h : size.h / size.w;
      thumb.picture.style.height = `${Math.round(WIDTH * aspect)}px`;
      thumb.number.textContent = String(index + 1);
      thumb.el.classList.toggle("current", index === this.host.viewer.currentPage);
      thumb.el.classList.toggle("selected", this.selected.has(ref.id));
      thumb.el.setAttribute("aria-selected", String(this.selected.has(ref.id)));
      if (thumb.el === cursor) cursor = cursor.nextElementSibling;
      else this.list.insertBefore(thumb.el, cursor);
    });
    for (const [id, thumb] of this.thumbs) {
      if (seen.has(id)) continue;
      this.observer.unobserve(thumb.el);
      thumb.el.remove();
      this.thumbs.delete(id);
      this.selected.delete(id);
      this.visible.delete(id);
    }
    void this.drawNext();
  }

  private create(ref: PageRef): Thumb {
    const picture = h("div", { class: "thumb-picture" });
    const number = h("span", { class: "thumb-number" });
    const el = h("div", { class: "thumb", role: "option", "data-id": ref.id }, picture, number);
    return { el, picture, number, drawn: "" };
  }

  /** Draws the visible thumbnails that are missing or out of date, one at a time. */
  private async drawNext() {
    if (this.drawing) return;
    const pages = this.host.store.pages;
    const next = pages.find((ref) => this.visible.has(ref.id) && this.thumbs.get(ref.id)?.drawn !== this.key(ref));
    if (!next) return;
    this.drawing = true;
    try {
      await this.draw(next);
    } catch (error) {
      console.warn("Could not draw a page thumbnail", error);
      const thumb = this.thumbs.get(next.id);
      if (thumb) thumb.drawn = this.key(next);
    } finally {
      this.drawing = false;
    }
    void this.drawNext();
  }

  private key(ref: PageRef) {
    return `${ref.rotation}@${window.devicePixelRatio}`;
  }

  private async draw(ref: PageRef) {
    const thumb = this.thumbs.get(ref.id);
    if (!thumb) return;
    const key = this.key(ref);
    if (ref.blank) {
      thumb.picture.replaceChildren();
      thumb.drawn = key;
      return;
    }
    const source = this.host.viewer.sources.get(ref.source);
    if (!source) return;
    const page: PDFPageProxy = await source.getPage(ref.index + 1);
    const rotation = (page.rotate + ref.rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const density = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (WIDTH * density) / base.width, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    if (!this.thumbs.has(ref.id)) return;
    thumb.picture.replaceChildren(canvas);
    thumb.drawn = key;
  }

  // ---- selecting and dragging ---------------------------------------------

  private onPointerDown(event: PointerEvent) {
    const el = (event.target as Element).closest<HTMLElement>(".thumb");
    if (!el || event.button !== 0) return;
    const id = el.dataset.id!;
    const pages = this.host.store.pages;
    const index = pages.findIndex((page) => page.id === id);

    if (event.shiftKey && this.anchor) {
      const from = pages.findIndex((page) => page.id === this.anchor);
      const [a, b] = from < index ? [from, index] : [index, from];
      this.selected = new Set(pages.slice(a, b + 1).map((page) => page.id));
    } else if (event.ctrlKey || event.metaKey) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.anchor = id;
    } else {
      if (!this.selected.has(id)) this.selected = new Set([id]);
      this.anchor = id;
      this.host.viewer.scrollToPage(index);
    }
    this.update();
    this.startDrag(event, id);
  }

  /** A press that moves far enough becomes a drag; dropping moves the selected pages there. */
  private startDrag(event: PointerEvent, id: string) {
    const startY = event.clientY;
    let dragging = false;
    let target = -1;
    const move = (e: PointerEvent) => {
      if (!dragging && Math.abs(e.clientY - startY) < 6) return;
      if (!dragging) {
        dragging = true;
        if (!this.selected.has(id)) this.selected = new Set([id]);
        this.list.classList.add("dragging");
      }
      target = this.dropIndex(e.clientY);
      const thumbs = [...this.list.querySelectorAll<HTMLElement>(".thumb")];
      const before = thumbs[target];
      const top = before ? before.offsetTop - 5 : (thumbs.at(-1)?.offsetTop ?? 0) + (thumbs.at(-1)?.offsetHeight ?? 0) + 3;
      this.indicator.style.top = `${top}px`;
      if (!this.indicator.isConnected) this.list.append(this.indicator);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.indicator.remove();
      this.list.classList.remove("dragging");
      if (dragging && target >= 0) this.host.movePages(this.targets(), target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Where pages dropped at this point of the window would go, or null when it isn't over the page list. */
  dropTarget(clientX: number, clientY: number): number | null {
    const rect = this.list.getBoundingClientRect();
    if (!rect.width || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    return this.dropIndex(clientY);
  }

  /** The position a page dropped at this height would take. */
  private dropIndex(clientY: number): number {
    const thumbs = [...this.list.querySelectorAll<HTMLElement>(".thumb")];
    for (let i = 0; i < thumbs.length; i++) {
      const rect = thumbs[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return thumbs.length;
  }

  private onKeyDown(event: KeyboardEvent) {
    const pages = this.host.store.pages;
    if (event.key === "Delete" || event.key === "Backspace") {
      this.deleteTargets();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      this.selected = new Set(pages.map((page) => page.id));
      this.update();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const current = this.host.viewer.currentPage;
      const next = Math.max(0, Math.min(pages.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      this.selected = new Set([pages[next].id]);
      this.anchor = pages[next].id;
      this.host.viewer.scrollToPage(next);
      this.update();
    } else if (event.key === "Escape") {
      this.selected.clear();
      this.update();
    } else {
      return;
    }
    // Keys used here don't also act on the document.
    event.preventDefault();
    event.stopPropagation();
  }

  dispose() {
    this.observer.disconnect();
  }
}
