/** FNV-1a, 32 bit, as 8 hex digits: a stable, filename-safe hash of a string (a book's
 * cover file names: the widget's and the car's). Not for anything secret. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
