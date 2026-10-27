import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, PDFWriter, StandardFonts, type PDFObject, type PDFRef } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { addPassword, aesEncrypt, isEncrypted, md5, rc4, removePassword, WrongPasswordError } from "../src/password";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Secret ducks");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 300]).drawText("Only for Kari", { x: 40, y: 200, size: 18, font });
  doc.addPage([400, 300]).drawText("Page two", { x: 40, y: 200, size: 18, font });
  return doc.save({ useObjectStreams: false });
}

async function textOf(bytes: Uint8Array, password?: string): Promise<string> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), password }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map((t) => ("str" in t ? t.str : "")).join(""));
  return out.join(" | ");
}

/** A test-only encryptor for the older methods (RC4 128-bit, revision 3; AES-128, revision 4), as the spec says. */
async function oldEncrypt(bytes: Uint8Array, password: string, aes: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const { context } = doc;
  const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
  const join = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  const pad = (s: string) => join(new TextEncoder().encode(s), PAD).subarray(0, 32);
  const id0 = crypto.getRandomValues(new Uint8Array(16));
  const n = 16;
  // O from an owner password (here "owner-secret"), algorithm 3.
  let h = md5(pad("owner-secret"));
  for (let i = 0; i < 50; i++) h = md5(h);
  let o = pad(password);
  for (let i = 0; i < 20; i++) o = rc4(h.subarray(0, n).map((b) => b ^ i), o);
  const p = -1028;
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, p, true);
  let key = md5(join(pad(password), o, pBytes, id0));
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  key = key.subarray(0, n);
  let u = rc4(key, md5(join(PAD, id0)));
  for (let i = 1; i <= 19; i++) u = rc4(key.map((b) => b ^ i), u);
  u = join(u, new Uint8Array(16));
  const objKey = (ref: PDFRef) => md5(join(key, Uint8Array.of(ref.objectNumber & 255, (ref.objectNumber >> 8) & 255, (ref.objectNumber >> 16) & 255, 0, 0), aes ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0))).subarray(0, 16);
  const seal = async (ref: PDFRef, d: Uint8Array) => {
    if (!aes) return rc4(objKey(ref), d);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    return join(iv, await aesEncrypt(objKey(ref), iv, d));
  };
  const strings = async (x: PDFObject, ref: PDFRef): Promise<PDFObject> => {
    if (x instanceof PDFString || x instanceof PDFHexString) return PDFHexString.of(hex(await seal(ref, x.asBytes())));
    if (x instanceof PDFDict) for (const [k, v] of x.entries()) x.set(k, await strings(v, ref));
    if (x instanceof PDFArray) for (let i = 0; i < x.size(); i++) x.set(i, await strings(x.get(i), ref));
    return x;
  };
  for (const [ref, x] of context.enumerateIndirectObjects()) {
    if (x instanceof PDFRawStream) {
      const c = await seal(ref, x.contents);
      x.dict.set(PDFName.of("Length"), PDFNumber.of(c.length));
      context.assign(ref, PDFRawStream.of(x.dict, c));
    } else await strings(x, ref);
  }
  const encrypt = context.obj(aes ? { Filter: "Standard", V: 4, R: 4, Length: 128, CF: { StdCF: { AuthEvent: "DocOpen", CFM: "AESV2", Length: 16 } }, StmF: "StdCF", StrF: "StdCF", P: p } : { Filter: "Standard", V: 2, R: 3, Length: 128, P: p }) as PDFDict;
  encrypt.set(PDFName.of("O"), PDFHexString.of(hex(o)));
  encrypt.set(PDFName.of("U"), PDFHexString.of(hex(u)));
  context.trailerInfo.Encrypt = context.register(encrypt);
  context.trailerInfo.ID = context.obj([PDFHexString.of(hex(id0)), PDFHexString.of(hex(id0))]);
  return PDFWriter.forContext(context, Infinity).serializeToBuffer();
}

describe("PDF passwords", () => {
  it("has working MD5 and RC4", () => {
    expect(hex(md5(new TextEncoder().encode("abc")))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(hex(md5(new Uint8Array(0)))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(rc4(new TextEncoder().encode("Key"), new TextEncoder().encode("Plaintext")))).toBe("bbf316e8d940af0ad3");
  });

  it("protects a PDF so other readers ask for the password (AES-256)", async () => {
    const locked = await addPassword(await sample(), "andefjær");
    expect(isEncrypted(locked)).toBe(true);
    await expect(textOf(locked)).rejects.toThrow(/password/i);
    expect(await textOf(locked, "andefjær")).toBe("Only for Kari | Page two");
  });

  it("takes a known password off again, and a wrong one is refused", async () => {
    const locked = await addPassword(await sample(), "ducks");
    await expect(removePassword(locked, ["geese"])).rejects.toBeInstanceOf(WrongPasswordError);
    const open = await removePassword(locked, ["geese", "ducks"]);
    expect(isEncrypted(open)).toBe(false);
    expect(await textOf(open)).toBe("Only for Kari | Page two");
    expect((await PDFDocument.load(open)).getTitle()).toBe("Secret ducks");
  });

  for (const aes of [false, true])
    it(`takes off an older ${aes ? "AES-128" : "RC4"} password, the user's or the owner's`, async () => {
      const locked = await oldEncrypt(await sample(), "kari", aes);
      // pdf.js agrees the test file is right.
      expect(await textOf(locked, "kari")).toBe("Only for Kari | Page two");
      expect(await textOf(await removePassword(locked, ["kari"]))).toBe("Only for Kari | Page two");
      expect(await textOf(await removePassword(locked, ["owner-secret"]))).toBe("Only for Kari | Page two");
    });
});
