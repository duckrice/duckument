import "./generated/annotation-layer.css";
import "./styles.css";

import { h, isTyping } from "./dom";
import { EncryptedPdfError, addItemsToPdf } from "./export";
import { icon } from "./icons";
import { Interaction, imageFromBlob } from "./interact";
import { Overlay } from "./overlay";
import {
  baseName,
  fromFile,
  isDesktop,
  onCloseRequested,
  onPathsDropped,
  pickImage,
  pickPdf,
  pickSavePath,
  readPath,
  readSystemFont,
  setTitle,
  startupFile,
  writePath,
  type OpenedFile,
} from "./platform";
import { loadSettings } from "./settings";
import { Store } from "./store";
import { baseline, rasterizeText } from "./textmetrics";
import { Toolbar } from "./toolbar";
import { OpenCancelled, Viewer } from "./viewer";

const APP_NAME = "Free PDF Editor";

interface OpenDocument {
  name: string;
  /** The file as it was opened; every save starts again from these bytes. */
  bytes: Uint8Array;
  /** Where the file came from, if it has a location on disk. */
  path: string | null;
  /** Where Save writes to, once the user has chosen. */
  savePath: string | null;
}

let current: OpenDocument | null = null;
let formsDirty = false;
/** Whether the tip about detected blanks has been shown for this document. */
let blanksAnnounced = false;

const app = document.getElementById("app")!;
const viewerEl = h("main", { class: "viewer" });
const toasts = h("div", { class: "toasts" });

const store = new Store();
const settings = loadSettings();
const viewer = new Viewer(viewerEl, {
  onView: () => toolbar?.update(),
  onFormEdit: () => {
    formsDirty = true;
    updateTitle();
  },
  onBlanks: (view) => {
    const count = view.blanks?.length ?? 0;
    if (!count || blanksAnnounced) return;
    blanksAnnounced = true;
    toast(`Found ${count} ${count === 1 ? "blank" : "blanks"} to fill in on page ${view.index + 1}. Click one to type in it; Tab moves to the next.`);
  },
  askPassword,
});
const overlay = new Overlay(store, viewer);
const interaction = new Interaction(store, viewer, overlay, settings, () => toolbar?.update());
const toolbar: Toolbar = new Toolbar(store, viewer, interaction, settings, {
  open: () => void openWithPicker(),
  save: () => void save(false),
  saveAs: () => void save(true),
  insertImage: () => void insertImage(),
  toast,
});

const welcome = h(
  "div",
  { class: "welcome" },
  h("div", { class: "welcome-icon", html: icon("document", 56) }),
  h("h1", {}, APP_NAME),
  h("p", {}, "Sign documents, fill in forms, add text and shapes."),
  h("button", { type: "button", class: "btn primary large", onclick: () => void openWithPicker() }, "Open a PDF"),
  h("p", { class: "muted" }, "or drop a file anywhere in this window"),
);
viewerEl.append(welcome);
app.append(toolbar.el, viewerEl, toasts);

store.subscribe(updateTitle);
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

function isDirty() {
  return store.dirty || formsDirty;
}

function updateTitle() {
  setTitle(current ? `${isDirty() ? "● " : ""}${current.name} – ${APP_NAME}` : APP_NAME);
}

// ---- opening ----------------------------------------------------------------

/** Offers to save unsaved work. Resolves to false if the user wants to stay. */
async function confirmDiscard(): Promise<boolean> {
  overlay.finishEdit();
  if (!current || !isDirty()) return true;
  const answer = await ask("Save your changes?", `"${current.name}" has changes that haven't been saved.`, [
    { label: "Cancel", value: "cancel" },
    { label: "Don't save", value: "discard" },
    { label: "Save", value: "save", primary: true },
  ]);
  if (answer === "discard") return true;
  if (answer === "save") return save(false);
  return false;
}

