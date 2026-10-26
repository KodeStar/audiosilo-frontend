// Opens EPUB bytes as a foliate-js book, without workers (the reader's CSP has no worker
// source, and the book is already in memory).
import { EPUB } from '../vendor/foliate-js/epub.js';
import {
  BlobReader,
  BlobWriter,
  configure,
  TextWriter,
  ZipReader,
} from '../vendor/foliate-js/vendor/zip.js';

/** Why a book could not be opened: `drm` (encrypted content) or `unreadable` (not an EPUB,
 * or a damaged one). The host shows a plain message for each. */
export class BookError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Font obfuscation (EPUB OCF, IDPF and Adobe) is not DRM: foliate undoes it.
const OBFUSCATION = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

/**
 * SHA-1 of a string's UTF-8 bytes: the key of IDPF font obfuscation. foliate's own uses
 * `crypto.subtle`, which only a secure context has, so a server's plain-HTTP home address
 * would refuse every book with obfuscated fonts.
 */
export function sha1(text) {
  const bytes = new TextEncoder().encode(text);
  const words = new Uint32Array((((bytes.length + 8) >> 6) + 1) * 16);
  bytes.forEach((b, i) => (words[i >> 2] |= b << (24 - (i % 4) * 8)));
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 1] = bytes.length * 8;
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 80; t++) {
      const x = t < 16 ? words[block + t] : w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = t < 16 ? x : (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = h;
    for (let t = 0; t < 80; t++) {
      const f =
        t < 20
          ? ((b & c) | (~b & d)) + 0x5a827999
          : t < 40
            ? (b ^ c ^ d) + 0x6ed9eba1
            : t < 60
              ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc
              : (b ^ c ^ d) + 0xca62c1d6;
      const next = (((a << 5) | (a >>> 27)) + f + e + w[t]) >>> 0;
      [e, d, c, b, a] = [d, c, (b << 30) | (b >>> 2), a, next];
    }
    [a, b, c, d, e].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
  }
  const out = new DataView(new ArrayBuffer(20));
  h.forEach((v, i) => out.setUint32(i * 4, v));
  return new Uint8Array(out.buffer);
}

/** Whether `META-INF/encryption.xml` encrypts anything with more than font obfuscation. */
export function hasDrm(encryptionXml) {
  if (!encryptionXml) return false;
  const methods = encryptionXml.matchAll(
    /<(?:[\w-]+:)?EncryptionMethod\b[^>]*\bAlgorithm\s*=\s*["']([^"']+)["']/g,
  );
  for (const [, algorithm] of methods) if (!OBFUSCATION.has(algorithm)) return true;
  return false;
}

export async function openEpub(bytes) {
  configure({ useWebWorkers: false });
  let entries;
  try {
    const blob = new Blob([bytes], { type: 'application/epub+zip' });
    entries = await new ZipReader(new BlobReader(blob)).getEntries();
  } catch (e) {
    throw new BookError('unreadable', `not a zip: ${e?.message ?? e}`);
  }
  const byName = new Map(entries.map((e) => [e.filename, e]));
  const load =
    (read) =>
    (name, ...args) =>
      byName.has(name) ? read(byName.get(name), ...args) : null;
  const loadText = load((e) => e.getData(new TextWriter()));
  const loadBlob = load((e, type) => e.getData(new BlobWriter(type)));
  if (byName.has('META-INF/rights.xml') || hasDrm(await loadText('META-INF/encryption.xml'))) {
    throw new BookError('drm', 'the book is encrypted');
  }
  try {
    return await new EPUB({
      entries,
      loadText,
      loadBlob,
      getSize: (name) => byName.get(name)?.uncompressedSize ?? 0,
      sha1,
    }).init();
  } catch (e) {
    throw new BookError('unreadable', `not an EPUB: ${e?.message ?? e}`);
  }
}
