import type { Book } from '@/api/types';

import { bookDedupKey, dedupBooks, type SourcedBook } from './dedup';

function book(p: Partial<SourcedBook> & { connectionId: string }): SourcedBook {
  return {
    id: 0,
    library_id: 1,
    rel_path: p.rel_path ?? 'x.m4b',
    is_folder: false,
    title: '',
    author: '',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 100,
    format: 'm4b',
    size: 1000,
    connectionName: p.connectionId,
    ...p,
  };
}

// Rank by the order connection ids appear in `prefs` (earlier = preferred).
const ranker = (prefs: string[]) => (id: string) => {
  const i = prefs.indexOf(id);
  return i === -1 ? prefs.length : i;
};

describe('bookDedupKey', () => {
  it('prefers the server dedup_key', () => {
    expect(bookDedupKey({ dedup_key: 'a:b01' } as Book)).toBe('a:b01');
  });
  it('falls back through asin → isbn → metadata', () => {
    expect(bookDedupKey({ asin: 'B01', title: 'X', author: 'Y' } as Book)).toBe('a:b01');
    expect(bookDedupKey({ isbn: '9-78', title: 'X' } as Book)).toBe('i:9 78');
    expect(bookDedupKey({ title: 'The Hobbit', author: 'Tolkien' } as Book)).toBe(
      'm:tolkien|the hobbit|',
    );
  });
  it('keeps untitled, id-less books unique', () => {
    const a = bookDedupKey({ library_id: 1, rel_path: 'a' } as Book);
    const b = bookDedupKey({ library_id: 1, rel_path: 'b' } as Book);
    expect(a).not.toBe(b);
  });
});

describe('dedupBooks', () => {
  const meta = { title: 'The Hobbit', author: 'Tolkien' };

  it('collapses the same book across connections, best quality wins', () => {
    const items = [
      book({ connectionId: 'A', ...meta, format: 'mp3', multi_file: true }),
      book({ connectionId: 'B', ...meta, format: 'm4b' }),
    ];
    const out = dedupBooks(items, ranker(['A', 'B'])); // A preferred, but B is better quality
    expect(out).toHaveLength(1);
    expect(out[0].connectionId).toBe('B');
    expect(out[0].also).toEqual([{ connectionId: 'A', connectionName: 'A' }]);
  });

  it('uses source priority only to break quality ties', () => {
    const items = [book({ connectionId: 'A', ...meta }), book({ connectionId: 'B', ...meta })];
    expect(dedupBooks(items, ranker(['B', 'A']))[0].connectionId).toBe('B');
    expect(dedupBooks(items, ranker(['A', 'B']))[0].connectionId).toBe('A');
  });

  it('keeps distinct books separate and preserves first-appearance order', () => {
    const items = [
      book({ connectionId: 'A', title: 'Dune', author: 'Herbert' }),
      book({ connectionId: 'A', ...meta }),
      book({ connectionId: 'B', ...meta }),
    ];
    const out = dedupBooks(items, ranker(['A', 'B']));
    expect(out.map((b) => b.title)).toEqual(['Dune', 'The Hobbit']);
    expect(out[1].also).toEqual([{ connectionId: 'B', connectionName: 'B' }]);
  });

  it('lists each other connection once', () => {
    const items = [
      book({ connectionId: 'A', ...meta }),
      book({ connectionId: 'B', ...meta, rel_path: 'b1' }),
      book({ connectionId: 'B', ...meta, rel_path: 'b2' }),
    ];
    const out = dedupBooks(items, ranker(['A', 'B']));
    expect(out[0].also).toEqual([{ connectionId: 'B', connectionName: 'B' }]);
  });
});
