// One open document: its pages, what has been added to them, its undo history,
// and saving it. Each tab in the window is one of these.

import { h } from "./dom";
import { restore, seal, storableItems } from "./editdata";
import { EncryptedPdfError, assemblePdf, type ExportEnv, type SourceBytes } from "./export";
import { Interaction, imageFromBlob } from "./interact";
import { newId, type PageRef } from "./model";
import { pageNumberItems, type PageNumberOptions } from "./pagenumbers";
import { watermarkItems, type WatermarkOptions } from "./watermark";
import { stampItem } from "./stamps";
import { Overlay } from "./overlay";
import { blankPage, deletePages, insertPages, itemsFor, movePages, pagesOf, rotatePages } from "./pageops";
import { WORD_FILTER, baseName, isDesktop, pickImage, pickPdfs, pickSavePath, readTextIn, readSystemFont, writePath, type OpenedFile } from "./platform";
import { pdfToDocx } from "./pdfword";
import type { Settings } from "./settings";
import { Store } from "./store";
import { baseline, measureWidth, rasterizeText } from "./textmetrics";
import { Thumbnails } from "./thumbnails";
import { compressPdf, flattenForm, type CompressOptions } from "./compress";
import { makeSearchable } from "./ocr";
import { addPassword, isEncrypted, removePassword } from "./password";
import { OpenCancelled, PRIMARY, Viewer } from "./viewer";

export interface TabHooks {
  /** Something about the tab changed: its title, its unsaved state, or the view. */
  changed(tab: DocTab): void;
  toast(message: string, kind?: "info" | "error"): void;
  askPassword(retry: boolean): Promise<string | null>;
}

interface FileInfo {
  name: string;
  /** The file as it was opened; every save starts again from these bytes. */
  bytes: Uint8Array;
  /** Where the file came from, if it has a location on disk. */
  path: string | null;
  /** Where Save writes to, once the user has chosen. */
  savePath: string | null;
}

/** A4, for a blank page in a document that has no pages to copy the size from. */
const A4 = { width: 595.28, height: 841.89 };

export class DocTab {
  /** The tab's whole area: page sidebar and pages. Only the active tab's is shown. */
  readonly el = h("div", { class: "doc" });
  readonly store = new Store();
  readonly viewer: Viewer;
  readonly overlay: Overlay;
  readonly interaction: Interaction;
  readonly thumbnails: Thumbnails;
  file: FileInfo | null = null;

  private formsDirty = false;
  private blanksAnnounced = false;
  /** The bytes of every PDF the pages come from, by source id. */
  private sourceBytes = new Map<string, Uint8Array>();
  private nextSource = 1;
  /** The page arrangement the viewer is showing. */
  private shownPages: PageRef[] = [];

  constructor(
    private settings: Settings,
    private hooks: TabHooks,
  ) {
    const pagesArea = h("main", { class: "viewer" });
    this.viewer = new Viewer(pagesArea, {
      onView: () => {
        this.thumbnails?.update();
        hooks.changed(this);
      },
      onFormEdit: () => {
        this.formsDirty = true;
        hooks.changed(this);
      },
      onBlanks: (view) => {
        const count = view.blanks?.length ?? 0;
        if (!count || this.blanksAnnounced) return;
        this.blanksAnnounced = true;
        hooks.toast(
          `Found ${count} ${count === 1 ? "blank" : "blanks"} to fill in on page ${view.index + 1}. Click one to type in it; Tab moves to the next.`,
        );
      },
      askPassword: hooks.askPassword,
    });
    this.overlay = new Overlay(this.store, this.viewer);
    this.interaction = new Interaction(this.store, this.viewer, this.overlay, settings, () => hooks.changed(this));
    this.thumbnails = new Thumbnails(this);
    this.el.append(this.thumbnails.el, pagesArea);
    this.store.subscribe(() => {
      // Page changes (and their undo) reach the viewer from here.
      if (this.store.pages !== this.shownPages && this.viewer.pdf) {
        this.shownPages = this.store.pages;
        this.viewer.layout(this.store.pages);
        this.overlay.sync();
      }
      this.thumbnails.update();
      hooks.changed(this);
    });
    this.active = false;
  }

  get name(): string {
    return this.file?.name ?? "";
  }

  get dirty(): boolean {
    return this.store.dirty || this.formsDirty;
  }

  set active(on: boolean) {
    this.el.hidden = !on;
    this.interaction.active = on;
    if (!on) this.overlay.finishEdit();
  }

