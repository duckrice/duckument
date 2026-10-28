// The toolbar: file actions, tools, the options for whatever is selected (or
// about to be added), and the zoom controls.

import { h } from "./dom";
import { FONTS, isInstalled } from "./fonts";
import { icon, type IconName } from "./icons";
import type { Interaction } from "./interact";
import { isLine, type Item, type MarkKind } from "./model";
import { isDesktop } from "./platform";
import { saveSettings, type Settings } from "./settings";
import { createSignature, loadSignatures, placedSize, storeSignatures, type Signature } from "./signature";
import type { Store, Tool } from "./store";
import type { Viewer } from "./viewer";

export interface Actions {
  open(): void;
  togglePages(): void;
  save(): void;
  saveAs(): void;
  saveAsWord(): void;
  compress(): void;
  insertImage(): void;
  pageNumbers(): void;
  watermark(): void;
  stamp(): void;
  toast(message: string): void;
}

const TOOLS: { tool: Tool; icon: IconName; label: string; key: string; text?: string }[] = [
  { tool: "select", icon: "select", label: "Select and move", key: "V" },
  { tool: "text", icon: "text", label: "Add text, or fill in a blank", key: "T", text: "Text" },
  { tool: "edit", icon: "edit", label: "Edit text that is in the document", key: "E", text: "Edit text" },
  { tool: "markup", icon: "highlighter", label: "Highlight, underline or strike through text", key: "H", text: "Highlight" },
  { tool: "note", icon: "note", label: "Add a comment", key: "N" },
  { tool: "check", icon: "check", label: "Check mark", key: "C" },
  { tool: "cross", icon: "cross", label: "Cross", key: "X" },
  { tool: "rect", icon: "rect", label: "Rectangle", key: "R" },
  { tool: "ellipse", icon: "ellipse", label: "Ellipse", key: "O" },
  { tool: "line", icon: "line", label: "Line", key: "L" },
  { tool: "arrow", icon: "arrow", label: "Arrow", key: "A" },
  { tool: "pen", icon: "pen", label: "Draw freehand", key: "P" },
  { tool: "whiteout", icon: "whiteout", label: "White-out (cover something up)", key: "W" },
  { tool: "redact", icon: "redact", label: "Redact (black out for good: the text underneath is removed when you save)", key: "B" },
];

const COLORS = ["#000000", "#1a3fb0", "#d92626", "#178a3e", "#f08c00", "#ffffff"];
const HIGHLIGHTS = ["#ffe14d", "#a6e36c", "#8ecdf5", "#f7a1c4", "#ffb366"];
const NOTE_COLORS = ["#ffd43b", "#ff922b", "#8ce99a", "#74c0fc", "#faa2c1"];
const WIDTHS = [0.5, 1, 1.5, 2, 3, 4, 6, 8];

const HINTS: Partial<Record<Tool, string>> = {
  select: "Click something you added to move or resize it. Fillable fields can be typed into directly.",
  place: "Click on the page where it should go. Press Esc to cancel.",
  edit: "Click any text in the document to change it. Clear it to delete it. The new text can be moved like anything else you add.",
  whiteout: "Drag over what you want to cover up.",
};

/** Which set of options applies to an item or tool. */
type Kind = "text" | "shape" | "stroke" | "markup" | "note" | "none";

function kindOf(target: Item | Tool): Kind {
  const type = typeof target === "string" ? target : target.type;
  if (type === "text") return "text";
  if (type === "markup" || type === "highlight" || type === "underline" || type === "strike") return "markup";
  if (type === "note") return "note";
  if (type === "rect" || type === "ellipse") {
    // White-out is a rectangle without an outline; it has nothing to configure.
    return typeof target !== "string" && target.type === "rect" && !target.stroke && target.fill === "#ffffff"
      ? "none"
      : "shape";
  }
  if (type === "line" || type === "arrow" || type === "pen" || type === "check" || type === "cross") return "stroke";
  return "none";
}

/** The document the toolbar is working on. */
export interface ToolbarTarget {
  store: Store;
  viewer: Viewer;
  interaction: Interaction;
}

export class Toolbar {
  readonly el: HTMLElement;

  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private undoButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private saveButton: HTMLButtonElement;
  private docButtons: HTMLButtonElement[] = [];
  private zoomLabel: HTMLButtonElement;
  private pageLabel: HTMLElement;
  private props: HTMLElement;
  private propsKey = "";
  private refreshProps: (() => void) | null = null;
  private signMenu: HTMLElement;
  private signButton: HTMLButtonElement;
  private pagesButton: HTMLButtonElement;

