import { contentKeyOf } from '@/lib/content-key';

import {
  aheadWindow,
  estimateBytes,
  pendingBytes,
  planKeepAhead,
  reserveBytes,
  roomLeft,
  type AheadBook,
  type KeepAheadInput,
} from './keep-ahead';
import type { DownloadStatus } from './types';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function book(path: string, p: Partial<AheadBook> = {}): AheadBook {
  return {
    connectionId: 'c1',
    libraryId: 1,
    path,
    title: path,
    size: 300 * MB,
    duration: 36_000,
    source: 'series',
    ...p,
  };
}

const current = { connectionId: 'c1', libraryId: 1, path: 'Now' };

function input(p: Partial<KeepAheadInput> = {}): KeepAheadInput {
  return {
    count: 2,
    network: 'allowed',
    window: [book('A'), book('B')],
    entries: new Map(),
    declined: new Set(),
    unavailable: new Set(),
    tooBig: new Set(),
    storage: { scope: 'device', capacity: 128 * GB, free: 60 * GB },
    pending: 0,
    ...p,
  };
}

const statuses = (pairs: [AheadBook, DownloadStatus][]) =>
  new Map(pairs.map(([b, s]) => [contentKeyOf(b), s]));

describe('estimateBytes', () => {
  it('uses the size, else the length at about 128 kbps, else a long book', () => {
    expect(estimateBytes({ size: 123, duration: 999 })).toBe(123);
    expect(estimateBytes({ size: 0, duration: 3600 })).toBe(57_600_000);
    expect(estimateBytes({ size: 0, duration: 0 })).toBe(GB);
  });
});

describe('reserveBytes', () => {
  it('keeps 1 GB or a tenth of the room free, whichever is more', () => {
    expect(reserveBytes(4 * GB)).toBe(GB);
    expect(reserveBytes(128 * GB)).toBe(Math.ceil(12.8 * GB));
  });
});

describe('roomLeft', () => {
  it('is the free space less what is queued and the reserve', () => {
    const storage = { scope: 'device' as const, capacity: 4 * GB, free: 3 * GB };
    expect(roomLeft(storage, 0)).toBe(2 * GB);
    expect(roomLeft(storage, 512 * MB)).toBe(1.5 * GB);
  });
  it('goes below zero once the reserve is eaten into', () => {
    expect(roomLeft({ scope: 'browser', capacity: 4 * GB, free: GB / 2 }, 0)).toBe(-GB / 2);
  });
  it('is null when the room is not knowable', () => {
    expect(roomLeft(null, 0)).toBeNull();
  });
});

describe('pendingBytes', () => {
  const entry = (status: DownloadStatus, bytes: number, totalBytes: number, size = 0) => ({
    status,
    bytes,
    totalBytes,
    manifest: { book: { size, duration: 0 } },
  });
  it('counts what queued and running downloads still have to write', () => {
    expect(
      pendingBytes([
        entry('downloading', 100, 400),
        entry('queued', 0, 0, 250),
        entry('downloaded', 500, 500),
        entry('error', 10, 400),
      ]),
    ).toBe(300 + 250);
  });
});

describe('aheadWindow', () => {
  it('takes the queue first, then the series, up to the count', () => {
    const w = aheadWindow({
      count: 3,
      current,
      queue: [book('Q1', { source: 'queue' }), book('Q2', { source: 'queue' })],
      series: [book('S1'), book('S2')],
      finished: new Set(),
    });
    expect(w.map((b) => b.path)).toEqual(['Q1', 'Q2', 'S1']);
  });

  it('skips the current book, finished books and repeats', () => {
    const w = aheadWindow({
      count: 3,
      current,
      queue: [book('Now', { source: 'queue' }), book('Done', { source: 'queue' }), book('S1')],
      series: [book('S1'), book('S2'), book('S3')],
      finished: new Set([contentKeyOf(book('Done'))]),
    });
    expect(w.map((b) => b.path)).toEqual(['S1', 'S2', 'S3']);
  });

  it('keys books by connection too', () => {
    const w = aheadWindow({
      count: 2,
      current,
      queue: [book('Now', { connectionId: 'c2' })],
      series: [],
      finished: new Set(),
    });
    expect(w).toHaveLength(1);
  });
});