async function openDocument(file: OpenedFile) {
  if (!(await confirmDiscard())) return;
  try {
    await viewer.open(file.bytes);
  } catch (error) {
    if (!(error instanceof OpenCancelled)) {
      console.error(error);
      toast(`"${file.name}" could not be opened. It may be damaged or not a PDF.`, "error");
    }
    return;
  }
  welcome.remove();
  overlay.clear();
  store.reset();
  interaction.setTool("select");
  current = { name: file.name, bytes: file.bytes, path: file.path, savePath: null };
  formsDirty = false;
  blanksAnnounced = false;
  updateTitle();
  toolbar.update();
  // Field detection finishes shortly after the first page is shown.
  setTimeout(() => {
    if (viewer.hasForms) toast("This PDF has fillable fields. Click a field to type in it.");
  }, 600);
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
  try {
    await openDocument(await readPath(path));
  } catch (error) {
    console.error(error);
    toast(String(error), "error");
  }
}

// ---- saving -----------------------------------------------------------------

async function buildPdf(doc: OpenDocument): Promise<Uint8Array> {
  const pdf = viewer.pdf!;
  // pdf.js writes the filled-in form fields; everything added on top is drawn afterwards.
  const base = pdf.annotationStorage.size > 0 ? await pdf.saveDocument() : doc.bytes;
  return addItemsToPdf(base, store.items, {
    pageTransform: (index) => viewer.pageTransform(index),
    baseline,
    rasterizeText,
    loadFont: isDesktop ? readSystemFont : undefined,
  });
}

function suggestedSavePath(doc: OpenDocument): string {
  const source = doc.path ?? doc.name;
  return source.replace(/(\.pdf)?$/i, "-edited.pdf");
}

/** Saves the document. Resolves to true once it has been written. */
async function save(chooseLocation: boolean): Promise<boolean> {
  const doc = current;
  if (!doc || !viewer.pdf) return false;
  overlay.finishEdit();
  try {
    // The first save always asks, so the original file is only replaced on purpose.
    let path = doc.savePath;
    if (!path || chooseLocation) {
      path = await pickSavePath(doc.savePath ?? suggestedSavePath(doc));
      if (!path) return false;
    }
    await writePath(path, await buildPdf(doc));
    if (current !== doc) return true;
    doc.savePath = path;
    formsDirty = false;
    viewer.pdf.annotationStorage.resetModified();
    store.markSaved();
    updateTitle();
    toast(`Saved as ${baseName(path)}`);
    return true;
  } catch (error) {
    console.error(error);
    toast(error instanceof EncryptedPdfError ? error.message : `Could not save: ${String(error)}`, "error");
    return false;
  }
}

async function insertImage() {
  if (!viewer.pdf) return;
  const blob = await pickImage();
  const image = blob && (await imageFromBlob(blob));
  if (image) interaction.placeImage(image.src, image.w, image.h);
  else if (blob) toast("That file could not be read as a picture.", "error");
}

// ---- global input -----------------------------------------------------------

window.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "o") void openWithPicker();
    else if (key === "s") void save(event.shiftKey);
    else if (key === "=" || key === "+") viewer.setZoom(viewer.zoom * 1.2);
    else if (key === "-") viewer.setZoom(viewer.zoom / 1.2);
    else if (key === "0") viewer.zoomToFitWidth();
    else return;
    event.preventDefault();
  } else if (key === "s" && !event.altKey && !isTyping(event.target)) {
    toolbar.toggleSignMenu();
    event.preventDefault();
  }
});

onPathsDropped((paths) => {
  const path = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
  if (path) void openPath(path);
  else toast("Only PDF files can be opened.", "error");
});

if (!isDesktop) {
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (file) void fromFile(file).then(openDocument);
  });
  window.addEventListener("beforeunload", (event) => {
    if (isDirty()) event.preventDefault();
  });
}

onCloseRequested(confirmDiscard);

void startupFile().then((path) => {
  if (path) void openPath(path);
});

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
      store,
      viewer,
      build: () => buildPdf(current!),
      /** Shows what saving would produce, in place of the document being edited. */
      async showSaved() {
        const bytes = await buildPdf(current!);
        store.markSaved();
        formsDirty = false;
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
