// PDF passwords (the "Standard security handler"): taking a known password off a PDF so it can be
// edited and saved, and putting one on (AES-256, as Acrobat does today). pdf-lib can't read
// encrypted files, so they are decrypted here first: the file is parsed with its object streams
// held back, every string and stream is decrypted, then the object streams are read.

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObjectStreamParser, PDFParser, PDFRawStream, PDFRef, PDFString, PDFWriter, type PDFContext, type PDFObject } from "pdf-lib";

// ---- small crypto: MD5 and RC4 (not in WebCrypto); AES and SHA from WebCrypto ------------------

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: Uint8Array): Uint8Array {
  const length = data.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) * 64);
  padded.set(data);
  padded[length] = 0x80;
  const bits = new DataView(padded.buffer);
  bits.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  bits.setUint32(padded.length - 4, Math.floor(length / 2 ** 29), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < padded.length; off += 64) {
    const m = Array.from({ length: 16 }, (_, i) => bits.getUint32(off + i * 4, true));
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const sum = (a + f + K[i] + m[g]) >>> 0;
      [a, d, c] = [d, c, b];
      b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
    }
    [a0, b0, c0, d0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0];
  }
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => view.setUint32(i * 4, v, true));
  return out;
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const aesKey = (key: Uint8Array, use: "encrypt" | "decrypt") => crypto.subtle.importKey("raw", buf(key), { name: "AES-CBC" }, false, [use]);

/** AES-CBC; without padding the data is whole 16-byte blocks and stays that long. */
export async function aesEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad = true): Promise<Uint8Array> {
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: buf(iv) }, await aesKey(key, "encrypt"), buf(data)));
  // WebCrypto always pads; without padding, the padding block is dropped.
  return pad ? out : out.subarray(0, data.length);
}

export async function aesDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad = true): Promise<Uint8Array> {
  let input = data;
  if (!pad) {
    // WebCrypto insists on padding: add the block a padded message would have ended with.
    const last = data.length >= 16 ? data.subarray(data.length - 16) : iv;
    input = concat(data, (await aesEncrypt(key, last, new Uint8Array(0))).subarray(0, 16));
  }
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: buf(iv) }, await aesKey(key, "decrypt"), buf(input)));
}

const sha = async (name: "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) => new Uint8Array(await crypto.subtle.digest(name, buf(data)));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** The password hash of PDF 2.0 (ISO 32000-2, algorithm 2.B); revision 5 used plain SHA-256. */
async function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array, revision: number): Promise<Uint8Array> {
  let k = await sha("SHA-256", concat(password, salt, udata));
  if (revision < 6) return k;
  for (let i = 0; ; i++) {
    const once = concat(password, k, udata);
    const k1 = new Uint8Array(once.length * 64);
    for (let r = 0; r < 64; r++) k1.set(once, r * once.length);
    const e = await aesEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1, false);
    const mod = e.subarray(0, 16).reduce((s, v) => s + v, 0) % 3;
    k = await sha(mod === 0 ? "SHA-256" : mod === 1 ? "SHA-384" : "SHA-512", e);
    if (i >= 63 && e[e.length - 1] <= i - 31) break;
  }
  return k.subarray(0, 32);
}

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
/** A password for the older handlers: Latin-1 bytes, cut or padded to 32. */
const padded = (password: string) => concat(Uint8Array.from([...password].slice(0, 32), (ch) => ch.charCodeAt(0) & 255), PAD).subarray(0, 32);
const utf8 = (password: string) => new TextEncoder().encode(password).subarray(0, 127);

// ---- finding the key ------------------------------------------------------------------------------

interface Crypt {
  string(ref: PDFRef, data: Uint8Array): Promise<Uint8Array>;
  stream(ref: PDFRef, data: Uint8Array): Promise<Uint8Array>;
  /** Whether the XMP metadata stream is encrypted too. */
  metadata: boolean;
}

const bytesOf = (o: PDFObject | undefined): Uint8Array => (o instanceof PDFString || o instanceof PDFHexString ? o.asBytes() : new Uint8Array(0));
const num = (o: PDFObject | undefined, fallback: number) => (o instanceof PDFNumber ? o.asNumber() : fallback);

