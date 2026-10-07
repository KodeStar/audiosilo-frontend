import type { Book, BookMetaSeries, BookMetaSeriesWork } from '@/api/types';
import { contentKey } from '@/lib/content-key';
import { seriesViews } from '@/lib/series-orderings';

import {
  currentEntry,
  defaultSelection,
  type ElsewhereBook,
  localEntries,
  localGaps,
  looseKey,
  metadataAnchor,
  pickRail,
  type ProgressLike,
  railEntries,
  seriesStats,
  trackSegments,
} from './series-model';

const CID = 'home';

function book(title: string, index: number, extra: Partial<Book> = {}): Book {
  return {
    id: index,
    library_id: 1,
    rel_path: `Corey/Expanse/${title}`,
    is_folder: true,
    title,
    author: 'James S. A. Corey',
    series: 'The Expanse',
    series_index: index,
    narrator: 'Jefferson Mays',
    duration: 36_000,
    format: 'm4b',
    size: 1,
    ...extra,
  };
}

function work(id: string, title: string, position: string, local?: Book): BookMetaSeriesWork {
  return {
    id,
    title,
    position,
    authors: [{ id: 'corey', name: 'James S. A. Corey' }],
    web_url: `https://meta/${id}`,
    ...(local ? { local: { library_id: local.library_id, path: local.rel_path } } : {}),
  };
}

const progress: Record<string, ProgressLike> = {};
const progressOf = (c: string, l: number, p: string) => progress[contentKey(c, l, p)];
const setProgress = (b: Book, p: Partial<ProgressLike>, cid = CID) => {
  progress[contentKey(cid, b.library_id, b.rel_path)] = {
    position: 0,
    duration: b.duration,
    finished: false,
    updated_at: '2026-10-01T00:00:00Z',
    ...p,
  };
};
const src = { connectionId: CID, connectionName: 'Home Library', progressOf };

beforeEach(() => {
  for (const k of Object.keys(progress)) delete progress[k];
});

describe('localGaps', () => {
  it('lists the whole numbers missing below the highest', () => {
    expect(localGaps([1, 2, 4])).toEqual([3]);
    expect(localGaps([1, 3, 3.5])).toEqual([2]);
    expect(localGaps([2, 5])).toEqual([1, 3, 4]);
    expect(localGaps([0, 0])).toEqual([]);
  });

  it('draws no gaps for a mostly empty run', () => {
    expect(localGaps([400])).toEqual([]);
  });
});

describe('localEntries', () => {
  it('orders by series_index, unnumbered last, with "Book N" gaps', () => {
    const books = [book('Four', 4), book('Extra', 0), book('One', 1), book('Two', 2)];
    const entries = localEntries(books, src);
    expect(entries.map((e) => [e.kind, e.position, e.title])).toEqual([
      ['owned', '1', 'One'],
      ['owned', '2', 'Two'],
      ['ghost', '3', undefined],
      ['owned', '4', 'Four'],
      ['owned', '', 'Extra'],
    ]);
  });

  it('names an untitled book by its folder, as the rest of the app shows it', () => {
    const untitled = book('', 2, { rel_path: 'Corey/Expanse/Caliban' });
    const entries = localEntries([book('One', 1), untitled], src);
    expect(entries.map((e) => e.title)).toEqual(['One', 'Caliban']);
  });

  it('fills a gap from another server by series number', () => {
    const maya: ElsewhereBook = {
      ...book('Three', 3, { library_id: 1 }),
      connectionId: 'maya',
      connectionName: "Maya's Shelf",
    };
    const entries = localEntries([book('One', 1), book('Four', 4)], { ...src, elsewhere: [maya] });
    expect(entries[2]).toMatchObject({ kind: 'elsewhere', title: 'Three', position: '3' });
    expect(entries[2].copy).toMatchObject({ connectionId: 'maya', connectionName: "Maya's Shelf" });
    expect(entries[1]).toMatchObject({ kind: 'ghost', position: '2' });
  });
});

