import type { Book } from '@/api/types';
import { contentKey } from '@/lib/content-key';

import {
  booksBySeries,
  creditedPeople,
  hslHex,
  personStats,
  portraitColors,
  portraitHue,
} from './people-model';
import { luminance } from './spine-colors';

function book(title: string, extra: Partial<Book> = {}): Book {
  return {
    id: 1,
    library_id: 1,
    rel_path: `x/${title}`,
    is_folder: true,
    title,
    author: 'Jim Butcher',
    series: '',
    series_index: 0,
    narrator: 'James Marsters',
    duration: 3600,
    format: 'm4b',
    size: 1,
    ...extra,
  };
}

describe('portraitHue', () => {
  it('gives a stable hue', () => {
    expect(portraitHue('Jim Butcher')).toBe(portraitHue('Jim Butcher'));
    expect(portraitHue('Jim Butcher')).toBeGreaterThanOrEqual(0);
    expect(portraitHue('Jim Butcher')).toBeLessThan(360);
  });
});

describe('personStats', () => {
  it('counts books, length, finished and listened time', () => {
    const a = book('A');
    const b = book('B');
    const rows: Record<
      string,
      { position: number; duration: number; finished: boolean; updated_at: string }
    > = {
      [contentKey('c', 1, a.rel_path)]: {
        position: 3600,
        duration: 3600,
        finished: true,
        updated_at: '',
      },
      [contentKey('c', 1, b.rel_path)]: {
        position: 900,
        duration: 3600,
        finished: false,
        updated_at: '',
      },
    };
    const s = personStats([a, b, book('C')], 'c', (c, l, p) => rows[contentKey(c, l, p)]);
    expect(s).toEqual({ books: 3, seconds: 10_800, finished: 1, listened: 4500 });
  });
});

describe('booksBySeries', () => {
  it('groups series in order and leaves standalones by title', () => {
    const { series, standalone } = booksBySeries([
      book('Grave Peril', { series: 'The Dresden Files', series_index: 3 }),
      book('Zed'),
      book('Storm Front', { series: 'The Dresden Files', series_index: 1 }),
      book('Furies of Calderon', { series: 'Codex Alera', series_index: 1 }),
      book('Alpha'),
    ]);
    expect(series.map((g) => [g.series, g.books.map((b) => b.title)])).toEqual([
      ['Codex Alera', ['Furies of Calderon']],
      ['The Dresden Files', ['Storm Front', 'Grave Peril']],
    ]);
    expect(standalone.map((b) => b.title)).toEqual(['Alpha', 'Zed']);
  });
});

describe('creditedPeople', () => {
  it('counts the other credits, most first, without self or blanks', () => {
    const people = creditedPeople(
      [
        book('A', { narrator: 'Kate Reading' }),
        book('B', { narrator: 'Michael Kramer' }),
        book('C', { narrator: 'Kate Reading' }),
        book('D', { narrator: '' }),
      ],
      'narrator',
      'Michael Kramer',
    );
    expect(people).toEqual([{ name: 'Kate Reading', books: 2 }]);
  });
});

describe('portrait colours', () => {
  it('converts hsl to hex', () => {
    expect(hslHex(0, 100, 50)).toBe('#ff0000');
    expect(hslHex(120, 100, 25)).toBe('#008000');
    expect(hslHex(0, 0, 100)).toBe('#ffffff');
  });

  it('gives authors a pale disc and narrators white initials', () => {
    const a = portraitColors('Jim Butcher', 'author');
    expect(luminance(a.from)).toBeGreaterThan(0.5);
    expect(luminance(a.ink)).toBeLessThan(0.1);
    expect(portraitColors('Jim Butcher', 'narrator').ink).toBe('#ffffff');
  });
});