/** The decryption for this password (user's or owner's), or null if it's the wrong one. */
async function unlockWith(encrypt: PDFDict, id0: Uint8Array, password: string): Promise<Crypt | null> {
  const v = num(encrypt.get(PDFName.of("V")), 0);
  const r = num(encrypt.get(PDFName.of("R")), 2);
  const o = bytesOf(encrypt.lookup(PDFName.of("O")));
  const u = bytesOf(encrypt.lookup(PDFName.of("U")));
  const p = num(encrypt.get(PDFName.of("P")), -4);
  const metadata = encrypt.get(PDFName.of("EncryptMetadata"))?.toString() !== "false";
  // Which method strings and streams use: from the crypt filters in version 4 and 5.
  const method = (which: "StmF" | "StrF") => {
    if (v < 4) return "RC4";
    const name = encrypt.get(PDFName.of(which))?.toString().slice(1) ?? "Identity";
    if (name === "Identity") return "None";
    const cf = (encrypt.lookup(PDFName.of("CF")) as PDFDict | undefined)?.lookup(PDFName.of(name)) as PDFDict | undefined;
    const cfm = cf?.get(PDFName.of("CFM"))?.toString().slice(1);
    return cfm === "V2" ? "RC4" : cfm === "AESV2" ? "AES128" : cfm === "AESV3" ? "AES256" : "None";
  };
  const [stm, str] = [method("StmF"), method("StrF")];

  let key: Uint8Array | null = null;
  if (r >= 5) {
    const pw = utf8(password);
    if (equal(await hash2B(pw, u.subarray(32, 40), new Uint8Array(0), r), u.subarray(0, 32))) {
      key = await aesDecrypt(await hash2B(pw, u.subarray(40, 48), new Uint8Array(0), r), new Uint8Array(16), bytesOf(encrypt.lookup(PDFName.of("UE"))), false);
    } else if (equal(await hash2B(pw, o.subarray(32, 40), u.subarray(0, 48), r), o.subarray(0, 32))) {
      key = await aesDecrypt(await hash2B(pw, o.subarray(40, 48), u.subarray(0, 48), r), new Uint8Array(16), bytesOf(encrypt.lookup(PDFName.of("OE"))), false);
    }
  } else {
    const n = r === 2 ? 5 : num(encrypt.get(PDFName.of("Length")), 40) / 8;
    const fileKey = (pw32: Uint8Array) => {
      const pBytes = new Uint8Array(4);
      new DataView(pBytes.buffer).setInt32(0, p, true);
      let h = md5(concat(pw32, o.subarray(0, 32), pBytes, id0, r >= 4 && !metadata ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array(0)));
      if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
      return h.subarray(0, n);
    };
    const userMatches = (k: Uint8Array) => {
      if (r === 2) return equal(rc4(k, PAD), u.subarray(0, 32));
      let x = rc4(k, md5(concat(PAD, id0)));
      for (let i = 1; i <= 19; i++) x = rc4(k.map((b) => b ^ i), x);
      return equal(x, u.subarray(0, 16));
    };
    const asUser = fileKey(padded(password));
    if (userMatches(asUser)) key = asUser;
    else {
      // The owner's password: it unlocks the user's (algorithm 7).
      let h = md5(padded(password));
      if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
      const ownerKey = h.subarray(0, n);
      let user = o.subarray(0, 32);
      if (r === 2) user = rc4(ownerKey, user);
      else for (let i = 19; i >= 0; i--) user = rc4(ownerKey.map((b) => b ^ i), user);
      const asOwner = fileKey(user);
      if (userMatches(asOwner)) key = asOwner;
    }
  }
  if (!key) return null;
  const fileKey = key;
  const objectKey = (ref: PDFRef, aes: boolean) => {
    const extra = Uint8Array.of(ref.objectNumber & 255, (ref.objectNumber >> 8) & 255, (ref.objectNumber >> 16) & 255, ref.generationNumber & 255, (ref.generationNumber >> 8) & 255);
    return md5(concat(fileKey, extra, aes ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0))).subarray(0, Math.min(fileKey.length + 5, 16));
  };
  const run = async (how: string, ref: PDFRef, data: Uint8Array) => {
    if (how === "None") return data;
    if (how === "RC4") return rc4(objectKey(ref, false), data);
    // AES: the first 16 bytes are the starting vector. A damaged or empty one is left as it is.
    if (data.length < 32 || data.length % 16) return data.length === 16 ? new Uint8Array(0) : data;
    return aesDecrypt(how === "AES256" ? fileKey : objectKey(ref, true), data.subarray(0, 16), data.subarray(16));
  };
  return { string: (ref, d) => run(str, ref, d), stream: (ref, d) => run(stm, ref, d), metadata };
}

