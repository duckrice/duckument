import { COMPRESS_LEVELS, compressPdf, flattenForm } from "./compress";
import { addPassword } from "./password";
import "./generated/annotation-layer.css";
import "./styles.css";

import { getVersion } from "@tauri-apps/api/app";
import logo from "./assets/duckument.png";
import { h, isTyping } from "./dom";
import { STAMPS } from "./stamps";
import {
  baseName,
  existingFiles,
  fromFile,
  isDesktop,
  onCloseRequested,
  onFilesOpened,
  onPathsDropped,
  pickPdf,
  readPath,
  setTitle,
  startupFiles,
  type OpenedFile,
} from "./platform";
import { addRecent, loadRecent, removeRecent } from "./recent";
import { loadSettings, saveSettings } from "./settings";
import { SearchBar } from "./search";
import { DocTab, type TabHooks } from "./tab";
import { Toolbar } from "./toolbar";
import { offerUpdate } from "./updates";
import { OpenCancelled } from "./viewer";

const APP_NAME = "Duckument";

const settings = loadSettings();
const tabs: DocTab[] = [];
let active: DocTab | null = null;

const hooks: TabHooks = {
  changed(tab) {
    renderTabs();
    if (tab === active) {
      toolbar.update();
      updateTitle();
    }
  },
  toast,
  askPassword,
  askSplit,
};

// Stands in for a document while none is open, so the toolbar always has one.
const nothingOpen = new DocTab(settings, hooks);

const app = document.getElementById("app")!;
const tabBar = h("nav", { class: "tab-bar", hidden: true, "aria-label": "Open documents" });
const documents = h("div", { class: "documents" });
const toasts = h("div", { class: "toasts" });
const search = new SearchBar();
const recentList = h("div", { class: "recent" });
const welcome = h(
  "div",
  { class: "welcome" },
  h("img", { class: "welcome-logo", src: logo, alt: "", width: 96, height: 96 }),
  h("h1", {}, APP_NAME),
  h("p", {}, "Sign documents, fill in forms, add text and shapes."),
  h("button", { type: "button", class: "btn primary large", onclick: () => void openWithPicker() }, "Open a PDF"),
  h("p", { class: "muted" }, "or drop a file anywhere in this window"),
  recentList,
  h("p", { class: "version muted" }),
);
const toolbar = new Toolbar(nothingOpen, settings, {
  open: () => void openWithPicker(),
  togglePages: () => {
    settings.showPages = !settings.showPages;
    saveSettings(settings);
    documents.classList.toggle("no-sidebar", !settings.showPages);
    toolbar.update();
  },
  save: () => void active?.save(false),
  saveAs: () => void active?.save(true),
  saveAsWord: () => void active?.saveAsWord(),
  compress: () => askCompress(),
  insertImage: () => void active?.insertImage(),
  pageNumbers: () => void askPageNumbers(),
  watermark: () => void askWatermark(),
  stamp: () => void askStamp(),
  toast,
});
documents.append(welcome, search.el);
documents.classList.toggle("no-sidebar", !settings.showPages);
app.append(tabBar, toolbar.el, documents, toasts);
void showRecent();
updateTitle();

// ---- small UI helpers -------------------------------------------------------

function toast(message: string, kind: "info" | "error" = "info") {
  const el = h("div", { class: `toast ${kind}`, role: "status" }, message);
  toasts.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 8000 : 4000);
}