describe('railEntries', () => {
  const lw = book('Leviathan Wakes', 1);
  const cw = book("Caliban's War", 2);
  const ng = book('Nemesis Games', 5, { rel_path: 'Corey/Expanse/05 - Nemesis' });
  const loose = book('Untagged Novella', 2.5);
  const series: BookMetaSeries = {
    id: 'the-expanse',
    name: 'The Expanse',
    position: '2',
    works: [
      work('lw', 'Leviathan Wakes', '1', lw),
      work('cw', "Caliban's War", '2', cw),
      work('ag', "Abaddon's Gate", '3'),
      work('cb', 'Cibola Burn', '4'),
      work('ng', 'Nemesis Games', '5'),
    ],
  };
  const view = seriesViews(series)[0];
  const maya: ElsewhereBook = {
    ...book("Abaddon's Gate", 3),
    connectionId: 'maya',
    connectionName: "Maya's Shelf",
  };

  it('places owned books, copies elsewhere and ghosts, in rail order', () => {
    const entries = railEntries(view, [lw, cw, ng, loose], { ...src, elsewhere: [maya] });
    expect(entries.map((e) => [e.kind, e.position, e.title])).toEqual([
      ['owned', '1', 'Leviathan Wakes'],
      ['owned', '2', "Caliban's War"],
      ['owned', '2.5', 'Untagged Novella'],
      ['elsewhere', '3', "Abaddon's Gate"],
      ['ghost', '4', 'Cibola Burn'],
      // Matched by title: the rail didn't place it.
      ['owned', '5', 'Nemesis Games'],
    ]);
    expect(entries[4]).toMatchObject({ webUrl: 'https://meta/cb', workId: 'cb' });
    expect(entries[0].key).toBe('w:lw');
  });

  it('ignores a same-titled book by another author on another server', () => {
    const other = { ...maya, author: 'Somebody Else' };
    const entries = railEntries(view, [lw, cw], { ...src, elsewhere: [other] });
    expect(entries[2]).toMatchObject({ kind: 'ghost', title: "Abaddon's Gate" });
  });

  it('keeps a placed book from another library without its row', () => {
    const elsewhereLib = {
      ...view,
      works: [work('x', 'Kids One', '1', book('Kids One', 1, { library_id: 2 }))],
    };
    const [e] = railEntries(elsewhereLib, [], src);
    expect(e).toMatchObject({ kind: 'owned', title: 'Kids One' });
    expect(e.copy).toMatchObject({ libraryId: 2, book: undefined });
  });

  it('reads progress, the current book and stats', () => {
    setProgress(lw, { finished: true, position: 36_000 });
    setProgress(cw, { position: 14_400, updated_at: '2026-10-05T00:00:00Z' });
    setProgress(maya, { position: 3600 }, 'maya');
    const entries = railEntries(view, [lw, cw], { ...src, elsewhere: [maya] });
    expect(entries[1]).toMatchObject({ started: true, finished: false, fraction: 0.4 });
    expect(currentEntry(entries)?.title).toBe("Caliban's War");
    expect(defaultSelection(entries)?.title).toBe("Caliban's War");
    const stats = seriesStats(entries);
    expect(stats).toMatchObject({ entries: 5, owned: 2, elsewhere: 1, missing: 2, finished: 1 });
    expect(stats.aheadSeconds).toBeCloseTo(36_000 * 0.6 + 36_000 * 0.9);
    expect(trackSegments(entries).map((s) => s.state)).toEqual([
      'finished',
      'partial',
      'partial',
      'missing',
      'missing',
    ]);
  });
});

describe('defaultSelection', () => {
  it('falls back to the first unfinished owned book, then the first entry', () => {
    const a = book('A', 1);
    const b = book('B', 2);
    setProgress(a, { finished: true, position: 36_000 });
    expect(defaultSelection(localEntries([a, b], src))?.title).toBe('B');
    setProgress(b, { finished: true, position: 36_000 });
    expect(defaultSelection(localEntries([a, b], src))?.title).toBe('A');
    expect(defaultSelection([])).toBeUndefined();
  });
});

describe('pickRail', () => {
  const lw = book('Leviathan Wakes', 1);
  const main: BookMetaSeries = {
    id: 'hp',
    name: 'Harry Potter',
    position: '1',
    works: [work('ps', 'Stone', '1')],
  };
  const fry: BookMetaSeries = {
    id: 'hp-fry',
    name: 'Harry Potter (Narrated by Stephen Fry)',
    position: '1',
    works: [work('ps', 'Stone', '1', lw), work('x', 'X', '2')],
  };
  const keys = new Set([contentKey(CID, lw.library_id, lw.rel_path)]);

  it('prefers the rail holding the linked work, then the name, then placement', () => {
    const opts = { connectionId: CID, ownedKeys: keys };
    expect(pickRail([main, fry], { ...opts, workId: 'x' })).toBe(fry);
    expect(pickRail([fry, main], { ...opts, name: 'harry potter' })).toBe(main);
    expect(pickRail([main, fry], { ...opts, name: 'Something else' })).toBe(fry);
    expect(pickRail([main], { ...opts, ownedKeys: new Set() })).toBeUndefined();
    expect(pickRail(undefined, opts)).toBeUndefined();
  });
});

describe('metadataAnchor', () => {
  it('asks about the tagged book the listener is on, else the first tagged one', () => {
    const a = book('A', 1);
    const b = book('B', 2, { asin: 'B00' });
    const c = book('C', 3, { isbn: '978' });
    expect(metadataAnchor([c, a, b], CID, progressOf)).toBe(b);
    setProgress(c, { position: 10 });
    expect(metadataAnchor([c, a, b], CID, progressOf)).toBe(c);
    expect(metadataAnchor([a], CID, progressOf)).toBeUndefined();
  });
});

describe('looseKey', () => {
  it('ignores case, accents and punctuation', () => {
    expect(looseKey("Caliban's War")).toBe(looseKey('CALIBANS  WAR'));
    expect(looseKey('J.K. Rowling')).toBe(looseKey('J. K. Rowling'));
    expect(looseKey('Émile')).toBe('emile');
  });
});