  /** Loads a PDF into this tab. Throws if it can't be opened (OpenCancelled if the user gave up on a password). */
  async open(file: OpenedFile) {
    // A file this Duckument saved comes back with its edits still editable.
    const restored = await restore(file.bytes);
    const bytes = restored?.bytes ?? file.bytes;
    const pdf = await this.viewer.load(bytes);
    const pages = pagesOf(PRIMARY, pdf.numPages).map((page, i) => ({ ...page, rotation: restored?.rotations[i] ?? 0 }));
    this.shownPages = pages;
    await this.viewer.show(pdf, pages);
    this.sourceBytes = new Map([[PRIMARY, bytes]]);
    this.overlay.clear();
    this.store.reset(pages, restored?.items ?? []);
    this.interaction.setTool("select");
    this.file = { name: file.name, bytes, path: file.path, savePath: null };
    this.formsDirty = false;
    this.blanksAnnounced = false;
    this.hooks.changed(this);
    // Field detection finishes shortly after the first page is shown.
    setTimeout(() => {
      if (this.viewer.hasForms) this.hooks.toast("This PDF has fillable fields. Click a field to type in it.");
    }, 600);
  }

  // ---- pages --------------------------------------------------------------

  private get state() {
    return { items: this.store.items, pages: this.store.pages };
  }

  rotatePages(ids: string[], degrees: number) {
    this.overlay.finishEdit();
    this.store.apply(rotatePages(this.state, ids, degrees));
  }

  deletePages(ids: string[]) {
    this.overlay.finishEdit();
    if (ids.length >= this.store.pages.length) {
      this.hooks.toast("A document needs at least one page.", "error");
      return;
    }
    this.store.apply(deletePages(this.state, ids));
  }

  movePages(ids: string[], to: number) {
    this.overlay.finishEdit();
    this.store.apply(movePages(this.state, ids, to));
  }

  /** Adds an empty page at position `at`, the size of the page before it. */
  insertBlankPage(at: number) {
    const neighbour = this.viewer.pages[Math.max(0, at - 1)];
    const size = neighbour ? { width: neighbour.width, height: neighbour.height } : A4;
    this.store.apply(insertPages(this.state, at, [blankPage(size.width, size.height)]));
  }

  /** Asks for a PDF and puts its pages in at position `at`. */
  async addPdf(at: number) {
    let files: OpenedFile[];
    try {
      files = await pickPdfs();
    } catch (error) {
      this.hooks.toast(String(error), "error");
      return;
    }
    await this.addPdfFiles(files, at);
  }

  /** Puts in the pages of several PDFs at `at`, in the order given. */
  async addPdfFiles(files: OpenedFile[], at: number) {
    // Each goes in at the same place, last first, so they end up in order.
    for (const file of [...files].reverse()) await this.addPdfFile(file, at);
  }

  /** Puts the pages of an opened PDF file in at position `at`. */
  async addPdfFile(file: OpenedFile, at: number) {
    let pdf;
    try {
      pdf = await this.viewer.load(file.bytes);
    } catch (error) {
      if (!(error instanceof OpenCancelled)) this.hooks.toast(`"${file.name}" could not be opened. It may be damaged or not a PDF.`, "error");
      return;
    }
    const id = String(this.nextSource++);
    this.viewer.addSource(id, pdf);
    this.sourceBytes.set(id, file.bytes);
    this.store.apply(insertPages(this.state, at, pagesOf(id, pdf.numPages)));
    this.hooks.toast(`Added ${pdf.numPages} ${pdf.numPages === 1 ? "page" : "pages"} from "${file.name}".`);
  }

  /** Saves the chosen pages, with what was added to them, as a new PDF. */
  async extractPages(ids: string[]) {
    if (!ids.length || !this.file) return;
    this.overlay.finishEdit();
    const chosen = this.store.pages.filter((page) => ids.includes(page.id));
    const suggested = (this.file.path ?? this.file.name).replace(/(\.pdf)?$/i, chosen.length === 1 ? `-page.pdf` : "-pages.pdf");
    try {
      const path = await pickSavePath(suggested);
      if (!path) return;
      await writePath(path, await this.buildPages(ids));
      this.hooks.toast(`Saved ${chosen.length} ${chosen.length === 1 ? "page" : "pages"} as ${baseName(path)}`);
    } catch (error) {
      console.error(error);
      this.hooks.toast(error instanceof EncryptedPdfError ? error.message : `Could not save: ${String(error)}`, "error");
    }
  }

  // ---- saving -------------------------------------------------------------

  /** Every source PDF, with the form fields filled in on it written into it. */
  /** Whether saving took a password (or a lock) off one of the PDFs, to say so. */
  private passwordRemoved = false;