  constructor(
    private target: ToolbarTarget,
    private settings: Settings,
    private actions: Actions,
  ) {
    const button = (name: IconName, title: string, onclick: () => void, label?: string) =>
      h("button", { type: "button", class: `tb${label ? " labelled" : ""}`, title, onclick, html: icon(name) }, label);

    const openButton = button("open", "Open a PDF (Ctrl+O)", actions.open, "Open");
    const pagesButton = button("pages", "Show or hide the page sidebar", actions.togglePages);
    this.pagesButton = pagesButton;
    this.saveButton = button("save", "Save (Ctrl+S)", actions.save, "Save");
    const saveAsButton = button("saveAs", "Save as… another name or place (F12)", actions.saveAs);
    const wordButton = button("document", "Save as a Word document (.docx), to edit the text in Word or DuckWriter", actions.saveAsWord, "Word");
    const compressButton = button("compress", "Save a copy to send: smaller, and with the form filled in for good", actions.compress);
    this.undoButton = button("undo", "Undo (Ctrl+Z)", () => this.store.undo());
    this.redoButton = button("redo", "Redo (Ctrl+Y)", () => this.store.redo());

    const tools = TOOLS.map((def) => {
      const el = button(def.icon, `${def.label} (${def.key})`, () => this.interaction.setTool(def.tool), def.text);
      this.toolButtons.set(def.tool, el);
      return el;
    });

    this.signButton = h(
      "button",
      { type: "button", class: "tb labelled", title: "Sign (S)", onclick: () => this.toggleSignMenu(), html: icon("sign") },
      "Sign",
      h("span", { class: "caret", html: icon("caret", 12) }),
    );
    this.signMenu = h("div", { class: "menu sign-menu", hidden: true });
    const imageButton = button("image", "Insert a picture", actions.insertImage);
    const numbersButton = button("hash", "Add page numbers, or a header or footer", actions.pageNumbers);
    const watermarkButton = button("watermark", "Add a watermark", actions.watermark);
    const stampButton = button("stamp", "Stamp the page (Approved, Received, …)", actions.stamp);

    const zoomOut = button("minus", "Zoom out (Ctrl+-)", () => this.viewer.setZoom(this.viewer.zoom / 1.2));
    const zoomIn = button("plus", "Zoom in (Ctrl++)", () => this.viewer.setZoom(this.viewer.zoom * 1.2));
    this.zoomLabel = h("button", { type: "button", class: "tb zoom", title: "Fit to window width (Ctrl+0)", onclick: () => this.viewer.zoomToFitWidth() });
    this.pageLabel = h("span", { class: "page-label" });

    // select, text, edit text, highlight, comment | sign | check, cross | shapes... | picture
    const [select, text, editText, markup, note, check, cross, ...shapes] = tools;
    this.docButtons = [pagesButton, this.saveButton, saveAsButton, wordButton, compressButton, ...tools, this.signButton, imageButton, numbersButton, watermarkButton, stampButton, zoomOut, zoomIn, this.zoomLabel];

    const main = h(
      "div",
      { class: "toolbar" },
      h("div", { class: "group" }, pagesButton, openButton, this.saveButton, saveAsButton, wordButton, compressButton),
      h("div", { class: "group" }, this.undoButton, this.redoButton),
      h("div", { class: "group" }, select, text, editText, markup, note, h("div", { class: "menu-anchor" }, this.signButton, this.signMenu), check, cross),
      h("div", { class: "group" }, ...shapes, imageButton, numbersButton, watermarkButton, stampButton),
      h("div", { class: "spacer" }),
      h("div", { class: "group" }, this.pageLabel, zoomOut, this.zoomLabel, zoomIn),
    );
    this.props = h("div", { class: "props" });
    this.el = h("header", { class: "chrome-top" }, main, this.props);

    document.addEventListener("pointerdown", (event) => {
      if (!this.signMenu.hidden && !(event.target as Element).closest(".menu-anchor")) this.signMenu.hidden = true;
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.signMenu.hidden = true;
    });
    this.update();
  }

  private get store() {
    return this.target.store;
  }

