import type { Book } from '@/api/types';
import { sectionLetter } from '@/lib/alpha-sections';
import { hashString } from '@/lib/monogram';

import { type ProgressLookup, sortSeriesBooks } from './series-model';

/**
 * Pure rules behind the Authors / Narrators modes and the author and narrator pages
 * (tested): letter heads, portrait monograms, a person's books grouped by series, and
 * the other people credited on them.
 */

/** A name's A-Z head: accents folded ("Émile" files under E), anything else '#'. */
export function letterOf(name: string): string {
  return sectionLetter(name.normalize('NFD').replace(/\p{M}/gu, ''));
}

/** Lists longer than this get A-Z heads (a shorter one reads as one grid: heads would
 * break a desktop row of seven into rows of one or two). */
export const LETTER_HEADS_MIN = 60;

export type Lettered<T> = { letter: string; items: T[] };

/** Group a list (already in display order) under its A-Z heads, A-Z then '#'. */
export function groupByLetter<T>(items: readonly T[], name: (item: T) => string): Lettered<T>[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const l = letterOf(name(it));
    const g = groups.get(l);
    if (g) g.push(it);
    else groups.set(l, [it]);
  }
  const rank = (l: string) => (l === '#' ? 27 : l.charCodeAt(0) - 64);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([letter, list]) => ({ letter, items: list }));
}

/** A credit can name several people ("Michael Kramer, Kate Reading"); the monogram is
 * the first person's. */
function firstPerson(name: string): string {
  return name.split(/\s*(?:,|&|\band\b|\/|;)\s*/)[0]?.trim() || name.trim();
}

/** The two-letter monogram of a portrait: the first person's first and last initials
 * ("James S. A. Corey" -> "JC"), one letter for a one-word name, '?' for none. */
export function initials(name: string): string {
  const words = firstPerson(name)
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** A portrait's hue (0-359), stable for a name. */
export function portraitHue(name: string): number {
  return hashString(name) % 360;
}

export type PersonStats = {
  books: number;
  seconds: number;
  finished: number;
  /** Seconds listened across their books (finished books count whole). */
  listened: number;
};

export function personStats(
  books: readonly Book[],
  connectionId: string,
  progressOf: ProgressLookup,
): PersonStats {
  const s: PersonStats = { books: books.length, seconds: 0, finished: 0, listened: 0 };
  for (const b of books) {
    s.seconds += b.duration;
    const p = progressOf(connectionId, b.library_id, b.rel_path);
    if (!p) continue;
    if (p.finished) {
      s.finished++;
      s.listened += b.duration;
    } else {
      s.listened += Math.min(p.position, b.duration || p.position);
    }
  }
  return s;
}

export type SeriesGroup = { series: string; books: Book[] };

/** A person's books as their series (by name, each in series order) and the books in
 * no series (by title). */
export function booksBySeries(books: readonly Book[]): {
  series: SeriesGroup[];
  standalone: Book[];
} {
  const groups = new Map<string, Book[]>();
  const standalone: Book[] = [];
  for (const b of books) {
    if (!b.series.trim()) {
      standalone.push(b);
      continue;
    }
    const g = groups.get(b.series);
    if (g) g.push(b);
    else groups.set(b.series, [b]);
  }
  return {
    series: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([series, list]) => ({ series, books: sortSeriesBooks(list) })),
    standalone: standalone.sort((a, b) => a.title.localeCompare(b.title)),
  };
}

/** The other people credited on a person's books (`field` of each book, exact values),
 * most books first, then by name; `self` and blanks left out. */
export function creditedPeople(
  books: readonly Book[],
  field: 'author' | 'narrator',
  self: string,
): { name: string; books: number }[] {
  const counts = new Map<string, number>();
  for (const b of books) {
    const v = b[field];
    if (!v.trim() || v === self) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, n]) => ({ name, books: n }))
    .sort((a, b) => b.books - a.books || a.name.localeCompare(b.name));
}

/** `hsl(h s% l%)` as `#rrggbb` (native colour props take hex reliably everywhere). */
export function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const hex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** A portrait's colours: an author's pale disc with deep initials, a narrator's deeper
 * square with white ones (STYLEGUIDE section 8, "Avatar, portrait"). Content colours,
 * the same in both themes, like a cover. */
export function portraitColors(
  name: string,
  kind: 'author' | 'narrator',
): { from: string; to: string; ink: string } {
  const h = portraitHue(name);
  const h2 = (h + 40) % 360;
  return kind === 'narrator'
    ? { from: hslHex(h, 60, 62), to: hslHex(h2, 55, 30), ink: '#ffffff' }
    : { from: hslHex(h, 46, 88), to: hslHex(h2, 40, 74), ink: hslHex(h, 50, 22) };
}
