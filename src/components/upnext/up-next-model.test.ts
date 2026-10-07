import type { Book, NextBook, QueueEntry } from '@/api/types';

import {
  canDrop,
  clampDrawerWidth,
  dragShift,
  dragTarget,
  entryState,
  isUpNextShortcut,
  keyMove,
  moveItem,
  parseDragPayload,
  pickSuggestions,
  progressIndex,
  queueConnectionId,
  queuedSeconds,
  serializeDragPayload,
} from './up-next-model';

const entry = (path: string, duration = 0, library_id = 1): QueueEntry => ({
  library_id,
  path,
  added_at: '2026-10-06T10:00:00Z',
  book: duration ? ({ duration } as Book) : undefined,
});
const prog = (path: string, position: number, duration: number, finished = false) => ({
  library_id: 1,
  path,
  position,
  duration,
  finished,
});

describe('clampDrawerWidth', () => {
  it('keeps the drawer between 300 and 480, defaulting anything unusable to 360', () => {
    expect(clampDrawerWidth(200)).toBe(300);
    expect(clampDrawerWidth(999)).toBe(480);
    expect(clampDrawerWidth(401.6)).toBe(402);
    expect(clampDrawerWidth('wide')).toBe(360);
    expect(clampDrawerWidth(Number.NaN)).toBe(360);
  });
});

describe('queueConnectionId', () => {
  const conns = [{ id: 'a' }, { id: 'b' }];
  it("prefers the loaded book's server, then the default, then the first", () => {
    expect(queueConnectionId('b', 'a', conns)).toBe('b');
    expect(queueConnectionId(undefined, 'b', conns)).toBe('b');
    expect(queueConnectionId('gone', 'gone too', conns)).toBe('a');
    expect(queueConnectionId(undefined, null, [])).toBeUndefined();
  });
});

describe('reordering', () => {
  it('moves one item to its final index', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('turns a drag distance into a target row, clamped to the list', () => {
    expect(dragTarget(1, 0, 60, 4)).toBe(1);
    expect(dragTarget(1, 95, 60, 4)).toBe(3);
    expect(dragTarget(1, -400, 60, 4)).toBe(0);
    expect(dragTarget(1, 400, 60, 4)).toBe(3);
    expect(dragTarget(2, 50, 0, 4)).toBe(2);
  });

  it('shifts the rows between the dragged row and its target', () => {
    // Row 0 dragged down to 2: rows 1 and 2 move up.
    expect([0, 1, 2, 3].map((i) => dragShift(i, 0, 2))).toEqual([0, -1, -1, 0]);
    // Row 3 dragged up to 1: rows 1 and 2 move down.
    expect([0, 1, 2, 3].map((i) => dragShift(i, 3, 1))).toEqual([0, 1, 1, 0]);
    // No drag.
    expect(dragShift(1, -1, 2)).toBe(0);
  });

  it('moves with the arrows on the grip, or Alt+arrows anywhere in the row', () => {
    const up = { key: 'ArrowUp', altKey: false };
    const down = { key: 'ArrowDown', altKey: false };
    expect(keyMove(up, true, 2, 4)).toBe(1);
    expect(keyMove(down, true, 2, 4)).toBe(3);
    expect(keyMove(down, false, 2, 4)).toBeNull();
    expect(keyMove({ ...down, altKey: true }, false, 2, 4)).toBe(3);
    expect(keyMove(up, true, 0, 4)).toBeNull();
    expect(keyMove(down, true, 3, 4)).toBeNull();
    expect(keyMove({ key: 'Enter', altKey: true }, true, 1, 4)).toBeNull();
  });
});

describe('isUpNextShortcut', () => {
  const key = (
    k: string,
    mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {},
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });
  it('is a bare Q, never while typing or with a modifier', () => {
    expect(isUpNextShortcut(key('q'), false)).toBe(true);
    expect(isUpNextShortcut(key('Q'), false)).toBe(true);
    expect(isUpNextShortcut(key('q'), true)).toBe(false);
    expect(isUpNextShortcut(key('q', { metaKey: true }), false)).toBe(false);
    expect(isUpNextShortcut(key('q', { ctrlKey: true }), false)).toBe(false);
    expect(isUpNextShortcut(key('w'), false)).toBe(false);
  });
});