  private get viewer() {
    return this.target.viewer;
  }

  private get interaction() {
    return this.target.interaction;
  }

  /** Switches the toolbar over to another document. */
  setTarget(target: ToolbarTarget) {
    if (target === this.target) return;
    this.target = target;
    this.signMenu.hidden = true;
    this.propsKey = "";
    this.update();
  }

  update() {
    const open = !!this.viewer.pdf;
    for (const el of this.docButtons) el.disabled = !open;
    this.undoButton.disabled = !this.store.canUndo;
    this.redoButton.disabled = !this.store.canRedo;
    for (const [tool, el] of this.toolButtons) el.classList.toggle("active", open && tool === this.interaction.tool);
    this.signButton.classList.toggle("active", this.interaction.tool === "place");
    this.pagesButton.classList.toggle("active", open && this.settings.showPages);
    this.zoomLabel.textContent = `${Math.round(this.viewer.zoom * 100)}%`;
    this.pageLabel.textContent = open ? `Page ${this.viewer.currentPage + 1} of ${this.viewer.pages.length}` : "";
    this.updateProps(open);
  }

  // ---- signatures ---------------------------------------------------------

  toggleSignMenu() {
    if (!this.viewer.pdf) return;
    if (!this.signMenu.hidden) {
      this.signMenu.hidden = true;
      return;
    }
    const saved = loadSignatures();
    if (!saved.length) {
      void this.newSignature();
      return;
    }
    this.signMenu.replaceChildren(
      ...saved.map((signature) =>
        h(
          "div",
          { class: "sign-row" },
          h(
            "button",
            { type: "button", class: "sign-pick", title: "Place this signature", onclick: () => this.place(signature) },
            h("img", { src: signature.src, alt: "Saved signature", draggable: "false" }),
          ),
          h("button", {
            type: "button",
            class: "tb small",
            title: "Forget this signature",
            html: icon("trash", 15),
            onclick: () => {
              storeSignatures(loadSignatures().filter((other) => other.id !== signature.id));
              this.signMenu.hidden = true;
              this.toggleSignMenu();
            },
          }),
        ),
      ),
      h("button", { type: "button", class: "menu-item", onclick: () => void this.newSignature() }, "New signature…"),
    );
    this.signMenu.hidden = false;
  }

  private place(signature: Signature) {
    this.signMenu.hidden = true;
    const size = placedSize(signature);
    this.interaction.placeImage(signature.src, size.w, size.h);
  }

  private async newSignature() {
    this.signMenu.hidden = true;
    const created = await createSignature();
    if (!created) return;
    if (created.remember && !storeSignatures([created.signature, ...loadSignatures()])) {
      this.actions.toast("The signature could not be remembered, but you can still place it now.");
    }
    this.place(created.signature);
  }

  // ---- options for the selection or the active tool -------------------------

  private updateProps(open: boolean) {
    const selected = this.store.selected;
    const target: Item | Tool = selected ?? this.interaction.tool;
    const kind = open ? kindOf(target) : "none";
    const key = `${open}|${kind}|${selected?.id ?? this.interaction.tool}`;
    if (key === this.propsKey) {
      this.refreshProps?.();
      return;
    }
    this.propsKey = key;
    this.refreshProps = null;

    const children: (HTMLElement | null)[] = [];
    if (kind === "text") children.push(...this.textProps());
    else if (kind === "shape") children.push(...this.shapeProps());
    else if (kind === "stroke") children.push(...this.strokeProps());
    else if (kind === "markup") children.push(...this.markupProps());
    else if (kind === "note") children.push(...this.noteProps());
    else if (open && !selected) children.push(h("span", { class: "hint" }, HINTS[this.interaction.tool] ?? ""));
    else if (!open) children.push(h("span", { class: "hint" }, "Open a PDF to sign it, fill it in or mark it up."));

    if (selected) {
      children.push(
        h("div", { class: "spacer" }),
        h(
          "button",
          { type: "button", class: "tb labelled", title: "Delete (Del)", html: icon("trash", 16), onclick: () => this.interaction.deleteSelected() },
          "Delete",
        ),
      );
    }
    this.props.replaceChildren(...children.filter((child): child is HTMLElement => !!child));
    // The builders above set this; TypeScript can't see assignments made inside them.
    (this.refreshProps as (() => void) | null)?.();
  }

