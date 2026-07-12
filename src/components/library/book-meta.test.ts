import type { BookMetaRecap, BookMetaSeries } from '@/api/types';

import {
  descriptionIsLong,
  recapDescriptor,
  revealFromStart,
  roleLabelKey,
  seriesRailWorks,
  sortRecaps,
} from './book-meta';

function work(id: string, position: string) {
  return { id, title: id, position, authors: [], web_url: `https://m/work?id=${id}` };
}

describe('descriptionIsLong', () => {
  it('is false for short or missing descriptions', () => {
    expect(descriptionIsLong(undefined)).toBe(false);
    expect(descriptionIsLong('')).toBe(false);
    expect(descriptionIsLong('A short blurb.')).toBe(false);
  });

  it('is true past the collapse threshold', () => {
    expect(descriptionIsLong('x'.repeat(301))).toBe(true);
  });
});

describe('seriesRailWorks', () => {
  const series: BookMetaSeries = {
    id: 's',
    name: 'Wandering Earth',
    position: '2',
    works: [work('a', '1'), work('b', '2'), work('c', '3')],
  };

  it('drops the current work, keeping the rest in order', () => {
    expect(seriesRailWorks(series, 'b').map((w) => w.id)).toEqual(['a', 'c']);
  });

  it('returns all works when the current work is not in the rail', () => {
    expect(seriesRailWorks(series, 'zzz').map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('roleLabelKey', () => {
  it('maps each known role to its translation key', () => {
    expect(roleLabelKey('protagonist')).toBe('book.meta.role.protagonist');
    expect(roleLabelKey('minor')).toBe('book.meta.role.minor');
  });
  it('is undefined for an absent role', () => {
    expect(roleLabelKey(undefined)).toBeUndefined();
  });
});

describe('revealFromStart', () => {
  it('is true for chapter 0 and 1', () => {
    expect(revealFromStart({ chapter: 0 })).toBe(true);
    expect(revealFromStart({ chapter: 1 })).toBe(true);
  });
  it('is false for a later chapter', () => {
    expect(revealFromStart({ chapter: 9 })).toBe(false);
  });
});

describe('recapDescriptor', () => {
  it('is the prior-books catch-up for a chapter-0 series recap', () => {
    expect(recapDescriptor({ through: { chapter: 0 }, scope: 'series', text: 'x' })).toEqual({
      kind: 'seriesPrior',
    });
  });
  it('is a pre-book note for a chapter-0 book recap', () => {
    expect(recapDescriptor({ through: { chapter: 0 }, scope: 'book', text: 'x' })).toEqual({
      kind: 'beforeBook',
    });
  });
  it('covers up to a chapter otherwise', () => {
    expect(recapDescriptor({ through: { chapter: 5 }, scope: 'book', text: 'x' })).toEqual({
      kind: 'upToChapter',
      chapter: 5,
    });
  });
});

describe('sortRecaps', () => {
  it('orders by position ascending without mutating the input', () => {
    const input: BookMetaRecap[] = [
      { through: { chapter: 9 }, scope: 'book', text: 'c' },
      { through: { chapter: 0 }, scope: 'series', text: 'a' },
      { through: { chapter: 4 }, scope: 'book', text: 'b' },
    ];
    expect(sortRecaps(input).map((r) => r.through.chapter)).toEqual([0, 4, 9]);
    expect(input.map((r) => r.through.chapter)).toEqual([9, 0, 4]);
  });
});
