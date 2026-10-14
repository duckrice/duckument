import "./generated/annotation-layer.css";
import "./styles.css";

import { getVersion } from "@tauri-apps/api/app";
import logo from "./assets/duckument.png";
import { h, isTyping } from "./dom";
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
import { loadSettings } from "./settings";
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
};

// Stands in for a document while none is open, so the toolbar always has one.
const nothingOpen = new DocTab(settings, hooks);

const app = document.getElementById("app")!;
const tabBar = h("nav", { class: "tab-bar", hidden: true, "aria-label": "Open documents" });
const documents = h("div", { class: "documents" });
const toasts = h("div", { class: "toasts" });
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
  save: () => void active?.save(false),
  saveAs: () => void active?.save(true),
  insertImage: () => void active?.insertImage(),
  toast,
});
documents.append(welcome);
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
    if (key === "o") void openWithPicker();
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

onPathsDropped(openPaths);
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