  /**
   * Applies a change to the selected item (as one undo step) and remembers it
   * as the default for the next item of that kind.
   */
  private apply(itemPatch: Record<string, unknown>, settingsPatch: Partial<Settings>) {
    Object.assign(this.settings, settingsPatch);
    saveSettings(this.settings);
    const selected = this.store.selected;
    if (selected) {
      this.store.replace({ ...selected, ...itemPatch } as Item);
      this.store.commit();
    }
  }

  private swatches(label: string, allowNone: boolean, get: () => string | null, set: (value: string | null) => void, palette: string[] = COLORS) {
    const custom = h("input", { type: "color", class: "swatch custom", title: "Other colour" });
    custom.addEventListener("input", () => set(custom.value));
    const buttons = new Map<string | null, HTMLElement>();
    const options: (string | null)[] = allowNone ? [null, ...palette] : palette;
    for (const value of options) {
      buttons.set(
        value,
        h("button", {
          type: "button",
          class: `swatch${value ? "" : " none"}`,
          style: value ? `--c:${value}` : undefined,
          title: value ? value : "None",
          onclick: () => set(value),
        }),
      );
    }
    const refresh = () => {
      const current = get();
      for (const [value, el] of buttons) el.classList.toggle("active", value === current);
      const isCustom = !!current && !buttons.has(current);
      custom.classList.toggle("active", isCustom);
      if (current && document.activeElement !== custom) custom.value = current;
    };
    return { el: h("div", { class: "field" }, h("span", { class: "field-label" }, label), h("div", { class: "swatches" }, ...buttons.values(), custom)), refresh };
  }

  private widthSelect(get: () => number, set: (value: number) => void) {
    const select = h("select", { class: "select", title: "Line thickness" }, ...WIDTHS.map((w) => h("option", { value: w }, `${w} pt`)));
    select.addEventListener("change", () => set(Number(select.value)));
    const refresh = () => {
      const current = get();
      // Show widths that aren't in the list (none are created by the app today) as the nearest one.
      select.value = String(WIDTHS.reduce((best, w) => (Math.abs(w - current) < Math.abs(best - current) ? w : best)));
    };
    return { el: h("div", { class: "field" }, h("span", { class: "field-label" }, "Thickness"), select), refresh };
  }

