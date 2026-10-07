import type { BookMetaCharacter, BookMetaRecap } from '@/api/types';

import {
  activeCompanionTab,
  chapterRows,
  companionTabs,
  isNaturalCrossing,
  newlyMet,
  NATURAL_STEP_S,
  revealOnCrossing,
  storySoFar,
  whoOrder,
} from './companion-model';

const char = (id: string, chapter: number): BookMetaCharacter => ({
  id,
  name: id,
  reveal: { chapter },
});
const cast = [char('Holden', 0), char('Prax', 1), char('Bobbie', 2), char('Avasarala', 5)];
const at = (chapter: number, finished = false) => ({ chapter, finished });
const sample = (position: number, chapter: number, playing = true) => ({
  position,
  chapter,
  playing,
});

describe('companionTabs', () => {
  it('offers Who is who and Story so far only on a metadata server', () => {
    expect(companionTabs(true)).toEqual([
      'who',
      'story',
      'chapters',
      'bookmarks',
      'notes',
      'history',
    ]);
    expect(companionTabs(false)).toEqual(['chapters', 'bookmarks', 'notes', 'history']);
  });

  it('falls back to the first tab when the one asked for is not there', () => {
    expect(activeCompanionTab(companionTabs(false), 'who')).toBe('chapters');
    expect(activeCompanionTab(companionTabs(true), 'notes')).toBe('notes');
    expect(activeCompanionTab(companionTabs(true), null)).toBe('who');
  });
});

describe('whoOrder', () => {
  it('puts the latest first appearance first and keeps ties in server order', () => {
    const order = whoOrder([char('a', 1), char('b', 3), char('c', 1), char('d', 2)]);
    expect(order.map((c) => c.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('newlyMet', () => {
  it('is who the later place reveals that the earlier did not', () => {
    expect(newlyMet(cast, 1, 2).map((c) => c.id)).toEqual(['Bobbie']);
    expect(newlyMet(cast, 2, 5).map((c) => c.id)).toEqual(['Avasarala']);
  });

  it('counts chapter 0 and 1 as met from the start (the book page rule)', () => {
    expect(newlyMet(cast, 0, 1)).toEqual([]);
  });
});

describe('isNaturalCrossing', () => {
  it('is the book playing on into the next chapter', () => {
    expect(isNaturalCrossing(sample(359, 1), sample(360.5, 2))).toBe(true);
  });

  it('is not a seek, a skip, a jump back or a stall', () => {
    // A skip forward over the boundary.
    expect(isNaturalCrossing(sample(350, 1), sample(350 + NATURAL_STEP_S + 1, 2))).toBe(false);
    // Backwards.
    expect(isNaturalCrossing(sample(400, 2), sample(399, 1))).toBe(false);
    // Paused or loading on either side (a resume lands while loading).
    expect(isNaturalCrossing(sample(359, 1, false), sample(360.5, 2))).toBe(false);
    expect(isNaturalCrossing(sample(359, 1), sample(360.5, 2, false))).toBe(false);
    // Same chapter.
    expect(isNaturalCrossing(sample(100, 1), sample(101, 1))).toBe(false);
  });
});

describe('revealOnCrossing', () => {
  it('announces the characters of the chapter the book plays into', () => {
    const met = revealOnCrossing(cast, sample(719, 4), sample(720.4, 5), 4, false);
    expect(met.map((c) => c.id)).toEqual(['Avasarala']);
  });

  it('says nothing on a seek that skips several chapters', () => {
    expect(revealOnCrossing(cast, sample(100, 1), sample(2000, 5), 1, false)).toEqual([]);
  });

  it('never announces someone already met earlier in the session', () => {
    // The listener reached chapter 5, went back to 4 and plays into 5 again.
    expect(revealOnCrossing(cast, sample(719, 4), sample(720.4, 5), 5, false)).toEqual([]);
  });

  it('says nothing in a finished book', () => {
    expect(revealOnCrossing(cast, sample(719, 4), sample(720.4, 5), 4, true)).toEqual([]);
  });
});

describe('storySoFar', () => {
  const recaps: BookMetaRecap[] = [
    { through: { chapter: 13 }, scope: 'book', text: 'c' },
    { through: { chapter: 0 }, scope: 'series', text: 'a' },
    { through: { chapter: 6 }, scope: 'book', text: 'b' },
  ];

  it('stops at the last recap the listener is past, in order, and counts the rest', () => {
    const s = storySoFar(recaps, at(11));
    expect(s.parts.map((r) => r.text)).toEqual(['a', 'b']);
    expect(s.upTo).toBe(6);
    expect(s.hidden.map((r) => r.text)).toEqual(['c']);
  });

  it('has no chapter to name with only the before-the-book recap', () => {
    const s = storySoFar(recaps, at(2));
    expect(s.parts.map((r) => r.text)).toEqual(['a']);
    expect(s.upTo).toBeNull();
  });

  it('shows everything once the book is finished', () => {
    expect(storySoFar(recaps, at(0, true)).hidden).toEqual([]);
  });
});

describe('chapterRows', () => {
  const starts = [0, 600, 1200, 3600];

  it('ticks the chapters behind, times the current one and the ones ahead at speed', () => {
    const rows = chapterRows(starts, 4800, 900, 1, 1.5);
    expect(rows[0]).toEqual({ state: 'past' });
    expect(rows[1]).toEqual({ state: 'current', left: 200 }); // 300 s at 1.5x
    expect(rows[2]).toEqual({ state: 'ahead', until: 200 });
    expect(rows[3]).toEqual({ state: 'ahead', until: 1800 }); // 2700 s at 1.5x
  });

  it('times the last chapter to the end of the book', () => {
    expect(chapterRows(starts, 4800, 4200, 3, 1)[3]).toEqual({ state: 'current', left: 600 });
  });
});
