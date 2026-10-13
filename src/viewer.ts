// Shows the pages of a PDF in a scrolling column. Only pages near the viewport
// are rendered, and zooming rescales what's on screen immediately while sharp
// versions are drawn in the background.

import {
  AnnotationLayer,
  AnnotationMode,
  GlobalWorkerOptions,
  PasswordResponses,
  RenderingCancelledException,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { h } from "./dom";
import type { Matrix } from "./export";

GlobalWorkerOptions.workerSrc = workerUrl;

/** CSS pixels per PDF point at 100% zoom. */
const CSS_UNITS = 96 / 72;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
/** Largest canvas drawn for one page; beyond it the page is upscaled instead. */
const MAX_CANVAS_PIXELS = 4096 * 4096;
/** Canvases further than this many pages from the current one are released. */
const KEEP_PAGES = 8;

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
  index: number;
  el: HTMLElement;
  canvasWrap: HTMLElement;
  items: HTMLElement;
  chrome: HTMLElement;
  /** Page size in points, as displayed. */
  width: number;
  height: number;
  pdfPage: PDFPageProxy | null;
  task: RenderTask | null;
  /** Identifies the zoom and pixel density the current canvas was drawn for. */
  renderedKey: string;
  formsBuilt: boolean;
}

export interface ViewerHooks {
  onView(): void;
  onFormEdit(): void;
  askPassword(retry: boolean): Promise<string | null>;
}

export class OpenCancelled extends Error {}

export class Viewer {
  pdf: PDFDocumentProxy | null = null;
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
      if (this.pdf && this.fitWidth) this.applyZoom(this.fitWidthZoom());
    }).observe(container);

    matchMedia("(resolution: 1dppx)").addEventListener("change", () => this.scheduleRender(0));
  }

  get scale() {
    return this.zoom * CSS_UNITS;
  }

  private get renderKey() {
    return `${this.scale.toFixed(4)}@${window.devicePixelRatio}`;
  }

  async open(bytes: Uint8Array) {
    const attempt = ++this.generation;
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    const task = getDocument({
      data: bytes.slice(),
      cMapUrl: asset("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: asset("standard_fonts"),
      wasmUrl: asset("wasm"),
      iccUrl: asset("iccs"),
    });
    task.onPassword = (submit: (password: string) => void, reason: number) => {
      void this.hooks.askPassword(reason === PasswordResponses.INCORRECT_PASSWORD).then((password) => {
        if (password === null) void task.destroy();
        else submit(password);
      });
    };

    let pdf: PDFDocumentProxy;
    try {
      pdf = await task.promise;
    } catch (error) {
      if (task.destroyed) throw new OpenCancelled();
      throw error;
    }
    if (attempt !== this.generation) {
      void pdf.loadingTask.destroy();
      throw new OpenCancelled();
    }

    const first = await pdf.getPage(1);
    this.close();
    const generation = this.generation;
    this.pdf = pdf;
    (pdf.annotationStorage as { onSetModified: (() => void) | null }).onSetModified = () => this.hooks.onFormEdit();
    void pdf.getFieldObjects().then((fields) => {
      if (generation === this.generation) this.hasForms = !!fields && fields.size > 0;
    });

    const size = first.getViewport({ scale: 1 });
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < pdf.numPages; index++) {
      const view = this.createPage(index, size.width, size.height);
      this.pages.push(view);
      fragment.append(view.el);
    }
    this.pages[0].pdfPage = first;
    this.pagesEl.append(fragment);

    this.fitWidth = true;
    this.applyZoom(this.fitWidthZoom());
    this.container.scrollTo(0, 0);
    for (const view of this.pages) this.observer.observe(view.el);
    this.hooks.onView();
    void this.measurePages(generation);
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
    void this.pdf?.loadingTask.destroy();
    this.pdf = null;
    this.hasForms = false;
    this.currentPage = 0;
  }

  private createPage(index: number, width: number, height: number): PageView {
    const canvasWrap = h("div", { class: "canvas-wrap" });
    const items = h("div", { class: "items" });
    const chrome = h("div", { class: "chrome" });
    const overlay = h("div", { class: "overlay" }, items, chrome);
    const el = h("div", { class: "page", "data-page": index }, canvasWrap, overlay);
    const view: PageView = {
      index,
      el,
      canvasWrap,
      items,
      chrome,
      width: 0,
      height: 0,
      pdfPage: null,
      task: null,
      renderedKey: "",
      formsBuilt: false,
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
  }

  /** Pages start out with the first page's size; correct the ones that differ. */
  private async measurePages(generation: number) {
    for (const view of this.pages) {
      if (generation !== this.generation) return;
      await this.loadPage(view);
    }
  }

  private async loadPage(view: PageView): Promise<PDFPageProxy> {
    if (!view.pdfPage) {
      view.pdfPage = await this.pdf!.getPage(view.index + 1);
      const size = view.pdfPage.getViewport({ scale: 1 });
      this.setPageSize(view, size.width, size.height);
    }
    return view.pdfPage;
  }

  // ---- zoom ---------------------------------------------------------------

  private fitWidthZoom(): number {
    const widest = Math.max(...this.pages.map((view) => view.width));
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

  /** Converts client coordinates to a point on a page, in PDF points. */
  pointOn(view: PageView, clientX: number, clientY: number): { x: number; y: number } {
    const rect = view.el.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.scale, y: (clientY - rect.top) / this.scale };
  }

  pageFromElement(el: Element | null): PageView | null {
    const pageEl = el?.closest<HTMLElement>(".page");
    return pageEl ? (this.pages[Number(pageEl.dataset.page)] ?? null) : null;
  }

  /** The matrix that maps PDF user space to the page as displayed at scale 1. */
  async pageTransform(index: number): Promise<Matrix> {
    const page = await this.loadPage(this.pages[index]);
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
    if (!next) return;

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
  }

  private async buildForms(view: PageView, page: PDFPageProxy) {
    const annotations = (await page.getAnnotations({ intent: "display" })).filter(
      (annotation) => annotation.subtype === "Widget",
    );
    if (!annotations.length || !this.pdf || view.pdfPage !== page) return;

    const div = h("div", { class: "annotationLayer" });
    view.el.insertBefore(div, view.canvasWrap.nextSibling);
    const viewport = page.getViewport({ scale: 1 }).clone({ dontFlip: true });
    const annotationStorage = this.pdf.annotationStorage;
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
      imageResourcesPath: "",
      enableScripting: false,
      hasJSActions: false,
      fieldObjects: null,
    });
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