describe('drag payload', () => {
  const book = { connectionId: 'a', libraryId: 2, path: 'X/Y' };
  it('round-trips a book and refuses anything else', () => {
    expect(parseDragPayload(serializeDragPayload(book))).toEqual(book);
    expect(parseDragPayload('https://example.com')).toBeNull();
    expect(parseDragPayload('{"connectionId":"a","libraryId":"2","path":"X"}')).toBeNull();
    expect(parseDragPayload('{"connectionId":"a","libraryId":2,"path":""}')).toBeNull();
    expect(parseDragPayload('')).toBeNull();
    expect(parseDragPayload(undefined)).toBeNull();
  });

  it("takes only a book from the queue's own server", () => {
    expect(canDrop(book, 'a')).toBe('ok');
    expect(canDrop(book, 'b')).toBe('other-server');
  });
});

describe('progress', () => {
  it('says where the listener is in a book', () => {
    expect(entryState(undefined)).toEqual({ kind: 'new' });
    expect(entryState(prog('A', 0, 100))).toEqual({ kind: 'new' });
    expect(entryState(prog('A', 55, 100))).toEqual({ kind: 'progress', percent: 55 });
    expect(entryState(prog('A', 0.1, 100))).toEqual({ kind: 'progress', percent: 0 });
    expect(entryState(prog('A', 99.9, 100))).toEqual({ kind: 'progress', percent: 99 });
    expect(entryState(prog('A', 100, 100, true))).toEqual({ kind: 'finished' });
  });

  it('adds up the listening left across the queue', () => {
    const q = [entry('A', 3600), entry('B', 1800), entry('C', 600), entry('D')];
    const index = progressIndex([prog('A', 600, 3600), prog('C', 600, 600, true)]);
    expect(queuedSeconds(q, index)).toBe(3000 + 1800);
  });
});

describe('pickSuggestions', () => {
  const next = (over: Partial<NextBook>): NextBook => ({ source: 'series', ...over });
  const current = { library_id: 1, path: 'Series/1' };

  it('offers the next book, then books in progress, never the loaded or a queued one', () => {
    const out = pickSuggestions({
      next: next({ next: { library_id: 1, path: 'Series/2' }, book: { series: 'Saga' } as Book }),
      current,
      queued: [entry('Queued')],
      inProgress: [
        prog('Series/1', 10, 100),
        prog('Queued/Part 1', 10, 100),
        prog('Other', 30, 100),
        prog('Done', 100, 100, true),
        prog('Series/2', 5, 100),
      ],
    });
    expect(out).toEqual([
      { kind: 'next', ref: { library_id: 1, path: 'Series/2' }, series: 'Saga' },
      { kind: 'progress', ref: { library_id: 1, path: 'Other' }, percent: 30 },
    ]);
  });

  it("skips a next book that is already queued, and ghosts a work this server can't place", () => {
    const out = pickSuggestions({
      next: next({
        next: { library_id: 1, path: 'Queued' },
        work: { id: 'w3', title: 'Book Three', position: '3', authors: [], web_url: 'u' },
      }),
      current,
      queued: [entry('Queued')],
      inProgress: [],
    });
    expect(out).toEqual([{ kind: 'ghost', title: 'Book Three', position: '3', workId: 'w3' }]);
  });

  it('keeps a placed work as a book, and keeps room for the ghost within the limit', () => {
    const placed = pickSuggestions({
      next: next({
        source: 'community',
        next: { library_id: 2, path: 'N' },
        work: {
          id: 'w',
          title: 'N',
          position: '2',
          authors: [],
          web_url: 'u',
          local: { library_id: 2, path: 'N' },
        },
      }),
      current: undefined,
      queued: [],
      inProgress: [],
    });
    expect(placed.map((s) => s.kind)).toEqual(['next']);

    const ghosted = pickSuggestions({
      next: next({ work: { id: 'w', title: 'G', position: '4', authors: [], web_url: 'u' } }),
      current: undefined,
      queued: [],
      inProgress: [prog('A', 1, 10), prog('B', 1, 10), prog('C', 1, 10)],
      limit: 3,
    });
    expect(ghosted.map((s) => s.kind)).toEqual(['progress', 'progress', 'ghost']);
  });
});
