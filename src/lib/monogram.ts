/** A small, stable string hash (FNV-1a), for per-title variation. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deep cloth colours for a book that has no colour of its own (a spine whose cover the
 * server hasn't read, a small cover with no art). Content colours, like cover art, not
 * theme tokens: white type reads on every one of them.
 */
export const CLOTH_COLORS = [
  '#27365f',
  '#6d2635',
  '#24584a',
  '#6a4a14',
  '#46305f',
  '#1d4b67',
  '#76391b',
  '#3b4a27',
] as const;

/** The cloth colour a title always gets. */
export function clothColor(title: string): string {
  return CLOTH_COLORS[hashString(title) % CLOTH_COLORS.length];
}

// Small English words: a leading article would make half the shelf "T", and "The Way
// of Kings" reads as WK, not WO.
const MINOR = /^(the|a|an|of|and|in|on|to|at|for)$/i;

/**
 * Up to two initials for a title too small to print ("Blood Rites" -> "BR", "The Way of
 * Kings" -> "WK", "Frankenstein" -> "F"): the first letters of its first two words,
 * skipping small words (when others are left) and anything that isn't a letter or a
 * digit. CJK and other unspaced scripts give their first character. '?' for an empty
 * title.
 */
export function titleMonogram(title: string): string {
  const all = title
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  const major = all.filter((w) => !MINOR.test(w));
  const words = major.length > 0 ? major : all;
  if (words.length === 0) return '?';
  const first = [...words[0]][0] ?? '';
  const second = words.length > 1 ? ([...words[1]][0] ?? '') : '';
  return (first + second).toUpperCase();
}
