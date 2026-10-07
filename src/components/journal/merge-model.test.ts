import { mergeNewestFirst, overallStatus, type SourceSnapshot } from './merge-model';

type Row = { id: number; at: string };
const row = (id: number, minute: number): Row => ({
  id,
  at: `2026-10-05T10:${String(minute).padStart(2, '0')}:00Z`,
});

const source = (
  connectionId: string,
  rows: Row[],
  opts: Partial<SourceSnapshot<Row>> = {},
): SourceSnapshot<Row> => ({
  connectionId,
  connectionName: connectionId.toUpperCase(),
  status: 'ready',
  rows,
  hasNextPage: false,
  isFetchingNextPage: false,
  ...opts,
});

const ids = (rows: { id: number; connectionId: string }[]) =>
  rows.map((r) => `${r.connectionId}:${r.id}`);

describe('mergeNewestFirst', () => {
  it('merges complete lists newest first, tagging each row with its server', () => {
    const m = mergeNewestFirst(
      [source('a', [row(1, 50), row(2, 20)]), source('b', [row(9, 40), row(8, 10)])],
      (r) => r.at,
    );
    expect(ids(m.rows)).toEqual(['a:1', 'b:9', 'a:2', 'b:8']);
    expect(m.rows[1].connectionName).toBe('B');
    expect(m.hasMore).toBe(false);
    expect(m.fetchFrom).toEqual([]);
  });

  it("holds back rows older than a server's frontier until that server's next page", () => {
    // `a` has more after 10:30; `b` is complete. b's 10:10 could have a newer neighbour on
    // a's next page, so it waits; b's 10:40 is safe.
    const m = mergeNewestFirst(
      [
        source('a', [row(1, 50), row(2, 30)], { hasNextPage: true }),
        source('b', [row(9, 40), row(8, 10)]),
      ],
      (r) => r.at,
    );
    expect(ids(m.rows)).toEqual(['a:1', 'b:9', 'a:2']);
    expect(m.hasMore).toBe(true);
    expect(m.fetchFrom).toEqual(['a']);
  });

  it('cuts at the NEWEST frontier and asks only the server sitting on it', () => {
    const m = mergeNewestFirst(
      [
        source('a', [row(1, 50), row(2, 30)], { hasNextPage: true }),
        source('b', [row(9, 45), row(8, 20)], { hasNextPage: true }),
      ],
      (r) => r.at,
    );
    expect(ids(m.rows)).toEqual(['a:1', 'b:9', 'a:2']);
    expect(m.fetchFrom).toEqual(['a']);
  });

  it('never lets a loading, failed or unable server hold the others back', () => {
    const m = mergeNewestFirst(
      [
        source('a', [row(1, 50)]),
        source('b', [], { status: 'loading' }),
        source('c', [], { status: 'error' }),
        source('d', [], { status: 'unsupported' }),
      ],
      (r) => r.at,
    );
    expect(ids(m.rows)).toEqual(['a:1']);
    expect(m.hasMore).toBe(false);
  });

  it('keeps the server order for rows at the same moment, and reports fetching', () => {
    const m = mergeNewestFirst(
      [source('a', [row(1, 30)]), source('b', [row(2, 30)], { isFetchingNextPage: true })],
      (r) => r.at,
    );
    expect(ids(m.rows)).toEqual(['a:1', 'b:2']);
    expect(m.isFetchingMore).toBe(true);
  });

  it('keeps each tagged row the same object from one merge to the next', () => {
    const a = [row(1, 50), row(2, 20)];
    const first = mergeNewestFirst([source('a', a)], (r) => r.at);
    const again = mergeNewestFirst([source('a', [row(0, 55), ...a])], (r) => r.at);
    expect(again.rows[1]).toBe(first.rows[0]);
    expect(again.rows[2]).toBe(first.rows[1]);
    // A renamed server tags its rows afresh.
    const renamed = mergeNewestFirst([{ ...source('a', a), connectionName: 'Home' }], (r) => r.at);
    expect(renamed.rows[0]).not.toBe(first.rows[0]);
    expect(renamed.rows[0].connectionName).toBe('Home');
  });
});

describe('overallStatus', () => {
  it('is ready as soon as one server that can list has answered', () => {
    expect(overallStatus([{ status: 'error' }, { status: 'ready' }])).toBe('ready');
  });
  it('loads while no server has answered and one still might', () => {
    expect(overallStatus([{ status: 'error' }, { status: 'loading' }])).toBe('loading');
  });
  it('fails only when every server that can list failed', () => {
    expect(overallStatus([{ status: 'error' }, { status: 'unsupported' }])).toBe('error');
  });
  it('is unsupported when no server can list, and ready with no servers', () => {
    expect(overallStatus([{ status: 'unsupported' }])).toBe('unsupported');
    expect(overallStatus([])).toBe('ready');
  });
});
