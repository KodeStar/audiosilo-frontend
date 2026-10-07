import type { BookMeta, BookMetaRecap, BookMetaSeries } from '@/api/types';
import type { OrderingPicks } from '@/lib/series-orderings';

// book-meta pulls in CoverFrame, whose iOS shadow hook reads the theme provider (its
// module side-effect-imports global.css, unparseable in Node); stub the hook so this
// pure-helper suite loads.
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'dark', pref: 'dark', setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import {
  descriptionIsLong,
  lastBookRecap,
  matchedMeta,
  revealFromStart,
  roleLabelKey,
  summaryIsVisible,
} from './book-meta';
import { recapDescriptor, sortRecaps } from './meta-gating';
import { previousWorks, seriesPositionValue, seriesRails } from './series-rails';
/* eslint-enable import/first */

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

describe('seriesRails', () => {
  const one: BookMetaSeries = { id: 's1', name: 'One', position: '1', works: [work('a', '1')] };
  const two: BookMetaSeries = {
    id: 's2',
    name: 'Two',
    position: '2',
    works: [work('a', '1'), work('b', '2')],
  };
  const three: BookMetaSeries = {
    id: 's3',
    name: 'Wandering Earth',
    position: '2',
    works: [work('a', '1'), work('b', '2'), work('c', '3')],
  };

  it('drops the current work from a rail, keeping the rest in order', () => {
    expect(seriesRails([three], 'b')[0].works.map((w) => w.id)).toEqual(['a', 'c']);
  });

  it('keeps every work when the current work is in no rail', () => {
    expect(seriesRails([three], 'zzz')[0].works.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops rails left empty after removing the current work', () => {
    expect(seriesRails([one, two], 'a').map((r) => r.series.id)).toEqual(['s2']);
    expect(seriesRails([one, two], 'a')[0].works.map((w) => w.id)).toEqual(['b']);
  });

  it('is empty when the book belongs to no series', () => {
    expect(seriesRails(undefined, 'a')).toEqual([]);
  });

  it('is one view per series, keyed by its own id, on a server with no ordering data', () => {
    const [rail] = seriesRails([three], 'b');
    expect(rail.family).toBe('s3');
    expect(rail.views.map((v) => v.id)).toEqual(['s3']);
    expect(rail.view.id).toBe('s3');
    expect(rail.holdsWork).toBe(true);
  });
});

describe('seriesRails (reading-order families)', () => {
  const family: BookMetaSeries = {
    id: 'pub',
    name: 'Saga',
    position: '1',
    ordering: 'publication',
    works: [work('me', '1'), work('two', '2')],
    orderings: [
      {
        id: 'chron',
        name: 'Saga (Chronological)',
        ordering: 'chronological',
        ordering_of: 'pub',
        works: [work('prequel', '1'), work('two', '2')],
      },
    ],
  };

  it('shows the main view by default, with every order of the family available', () => {
    const [rail] = seriesRails([family], 'me');
    expect(rail.family).toBe('pub');
    expect(rail.views.map((v) => v.id)).toEqual(['pub', 'chron']);
    expect(rail.view.id).toBe('pub');
    expect(rail.works.map((w) => w.id)).toEqual(['two']);
  });

  it('shows the picked order, and says when the book is not part of it', () => {
    const [rail] = seriesRails([family], 'me', { pub: 'chron' });
    expect(rail.view.id).toBe('chron');
    expect(rail.works.map((w) => w.id)).toEqual(['prequel', 'two']);
    expect(rail.holdsWork).toBe(false);
  });

  it('keeps a rail whose picked order holds only the current work while another is not empty', () => {
    const s: BookMetaSeries = {
      ...family,
      works: [work('me', '1')],
      orderings: [{ ...family.orderings![0], works: [work('other', '1')] }],
    };
    const rails = seriesRails([s], 'me');
    expect(rails).toHaveLength(1);
    expect(rails[0].works).toEqual([]);
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

describe('seriesPositionValue', () => {
  it('reads the leading number, including a decimal position', () => {
    expect(seriesPositionValue('1')).toBe(1);
    expect(seriesPositionValue('2.5')).toBe(2.5);
  });

  it('takes the FIRST number of a span (an omnibus sorts at its start)', () => {
    expect(seriesPositionValue('1-3.5')).toBe(1);
  });

  it('is undefined for an unparsable or missing position', () => {
    expect(seriesPositionValue('')).toBeUndefined();
    expect(seriesPositionValue('novella')).toBeUndefined();
    expect(seriesPositionValue(undefined)).toBeUndefined();
  });
});

// `previousWorks` reads the rails `seriesRails` built, exactly as the screen does.
const prev = (series: BookMetaSeries[] | undefined, workId: string, picks?: OrderingPicks) =>
  previousWorks(seriesRails(series, workId, picks));

describe('previousWorks', () => {
  const series = (
    id: string,
    position: string,
    works: BookMetaSeries['works'],
  ): BookMetaSeries => ({
    id,
    name: id,
    position,
    works,
  });

  it('keeps only the works before the current position, most recent first', () => {
    const s = series('s', '3', [work('a', '1'), work('b', '2'), work('c', '3'), work('d', '4')]);
    expect(prev([s], 'c').map((w) => w.id)).toEqual(['b', 'a']);
  });

  it('places a "2.5" novella between books 2 and 3', () => {
    const s = series('s', '4', [work('a', '2'), work('b', '2.5'), work('c', '3')]);
    expect(prev([s], 'zzz').map((w) => w.id)).toEqual(['c', 'b', 'a']);
  });

  it('deduplicates a work listed by two different series (two families still union)', () => {
    const s1 = series('s1', '2', [work('shared', '1')]);
    const s2 = series('s2', '5', [work('shared', '4'), work('other', '3')]);
    expect(prev([s1, s2], 'me').map((w) => w.id)).toEqual(['other', 'shared']);
  });

  it('excludes entries whose position does not parse', () => {
    const s = series('s', '3', [work('a', '1'), work('bonus', 'novella')]);
    expect(prev([s], 'zzz').map((w) => w.id)).toEqual(['a']);
  });

  it('excludes a whole series whose own position does not parse', () => {
    const s = series('s', 'anthology', [work('a', '1')]);
    expect(prev([s], 'zzz')).toEqual([]);
  });

  it('is empty for no series, book one, or when only the current work matches', () => {
    expect(prev(undefined, 'a')).toEqual([]);
    expect(prev([series('s', '1', [work('a', '1'), work('b', '2')])], 'a')).toEqual([]);
    expect(prev([series('s', '2', [work('a', '2')])], 'a')).toEqual([]);
  });
});

// The spoiler this guards against was live: previous books UNIONED every order of a
// family, so in publication order (where The Lion, the Witch and the Wardrobe is
// book 1) The Magician's Nephew - book 1 only in the CHRONOLOGICAL order - was
// offered as a "previous book".
describe('previousWorks follows the picked reading order (Narnia regression)', () => {
  const lion = 'the-lion-the-witch-and-the-wardrobe';
  const nephew = 'the-magicians-nephew';
  const narnia: BookMetaSeries = {
    id: 'narnia',
    name: 'The Chronicles of Narnia',
    position: '1',
    ordering: 'publication',
    works: [work(lion, '1'), work('prince-caspian', '2'), work(nephew, '6')],
    orderings: [
      {
        id: 'narnia-chronological',
        name: 'The Chronicles of Narnia (Chronological)',
        ordering: 'chronological',
        ordering_of: 'narnia',
        position: '2',
        works: [work(nephew, '1'), work(lion, '2'), work('the-horse-and-his-boy', '3')],
      },
    ],
  };

  it('has no previous books in publication order (the default)', () => {
    expect(prev([narnia], lion)).toEqual([]);
    expect(prev([narnia], lion, { narnia: 'narnia' })).toEqual([]);
  });

  it("offers The Magician's Nephew once the reader picks the chronological order", () => {
    expect(prev([narnia], lion, { narnia: 'narnia-chronological' }).map((w) => w.id)).toEqual([
      nephew,
    ]);
  });

  it('contributes nothing from a picked order the current book is not part of', () => {
    const variantOnly: BookMetaSeries = {
      id: 'narnia-chronological',
      name: 'The Chronicles of Narnia (Chronological)',
      position: '0.5',
      ordering: 'chronological',
      ordering_of: 'narnia',
      works: [work('prequel', '0.5'), work(nephew, '1')],
      orderings: [{ id: 'narnia', name: 'The Chronicles of Narnia', works: [work(lion, '1')] }],
    };
    expect(prev([variantOnly], 'prequel', { narnia: 'narnia' })).toEqual([]);
  });

  it('still unions a different family beside the picked order', () => {
    const other: BookMetaSeries = {
      id: 'other',
      name: 'Other',
      position: '3',
      works: [work('o1', '1'), work('o2', '2')],
    };
    expect(prev([narnia, other], lion).map((w) => w.id)).toEqual(['o2', 'o1']);
  });
});

describe('matchedMeta', () => {
  const matched: BookMeta = {
    matched: true,
    work: { id: 'w', title: 'W', authors: [], language: 'en' },
    web_url: 'https://m/work?id=w',
  };

  it('is the payload only when the capability is on AND the book matched', () => {
    expect(matchedMeta(matched, true)).toBe(matched);
  });

  it('is undefined when the server capability is off', () => {
    // Progressive enhancement: an older server never advertises `metadata`, so even a
    // cached payload must not render.
    expect(matchedMeta(matched, false)).toBeUndefined();
  });

  it('is undefined while the response has not arrived', () => {
    expect(matchedMeta(undefined, true)).toBeUndefined();
  });

  it('is undefined when the service found no match', () => {
    expect(matchedMeta({ matched: false }, true)).toBeUndefined();
  });
});

describe('summaryIsVisible', () => {
  it('is true for an in_short, finished or not', () => {
    expect(summaryIsVisible({ in_short: 'A summary.' }, false)).toBe(true);
    expect(summaryIsVisible({ in_short: 'A summary.' }, true)).toBe(true);
  });

  it('counts an in_short as visible while unfinished because it renders as the tap row', () => {
    // in_short includes the ending, so mid-book it is NOT shown inline - but it still
    // renders the collapsed "Whole-book summary" spoiler row, so the Recaps tab never
    // opens onto an empty panel. With an ending too, the ending adds nothing yet.
    expect(summaryIsVisible({ in_short: 'A summary.', ending: 'They win.' }, false)).toBe(true);
    expect(summaryIsVisible({ in_short: '  ', ending: 'They win.' }, false)).toBe(false);
  });

  it('withholds an ending-only summary until the book is finished', () => {
    expect(summaryIsVisible({ ending: 'They win.' }, false)).toBe(false);
    expect(summaryIsVisible({ ending: 'They win.' }, true)).toBe(true);
  });

  it('is false when absent or blank', () => {
    expect(summaryIsVisible(undefined, true)).toBe(false);
    expect(summaryIsVisible({}, true)).toBe(false);
    expect(summaryIsVisible({ in_short: '  ', ending: '' }, true)).toBe(false);
    expect(summaryIsVisible({ in_short: '  ', ending: '   ' }, true)).toBe(false);
  });
});

describe('lastBookRecap', () => {
  const r = (chapter: number, scope?: 'book' | 'series'): BookMetaRecap => ({
    through: { chapter },
    ...(scope ? { scope } : {}),
    text: `through ${chapter}`,
  });

  it('is the furthest book-scope recap, whatever the input order', () => {
    expect(lastBookRecap([r(9), r(3), r(6)])?.through.chapter).toBe(9);
  });

  it('ignores series-scope recaps (they summarise other books)', () => {
    expect(lastBookRecap([r(2, 'book'), r(12, 'series')])?.through.chapter).toBe(2);
  });

  it('is undefined with no recaps or only series-scope ones', () => {
    expect(lastBookRecap(undefined)).toBeUndefined();
    expect(lastBookRecap([])).toBeUndefined();
    expect(lastBookRecap([r(0, 'series')])).toBeUndefined();
  });
});
