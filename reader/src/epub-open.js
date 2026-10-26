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
    }).init();
  } catch (e) {
    throw new BookError('unreadable', `not an EPUB: ${e?.message ?? e}`);
  }
}
