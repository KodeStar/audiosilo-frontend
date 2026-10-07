import type { Page } from '@/api/types';

import { collectPages } from './export-collect';

type Row = { id: number };
const rows = (from: number, to: number): Row[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i }));

/** A server with `total` rows, `size` per page, cursors "p<index>". */
function server(total: number, size: number) {
  const calls: (string | undefined)[] = [];
  const fetchPage = jest.fn(async (cursor: string | undefined): Promise<Page<Row>> => {
    calls.push(cursor);
    const start = cursor ? Number(cursor.slice(1)) : 0;
    const items = rows(start + 1, Math.min(total, start + size));
    const next = start + size < total ? `p${start + size}` : undefined;
    return next ? { items, next_cursor: next } : { items };
  });
  return { fetchPage, calls };
}

describe('collectPages', () => {
  it('fetches every page when nothing is loaded yet, reporting progress', async () => {
    const s = server(5, 2);
    const progress: number[] = [];
    const got = await collectPages(undefined, s.fetchPage, {
      maxRows: 100,
      onProgress: (n) => progress.push(n),
    });
    expect(got.items.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(got.truncated).toBe(false);
    expect(s.calls).toEqual([undefined, 'p2', 'p4']);
    expect(progress).toEqual([2, 4, 5]);
  });

  it('starts from the pages already loaded and asks only for the rest', async () => {
    const s = server(5, 2);
    const cached = {
      pages: [{ items: rows(1, 2), next_cursor: 'p2' }],
      pageParams: [undefined],
    };
    const got = await collectPages(cached, s.fetchPage, { maxRows: 100 });
    expect(got.items.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(s.calls).toEqual(['p2', 'p4']);
  });

  it('asks nothing when the loaded pages are the whole list', async () => {
    const s = server(2, 2);
    const got = await collectPages(
      { pages: [{ items: rows(1, 2) }], pageParams: [undefined] },
      s.fetchPage,
      {
        maxRows: 100,
      },
    );
    expect(got.items).toHaveLength(2);
    expect(s.fetchPage).not.toHaveBeenCalled();
  });

  it('stops at the bound and says it did', async () => {
    const s = server(50, 10);
    const got = await collectPages(undefined, s.fetchPage, { maxRows: 25 });
    expect(got.items).toHaveLength(25);
    expect(got.truncated).toBe(true);
    expect(s.calls).toEqual([undefined, 'p10', 'p20']);
  });

  it('never loops on a server that repeats its cursor, and drops duplicate rows', async () => {
    const fetchPage = jest.fn(async () => ({ items: rows(1, 2), next_cursor: 'same' }));
    const got = await collectPages(undefined, fetchPage, { maxRows: 100 });
    expect(got.items.map((r) => r.id)).toEqual([1, 2]);
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(2);
    expect(got.truncated).toBe(true);
  });

  it('passes a failure on (the caller leaves that server out)', async () => {
    await expect(
      collectPages(undefined, () => Promise.reject(new Error('offline')), { maxRows: 10 }),
    ).rejects.toThrow('offline');
  });
});