describe('planKeepAhead', () => {
  it('does nothing when the setting is off or automatic downloads are off', () => {
    expect(planKeepAhead(input({ count: 0 }))).toEqual({ status: 'off', slots: [], start: [] });
    expect(planKeepAhead(input({ network: 'never' }))).toEqual({
      status: 'never',
      slots: [],
      start: [],
    });
  });

  it('is idle with nothing after the current book', () => {
    expect(planKeepAhead(input({ window: [] })).status).toBe('idle');
  });

  it('starts every missing book of the window that fits', () => {
    const plan = planKeepAhead(input());
    expect(plan.start.map((b) => b.path)).toEqual(['A', 'B']);
    expect(plan.status).toBe('working');
  });

  it('counts books already on the device or on their way', () => {
    const [a, b] = [book('A'), book('B')];
    const plan = planKeepAhead(
      input({
        entries: statuses([
          [a, 'downloaded'],
          [b, 'downloading'],
        ]),
      }),
    );
    expect(plan.slots.map((s) => s.state)).toEqual(['ready', 'active']);
    expect(plan.start).toEqual([]);
    expect(plan.status).toBe('working');
    expect(
      planKeepAhead(input({ window: [a], entries: statuses([[a, 'downloaded']]) })).status,
    ).toBe('ready');
  });

  it('never fetches a book removed this session, and does not reach past it', () => {
    const plan = planKeepAhead(
      input({ count: 1, window: [book('A')], declined: new Set([contentKeyOf(book('A'))]) }),
    );
    expect(plan.slots.map((s) => s.state)).toEqual(['declined']);
    expect(plan.start).toEqual([]);
    expect(plan.status).toBe('declined');
  });

  it('leaves a failed download to the listener', () => {
    const a = book('A');
    const plan = planKeepAhead(input({ entries: statuses([[a, 'error']]) }));
    expect(plan.slots.map((s) => s.state)).toEqual(['failed', 'start']);
    const b = book('B');
    const settled = planKeepAhead(
      input({
        entries: statuses([
          [a, 'error'],
          [b, 'downloaded'],
        ]),
      }),
    );
    expect(settled.status).toBe('failed');
  });

  it('is ready when the rest of the window is on the device', () => {
    const [a, b] = [book('A'), book('B')];
    const plan = planKeepAhead(
      input({ entries: statuses([[b, 'downloaded']]), declined: new Set([contentKeyOf(a)]) }),
    );
    expect(plan.status).toBe('ready');
  });

  it('waits for Wi-Fi on a metered network', () => {
    const plan = planKeepAhead(input({ network: 'metered' }));
    expect(plan.slots.map((s) => s.state)).toEqual(['waiting', 'waiting']);
    expect(plan.start).toEqual([]);
    expect(plan.status).toBe('waiting');
  });

  it('keeps the reserve free, counting downloads still on their way', () => {
    // 128 GB disk: reserve 12.8 GB. 13.5 GB free, 0.5 GB pending: room 0.2 GB.
    const plan = planKeepAhead(
      input({
        storage: { scope: 'device', capacity: 128 * GB, free: 13.5 * GB },
        pending: 0.5 * GB,
        window: [book('A', { size: 150 * MB }), book('B', { size: 150 * MB })],
      }),
    );
    expect(plan.slots.map((s) => s.state)).toEqual(['start', 'no-space']);
    expect(plan.status).toBe('working');
  });

  it('stops at the first book that does not fit, even if a later one would', () => {
    const plan = planKeepAhead(
      input({
        count: 3,
        storage: { scope: 'browser', capacity: 10 * GB, free: 1.5 * GB },
        window: [
          book('Big', { size: 2 * GB }),
          book('Small', { size: 10 * MB }),
          book('Tiny', { size: MB }),
        ],
      }),
    );
    expect(plan.slots.map((s) => s.state)).toEqual(['no-space', 'no-space', 'no-space']);
    expect(plan.status).toBe('no-space');
  });

  it('downloads one book at a time when the room is not knowable', () => {
    const [a, b, c] = [book('A'), book('B'), book('C')];
    const first = planKeepAhead(input({ count: 3, window: [a, b, c], storage: null }));
    expect(first.slots.map((s) => s.state)).toEqual(['start', 'later', 'later']);
    const second = planKeepAhead(
      input({ count: 3, window: [a, b, c], storage: null, entries: statuses([[a, 'queued']]) }),
    );
    expect(second.start).toEqual([]);
    const third = planKeepAhead(
      input({
        count: 3,
        window: [a, b, c],
        storage: null,
        entries: statuses([[a, 'downloaded']]),
      }),
    );
    expect(third.start.map((x) => x.path)).toEqual(['B']);
  });
});

describe('planKeepAhead with books the downloads store turned away', () => {
  it('leaves a book this device cannot keep alone, and plans the next instead', () => {
    const [a, b] = [book('A'), book('B')];
    const plan = planKeepAhead(input({ window: [a, b], unavailable: new Set([contentKeyOf(a)]) }));
    expect(plan.slots.map((s) => s.state)).toEqual(['unavailable', 'start']);
    expect(plan.start).toEqual([b]);
    expect(plan.status).toBe('working');
  });

  it('spends the one-at-a-time budget of an unknowable room on a book it can keep', () => {
    const [a, b] = [book('A'), book('B')];
    const plan = planKeepAhead(
      input({ window: [a, b], storage: null, unavailable: new Set([contentKeyOf(a)]) }),
    );
    expect(plan.start).toEqual([b]);
  });

  it('says so when no book of the window can be kept', () => {
    const [a, b] = [book('A'), book('B')];
    const plan = planKeepAhead(
      input({ window: [a, b], unavailable: new Set([contentKeyOf(a), contentKeyOf(b)]) }),
    );
    expect(plan.status).toBe('unavailable');
    expect(plan.start).toEqual([]);
  });

  it('reads a book turned away for room as no room, holding the ones after it', () => {
    const [a, b] = [book('A'), book('B')];
    const plan = planKeepAhead(input({ window: [a, b], tooBig: new Set([contentKeyOf(a)]) }));
    expect(plan.slots.map((s) => s.state)).toEqual(['no-space', 'no-space']);
    expect(plan.status).toBe('no-space');
  });
});
