// One open document: its pages, what has been added to them, its undo history,
// and saving it. Each tab in the window is one of these.

import { h } from "./dom";
import { EncryptedPdfError, addItemsToPdf } from "./export";
import { Interaction, imageFromBlob } from "./interact";
import { Overlay } from "./overlay";
import { baseName, isDesktop, pickImage, pickSavePath, readSystemFont, writePath, type OpenedFile } from "./platform";
import type { Settings } from "./settings";
import { Store } from "./store";
import { baseline, rasterizeText } from "./textmetrics";
import { Viewer } from "./viewer";

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

export class DocTab {
  /** The scrolling page area; only the active tab's is shown. */
  readonly el = h("main", { class: "viewer" });
  readonly store = new Store();
  readonly viewer: Viewer;
  readonly overlay: Overlay;
  readonly interaction: Interaction;
  file: FileInfo | null = null;

  private formsDirty = false;
  private blanksAnnounced = false;

  constructor(
    settings: Settings,
    private hooks: TabHooks,
  ) {
    this.viewer = new Viewer(this.el, {
      onView: () => hooks.changed(this),
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
    this.store.subscribe(() => hooks.changed(this));
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
    await this.viewer.open(file.bytes);
    this.overlay.clear();
    this.store.reset();
    this.interaction.setTool("select");
    this.file = { name: file.name, bytes: file.bytes, path: file.path, savePath: null };
    this.formsDirty = false;
    this.blanksAnnounced = false;
    this.hooks.changed(this);
    // Field detection finishes shortly after the first page is shown.
    setTimeout(() => {
      if (this.viewer.hasForms) this.hooks.toast("This PDF has fillable fields. Click a field to type in it.");
    }, 600);
  }

  /** The PDF as Save would write it. */
  async build(): Promise<Uint8Array> {
    const pdf = this.viewer.pdf!;
    // pdf.js writes the filled-in form fields; everything added on top is drawn afterwards.
    const base = pdf.annotationStorage.size > 0 ? await pdf.saveDocument() : this.file!.bytes;
    return addItemsToPdf(base, this.store.items, {
      pageTransform: (index) => this.viewer.pageTransform(index),
      baseline,
      rasterizeText,
      loadFont: isDesktop ? readSystemFont : undefined,
    });
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
      this.viewer.pdf.annotationStorage.resetModified();
      this.store.markSaved();
      this.hooks.toast(`Saved as ${baseName(path)}`);
      return true;
    } catch (error) {
      console.error(error);
      this.hooks.toast(error instanceof EncryptedPdfError ? error.message : `Could not save: ${String(error)}`, "error");
      return false;
    }
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
    this.viewer.close();
    this.el.remove();
  }
}
