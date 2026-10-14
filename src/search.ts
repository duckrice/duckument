// Ctrl+F: finds text in the active document, highlights every match and steps
// through them.

import { h } from "./dom";
import { findInPieces, normalizeQuery, type TextMatch } from "./findtext";
import { icon } from "./icons";
import type { PageView, Viewer } from "./viewer";

interface Hit {
  page: number;
  match: TextMatch;
}

export class SearchBar {
  readonly el: HTMLElement;
  private input = h("input", { type: "search", class: "search-input", placeholder: "Find in document", spellcheck: "false", "aria-label": "Find in document" });
  private status = h("span", { class: "search-status", "aria-live": "polite" });
  private viewer: Viewer | null = null;
  private hits: Hit[] = [];
  private current = -1;
  private query = "";
  /** The page list the hits were found in; a different one means pages moved. */
  private searchedPages: PageView[] = [];
  private generation = 0;
  private timer = 0;
  /** The page whose current match should be scrolled to once its text is laid out. */
  private scrollPending = -1;

  constructor() {
    const button = (name: Parameters<typeof icon>[0], title: string, onclick: () => void) =>
      h("button", { type: "button", class: "tb small", title, onclick, html: icon(name, 16) });
    this.el = h(
      "div",
      { class: "search-bar", hidden: true, role: "search" },
      this.input,
      this.status,
      button("up", "Previous match (Shift+Enter)", () => this.step(-1)),
      button("down", "Next match (Enter)", () => this.step(1)),
      button("cross", "Close (Esc)", () => this.close()),
    );
    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(), 200);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.step(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.input.focus();
    this.input.select();
    if (normalizeQuery(this.input.value) !== this.query) void this.run();
  }

  close() {
    this.el.hidden = true;
    this.generation++;
    this.clearHighlights();
    this.hits = [];
    this.current = -1;
    this.query = "";
    this.status.textContent = "";
  }

  /** Searches another document from now on (null when none is open). */
  setViewer(viewer: Viewer | null) {
    if (viewer === this.viewer) return;
    this.clearHighlights();
    this.viewer?.container.removeEventListener("textlayer", this.onTextLayer);
    this.viewer = viewer;
    viewer?.container.addEventListener("textlayer", this.onTextLayer);
    this.hits = [];
    this.current = -1;
    this.query = "";
    if (this.isOpen) void this.run();
  }

  private onTextLayer = (event: Event) => {
    const view = (event as CustomEvent<PageView>).detail;
    this.drawPage(view);
  };

  private async run() {
    const viewer = this.viewer;
    const query = normalizeQuery(this.input.value);
    const generation = ++this.generation;
    this.clearHighlights();
    this.hits = [];
    this.current = -1;
    this.query = query;
    this.searchedPages = viewer?.pages ?? [];
    if (!viewer || !query) {
      this.status.textContent = "";
      return;
    }
    this.status.textContent = "Searching…";
    const pages = viewer.pages.length;
    for (let page = 0; page < pages; page++) {
      const pieces = await viewer.pageText(page);
      if (generation !== this.generation) return;
      for (const match of findInPieces(pieces, query)) this.hits.push({ page, match });
    }
    if (!this.hits.length) {
      this.status.textContent = "Not found";
      return;
    }
    // Start from the page being read.
    const from = this.hits.findIndex((hit) => hit.page >= viewer.currentPage);
    this.current = from < 0 ? 0 : from;
    for (const view of viewer.pages) this.drawPage(view);
    this.show();
  }

  /** Moves to the next (1) or previous (-1) match. */
  step(direction: number) {
    if (this.viewer && this.viewer.pages !== this.searchedPages) {
      // Pages were moved or deleted since searching; look again.
      void this.run();
      return;
    }
    if (!this.hits.length) return;
    const before = this.hits[this.current]?.page;
    this.current = (this.current + direction + this.hits.length) % this.hits.length;
    if (before !== undefined && this.viewer?.pages[before]) this.drawPage(this.viewer.pages[before]);
    this.show();
  }

  /** Updates the count and brings the current match into view. */
  private show() {
    const hit = this.hits[this.current];
    this.status.textContent = `${this.current + 1} of ${this.hits.length}`;
    const view = this.viewer?.pages[hit.page];
    if (!view) return;
    this.scrollPending = hit.page;
    if (view.textLayer && view.hits.childElementCount) this.drawPage(view);
    else view.el.scrollIntoView({ block: "start" });
  }

  private clearHighlights() {
    for (const view of this.viewer?.pages ?? []) view.hits.replaceChildren();
  }

  /** Highlights the matches on one page, if its text has been laid out. */
  private drawPage(view: PageView) {
    view.hits.replaceChildren();
    const layer = view.textLayer;
    const viewer = this.viewer;
    if (!layer || !viewer || !this.query) return;
    const onPage = this.hits.map((hit, index) => ({ hit, index })).filter(({ hit }) => hit.page === view.index);
    if (!onPage.length) return;

    // Pair each piece of the page's text with the element showing it.
    const pieces = view.text ?? [];
    const strings = layer.textContentItemsStr;
    const divs = layer.textDivs;
    const elementOf: number[] = [];
    let j = 0;
    for (let i = 0; i < pieces.length; i++) {
      let k = j;
      while (k < strings.length && strings[k] !== pieces[i].str) k++;
      if (k < strings.length) {
        elementOf[i] = k;
        j = k + 1;
      } else elementOf[i] = -1;
    }

    let scrollTo: HTMLElement | null = null;
    for (const { hit, index } of onPage) {
      const isCurrent = index === this.current;
      const { start, end } = hit.match;
      for (let piece = start.piece; piece <= end.piece; piece++) {
        const div = divs[elementOf[piece]];
        const node = div?.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        const length = node.textContent!.length;
        const range = document.createRange();
        range.setStart(node, Math.min(piece === start.piece ? start.offset : 0, length));
        range.setEnd(node, Math.min(piece === end.piece ? end.offset : length, length));
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const a = viewer.pointOn(view, rect.left, rect.top);
          const b = viewer.pointOn(view, rect.right, rect.bottom);
          const box = h("div", {
            class: `hit${isCurrent ? " current" : ""}`,
            style: `left:${Math.min(a.x, b.x)}px;top:${Math.min(a.y, b.y)}px;width:${Math.abs(b.x - a.x)}px;height:${Math.abs(b.y - a.y)}px`,
          });
          view.hits.append(box);
          if (isCurrent) scrollTo ??= box;
        }
      }
    }
    if (scrollTo && this.scrollPending === view.index) {
      this.scrollPending = -1;
      scrollTo.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }
}