/** Shows a modal question and resolves to the chosen button's value, or null if dismissed. */
function ask(title: string, message: string, buttons: { label: string; value: string; primary?: boolean }[]) {
  return new Promise<string | null>((resolve) => {
    let answer: string | null = null;
    const dialog = h(
      "dialog",
      { class: "dialog" },
      h("h2", {}, title),
      h("p", {}, message),
      h(
        "div",
        { class: "dialog-footer" },
        ...buttons.map((b) =>
          h(
            "button",
            {
              type: "button",
              class: `btn${b.primary ? " primary" : ""}`,
              onclick: () => {
                answer = b.value;
                dialog.close();
              },
            },
            b.label,
          ),
        ),
      ),
    );
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Asks how to number the pages, then numbers them. */
function askPageNumbers() {
  const tab = active;
  if (!tab?.viewer.pdf) return;
  const select = (label: string, options: [string, string][]) => h("label", { class: "field" }, label, h("select", { class: "text-input" }, ...options.map(([value, text]) => h("option", { value }, text))));
  const format = select("Look", [["page-of", "Page 1 of 9"], ["number", "1"], ["slash", "1 / 9"], ["custom", "My own text…"]]);
  const place = select("Where", [["bottom-center", "Bottom, in the middle"], ["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"], ["top-right", "Top right"], ["top-center", "Top, in the middle"], ["top-left", "Top left"]]);
  const custom = h("label", { class: "field", hidden: true }, "Text ({n} = page, {total} = pages, {date} = today)", h("input", { type: "text", class: "text-input", value: "Confidential · page {n} of {total}" }));
  format.querySelector("select")!.addEventListener("change", (e) => (custom.hidden = (e.target as HTMLSelectElement).value !== "custom"));
  const size = h("label", { class: "field" }, "Size", h("input", { type: "number", class: "text-input", min: 6, max: 72, value: 10 }));
  const start = h("label", { class: "field" }, "Start at", h("input", { type: "number", class: "text-input", min: 0, value: 1 }));
  const skip = h("label", { class: "check-field" }, h("input", { type: "checkbox" }), " No number on the first page (a title page)");
  const form = h(
    "form",
    { method: "dialog" },
    h("h2", {}, "Page numbers, header and footer"),
    h("p", {}, "A number goes on every page as ordinary text: you can move, change or delete each one, and undo them all at once."),
    format,
    custom,
    place,
    size,
    start,
    skip,
    h("div", { class: "dialog-footer" }, h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"), h("button", { type: "submit", class: "btn primary" }, "Add")),
  );
  const value = (el: HTMLElement) => (el.querySelector("select, input") as HTMLInputElement).value;
  form.addEventListener("submit", () => {
    const count = tab.addPageNumbers({
      format: value(format) as "page-of",
      place: value(place) as "bottom-center",
      size: Math.max(6, Math.min(72, Number(value(size)) || 10)),
      start: Math.max(0, Math.round(Number(value(start)) || 1)),
      skipFirst: (skip.querySelector("input") as HTMLInputElement).checked,
      text: (custom.querySelector("input") as HTMLInputElement).value,
    });
    toast(`Numbered ${count} ${count === 1 ? "page" : "pages"}.`);
  });
  const dialog = h("dialog", { class: "dialog" }, form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Asks how to split a PDF into files. */
function askSplit(total: number, selected: number): Promise<{ every: number } | { atSelected: true } | null> {
  return new Promise((resolve) => {
    let answer: { every: number } | { atSelected: true } | null = null;
    const every = h("input", { type: "radio", name: "split-how", checked: selected < 2 }) as HTMLInputElement;
    const count = h("input", { type: "number", class: "text-input", min: 1, max: Math.max(1, total - 1), value: 1, style: "width: 5em" }) as HTMLInputElement;
    const atSelected = h("input", { type: "radio", name: "split-how", checked: selected >= 2, disabled: selected < 2 }) as HTMLInputElement;
    count.addEventListener("focus", () => (every.checked = true));
    const form = h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Split into several PDFs"),
      h("p", {}, `The ${total} pages are saved as numbered files (name-1.pdf, name-2.pdf, …). The document you have open isn't changed.`),
      h("label", { class: "check-field" }, every, " A new file every ", count, " pages"),
      h("label", { class: "check-field" }, atSelected, selected >= 2 ? ` A new file at each of the ${selected} selected pages` : " A new file at each selected page (select pages in the page list first, Ctrl+click for more)"),
      h("div", { class: "dialog-footer" }, h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"), h("button", { type: "submit", class: "btn primary" }, "Save…")),
    );
    form.addEventListener("submit", () => {
      answer = atSelected.checked ? { atSelected: true } : { every: Math.max(1, Math.round(Number(count.value) || 1)) };
    });
    const dialog = h("dialog", { class: "dialog" }, form);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Asks how the copy to send should be (smaller, form filled in for good), then saves it. */
function askCompress() {
  const tab = active;
  if (!tab?.viewer.pdf) return;
  const levels: [keyof typeof COMPRESS_LEVELS | "none", string][] = [
    ["strong", "Smallest, for e-mail"],
    ["medium", "Medium, for reading on a screen"],
    ["light", "A little, still good for printing"],
    ["none", "Keep the pictures as they are"],
  ];
  const radios = levels.map(([value], i) => h("input", { type: "radio", name: "compress-level", value, checked: i === 0 }) as HTMLInputElement);
  // Ticked when a form was filled in here.
  const hasForm = [...tab.viewer.sources.values()].some((pdf) => pdf.annotationStorage.size > 0);
  const flatten = h("input", { type: "checkbox", checked: hasForm }) as HTMLInputElement;
  const ocr = h("input", { type: "checkbox" }) as HTMLInputElement;
  const password = h("input", { type: "password", class: "text-input", autocomplete: "new-password", placeholder: "None" }) as HTMLInputElement;
  const again = h("input", { type: "password", class: "text-input", autocomplete: "new-password", placeholder: "Type it again" }) as HTMLInputElement;
  again.addEventListener("input", () => again.setCustomValidity(""));
  const form = h(
    "form",
    { method: "dialog" },
    h("h2", {}, "Save a copy to send"),
    h("p", {}, "The document you have open isn't changed."),
    h("p", {}, "Pictures and scanned pages:"),
    ...levels.map(([, label], i) => h("label", { class: "check-field" }, radios[i], ` ${label}`)),
    h("p", {}, "Form:"),
    h("label", { class: "check-field" }, flatten, " Fill in the form for good (the answers become part of the page and can't be changed)"),
    h("p", {}, "Scans:"),
    h("label", { class: "check-field" }, ocr, " Make scanned pages searchable (the text in them is read, so it can be found and copied)"),
    h("label", { class: "field" }, "Password to open it (only people who know it can read it)", password, again),
    h("div", { class: "dialog-footer" }, h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"), h("button", { type: "submit", class: "btn primary" }, "Save…")),
  );
  form.addEventListener("submit", (event) => {
    if (password.value !== again.value) {
      event.preventDefault();
      again.setCustomValidity("The two passwords aren't the same.");
      again.reportValidity();
      return;
    }
    const level = radios.find((r) => r.checked)!.value;
    void tab.saveCopy(level === "none" ? null : COMPRESS_LEVELS[level as keyof typeof COMPRESS_LEVELS], flatten.checked, ocr.checked, password.value);
  });
  const dialog = h("dialog", { class: "dialog" }, form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Shows the stamps to pick from, then puts the chosen one on the page being read. */
function askStamp() {
  const tab = active;
  if (!tab?.viewer.pdf) return;
  const withDate = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const own = h("input", { type: "text", class: "text-input", maxlength: 30, placeholder: "Your own words" }) as HTMLInputElement;
  const ownColor = h("input", { type: "color", value: "#7c3aed" }) as HTMLInputElement;
  const place = (words: string, color: string) => {
    dialog.close();
    const date = withDate.checked ? new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
    toast(`Stamped page ${tab.addStamp(words, color, date)}. Drag it where you want it.`);
  };
  const form = h(
    "form",
    { method: "dialog" },
    h("h2", {}, "Stamp"),
    h("p", {}, "Goes in the top-right corner of the page you're reading. It can be moved, changed or deleted afterwards."),
    h("div", { class: "stamp-grid" }, ...STAMPS.map(([words, color]) => h("button", { type: "button", class: "stamp-choice", style: `color: ${color}; border-color: ${color}`, onclick: () => place(words, color) }, words))),
    h("label", { class: "field" }, "Or", own, ownColor),
    h("label", { class: "check-field" }, withDate, " With today's date"),
    h("div", { class: "dialog-footer" }, h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"), h("button", { type: "submit", class: "btn primary" }, "Stamp")),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (own.value.trim()) place(own.value.trim().toUpperCase(), ownColor.value);
    else own.focus();
  });
  const dialog = h("dialog", { class: "dialog" }, form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Asks for a watermark's words and look, then puts it on every page. */
function askWatermark() {
  const tab = active;
  if (!tab?.viewer.pdf) return;
  const words = h("input", { type: "text", class: "text-input", list: "watermark-words", value: "DRAFT", maxlength: 40 });
  const list = h("datalist", { id: "watermark-words" }, ...["DRAFT", "CONFIDENTIAL", "COPY", "SAMPLE", "UTKAST", "KONFIDENSIELT"].map((w) => h("option", { value: w })));
  const color = h("input", { type: "color", value: "#888888" });
  const size = h("input", { type: "number", class: "text-input", min: 12, max: 200, value: 80 });
  const opacity = h("input", { type: "range", min: 5, max: 100, value: 25 });
  const across = h("input", { type: "checkbox", checked: true });
  const form = h(
    "form",
    { method: "dialog" },
    h("h2", {}, "Watermark"),
    h("p", {}, "Words across the middle of every page. Each page's watermark can still be moved or changed, and Undo takes them all off."),
    h("label", { class: "field" }, "Words", words, list),
    h("label", { class: "field" }, "Size", size),
    h("label", { class: "field" }, "Colour", color),
    h("label", { class: "field" }, "How see-through", opacity),
    h("label", { class: "check-field" }, across, " Diagonal"),
    h("div", { class: "dialog-footer" }, h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"), h("button", { type: "submit", class: "btn primary" }, "Add")),
  );
  form.addEventListener("submit", () => {
    const text = (words as HTMLInputElement).value.trim();
    if (!text) return;
    const count = tab.addWatermark({
      text,
      size: Math.max(12, Math.min(200, Number((size as HTMLInputElement).value) || 80)),
      angle: (across as HTMLInputElement).checked ? 45 : 0,
      opacity: Number((opacity as HTMLInputElement).value) / 100,
      color: (color as HTMLInputElement).value,
    });
    toast(`Added the watermark to ${count} ${count === 1 ? "page" : "pages"}.`);
  });
  const dialog = h("dialog", { class: "dialog" }, form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function askPassword(retry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const input = h("input", { type: "password", class: "text-input", autocomplete: "off" });
    const form = h(
      "form",
      { method: "dialog" },
      h("h2", {}, "This PDF is locked"),
      h("p", {}, retry ? "That password was not right. Try again." : "Enter its password to open it."),
      input,
      h(
        "div",
        { class: "dialog-footer" },
        h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"),
        h("button", { type: "submit", class: "btn primary" }, "Open"),
      ),
    );
    form.addEventListener("submit", () => (answer = input.value));
    const dialog = h("dialog", { class: "dialog" }, form);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function updateTitle() {
  setTitle(active ? `${active.dirty ? "● " : ""}${active.name} – ${APP_NAME}` : APP_NAME);
}

// ---- tabs -------------------------------------------------------------------

function activate(tab: DocTab | null) {
  for (const other of tabs) other.active = other === tab;
  active = tab;
  welcome.hidden = !!tab;
  toolbar.setTarget(tab ?? nothingOpen);
  search.setViewer(tab?.viewer ?? null);
  if (!tab) search.close();
  if (!tab) void showRecent();
  renderTabs();
  updateTitle();
}

function renderTabs() {
  tabBar.hidden = tabs.length === 0;
  if (tabBar.hidden) return;
  tabBar.replaceChildren(
    ...tabs.map((tab) => {
      const close = h("span", { class: "tab-close", role: "button", title: "Close (Ctrl+W)", "aria-label": `Close ${tab.name}` }, "×");
      const el = h(
        "div",
        {
          class: `doc-tab${tab === active ? " active" : ""}${tab.dirty ? " dirty" : ""}`,
          role: "tab",
          "aria-selected": tab === active ? "true" : "false",
          title: tab.file?.path ?? tab.name,
        },
        h("span", { class: "tab-name" }, tab.name),
        h("span", { class: "tab-dot", "aria-label": "unsaved changes" }),
        close,
      );
      el.addEventListener("pointerdown", (event) => {
        // The middle button closes a tab, as in a web browser.
        if (event.button === 1) {
          event.preventDefault();
          void closeTab(tab);
        } else if (event.button === 0 && !(event.target as Element).closest(".tab-close")) activate(tab);
      });
      close.addEventListener("click", () => void closeTab(tab));
      return el;
    }),
    h("button", { type: "button", class: "tab-add", title: "Open another PDF (Ctrl+O)", onclick: () => void openWithPicker() }, "+"),
  );
}

/** Asks whether to save a document's changes. Resolves to false if the user wants to keep it open. */
async function confirmDiscard(tab: DocTab): Promise<boolean> {
  tab.overlay.finishEdit();
  if (!tab.dirty) return true;
  activate(tab);
  const answer = await ask("Save your changes?", `"${tab.name}" has changes that haven't been saved.`, [
    { label: "Cancel", value: "cancel" },
    { label: "Don't save", value: "discard" },
    { label: "Save", value: "save", primary: true },
  ]);
  if (answer === "discard") return true;
  if (answer === "save") return tab.save(false);
  return false;
}

/** Offers to save every document with changes. Resolves to false if the user wants to stay. */
async function confirmDiscardAll(): Promise<boolean> {
  for (const tab of [...tabs]) if (!(await confirmDiscard(tab))) return false;
  return true;
}

async function closeTab(tab: DocTab): Promise<boolean> {
  if (!(await confirmDiscard(tab))) return false;
  const index = tabs.indexOf(tab);
  if (index < 0) return true;
  tabs.splice(index, 1);
  tab.close();
  if (active === tab) activate(tabs[Math.min(index, tabs.length - 1)] ?? null);
  else renderTabs();
  return true;
}

function cycleTabs(step: number) {
  if (!active || tabs.length < 2) return;
  const index = (tabs.indexOf(active) + step + tabs.length) % tabs.length;
  activate(tabs[index]);
}

// ---- opening ----------------------------------------------------------------

const samePath = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function openDocument(file: OpenedFile) {
  // A file that is already open is shown rather than opened twice.
  const existing = tabs.find((tab) => samePath(tab.file?.path, file.path));
  if (existing) {
    activate(existing);
    return;
  }
  const previous = active;
  const tab = new DocTab(settings, hooks);
  documents.append(tab.el);
  // The new page area has to be on screen while opening, to size the pages to it.
  if (previous) previous.active = false;
  welcome.hidden = true;
  tab.active = true;
  try {
    await tab.open(file);
  } catch (error) {
    tab.close();
    activate(previous);
    if (!(error instanceof OpenCancelled)) {
      console.error(error);
      toast(`"${file.name}" could not be opened. It may be damaged or not a PDF.`, "error");
    }
    return;
  }
  tabs.push(tab);
  activate(tab);
  if (file.path) addRecent(file.path, file.name);
}

async function openWithPicker() {
  try {
    const file = await pickPdf();
    if (file) await openDocument(file);
  } catch (error) {
    console.error(error);
    toast(String(error), "error");
  }
}

async function openPath(path: string) {
  const existing = tabs.find((tab) => samePath(tab.file?.path, path));
  if (existing) {
    activate(existing);
    return;
  }
  let file: OpenedFile;
  try {
    file = await readPath(path);
  } catch (error) {
    console.error(error);
    removeRecent([path]);
    toast(`"${baseName(path)}" could not be opened. It may have been moved or deleted.`, "error");
    if (!active) void showRecent();
    return;
  }
  await openDocument(file);
}

/** Lists recently opened files that still exist on the start screen. */
async function showRecent() {
  const recent = loadRecent();
  const exists = await existingFiles(recent.map((f) => f.path));
  const gone = recent.filter((_, i) => !exists[i]).map((f) => f.path);
  if (gone.length) removeRecent(gone);
  const present = recent.filter((_, i) => exists[i]);
  recentList.replaceChildren(
    ...(present.length ? [h("h2", {}, "Recent files")] : []),
    ...present.map((file) =>
      h(
        "button",
        { type: "button", class: "recent-file", title: file.path, onclick: () => void openPath(file.path) },
        h("span", { class: "recent-name" }, file.name),
        h("span", { class: "recent-folder" }, file.path.slice(0, file.path.length - file.name.length).replace(/[\\/]$/, "")),
      ),
    ),
  );
}

// ---- global input -----------------------------------------------------------

window.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    const viewer = active?.viewer;
    if (key === "f") {
      if (active) search.open();
    } else if (key === "o") void openWithPicker();
    else if (key === "s") void active?.save(event.shiftKey);
    else if (key === "w") {
      if (active) void closeTab(active);
    } else if (key === "tab") cycleTabs(event.shiftKey ? -1 : 1);
    else if (key === "pagedown") cycleTabs(1);
    else if (key === "pageup") cycleTabs(-1);
    else if (key === "=" || key === "+") viewer?.setZoom(viewer.zoom * 1.2);
    else if (key === "-") viewer?.setZoom(viewer.zoom / 1.2);
    else if (key === "0") viewer?.zoomToFitWidth();
    else return;
    event.preventDefault();
  } else if (event.key === "F12" && active) {
    void active.save(true);
    event.preventDefault();
  } else if (event.key === "F3" && search.isOpen) {
    search.step(event.shiftKey ? -1 : 1);
    event.preventDefault();
  } else if (key === "s" && !event.altKey && !isTyping(event.target) && active) {
    toolbar.toggleSignMenu();
    event.preventDefault();
  }
});

const openPaths = (paths: string[]) => {
  const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length && paths.length) toast("Only PDF files can be opened.", "error");
  void (async () => {
    for (const path of pdfs) await openPath(path);
  })();
};

// PDFs dropped on the page list go in among the pages there, as in Acrobat; elsewhere they open.
onPathsDropped((paths, at) => {
  const index = active?.thumbnails.dropTarget(at.x, at.y) ?? null;
  const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
  if (index === null || !pdfs.length) return openPaths(paths);
  const tab = active!;
  void Promise.all(pdfs.map(readPath)).then((files) => tab.addPdfFiles(files, index));
});
onFilesOpened(openPaths);

if (!isDesktop) {
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    for (const file of event.dataTransfer?.files ?? []) {
      if (file.name.toLowerCase().endsWith(".pdf")) void fromFile(file).then(openDocument);
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (tabs.some((tab) => tab.dirty)) event.preventDefault();
  });
}

onCloseRequested(confirmDiscardAll);

if (isDesktop) {
  void getVersion().then((version) => {
    welcome.querySelector(".version")!.textContent = `Version ${version}`;
  });
  // Give the first document a moment to open before going online.
  setTimeout(() => void offerUpdate(toolbar.el, { beforeInstall: confirmDiscardAll }), 3000);
}

void startupFiles().then(openPaths);

// Testing aid: `__fpe` in the console. In the installed app it is only there
// after `localStorage["freepdfeditor.debug"] = "1"` and a reload.
let debug = import.meta.env.DEV;
try {
  debug ||= localStorage.getItem("freepdfeditor.debug") === "1";
} catch {
  // No storage, no debug handle.
}
if (debug) {
  Object.assign(window, {
    __fpe: {
      get store() {
        return active?.store;
      },
      get viewer() {
        return active?.viewer;
      },
      get tabs() {
        return tabs.map((tab) => ({ name: tab.name, path: tab.file?.path ?? null, dirty: tab.dirty, active: tab === active }));
      },
      build: () => active!.build(),
      compress: (bytes: Uint8Array, level: keyof typeof COMPRESS_LEVELS) => compressPdf(bytes, COMPRESS_LEVELS[level]),
      flatten: (bytes: Uint8Array) => flattenForm(bytes),
      searchable: (bytes: Uint8Array) => active!.searchable(bytes),
      protect: (bytes: Uint8Array, password: string) => addPassword(bytes, password),
      get tab() {
        return active;
      },
      /** Merges a file the test supplies, as "Add PDF…" would after the file dialog. */
      async addPdf(path: string | string[], at: number) {
        await active!.addPdfFiles(await Promise.all([path].flat().map(readPath)), at);
      },
      activate: (index: number) => activate(tabs[index]),
      /** Shows what saving would produce, in a new tab. */
      async showSaved() {
        const bytes = await active!.build();
        await openDocument({ name: "saved.pdf", path: null, bytes });
      },
    },
  });
}

if (import.meta.env.DEV) {
  // http://localhost:1420/?src=/samples/form.pdf opens a file served by Vite.
  const src = new URLSearchParams(location.search).get("src");
  if (src) {
    void fetch(src)
      .then((response) => response.arrayBuffer())
      .then((buffer) => openDocument({ name: baseName(src), path: null, bytes: new Uint8Array(buffer) }));
  }
}
