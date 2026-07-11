import type { BookMetaSeries } from '@/api/types';

import { descriptionIsLong, seriesRailWorks } from './book-meta';

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
