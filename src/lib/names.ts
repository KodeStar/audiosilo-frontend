/**
 * Name helpers shared by Books, People, Series and Search, so they file, compare and
 * draw a name the same way.
 */

/** A string with its accents removed ("Émile" -> "Emile"). Hermes has `normalize`;
 * guarded anyway, so a runtime without it keeps the accents. */
export function foldAccents(s: string): string {
  return typeof s.normalize === 'function' ? s.normalize('NFD').replace(/\p{M}/gu, '') : s;
}

/** A credit can name several people ("Michael Kramer, Kate Reading"); the monogram is
 * the first person's. */
function firstPerson(name: string): string {
  return name.split(/\s*(?:,|&|\band\b|\/|;)\s*/)[0]?.trim() || name.trim();
}

/** The two-letter monogram of a portrait or token: the first person's first and last
 * initials ("James S. A. Corey" -> "JC"), one letter for a one-word name, '?' for none. */
export function initials(name: string): string {
  const words = firstPerson(name)
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}