  private async sourcesWithForms(): Promise<SourceBytes> {
    const out: SourceBytes = new Map();
    for (const [id, bytes] of this.sourceBytes) {
      const pdf = this.viewer.sources.get(id);
      // pdf.js writes the filled-in form fields; everything else is done afterwards.
      const own = pdf && pdf.annotationStorage.size > 0 ? await pdf.saveDocument() : bytes;
      // A PDF with a password is saved without it: pdf-lib can't write encrypted files.
      if (isEncrypted(own)) this.passwordRemoved = true;
      out.set(id, isEncrypted(own) ? await removePassword(own, this.viewer.passwords) : own);
    }
    return out;
  }

  /** How to write the given pages and items, keeping a copy of the edits only this computer can read. */
  private exportEnv(pages: PageRef[] = this.store.pages, items = this.store.items): ExportEnv {
    return {
      seal: (saved) => seal({ v: 1, pages: saved.map((page, i) => ({ ...page, extra: pages[i]?.rotation ?? 0 })), items: storableItems(items) }),
      pageTransform: (index) => this.viewer.pageTransform(index),
      redact: (index, boxes) => this.viewer.redactedPicture(index, boxes),
      baseline,
      rasterizeText,
      loadFont: isDesktop ? readSystemFont : undefined,
      measure: measureWidth,
      onCoverOnly: (count) =>
        this.hooks.toast(
          count === 1
            ? "One piece of edited text could only be painted over, not removed, because of how this PDF stores it."
            : `${count} pieces of edited text could only be painted over, not removed, because of how this PDF stores them.`,
        ),
    };
  }

  /** A PDF of just the given pages, with what was added to them. */
  async buildPages(ids: string[]): Promise<Uint8Array> {
    const chosen = this.store.pages.filter((page) => ids.includes(page.id));
    const viewIndex = chosen.map((page) => this.store.pages.indexOf(page));
    const items = itemsFor(this.state, ids);
    return assemblePdf(await this.sourcesWithForms(), PRIMARY, chosen, items, {
      ...this.exportEnv(chosen, items),
      pageTransform: (index) => this.viewer.pageTransform(viewIndex[index]),
      redact: (index, boxes) => this.viewer.redactedPicture(viewIndex[index], boxes),
    });
  }

  /** The PDF as Save would write it. */
  async build(): Promise<Uint8Array> {
    return assemblePdf(await this.sourcesWithForms(), PRIMARY, this.store.pages, this.store.items, this.exportEnv());
  }

  /** Saves the document. Resolves to true once it has been written. */
  async save(chooseLocation: boolean): Promise<boolean> {
    const file = this.file;
    if (!file || !this.viewer.pdf) return false;
    this.overlay.finishEdit();
    try {
      // The first save always asks, so the original file is only replaced on purpose.
      let path = file.savePath;
      if (!path || chooseLocation) {
        path = await pickSavePath(file.savePath ?? (file.path ?? file.name).replace(/(\.pdf)?$/i, "-edited.pdf"));
        if (!path) return false;
      }
      await writePath(path, await this.build());
      if (this.file !== file) return true;
      file.savePath = path;
      this.formsDirty = false;
      for (const pdf of this.viewer.sources.values()) pdf.annotationStorage.resetModified();
      this.store.markSaved();
      this.hooks.toast(`Saved as ${baseName(path)}${this.passwordRemoved ? ", without the password it had (Save a copy to send can put one on)" : ""}`);
      return true;
    } catch (error) {
      console.error(error);
      this.hooks.toast(error instanceof EncryptedPdfError ? error.message : `Could not save: ${String(error)}`, "error");
      return false;
    }
  }

  /** Saves a Word document (.docx) worked out from the PDF, with what was added to it. */
  /** Saves a copy to send: the document as Save would write it, smaller and/or with its form filled in for good. */
  async saveCopy(options: CompressOptions | null, flatten: boolean, ocr = false, password = ""): Promise<void> {
    const file = this.file;
    if (!file || !this.viewer.pdf) return;
    this.overlay.finishEdit();
    try {
      const path = await pickSavePath((file.path ?? file.name).replace(/(\.pdf)?$/i, options ? "-smaller.pdf" : "-filled.pdf"));
      if (!path) return;
      this.hooks.toast(options ? "Making it smaller…" : "Saving…");
      const before = await this.build();
      let filled = flatten ? await flattenForm(before) : before;
      let read = 0;
      // Read before pictures are made smaller, so the OCR sees them sharp.
      if (ocr) ({ bytes: filled, pages: read } = await this.searchable(filled));
      const smaller = options ? await compressPdf(filled, options) : filled;
      const after = password ? await addPassword(smaller, password) : smaller;
      await writePath(path, after);
      const mb = (n: number) => `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB`;
      const scans = ocr ? (read ? ` ${read} scanned ${read === 1 ? "page is" : "pages are"} now searchable.` : " No scanned pages needed reading.") : "";
      this.hooks.toast((password ? "Protected with a password. " : "") + (!options ? `Saved ${baseName(path)}.` : after.length < before.length ? `Saved ${baseName(path)}: ${mb(before.length)} → ${mb(after.length)}.` : `Saved ${baseName(path)}. It couldn't be made smaller: it has no big pictures.`) + scans);
    } catch (error) {
      console.error(error);
      this.hooks.toast(`Could not make a smaller copy: ${String(error)}`, "error");
    }
  }

