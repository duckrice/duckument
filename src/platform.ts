// File access. Inside the desktop app this goes through native dialogs and the
// Rust side; in a plain browser (used during development) it falls back to a
// file picker and a download.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";

export const isDesktop = "__TAURI_INTERNALS__" in window;

export interface OpenedFile {
  name: string;
  /** Absolute path; missing in the browser, where files can't be written back. */
  path: string | null;
  bytes: Uint8Array;
}

const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function readPath(path: string): Promise<OpenedFile> {
  const buffer = await invoke<ArrayBuffer>("read_file", { path });
  return { name: baseName(path), path, bytes: new Uint8Array(buffer) };
}

function pickInBrowser(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function fromFile(file: File): Promise<OpenedFile> {
  return { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export async function pickPdf(): Promise<OpenedFile | null> {
  if (isDesktop) {
    const path = await open({ multiple: false, directory: false, filters: PDF_FILTER });
    return path ? readPath(path) : null;
  }
  const file = await pickInBrowser("application/pdf,.pdf");
  return file ? fromFile(file) : null;
}

export async function pickImage(): Promise<Blob | null> {
  if (isDesktop) {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
    });
    return path ? new Blob([(await readPath(path)).bytes as BlobPart]) : null;
  }
  return pickInBrowser("image/*");
}

/** Asks where to save; returns null if cancelled. In the browser there is nothing to ask. */
export async function pickSavePath(suggested: string, filters = PDF_FILTER): Promise<string | null> {
  if (!isDesktop) return suggested;
  return save({ defaultPath: suggested, filters });
}

export const WORD_FILTER = [{ name: "Word document", extensions: ["docx"] }];

export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  if (isDesktop) {
    await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = baseName(path);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const systemFonts = new Map<string, Promise<Uint8Array | null>>();

/** Reads a font file from the Windows Fonts folder; null when it isn't installed. */
export function readSystemFont(file: string): Promise<Uint8Array | null> {
  let font = systemFonts.get(file);
  if (!font) {
    font = invoke<ArrayBuffer>("read_system_font", { file }).then(
      (buffer) => new Uint8Array(buffer),
      () => null,
    );
    systemFonts.set(file, font);
  }
  return font;
}

/** The PDFs Duckument was started with. */
export async function startupFiles(): Promise<string[]> {
  return isDesktop ? invoke<string[]>("startup_files") : [];
}

/** Calls `handler` with the files someone opens while Duckument is already running. */
export function onFilesOpened(handler: (paths: string[]) => void) {
  if (isDesktop) void listen<string[]>("open-files", (event) => handler(event.payload));
}

/** Which of `paths` still exist. */
export async function existingFiles(paths: string[]): Promise<boolean[]> {
  return isDesktop ? invoke<boolean[]>("existing_files", { paths }) : paths.map(() => false);
}

export function setTitle(title: string) {
  document.title = title;
  if (isDesktop) void getCurrentWindow().setTitle(title);
}

/** Calls `handler` with the paths of files dropped onto the window. */
export function onPathsDropped(handler: (paths: string[]) => void) {
  if (!isDesktop) return;
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") handler(event.payload.paths);
  });
}

/**
 * Lets `confirm` veto closing the window (e.g. to offer saving first).
 * It resolves to true when the window may close.
 */
export function onCloseRequested(confirm: () => Promise<boolean>) {
  if (!isDesktop) return;
  const appWindow = getCurrentWindow();
  void appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (await confirm()) await appWindow.destroy();
  });
}
