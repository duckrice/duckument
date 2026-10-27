// Making a PDF smaller for e-mail: big pictures are scaled down and saved as JPEG, and the file is
// written with object streams. Text and drawings stay as they are, so they stay sharp. Pictures
// this can't safely redo (CMYK, masks, 16-bit, unusual compressions) are left alone.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from "pdf-lib";

export interface CompressOptions {
  /** The longest side, in pixels, a picture keeps. */
  maxSide: number;
  /** JPEG quality, 0 to 1. */
  quality: number;
}

/** Strong: for e-mail; medium: for reading on screen; light: for printing. */
export const COMPRESS_LEVELS: Record<"strong" | "medium" | "light", CompressOptions> = {
  strong: { maxSide: 1200, quality: 0.6 },
  medium: { maxSide: 1800, quality: 0.75 },
  light: { maxSide: 2600, quality: 0.85 },
};

/** How many components a picture's colour space has, if it's one this can redo as RGB. */
function channels(space: unknown, doc: PDFDocument): number | null {
  const resolved = space instanceof PDFName || space instanceof PDFArray ? space : doc.context.lookup(space as never);
  if (resolved === PDFName.of("DeviceRGB")) return 3;
  if (resolved === PDFName.of("DeviceGray")) return 1;
  if (resolved instanceof PDFArray && resolved.get(0) === PDFName.of("ICCBased")) {
    const profile = doc.context.lookup(resolved.get(1));
    const n = profile instanceof PDFRawStream ? profile.dict.get(PDFName.of("N")) : null;
    return n instanceof PDFNumber && [1, 3].includes(n.asNumber()) ? n.asNumber() : null;
  }
  return null;
}

/** The picture as something the browser can draw, or null. */
async function picture(stream: PDFRawStream, doc: PDFDocument, w: number, h: number): Promise<ImageBitmap | null> {
  const dict = stream.dict;
  const filter = dict.get(PDFName.of("Filter"));
  const only = filter instanceof PDFArray ? (filter.size() === 1 ? filter.get(0) : null) : filter;
  const n = channels(dict.get(PDFName.of("ColorSpace")), doc);
  if (!n || dict.get(PDFName.of("Decode"))) return null;
  if (only === PDFName.of("DCTDecode")) return createImageBitmap(new Blob([stream.contents as BlobPart], { type: "image/jpeg" }));
  if (only !== PDFName.of("FlateDecode") || dict.get(PDFName.of("DecodeParms"))) return null;
  const raw = decodePDFRawStream(stream).decode();
  if (raw.length < w * h * n) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += n) {
    rgba[i * 4] = raw[j];
    rgba[i * 4 + 1] = raw[n === 3 ? j + 1 : j];
    rgba[i * 4 + 2] = raw[n === 3 ? j + 2 : j];
    rgba[i * 4 + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, w, h));
}

/**
 * Fills the form in for good: each field's answer becomes part of the page, as text that can't be
 * changed, and the fields go. A PDF without a form is returned as it is.
 */
export async function flattenForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (!doc.catalog.has(PDFName.of("AcroForm"))) return bytes;
  const form = doc.getForm();
  if (!form.getFields().length) return bytes;
  // The answers' own appearances (as Duckument wrote them) are kept, so they look as they did.
  form.flatten({ updateFieldAppearances: false });
  return doc.save();
}

/** The PDF made smaller; returns the original bytes if that didn't help. */
export async function compressPdf(bytes: Uint8Array, options: CompressOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  // A picture's transparency (its SMask) must stay a grey picture of its own.
  const masks = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const mask = obj instanceof PDFRawStream ? obj.dict.get(PDFName.of("SMask")) : undefined;
    if (mask) masks.add(mask.toString());
  }
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || masks.has(ref.toString())) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image") || dict.get(PDFName.of("ImageMask")) || dict.get(PDFName.of("Mask"))) continue;
    const num = (key: string) => (dict.get(PDFName.of(key)) as PDFNumber | undefined)?.asNumber?.() ?? 0;
    const [w, h] = [num("Width"), num("Height")];
    if (num("BitsPerComponent") !== 8 || w * h < 64 * 64) continue;
    let bitmap: ImageBitmap | null;
    try {
      bitmap = await picture(obj, doc, w, h);
    } catch {
      continue;
    }
    if (!bitmap) continue;
    const scale = Math.min(1, options.maxSide / Math.max(w, h));
    const [nw, nh] = [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
    const canvas = new OffscreenCanvas(nw, nh);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, nw, nh);
    bitmap.close();
    const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: options.quality })).arrayBuffer());
    if (jpeg.length >= obj.contents.length) continue;
    const fresh = PDFDict.withContext(doc.context);
    for (const [k, v] of dict.entries()) if (!["Filter", "DecodeParms", "Length", "Width", "Height", "ColorSpace"].includes(k.asString().slice(1))) fresh.set(k, v);
    fresh.set(PDFName.of("Width"), PDFNumber.of(nw));
    fresh.set(PDFName.of("Height"), PDFNumber.of(nh));
    fresh.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    fresh.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    fresh.set(PDFName.of("Length"), PDFNumber.of(jpeg.length));
    doc.context.assign(ref, PDFRawStream.of(fresh, jpeg));
  }
  const out = await doc.save({ useObjectStreams: true });
  return out.length < bytes.length ? out : bytes;
}