  /** The PDF with the text on its scanned pages read (Windows' OCR) and put in invisibly. */
  async searchable(bytes: Uint8Array): Promise<{ bytes: Uint8Array; pages: number }> {
    const pdf = await this.viewer.load(bytes);
    try {
      return await makeSearchable(bytes, pdf, readTextIn, (done, total) => {
        if (done < total) this.hooks.toast(`Reading the text in scanned pages… ${done + 1} of ${total}`);
      });
    } finally {
      void pdf.loadingTask.destroy();
    }
  }

  async saveAsWord(): Promise<boolean> {
    const file = this.file;
    if (!file || !this.viewer.pdf) return false;
    this.overlay.finishEdit();
    try {
      const path = await pickSavePath((file.path ?? file.name).replace(/(\.pdf)?$/i, ".docx"), WORD_FILTER);
      if (!path) return false;
      this.hooks.toast("Making the Word document…");
      await writePath(path, await this.wordDocument());
      this.hooks.toast(`Saved as ${baseName(path)}`);
      return true;
    } catch (error) {
      console.error(error);
      this.hooks.toast(`Could not make the Word document: ${String(error)}`, "error");
      return false;
    }
  }

  /** The .docx Save as Word writes: the PDF with what was added to it, worked out into a document. */
  async wordDocument(): Promise<Uint8Array> {
    // A PDF with a password can't be written, so then it's the PDF as opened, without the additions.
    let pdf = this.viewer.pdf!;
    let own = false;
    try {
      pdf = await this.viewer.load(await this.build());
      own = true;
    } catch (error) {
      if (!(error instanceof EncryptedPdfError)) throw error;
    }
    try {
      return await pdfToDocx(pdf);
    } finally {
      if (own) void pdf.loadingTask.destroy();
    }
  }

  /** Puts page numbers on every page, as one step to undo. */
  addPageNumbers(options: Omit<PageNumberOptions, "font" | "color">) {
    const pages = this.viewer.pages.map((v) => (v.ref.rotation % 180 ? { width: v.height, height: v.width } : { width: v.width, height: v.height }));
    const items = pageNumberItems(pages, { ...options, font: this.settings.font, color: "#000000" }, newId);
    this.store.apply({ items: [...this.store.items, ...items], pages: this.store.pages });
    return items.length;
  }

  /** Puts a watermark across every page, as one step to undo. */
  addWatermark(options: Omit<WatermarkOptions, "font">) {
    const pages = this.viewer.pages.map((v) => (v.ref.rotation % 180 ? { width: v.height, height: v.width } : { width: v.width, height: v.height }));
    const items = watermarkItems(pages, { ...options, font: "helvetica" }, newId);
    this.store.apply({ items: [...this.store.items, ...items], pages: this.store.pages });
    return items.length;
  }

  /** Puts a stamp on the page being read; returns which page (from 1). */
  addStamp(words: string, color: string, date: string | null): number {
    const index = this.viewer.currentPage;
    const v = this.viewer.pages[index];
    const page = v.ref.rotation % 180 ? { width: v.height, height: v.width } : { width: v.width, height: v.height };
    this.store.apply({ items: [...this.store.items, stampItem(page, index, words, color, date, newId())], pages: this.store.pages });
    return index + 1;
  }

  async insertImage() {
    if (!this.viewer.pdf) return;
    const blob = await pickImage();
    const image = blob && (await imageFromBlob(blob));
    if (image) this.interaction.placeImage(image.src, image.w, image.h);
    else if (blob) this.hooks.toast("That file could not be read as a picture.", "error");
  }

  /** Releases everything the tab holds. */
  close() {
    this.overlay.finishEdit();
    this.interaction.dispose();
    this.thumbnails.dispose();
    this.viewer.close();
    this.el.remove();
  }
}
