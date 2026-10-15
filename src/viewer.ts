// Shows a document's pages in a scrolling column. The pages can come from
// several PDFs, in any order and turned any way (see PageRef). Only pages near
// the viewport are rendered, and zooming rescales what's on screen immediately
// while sharp versions are drawn in the background.

import {
  AnnotationLayer,
  AnnotationMode,
  GlobalWorkerOptions,
  PasswordResponses,
  RenderingCancelledException,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { detectBlanks, type Blank } from "./blanks";
import { h } from "./dom";
import type { Matrix } from "./export";
import type { TextPiece } from "./findtext";
import type { FontEvidence } from "./fontmatch";
import type { Box, PageRef } from "./model";
import { findParagraphs, type Paragraph } from "./paragraphs";
import { buildRuns, type TextRun } from "./textruns";

GlobalWorkerOptions.workerSrc = workerUrl;

/** CSS pixels per PDF point at 100% zoom. */
const CSS_UNITS = 96 / 72;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
/** Largest canvas drawn for one page; beyond it the page is upscaled instead. */
const MAX_CANVAS_PIXELS = 4096 * 4096;
/** Canvases further than this many pages from the current one are released. */
const KEEP_PAGES = 8;
/** Resolution, in pixels per point, of the picture blanks are looked for in. */
const BLANK_SCAN_SCALE = 2;

/**
 * What the active tool wants to know about the visible pages: where their
 * empty lines and boxes are, or where their text is.
 */
export type Assist = "blanks" | "runs" | null;

const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

// Form fields only need the link service to exist; links themselves aren't shown.
const linkService = {
  eventBus: undefined,
  getDestinationHash: () => "#",
  getAnchorUrl: () => "#",
  addLinkAttributes() {},
  executeNamedAction() {},
  executeSetOCGState() {},
  goToDestination() {},
};

export interface PageView {
  /** Which page this is, and where it comes from. */
  ref: PageRef;
  /** Position in the document. */
  index: number;
  /** Takes the room of the page as turned; `inner` is the page itself, turned with CSS. */
  el: HTMLElement;
  inner: HTMLElement;
  canvasWrap: HTMLElement;
  /** Colour blended into the page: highlights and search matches. */
  marks: HTMLElement;
  /** Search matches. */
  hits: HTMLElement;
  /** Invisible copy of the page's text, for selecting and copying it. Null until the page is first drawn. */
  textLayer: TextLayer | null;
  /** The page's text, once read. */
  text: TextPiece[] | null;
  /** Highlights for detected blanks and for editable text. */
  blanksEl: HTMLElement;
  runsEl: HTMLElement;
  /** Patches that hide original text that has been replaced. */
  covers: HTMLElement;
  items: HTMLElement;
  chrome: HTMLElement;
  /** Page size in points, before the user's turning (but with the PDF's own rotation). */
  width: number;
  height: number;
  /** Null for an inserted blank page, and until loaded. */
  pdfPage: PDFPageProxy | null;
  task: RenderTask | null;
  /** Identifies the zoom and pixel density the current canvas was drawn for. */
  renderedKey: string;
  formsBuilt: boolean;
  /** Areas taken by real form fields, in page points. */
  widgets: Box[];
  /** Null until looked for. */
  blanks: Blank[] | null;
  runs: TextRun[] | null;
  /** Lines of text that belong together, found with the runs. */
  paragraphs: Paragraph[];
}

export interface ViewerHooks {
  onView(): void;
  onFormEdit(): void;
  /** Blanks have been found on a page. */
  onBlanks(view: PageView): void;
  askPassword(retry: boolean): Promise<string | null>;
}

export class OpenCancelled extends Error {}

/** The id of the document's own PDF among the sources of its pages. */
export const PRIMARY = "0";

export class Viewer {
  /** The document's own PDF. */
  pdf: PDFDocumentProxy | null = null;
  /** Every PDF the pages come from, the document's own one included, by source id. */
  readonly sources = new Map<string, PDFDocumentProxy>();
  pages: PageView[] = [];
  zoom = 1;
  currentPage = 0;
  /** True when at least one page has fillable form fields. */
  hasForms = false;

  readonly pagesEl: HTMLElement;
  private fitWidth = true;
  private generation = 0;
  private visible = new Set<PageView>();
  private rendering = false;
  private assist: Assist = null;
  private renderTimer = 0;
  private observer: IntersectionObserver;

  constructor(
    readonly container: HTMLElement,
    private hooks: ViewerHooks,
  ) {
    this.pagesEl = h("div", { class: "pages" });
    container.append(this.pagesEl);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const view = this.pages[Number((entry.target as HTMLElement).dataset.page)];
          if (!view) continue;
          if (entry.isIntersecting) this.visible.add(view);
          else this.visible.delete(view);
        }
        // After a jump the scroll handler runs before this list is up to date.
        this.updateCurrentPage();
        this.scheduleRender(0);
      },
      { root: container, rootMargin: "60% 0px" },
    );

    container.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey || !this.pdf) return;
        event.preventDefault();
        this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.002), { x: event.clientX, y: event.clientY });
      },
      { passive: false },
    );

    let scrollFrame = 0;
    let idleTimer = 0;
    container.addEventListener("scroll", () => {
      if (!scrollFrame) {
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = 0;
          this.updateCurrentPage();
        });
      }
      clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => this.releaseFarPages(), 400);
    });

    new ResizeObserver(() => {
      // A document in a background tab is hidden and has no width at all.
      if (this.pdf && this.fitWidth && container.clientWidth > 0) this.applyZoom(this.fitWidthZoom());
    }).observe(container);

    matchMedia("(resolution: 1dppx)").addEventListener("change", () => this.scheduleRender(0));
  }

  get scale() {
    return this.zoom * CSS_UNITS;
  }

  private get renderKey() {
    return `${this.scale.toFixed(4)}@${window.devicePixelRatio}`;
  }

  /** Opens a PDF, asking for its password if it has one. Throws OpenCancelled if the user gives up. */
  async load(bytes: Uint8Array): Promise<PDFDocumentProxy> {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    const task = getDocument({
      data: bytes.slice(),
      cMapUrl: asset("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: asset("standard_fonts"),
      wasmUrl: asset("wasm"),
      iccUrl: asset("iccs"),
      // Keeps the fonts' real names, which the Edit text tool matches against.
      fontExtraProperties: true,
    });
    task.onPassword = (submit: (password: string) => void, reason: number) => {
      void this.hooks.askPassword(reason === PasswordResponses.INCORRECT_PASSWORD).then((password) => {
        if (password === null) void task.destroy();
        else submit(password);
      });
    };
    try {
      return await task.promise;
    } catch (error) {
      if (task.destroyed) throw new OpenCancelled();
      throw error;
    }
  }

  /** Shows a newly opened document. */
  async show(pdf: PDFDocumentProxy, pages: PageRef[]) {
    const first = await pdf.getPage(1);
    this.close();
    const generation = this.generation;
    this.pdf = pdf;
    this.addSource(PRIMARY, pdf);
    void pdf.getFieldObjects().then((fields) => {
      if (generation === this.generation) this.hasForms = !!fields && fields.size > 0;
    });
    this.firstSize = first.getViewport({ scale: 1 });
    this.layout(pages);
    if (pages[0]?.source === PRIMARY && pages[0].index === 0) this.pages[0].pdfPage = first;
    this.fitWidth = true;
    this.applyZoom(this.fitWidthZoom());
    this.container.scrollTo(0, 0);
  }

  /** Makes another PDF's pages available, for merging. */
  addSource(id: string, pdf: PDFDocumentProxy) {
    this.sources.set(id, pdf);
    (pdf.annotationStorage as { onSetModified: (() => void) | null }).onSetModified = () => this.hooks.onFormEdit();
  }

  private firstSize: { width: number; height: number } = { width: 595, height: 842 };

  /** Arranges the pages as `refs` lists them, reusing what is already drawn. */
  layout(refs: PageRef[]) {
    const existing = new Map(this.pages.map((view) => [view.ref.id, view]));
    const next: PageView[] = [];
    refs.forEach((ref, index) => {
      let view = existing.get(ref.id);
      if (view) existing.delete(ref.id);
      else {
        const size = ref.blank ?? this.firstSize;
        view = this.createPage(ref, size.width, size.height);
        this.observer.observe(view.el);
      }
      view.ref = ref;
      view.index = index;
      view.el.dataset.page = String(index);
      this.setRotation(view);
      next.push(view);
    });
    for (const view of existing.values()) {
      view.task?.cancel();
      this.observer.unobserve(view.el);
      this.visible.delete(view);
      view.el.remove();
    }
    this.pages = next;

    let cursor = this.pagesEl.firstElementChild;
    for (const view of next) {
      if (view.el === cursor) cursor = cursor.nextElementSibling;
      else this.pagesEl.insertBefore(view.el, cursor);
    }
    this.currentPage = Math.min(this.currentPage, Math.max(0, next.length - 1));
    void this.measurePages(this.generation);
    this.hooks.onView();
    this.scheduleRender(0);
  }

  close() {
    this.generation++;
    for (const view of this.pages) {
      view.task?.cancel();
      this.observer.unobserve(view.el);
    }
    this.pages = [];
    this.visible.clear();
    this.pagesEl.replaceChildren();
    for (const pdf of this.sources.values()) void pdf.loadingTask.destroy();
    this.sources.clear();
    this.pdf = null;
    this.hasForms = false;
    this.currentPage = 0;
  }

  private createPage(ref: PageRef, width: number, height: number): PageView {
    const canvasWrap = h("div", { class: "canvas-wrap" });
    const blanksEl = h("div", { class: "blanks" });
    const runsEl = h("div", { class: "runs" });
    const covers = h("div", { class: "covers" });
    const items = h("div", { class: "items" });
    const chrome = h("div", { class: "chrome" });
    const hits = h("div", { class: "hits" });
    const marks = h("div", { class: "marks" }, hits);
    const overlay = h("div", { class: "overlay" }, blanksEl, runsEl, covers, items, chrome);
    const inner = h("div", { class: "page-inner" }, canvasWrap, marks, overlay);
    const el = h("div", { class: "page" }, inner);
    const view: PageView = {
      ref,
      index: 0,
      el,
      inner,
      canvasWrap,
      marks,
      hits,
      textLayer: null,
      text: ref.blank ? [] : null,
      blanksEl,
      runsEl,
      covers,
      items,
      chrome,
      width: 0,
      height: 0,
      pdfPage: null,
      task: null,
      renderedKey: "",
      formsBuilt: false,
      widgets: [],
      // A blank page has nothing to find.
      blanks: ref.blank ? [] : null,
      runs: ref.blank ? [] : null,
      paragraphs: [],
    };
    this.setPageSize(view, width, height);
    return view;
  }

  private setPageSize(view: PageView, width: number, height: number) {
    if (view.width === width && view.height === height) return;
    view.width = width;
    view.height = height;
    view.el.style.setProperty("--w", String(width));
    view.el.style.setProperty("--h", String(height));
    this.setRotation(view);
  }

  /** How far the user has turned a page: 0, 90, 180 or 270 degrees clockwise. */
  rotationOf(view: PageView): number {
    return view.ref.rotation;
  }

  private setRotation(view: PageView) {
    const turned = view.ref.rotation % 180 !== 0;
    view.el.dataset.rotation = String(view.ref.rotation);
    view.el.style.setProperty("--ow", String(turned ? view.height : view.width));
    view.el.style.setProperty("--oh", String(turned ? view.width : view.height));
  }

  /** Pages start out with the first page's size; correct the ones that differ. */
  private async measurePages(generation: number) {
    for (const view of this.pages) {
      if (generation !== this.generation) return;
      await this.loadPage(view);
    }
  }

  /** The pdf.js page behind a view; null for a blank page. */
  private async loadPage(view: PageView): Promise<PDFPageProxy | null> {
    if (view.ref.blank) {
      this.setPageSize(view, view.ref.blank.width, view.ref.blank.height);
      return null;
    }
    if (!view.pdfPage) {
      const source = this.sources.get(view.ref.source);
      if (!source) return null;
      view.pdfPage = await source.getPage(view.ref.index + 1);
      const size = view.pdfPage.getViewport({ scale: 1 });
      this.setPageSize(view, size.width, size.height);
    }
    return view.pdfPage;
  }

  // ---- zoom ---------------------------------------------------------------

  private fitWidthZoom(): number {
    const widest = Math.max(...this.pages.map((view) => (view.ref.rotation % 180 ? view.height : view.width)));
    const available = this.container.clientWidth - 48;
    return Math.min(1.5, Math.max(MIN_ZOOM, available / (widest * CSS_UNITS)));
  }

  zoomToFitWidth() {
    this.fitWidth = true;
    this.applyZoom(this.fitWidthZoom());
  }

  /** Sets the zoom, keeping the document point under `anchor` (client coordinates) in place. */
  setZoom(zoom: number, anchor?: { x: number; y: number }) {
    this.fitWidth = false;
    this.applyZoom(zoom, anchor);
  }

  private applyZoom(zoom: number, anchor?: { x: number; y: number }) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (!this.pages.length) return;

    const bounds = this.container.getBoundingClientRect();
    const at = anchor ?? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    const view = this.pageNear(at.y);
    const before = view.el.getBoundingClientRect();
    const fx = (at.x - before.left) / before.width;
    const fy = (at.y - before.top) / before.height;

    this.zoom = zoom;
    const style = this.pagesEl.style;
    style.setProperty("--s", String(this.scale));
    style.setProperty("--scale-factor", String(this.scale));
    style.setProperty("--total-scale-factor", String(this.scale));

    const after = view.el.getBoundingClientRect();
    this.container.scrollLeft += after.left + fx * after.width - at.x;
    this.container.scrollTop += after.top + fy * after.height - at.y;

    this.hooks.onView();
    // Wait for the zoom gesture to settle before redrawing at the new size.
    for (const page of this.pages) page.task?.cancel();
    this.scheduleRender(140);
  }

  // ---- geometry -----------------------------------------------------------

  private pageNear(clientY: number): PageView {
    let best = this.pages[0];
    let bestDistance = Infinity;
    const candidates = this.visible.size ? this.visible : this.pages;
    for (const view of candidates) {
      const rect = view.el.getBoundingClientRect();
      const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      if (distance < bestDistance) {
        best = view;
        bestDistance = distance;
      }
    }
    return best;
  }

  private updateCurrentPage() {
    if (!this.pages.length) return;
    const bounds = this.container.getBoundingClientRect();
    const index = this.pageNear(bounds.top + bounds.height / 2).index;
    if (index !== this.currentPage) {
      this.currentPage = index;
      this.hooks.onView();
    }
  }

  /** Converts client coordinates to a point on a page, in PDF points, undoing the user's turning of the page. */
  pointOn(view: PageView, clientX: number, clientY: number): { x: number; y: number } {
    const rect = view.el.getBoundingClientRect();
    const dx = (clientX - rect.left) / this.scale;
    const dy = (clientY - rect.top) / this.scale;
    switch (view.ref.rotation) {
      case 90:
        return { x: dy, y: view.height - dx };
      case 180:
        return { x: view.width - dx, y: view.height - dy };
      case 270:
        return { x: view.width - dy, y: dx };
      default:
        return { x: dx, y: dy };
    }
  }

  pageFromElement(el: Element | null): PageView | null {
    const pageEl = el?.closest<HTMLElement>(".page");
    return pageEl ? (this.pages[Number(pageEl.dataset.page)] ?? null) : null;
  }

  /**
   * The matrix that maps PDF user space to a page as displayed at scale 1,
   * before the user's turning (items are kept in that space).
   */
  async pageTransform(index: number): Promise<Matrix> {
    const view = this.pages[index];
    const page = await this.loadPage(view);
    if (!page) return [1, 0, 0, -1, 0, view.height];
    return page.getViewport({ scale: 1 }).transform as Matrix;
  }

  scrollToPage(index: number) {
    this.pages[index]?.el.scrollIntoView({ block: "start" });
  }

  // ---- rendering ----------------------------------------------------------

  private scheduleRender(delay: number) {
    clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => void this.renderNext(), delay);
  }

  private async renderNext() {
    if (this.rendering || !this.pdf) return;
    const key = this.renderKey;
    const bounds = this.container.getBoundingClientRect();
    const middle = bounds.top + bounds.height / 2;
    let next: PageView | null = null;
    let nextDistance = Infinity;
    for (const view of this.visible) {
      if (view.renderedKey === key) continue;
      const rect = view.el.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - middle);
      if (distance < nextDistance) {
        next = view;
        nextDistance = distance;
      }
    }
    if (!next) {
      void this.assistNext();
      return;
    }

    this.rendering = true;
    try {
      await this.renderPage(next, key);
    } catch (error) {
      if (!(error instanceof RenderingCancelledException)) {
        console.error(`Could not render page ${next.index + 1}`, error);
        // Don't retry a page that fails every time.
        next.renderedKey = key;
      }
    } finally {
      this.rendering = false;
    }
    void this.renderNext();
  }

  private async renderPage(view: PageView, key: string) {
    const generation = this.generation;
    const page = await this.loadPage(view);
    if (generation !== this.generation) return;
    if (!page) {
      // A blank page: nothing to draw but white.
      view.canvasWrap.replaceChildren();
      view.renderedKey = key;
      return;
    }

    const viewport = page.getViewport({ scale: this.scale });
    let density = window.devicePixelRatio || 1;
    const pixels = viewport.width * viewport.height * density * density;
    if (pixels > MAX_CANVAS_PIXELS) density *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width * density));
    canvas.height = Math.max(1, Math.floor(viewport.height * density));
    view.task = page.render({
      canvas,
      viewport,
      transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
      // Fillable fields are shown as real inputs on top, so keep them off the canvas.
      annotationMode: AnnotationMode.ENABLE_FORMS,
    });
    try {
      await view.task.promise;
    } finally {
      view.task = null;
    }
    if (generation !== this.generation) return;

    // Swap in the finished canvas in one go so the page never flashes blank.
    view.canvasWrap.replaceChildren(canvas);
    view.renderedKey = key;
    if (!view.formsBuilt) {
      view.formsBuilt = true;
      await this.buildForms(view, page);
    }
    if (!view.textLayer) await this.buildTextLayer(view, page);
  }

  /** Lays the page's text over it, invisibly, so it can be selected and copied. */
  private async buildTextLayer(view: PageView, page: PDFPageProxy) {
    const div = h("div", { class: "textLayer" });
    // Under the form fields and everything added, over the picture of the page.
    view.inner.insertBefore(div, view.canvasWrap.nextSibling);
    const layer = new TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: div,
      viewport: page.getViewport({ scale: 1 }),
    });
    view.textLayer = layer;
    try {
      await layer.render();
    } catch (error) {
      console.warn(`Could not lay out the text of page ${view.index + 1}`, error);
      return;
    }
    // Lets search highlight what it found on this page.
    this.container.dispatchEvent(new CustomEvent("textlayer", { detail: view }));
  }

  /** The text of a page, for searching. */
  async pageText(index: number): Promise<TextPiece[]> {
    const view = this.pages[index];
    if (!view) return [];
    if (!view.text) {
      const page = await this.loadPage(view);
      if (!page) return (view.text = []);
      const content = await page.getTextContent({ disableNormalization: true });
      view.text = content.items
        .filter((item) => "str" in item)
        .map((item) => ({ str: (item as { str: string }).str, eol: !!(item as { hasEOL?: boolean }).hasEOL }));
    }
    return view.text;
  }

  private async buildForms(view: PageView, page: PDFPageProxy) {
    // Form fields, and comments (sticky notes) with their pop-ups.
    const annotations = (await page.getAnnotations({ intent: "display" })).filter((annotation) =>
      ["Widget", "Text", "Popup"].includes(annotation.subtype),
    );
    const source = this.sources.get(view.ref.source);
    if (!annotations.length || !source || view.pdfPage !== page) return;

    const upright = page.getViewport({ scale: 1 });
    view.widgets = annotations.filter((annotation) => annotation.subtype === "Widget").map((annotation) => {
      const [x1, y1] = upright.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
      const [x2, y2] = upright.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    });

    const div = h("div", { class: "annotationLayer" });
    view.inner.insertBefore(div, view.canvasWrap.nextSibling);
    const viewport = upright.clone({ dontFlip: true });
    const annotationStorage = source.annotationStorage;
    const layer = new AnnotationLayer({
      div,
      page,
      viewport,
      linkService,
      annotationStorage,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      structTreeLayer: null,
      commentManager: null,
    });
    await layer.render({
      div,
      page,
      viewport,
      annotations,
      // The stub above covers everything form fields ask of the link service.
      linkService: linkService as never,
      annotationStorage,
      renderForms: true,
      imageResourcesPath: asset("images"),
      enableScripting: false,
      hasJSActions: false,
      fieldObjects: null,
    });
  }

  // ---- help for the tools ---------------------------------------------------

  /** Chooses what to work out about the visible pages while a tool is active. */
  setAssist(assist: Assist) {
    this.assist = assist;
    if (assist) this.scheduleRender(0);
  }

  /** Runs once the visible pages are drawn: one page per call, nearest first. */
  private async assistNext() {
    const assist = this.assist;
    if (!assist || this.rendering || !this.pdf) return;
    let next: PageView | null = null;
    for (const view of this.visible) {
      const pending = assist === "blanks" ? view.blanks === null : view.runs === null;
      const nearer = !next || Math.abs(view.index - this.currentPage) < Math.abs(next.index - this.currentPage);
      if (pending && view.renderedKey && view.pdfPage && nearer) next = view;
    }
    if (!next) return;

    const generation = this.generation;
    this.rendering = true;
    try {
      if (assist === "blanks") await this.findBlanks(next, next.pdfPage!);
      else await this.findRuns(next, next.pdfPage!);
    } catch (error) {
      if (generation === this.generation) {
        console.error(`Could not analyse page ${next.index + 1}`, error);
        if (assist === "blanks") next.blanks = [];
        else next.runs = [];
      }
    } finally {
      this.rendering = false;
    }
    void this.renderNext();
  }

  private async findBlanks(view: PageView, page: PDFPageProxy) {
    const generation = this.generation;
    const viewport = page.getViewport({ scale: BLANK_SCAN_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE_FORMS }).promise;
    if (generation !== this.generation) return;

    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    // Real form fields already handle themselves.
    view.blanks = detectBlanks(pixels, BLANK_SCAN_SCALE).filter(
      (blank) => !view.widgets.some((widget) => overlaps(blank, widget)),
    );
    view.blanksEl.replaceChildren(
      ...view.blanks.map((b) =>
        h("div", { class: `blank ${b.kind}`, style: `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px` }),
      ),
    );
    this.hooks.onBlanks(view);
  }

  private async findRuns(view: PageView, page: PDFPageProxy) {
    const generation = this.generation;
    const content = await page.getTextContent();
    if (generation !== this.generation) return;
    view.runs = buildRuns(content.items, content.styles, page.getViewport({ scale: 1 }).transform);
    view.paragraphs = findParagraphs(view.runs);
    view.runsEl.replaceChildren(
      ...view.runs.map((r) =>
        h("div", { class: "run", style: `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px` }),
      ),
    );
  }

  /** What pdf.js knows about a font used on a page, as clues to which font it really is. */
  fontEvidence(view: PageView, internalName: string): FontEvidence {
    try {
      const objs = view.pdfPage?.commonObjs;
      if (objs?.has(internalName)) {
        const font = objs.get(internalName) as {
          name?: string;
          bold?: boolean;
          italic?: boolean;
          black?: boolean;
          isSerifFont?: boolean;
          isMonospace?: boolean;
          data?: Uint8Array | null;
        };
        return {
          name: font.name ?? "",
          bold: !!font.bold || !!font.black,
          italic: !!font.italic,
          serif: !!font.isSerifFont,
          mono: !!font.isMonospace,
          data: font.data,
        };
      }
    } catch {
      // A font pdf.js could not load tells us nothing.
    }
    return { name: "" };
  }

  /**
   * Looks at the rendered page inside `box` and returns its background colour
   * and the colour of whatever is drawn on it (the text, typically).
   */
  sampleColors(view: PageView, box: Box): { background: string; ink: string } {
    const fallback = { background: "#ffffff", ink: "#000000" };
    const canvas = view.canvasWrap.querySelector("canvas");
    if (!canvas) return fallback;
    const k = canvas.width / view.width;
    const x = Math.max(0, Math.floor(box.x * k));
    const y = Math.max(0, Math.floor(box.y * k));
    const w = Math.min(canvas.width - x, Math.ceil(box.w * k));
    const height = Math.min(canvas.height - y, Math.ceil(box.h * k));
    if (w < 2 || height < 2) return fallback;
    const { data } = canvas.getContext("2d")!.getImageData(x, y, w, height);

    // Background: the most common colour, counted in coarse buckets.
    const buckets = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < data.length; i += 4) {
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket[0] += data[i];
        bucket[1] += data[i + 1];
        bucket[2] += data[i + 2];
        bucket[3]++;
      } else buckets.set(key, [data[i], data[i + 1], data[i + 2], 1]);
    }
    let common: [number, number, number, number] = [255, 255, 255, 0];
    for (const bucket of buckets.values()) if (bucket[3] > common[3]) common = bucket;
    const bg = [common[0] / common[3], common[1] / common[3], common[2] / common[3]];

    // Ink: the average of the pixels that differ most from the background,
    // which leaves out the blended pixels along the edges of letters.
    const distance = (i: number) =>
      Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    let far = 0;
    for (let i = 0; i < data.length; i += 4) far = Math.max(far, distance(i));
    const ink = [0, 0, 0];
    let count = 0;
    if (far > 60) {
      for (let i = 0; i < data.length; i += 4) {
        if (distance(i) >= far * 0.85) {
          ink[0] += data[i];
          ink[1] += data[i + 1];
          ink[2] += data[i + 2];
          count++;
        }
      }
    }
    const hex = (rgb: number[]) => {
      // Rendering leaves black and white a shade off; put them back.
      if (rgb.every((v) => v < 26)) return "#000000";
      if (rgb.every((v) => v > 244)) return "#ffffff";
      return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    };
    return { background: hex(bg), ink: count ? hex(ink.map((v) => v / count)) : fallback.ink };
  }

  private releaseFarPages() {
    for (const view of this.pages) {
      if (view.renderedKey && Math.abs(view.index - this.currentPage) > KEEP_PAGES && !this.visible.has(view)) {
        view.canvasWrap.replaceChildren();
        view.renderedKey = "";
      }
    }
  }
}
