import type { Book } from '@/api/types';
import { hashString } from '@/lib/monogram';

import { inSeries, type ProgressLookup, seriesOf, sortSeriesBooks } from './series-model';

/**
 * Pure rules behind the Authors / Narrators modes and the author and narrator pages
 * (tested): letter heads, portrait monograms, a person's books grouped by series, and
 * the other people credited on them.
 */

/** Lists longer than this get A-Z heads (a shorter one reads as one grid: heads would
 * break a desktop row of seven into rows of one or two). */
export const LETTER_HEADS_MIN = 60;

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

/** A person's books as their series (by name, each in series order; a book in several
 * series is on each, placed by its position there) and the books in no series (by
 * title). Each shelf holds the books' own rows (a download or an action started from
 * one keeps the book's main series); `inSeries` numbers a row by its shelf. */
export function booksBySeries(books: readonly Book[]): {
  series: SeriesGroup[];
  standalone: Book[];
} {
  const groups = new Map<string, Book[]>();
  const standalone: Book[] = [];
  for (const b of books) {
    const all = seriesOf(b).filter((s) => s.name.trim());
    if (all.length === 0) {
      standalone.push(b);
      continue;
    }
    // A book in several series is on each shelf.
    for (const s of all) {
      const g = groups.get(s.name);
      if (g) g.push(b);
      else groups.set(s.name, [b]);
    }
  }
  return {
    series: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([series, list]) => ({
        series,
        books: sortSeriesBooks(list, (b) => inSeries(b, series)?.series_index ?? 0),
      })),
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

/** Who a portrait shows: a book's author or narrator, or the signed-in listener. */
export type PortraitKind = 'author' | 'narrator' | 'user';

/** A portrait's colours: an author's pale disc with deep initials, a narrator's deeper
 * square with white ones, the listener's vivid disc with white ones (STYLEGUIDE section
 * 8, "Avatar, portrait"). Content colours, the same in both themes, like a cover. */
export function portraitColors(
  name: string,
  kind: PortraitKind,
): { from: string; to: string; ink: string } {
  const h = portraitHue(name);
  const h2 = (h + 40) % 360;
  if (kind === 'user') return { from: hslHex(h, 74, 60), to: hslHex(h2, 68, 42), ink: '#ffffff' };
  return kind === 'narrator'
    ? { from: hslHex(h, 60, 62), to: hslHex(h2, 55, 30), ink: '#ffffff' }
    : { from: hslHex(h, 46, 88), to: hslHex(h2, 40, 74), ink: hslHex(h, 50, 22) };
}