/** Whether a PDF file is encrypted (has a password, or a permissions lock). */
export function isEncrypted(bytes: Uint8Array): boolean {
  // The trailer (or cross-reference stream) names the encryption dictionary.
  const text = new TextDecoder("latin1").decode(bytes.length > 4_000_000 ? concat(bytes.subarray(0, 2_000_000), bytes.subarray(bytes.length - 2_000_000)) : bytes);
  return /\/Encrypt\s*\d+\s+\d+\s+R/.test(text) || /\/Encrypt\s*<</.test(text);
}

export class WrongPasswordError extends Error {
  constructor() {
    super("This PDF's password is needed to save it. Open it again and type its password.");
  }
}

/**
 * The PDF without its encryption, using the first of `passwords` that opens it (an empty one
 * covers files that only lock printing or copying). Throws WrongPasswordError if none do.
 */
export async function removePassword(bytes: Uint8Array, passwords: string[]): Promise<Uint8Array> {
  const held: [PDFRef, PDFRawStream][] = [];
  const parser = PDFParser.forBytesWithOptions(bytes, Infinity, false) as unknown as {
    parseDocument(): Promise<PDFContext>;
    parseIndirectObject(): Promise<PDFRef>;
    parseIndirectObjectHeader(): PDFRef;
    skipWhitespaceAndComments(): void;
    parseObject(): PDFObject;
    matchKeyword(keyword: number[]): boolean;
    context: PDFContext;
  };
  // As pdf-lib's own, except that object streams are kept aside: they can only be read once decrypted.
  parser.parseIndirectObject = async function () {
    const ref = this.parseIndirectObjectHeader();
    this.skipWhitespaceAndComments();
    const object = this.parseObject();
    this.skipWhitespaceAndComments();
    this.matchKeyword([...new TextEncoder().encode("endobj")]);
    const type = object instanceof PDFRawStream ? object.dict.lookup(PDFName.of("Type")) : undefined;
    if (type === PDFName.of("ObjStm")) held.push([ref, object as PDFRawStream]);
    else if (type !== PDFName.of("XRef")) this.context.assign(ref, object);
    return ref;
  };
  const context = await parser.parseDocument();
  const encryptRef = context.trailerInfo.Encrypt;
  const encrypt = (encryptRef instanceof PDFRef ? context.lookup(encryptRef) : encryptRef) as PDFDict | undefined;
  if (!encrypt) return bytes;
  const ids = context.trailerInfo.ID;
  const id0 = ids instanceof PDFArray ? bytesOf(ids.lookup(0)) : new Uint8Array(0);
  if (encrypt.get(PDFName.of("Filter"))?.toString() !== "/Standard") throw new Error("This PDF is protected in a way Duckument can't open for saving (a certificate, or a special program).");
  let crypt: Crypt | null = null;
  for (const password of ["", ...passwords]) if ((crypt = await unlockWith(encrypt, id0, password))) break;
  if (!crypt) throw new WrongPasswordError();
  const c = crypt;

  const strings = async (o: PDFObject, ref: PDFRef): Promise<PDFObject> => {
    if (o instanceof PDFString || o instanceof PDFHexString) return PDFHexString.of([...(await c.string(ref, o.asBytes()))].map((b) => b.toString(16).padStart(2, "0")).join(""));
    if (o instanceof PDFDict) for (const [k, v] of o.entries()) o.set(k, await strings(v, ref));
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) o.set(i, await strings(o.get(i), ref));
    return o;
  };
  const stream = async (ref: PDFRef, s: PDFRawStream) => {
    await strings(s.dict, ref);
    const skip = !c.metadata && s.dict.lookup(PDFName.of("Type")) === PDFName.of("Metadata");
    const contents = skip ? s.contents : await c.stream(ref, s.contents);
    s.dict.set(PDFName.of("Length"), PDFNumber.of(contents.length));
    return PDFRawStream.of(s.dict, contents);
  };
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object === encrypt) continue;
    context.assign(ref, object instanceof PDFRawStream ? await stream(ref, object) : await strings(object, ref));
  }
  // Objects in object streams aren't encrypted one by one; the stream as a whole was.
  for (const [ref, s] of held) await PDFObjectStreamParser.forStream(await stream(ref, s)).parseIntoContext();
  if (encryptRef instanceof PDFRef) context.delete(encryptRef);
  context.trailerInfo.Encrypt = undefined;
  // Written out and read again, so the file is an ordinary one pdf-lib can work with.
  const plain = await PDFWriter.forContext(context, Infinity).serializeToBuffer();
  return (await PDFDocument.load(plain, { updateMetadata: false })).save({ useObjectStreams: false });
}

