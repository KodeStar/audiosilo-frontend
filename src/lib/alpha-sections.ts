import type { FsEntry } from '@/api/types';

/** A first-letter group of filesystem entries for the browse SectionList. */
export type AlphaSection = { letter: string; data: FsEntry[] };

/** The A–Z jump-rail letters. The '#' bucket (non-Latin/digits/symbols) is a real
 * section but is omitted from the rail to save vertical space - it stays reachable
 * by scrolling, and a tapped letter with no later match snaps to it. */
export const RAIL_LETTERS: string[] = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i),
);

/** First-letter bucket for an entry name: an uppercase A–Z, or '#' for anything
 * else (digits, symbols, accented/non-Latin first characters, empty). */
export function sectionLetter(name: string): string {
  const ch = name.trim().charAt(0).toUpperCase();
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
}

/** Case-insensitive substring filter on entry names. A blank query returns the
 * input array unchanged. */
export function filterEntries(entries: FsEntry[], query: string): FsEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

/** Sort rank for a section letter: A=1…Z=26, then '#'=27 (sorts last). */
function letterRank(letter: string): number {
  return letter === '#' ? 27 : letter.charCodeAt(0) - 64;
}

/** Group entries into first-letter sections (A–Z then '#'), preserving the input
 * order within each bucket. The server already returns directories before files
 * (each alphabetical), so iterating in that order keeps folders ahead of files
 * inside a shared letter for free. */
export function groupByLetter(entries: FsEntry[]): AlphaSection[] {
  const buckets = new Map<string, FsEntry[]>();
  for (const e of entries) {
    const letter = sectionLetter(e.name);
    const bucket = buckets.get(letter);
    if (bucket) bucket.push(e);
    else buckets.set(letter, [e]);
  }
  return [...buckets.keys()]
    .sort((a, b) => letterRank(a) - letterRank(b))
    .map((letter) => ({ letter, data: buckets.get(letter) as FsEntry[] }));
}

/** Letters that have at least one entry - drives which rail letters are active. */
export function presentLetters(sections: AlphaSection[]): Set<string> {
  return new Set(sections.map((s) => s.letter));
}

/** The section index to scroll to for a tapped rail letter: the matching section,
 * else the next present section at/after it (so a gap snaps forward to the closest
 * group), else the last section. Returns -1 when there are no sections. */
export function sectionIndexForLetter(sections: AlphaSection[], letter: string): number {
  if (sections.length === 0) return -1;
  const target = letterRank(letter);
  for (let i = 0; i < sections.length; i++) {
    const r = letterRank(sections[i].letter);
    if (r === target) return i;
    if (r > target) return i;
  }
  return sections.length - 1;
}