  private textProps(): HTMLElement[] {
    const item = () => {
      const selected = this.store.selected;
      return selected?.type === "text" ? selected : null;
    };
    // Windows fonts are embedded from the Fonts folder when saving, which only the desktop app can do.
    const fonts = FONTS.filter((def) => !def.files || (isDesktop && isInstalled(def)));
    const font = h("select", { class: "select", title: "Font" }, ...fonts.map((def) => h("option", { value: def.id }, def.label)));
    font.addEventListener("change", () => this.apply({ font: font.value }, { font: font.value }));

    const size = h("input", { class: "number", type: "number", min: 4, max: 300, step: 1, title: "Text size in points" });
    const setSize = (value: number) => {
      if (!Number.isFinite(value)) return;
      const clamped = Math.min(300, Math.max(4, value));
      this.apply({ size: clamped }, { fontSize: clamped });
    };
    size.addEventListener("change", () => setSize(Number(size.value)));
    const smaller = h("button", { type: "button", class: "tb small", title: "Smaller text", html: icon("minus", 14), onclick: () => setSize((item()?.size ?? this.settings.fontSize) - 1) });
    const larger = h("button", { type: "button", class: "tb small", title: "Larger text", html: icon("plus", 14), onclick: () => setSize((item()?.size ?? this.settings.fontSize) + 1) });

    const bold = h("button", { type: "button", class: "tb small toggle bold", title: "Bold", onclick: () => this.apply({ bold: !(item()?.bold ?? this.settings.bold) }, { bold: !(item()?.bold ?? this.settings.bold) }) }, "B");
    const italic = h("button", { type: "button", class: "tb small toggle italic", title: "Italic", onclick: () => this.apply({ italic: !(item()?.italic ?? this.settings.italic) }, { italic: !(item()?.italic ?? this.settings.italic) }) }, "I");
    const color = this.swatches(
      "Colour",
      false,
      () => item()?.color ?? this.settings.textColor,
      (value) => this.apply({ color: value }, { textColor: value! }),
    );

    this.refreshProps = () => {
      const current = item();
      font.value = current?.font ?? this.settings.font;
      if (document.activeElement !== size) size.value = String(current?.size ?? this.settings.fontSize);
      bold.classList.toggle("active", current?.bold ?? this.settings.bold);
      italic.classList.toggle("active", current?.italic ?? this.settings.italic);
      color.refresh();
    };
    return [
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Font"), font),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Size"), smaller, size, larger),
      h("div", { class: "field" }, bold, italic),
      color.el,
    ];
  }

  private markupProps(): HTMLElement[] {
    const item = () => {
      const selected = this.store.selected;
      return selected && (selected.type === "highlight" || selected.type === "underline" || selected.type === "strike") ? selected : null;
    };
    const kinds: [MarkKind, string][] = [
      ["highlight", "Highlight"],
      ["underline", "Underline"],
      ["strike", "Strike through"],
    ];
    const buttons = kinds.map(([kind, label]) =>
      h(
        "button",
        {
          type: "button",
          class: "tb small labelled-small",
          onclick: () => {
            this.settings.markKind = kind;
            const selected = item();
            if (selected) {
              this.store.replace({ ...selected, type: kind, color: this.settings.markColors[kind] });
              this.store.commit();
            }
            saveSettings(this.settings);
            this.refreshProps?.();
          },
        },
        label,
      ),
    );
    const kindNow = () => item()?.type ?? this.settings.markKind;
    const color = this.swatches(
      "Colour",
      false,
      () => item()?.color ?? this.settings.markColors[kindNow()],
      (value) => {
        this.settings.markColors[kindNow()] = value!;
        this.apply({ color: value }, {});
      },
      kindNow() === "highlight" ? HIGHLIGHTS : COLORS,
    );
    this.refreshProps = () => {
      buttons.forEach((b, i) => b.classList.toggle("active", kinds[i][0] === kindNow()));
      color.refresh();
    };
    return [h("div", { class: "field" }, ...buttons), color.el, h("span", { class: "hint" }, item() ? "" : "Select text to mark it.")];
  }

  private noteProps(): HTMLElement[] {
    const item = () => (this.store.selected?.type === "note" ? this.store.selected : null);
    const color = this.swatches(
      "Colour",
      false,
      () => item()?.color ?? this.settings.noteColor,
      (value) => this.apply({ color: value }, { noteColor: value! }),
      NOTE_COLORS,
    );
    this.refreshProps = () => color.refresh();
    return [color.el, h("span", { class: "hint" }, item() ? "" : "Click on the page to leave a comment there.")];
  }

  private strokeProps(): HTMLElement[] {
    const item = () => {
      const selected = this.store.selected;
      return selected && (isLine(selected) || selected.type === "pen" || selected.type === "check" || selected.type === "cross") ? selected : null;
    };
    const color = this.swatches(
      "Colour",
      false,
      () => item()?.stroke ?? this.settings.stroke,
      (value) => this.apply({ stroke: value }, { stroke: value! }),
    );
    const width = this.widthSelect(
      () => item()?.strokeWidth ?? this.settings.strokeWidth,
      (value) => this.apply({ strokeWidth: value }, { strokeWidth: value }),
    );
    this.refreshProps = () => {
      color.refresh();
      width.refresh();
    };
    return [color.el, width.el];
  }

  private shapeProps(): HTMLElement[] {
    const item = () => {
      const selected = this.store.selected;
      return selected?.type === "rect" || selected?.type === "ellipse" ? selected : null;
    };
    const current = () => item() ?? { stroke: this.settings.stroke, fill: this.settings.fill, strokeWidth: this.settings.strokeWidth };
    const outline = this.swatches(
      "Outline",
      true,
      () => current().stroke,
      (value) => {
        // A shape with neither outline nor fill would be invisible.
        if (!value && !current().fill) return;
        this.apply({ stroke: value }, value ? { stroke: value } : {});
      },
    );
    const fill = this.swatches(
      "Fill",
      true,
      () => current().fill,
      (value) => {
        if (!value && !current().stroke) return;
        this.apply({ fill: value }, { fill: value });
      },
    );
    const width = this.widthSelect(
      () => current().strokeWidth,
      (value) => this.apply({ strokeWidth: value }, { strokeWidth: value }),
    );
    this.refreshProps = () => {
      outline.refresh();
      fill.refresh();
      width.refresh();
    };
    return [outline.el, width.el, fill.el];
  }
}