/** The PDF protected with a password to open it, encrypted with AES-256 (PDF 2.0, revision 6). */
export async function addPassword(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  // Every stream read back raw, as it will be written.
  const doc = await PDFDocument.load(await (await PDFDocument.load(bytes, { updateMetadata: false })).save({ useObjectStreams: false }), { updateMetadata: false });
  const { context } = doc;
  const key = random(32);
  const pw = utf8(password);
  const [uvs, uks, ovs, oks] = [random(8), random(8), random(8), random(8)];
  const u = concat(await hash2B(pw, uvs, new Uint8Array(0), 6), uvs, uks);
  const ue = await aesEncrypt(await hash2B(pw, uks, new Uint8Array(0), 6), new Uint8Array(16), key, false);
  // The same password for the owner: whoever can open it can do everything with it.
  const o = concat(await hash2B(pw, ovs, u, 6), ovs, oks);
  const oe = await aesEncrypt(await hash2B(pw, oks, u, 6), new Uint8Array(16), key, false);
  const p = -4;
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, p, true);
  perms.set([0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62], 4);
  perms.set(random(4), 12);
  const permsEncrypted = (await aesEncrypt(key, new Uint8Array(16), perms, false)).subarray(0, 16);

  const seal = async (data: Uint8Array) => {
    const iv = random(16);
    return concat(iv, await aesEncrypt(key, iv, data));
  };
  const hex = (b: Uint8Array) => PDFHexString.of([...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
  const strings = async (o: PDFObject): Promise<PDFObject> => {
    if (o instanceof PDFString || o instanceof PDFHexString) return hex(await seal(o.asBytes()));
    if (o instanceof PDFDict) for (const [k, v] of o.entries()) o.set(k, await strings(v));
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) o.set(i, await strings(o.get(i)));
    return o;
  };
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      await strings(object.dict);
      const contents = await seal(object.contents);
      object.dict.set(PDFName.of("Length"), PDFNumber.of(contents.length));
      context.assign(ref, PDFRawStream.of(object.dict, contents));
    } else await strings(object);
  }
  const encrypt = context.obj({
    Filter: "Standard",
    V: 5,
    R: 6,
    Length: 256,
    CF: { StdCF: { AuthEvent: "DocOpen", CFM: "AESV3", Length: 32 } },
    StmF: "StdCF",
    StrF: "StdCF",
    P: p,
  }) as PDFDict;
  for (const [name, value] of [["O", o], ["U", u], ["OE", oe], ["UE", ue], ["Perms", permsEncrypted]] as const) encrypt.set(PDFName.of(name), hex(value));
  context.trailerInfo.Encrypt = context.register(encrypt);
  context.trailerInfo.ID = context.obj([hex(random(16)), hex(random(16))]);
  return PDFWriter.forContext(context, Infinity).serializeToBuffer();
}
