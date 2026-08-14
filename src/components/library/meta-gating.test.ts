import type { BookMetaCharacter, BookMetaRecap } from '@/api/types';

import {
  chapterNumberAt,
  characterIsVisible,
  listeningProgressFor,
  recapIsVisible,
  splitCharacters,
  splitRecaps,
} from './meta-gating';

const character = (id: string, chapter: number): BookMetaCharacter => ({
  id,
  name: id,
  reveal: { chapter },
});
const recap = (chapter: number): BookMetaRecap => ({
  through: { chapter },
  scope: 'book',
  text: `through ${chapter}`,
});

// Three chapters of 100s each on the whole-book timeline.
const starts = [0, 100, 200];

describe('chapterNumberAt', () => {
  it('is 0 with no chapters or no progress', () => {
    expect(chapterNumberAt([], 500)).toBe(0);
    expect(chapterNumberAt(starts, 0)).toBe(0);
    expect(chapterNumberAt(starts, -5)).toBe(0);
  });

  it('is the 1-based ordinal of the chapter containing the position', () => {
    expect(chapterNumberAt(starts, 1)).toBe(1);
    expect(chapterNumberAt(starts, 99)).toBe(1);
    expect(chapterNumberAt(starts, 100)).toBe(2);
    expect(chapterNumberAt(starts, 250)).toBe(3);
    expect(chapterNumberAt(starts, 9999)).toBe(3);
  });
});

describe('listeningProgressFor', () => {
  it('knows nothing without a position', () => {
    expect(
      listeningProgressFor({ chapterStarts: starts, position: null, finished: false }),
    ).toEqual({ chapter: 0, finished: false });
    expect(
      listeningProgressFor({ chapterStarts: starts, position: undefined, finished: false }),
    ).toEqual({ chapter: 0, finished: false });
  });

  it('maps a position onto the chapter list', () => {
    expect(listeningProgressFor({ chapterStarts: starts, position: 150, finished: false })).toEqual(
      { chapter: 2, finished: false },
    );
  });

  it('uses the SAME mapping for a live position as for a saved one', () => {
    // The screen picks which position is freshest; the helper does not care, so a
    // playing book and a parked one can never gate differently at the same offset.
    const live = listeningProgressFor({ chapterStarts: starts, position: 250, finished: false });
    const saved = listeningProgressFor({ chapterStarts: starts, position: 250, finished: false });
    expect(live).toEqual(saved);
    expect(live.chapter).toBe(3);
  });

  it('gates a chapterless book to 0 however far in the listener is', () => {
    // No chapter boundaries to map onto (the player's synthetic 30-minute chapters
    // are wall-clock slices, not logical chapters) - so nothing is claimed reached.
    expect(listeningProgressFor({ chapterStarts: [], position: 9999, finished: false })).toEqual({
      chapter: 0,
      finished: false,
    });
  });

  it('carries the finished flag through, with or without a position', () => {
    expect(
      listeningProgressFor({ chapterStarts: starts, position: 300, finished: true }).finished,
    ).toBe(true);
    expect(listeningProgressFor({ chapterStarts: starts, position: null, finished: true })).toEqual(
      { chapter: 0, finished: true },
    );
  });
});

describe('characterIsVisible', () => {
  const p = (chapter: number, finished = false) => ({ chapter, finished });

  it('shows the from-the-start cast even before the book is started', () => {
    expect(characterIsVisible(character('a', 0), p(0))).toBe(true);
    expect(characterIsVisible(character('a', 1), p(0))).toBe(true);
    expect(characterIsVisible(character('a', 2), p(0))).toBe(false);
  });

  it('reveals a character once their chapter is reached', () => {
    expect(characterIsVisible(character('a', 5), p(4))).toBe(false);
    expect(characterIsVisible(character('a', 5), p(5))).toBe(true);
    expect(characterIsVisible(character('a', 5), p(9))).toBe(true);
  });

  it('reveals everyone on a finished book', () => {
    expect(characterIsVisible(character('a', 40), p(1, true))).toBe(true);
  });
});

describe('recapIsVisible', () => {
  const p = (chapter: number, finished = false) => ({ chapter, finished });

  it('always shows the chapter-0 catch-ups', () => {
    expect(recapIsVisible(recap(0), p(0))).toBe(true);
  });

  it('needs the covered chapter to be behind you', () => {
    // Still inside chapter 3: its recap would spoil the chapter being heard.
    expect(recapIsVisible(recap(3), p(3))).toBe(false);
    expect(recapIsVisible(recap(3), p(4))).toBe(true);
  });

  it('shows everything on a finished book', () => {
    expect(recapIsVisible(recap(12), p(2, true))).toBe(true);
  });
});

describe('splitting', () => {
  it('partitions characters into reached and held back, preserving order', () => {
    const cast = [character('a', 1), character('b', 8), character('c', 3)];
    const { visible, hidden } = splitCharacters(cast, { chapter: 3, finished: false });
    expect(visible.map((c) => c.id)).toEqual(['a', 'c']);
    expect(hidden.map((c) => c.id)).toEqual(['b']);
  });

  it('partitions recaps the same way', () => {
    const { visible, hidden } = splitRecaps([recap(0), recap(2), recap(9)], {
      chapter: 5,
      finished: false,
    });
    expect(visible.map((r) => r.through.chapter)).toEqual([0, 2]);
    expect(hidden.map((r) => r.through.chapter)).toEqual([9]);
  });
});
