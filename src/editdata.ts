// Keeps what was added in Duckument editable after saving, for this computer
// only. A saved PDF looks and reads like any other: everything added is part
// of the page. Next to that it carries a copy of the edits, encrypted with a
// key that only exists in this Duckument's settings. When this Duckument opens
// the file again, it takes its own drawing back off the pages and restores the
// edits as movable items. Any other program, or Duckument on another
// computer, can't read the copy and just sees the finished pages.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, PDFRef, decodePDFRawStream, degrees } from "pdf-lib";
import type { Item } from "./model";

/** Tag for Duckument's own drawing on a page, so it can be found again. */
export const MARK = "Duckument";
/** Key on comments Duckument added. */
export const NOTE_FLAG = "DuckumentNote";

const KEY_STORAGE = "freepdfeditor.editKey";

/** What is stored for each page, to restore it as it was. */
export interface SavedPage {
  /** The page's own rotation, before the user turned it. */
  rotate: number;
  /** How far the user had turned it. */
  extra: number;
  width: number;
  height: number;
}

export interface EditPayload {
  v: 1;
  pages: SavedPage[];
  items: Item[];
}

// ---- the key --------------------------------------------------------------------

let keyPromise: Promise<{ key: CryptoKey; id: string }> | null = null;

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** This computer's key, made the first time it is needed. */
function editKey(): Promise<{ key: CryptoKey; id: string }> {
  keyPromise ??= (async () => {
    let raw: Uint8Array | null = null;
    try {
      const stored = localStorage.getItem(KEY_STORAGE);
      if (stored) raw = fromBase64(stored);
    } catch {
      raw = null;
    }
    if (!raw || raw.length !== 32) {
      raw = crypto.getRandomValues(new Uint8Array(32));
      try {
        localStorage.setItem(KEY_STORAGE, toBase64(raw));
      } catch {
        // Without storage the key lasts until Duckument closes.
      }
    }
    const key = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
    // Names the key without giving it away, to tell at once whether a file is ours.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw as BufferSource));
    const id = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
    return { key, id };
  })();
  return keyPromise;
}

async function deflate(bytes: Uint8Array, mode: "compress" | "decompress"): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(mode === "compress" ? new CompressionStream("deflate") : new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encrypts the edits. */
export async function seal(payload: EditPayload): Promise<{ blob: Uint8Array; keyId: string }> {
  const { key, id } = await editKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await deflate(new TextEncoder().encode(JSON.stringify(payload)), "compress");
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource));
  const blob = new Uint8Array(iv.length + cipher.length);
  blob.set(iv);
  blob.set(cipher, iv.length);
  return { blob, keyId: id };
}

async function unseal(blob: Uint8Array): Promise<EditPayload | null> {
  try {
    const { key } = await editKey();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12));
    const payload = JSON.parse(new TextDecoder().decode(await deflate(new Uint8Array(plain), "decompress")));
    return payload?.v === 1 && Array.isArray(payload.items) && Array.isArray(payload.pages) ? payload : null;
  } catch {
    return null;
  }
}

// ---- in the PDF -------------------------------------------------------------------

/** Puts the encrypted edits into a document, where only Duckument looks. */
export function attach(doc: PDFDocument, blob: Uint8Array, keyId: string) {
  const stream = doc.context.register(doc.context.stream(blob));
  const entry = doc.context.obj({ LastModified: PDFString.fromDate(new Date()), KeyId: PDFString.of(keyId), Private: stream });
  const existing = doc.catalog.lookup(PDFName.of("PieceInfo"));
  const pieces = existing instanceof PDFDict ? existing : doc.context.obj({});
  pieces.set(PDFName.of(MARK), entry);
  doc.catalog.set(PDFName.of("PieceInfo"), pieces);
}

function attached(doc: PDFDocument): { blob: Uint8Array; keyId: string } | null {
  const pieces = doc.catalog.lookup(PDFName.of("PieceInfo"));
  const entry = pieces instanceof PDFDict ? pieces.lookup(PDFName.of(MARK)) : undefined;
  if (!(entry instanceof PDFDict)) return null;
  const stream = entry.lookup(PDFName.of("Private"));
  const keyId = entry.lookup(PDFName.of("KeyId"));
  if (!(stream instanceof PDFRawStream) || !(keyId instanceof PDFString)) return null;
  return { blob: stream.getContents(), keyId: keyId.decodeText() };
}

/** Whether a page content stream is Duckument's own drawing. */
function isOurs(doc: PDFDocument, ref: unknown): boolean {
  const stream = doc.context.lookup(ref as PDFRef);
  if (!(stream instanceof PDFRawStream)) return false;
  try {
    const head = new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode().slice(0, 40));
    return head.trimStart().startsWith(`/${MARK} BMC`);
  } catch {
    return false;
  }
}

export interface Restored {
  /** The document without Duckument's drawing, turned back as it was before saving. */
  bytes: Uint8Array;
  items: Item[];
  /** How far the user had turned each page. */
  rotations: number[];
}

/**
 * If a PDF was saved by this Duckument, takes its own drawing back off and
 * returns the edits; otherwise null, and the file opens as it is.
 */
export async function restore(bytes: Uint8Array): Promise<Restored | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return null;
  }
  if (doc.isEncrypted) return null;
  const found = attached(doc);
  if (!found || found.keyId !== (await editKey()).id) return null;
  const payload = await unseal(found.blob);
  if (!payload) return null;

  // If the file was rearranged by another program since, the edits no longer fit it.
  const pages = doc.getPages();
  if (pages.length !== payload.pages.length) return null;
  const fits = pages.every((page, i) => {
    const { width, height } = page.getMediaBox();
    return Math.abs(width - payload.pages[i].width) < 0.5 && Math.abs(height - payload.pages[i].height) < 0.5;
  });
  if (!fits) return null;

  pages.forEach((page, i) => {
    const contents = page.node.Contents();
    if (contents instanceof PDFArray) {
      const kept = contents.asArray().filter((ref) => !isOurs(doc, ref));
      page.node.set(PDFName.of("Contents"), doc.context.obj(kept));
    }
    const annots = page.node.Annots();
    if (annots) {
      const kept = annots.asArray().filter((ref) => {
        const annot = doc.context.lookup(ref);
        return !(annot instanceof PDFDict && annot.has(PDFName.of(NOTE_FLAG)));
      });
      page.node.set(PDFName.of("Annots"), doc.context.obj(kept));
    }
    page.setRotation(degrees(payload.pages[i].rotate));
  });
  const pieces = doc.catalog.lookup(PDFName.of("PieceInfo"));
  if (pieces instanceof PDFDict) pieces.delete(PDFName.of(MARK));

  return { bytes: await doc.save(), items: payload.items, rotations: payload.pages.map((p) => p.extra) };
}

/** A copy of the items fit to be stored: text that was removed from the page is never kept. */
export function storableItems(items: Item[]): Item[] {
  return items.map((item) => (item.type === "text" && item.cover ? { ...item, cover: { ...item.cover, original: "" } } : item));
}
