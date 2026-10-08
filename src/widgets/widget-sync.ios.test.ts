import type { TFunction } from 'i18next';
import i18next from 'i18next';

import type { Chapter } from '@/api/types';
import { playerStoreMock, type MockNowPlaying } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

// The session store: just the connection list and the removal registry the sync uses.
const mockRemoval = { fns: new Set<(id: string) => void>() };
const mockConnections = { ids: ['srv'] };
jest.mock('@/stores/session', () => ({
  useSession: {
    getState: () => ({ connections: mockConnections.ids.map((id) => ({ id })) }),
  },
  onConnectionRemoved: (fn: (id: string) => void) => {
    mockRemoval.fns.add(fn);
    return () => mockRemoval.fns.delete(fn);
  },
}));
// A file system of names in a set: enough for `prepareCovers` (the sync itself takes its
// covers injected).
const mockFiles = new Map<string, Uint8Array>();
jest.mock('expo-file-system', () => {
  class Directory {
    uri = 'file:///group';
    exists = true;
    list() {
      return [];
    }
  }
  class File {
    uri: string;
    constructor(dirOrUri: Directory | string, name?: string) {
      this.uri = typeof dirOrUri === 'string' ? dirOrUri : `${dirOrUri.uri}/${name}`;
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    write(bytes: Uint8Array) {
      mockFiles.set(this.uri, bytes);
    }
    bytes() {
      return Promise.resolve(mockFiles.get(this.uri)!);
    }
  }
  return { Directory, File };
});
const mockCoverSizes: { value: boolean | undefined } = { value: undefined };
jest.mock('@/api/hooks', () => ({ cachedCapability: () => mockCoverSizes.value }));
jest.mock('@/api/connection-clients', () => ({
  resolveClient: () => ({
    coverUrl: (_lib: number, _path: string, opts?: { size?: number }) =>
      `https://s/cover?size=${opts?.size}`,
  }),
}));

/* eslint-disable import/first */
import { Directory } from 'expo-file-system';

import type { NowPlaying } from '@/playback/store';
import { useSleepTimer } from '@/playback/sleep-timer';

import type { ContinueListeningProps, SleepTimerActivityProps } from './widget-model';
import { prepareCovers, runWidgetSync, type Covers, type WidgetSyncDeps } from './widget-sync.ios';
/* eslint-enable import/first */

const player = playerStoreMock();
// eslint-disable-next-line import/no-named-as-default-member -- the i18next instance's `t`
const t = i18next.t.bind(i18next) as TFunction;
const KEY = 'srv:1:Book';
let now = 1_700_000_000_000;

const CHAPTERS: Chapter[] = [
  { index: 0, title: 'One', file_index: 0, file_path: 'a', start: 0, end: 600, book_offset: 0 },
  {
    index: 1,
    title: 'Two',
    file_index: 0,
    file_path: 'a',
    start: 600,
    end: 1200,
    book_offset: 600,
  },
];

function loadBook(position = 0, state = 'playing') {
  const np = {
    connectionId: 'srv',
    libraryId: 1,
    path: 'Book',
    title: 'Book',
    author: 'Author',
    cover: '',
    queue: { chapters: CHAPTERS, total: 1200 },
  } as MockNowPlaying;
  player.usePlayer.setState({
    nowPlaying: np,
    bookPosition: position,
    snapshot: { state, trackIndex: 0, position, duration: 1200, rate: 1 },
  });
}

function setTimer(fields: Partial<ReturnType<typeof useSleepTimer.getState>>) {
  useSleepTimer.setState(fields);
}
const IDLE_TIMER = {
  phase: 'idle',
  endsAt: null,
  frozenAt: null,
  pauseAtPosition: null,
  bookKey: null,
} as const;

type Harness = {
  deps: WidgetSyncDeps;
  writes: ContinueListeningProps[];
  started: SleepTimerActivityProps[];
  updates: jest.Mock;
  ends: jest.Mock;
  foreground: { active: boolean; fire: () => void };
  resolveCovers: (c: Covers) => void;
  stale: { end: jest.Mock }[];
};

function harness(opts: { timeline?: ContinueListeningProps[]; startThrows?: boolean } = {}) {
  const writes: ContinueListeningProps[] = [];
  const started: SleepTimerActivityProps[] = [];
  const updates = jest.fn((_p: SleepTimerActivityProps) => Promise.resolve());
  const ends = jest.fn((_policy?: unknown) => Promise.resolve());
  let foregroundFn: (() => void) | null = null;
  const foreground = { active: true, fire: () => foregroundFn?.() };
  let resolveCovers: (c: Covers) => void = () => {};
  const stale = [{ end: jest.fn(() => Promise.resolve()) }];
  const deps: WidgetSyncDeps = {
    widget: {
      updateSnapshot: (p) => writes.push(p),
      getTimeline: () =>
        Promise.resolve((opts.timeline ?? []).map((props) => ({ date: new Date(now), props }))),
    },
    activity: {
      start: (p) => {
        if (opts.startThrows) throw new Error('Live Activities are not supported');
        started.push(p);
        return { update: updates, end: ends } as never;
      },
      getInstances: () => stale as never,
    },
    prepareCovers: () => new Promise<Covers>((r) => (resolveCovers = r)),
    clearCovers: jest.fn(),
    isForeground: () => foreground.active,
    onForeground: (fn) => {
      foregroundFn = fn;
      return () => (foregroundFn = null);
    },
    t: () => t,
    now: () => now,
  };
  const h: Harness = {
    deps,
    writes,
    started,
    updates,
    ends,
    foreground,
    resolveCovers: (c) => resolveCovers(c),
    stale,
  };
  return h;
}

let stop: (() => void) | null = null;
const run = (h: Harness) => {
  stop = runWidgetSync(h.deps);
};
const flush = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
  jest.useFakeTimers();
  player.reset();
  useSleepTimer.setState({ ...IDLE_TIMER, remaining: null, origin: null, label: null });
  mockConnections.ids = ['srv'];
  mockRemoval.fns.clear();
});

afterEach(() => {
  stop?.();
  stop = null;
  jest.useRealTimers();
});

describe('the Continue listening widget', () => {
  it('writes the localized empty state when nothing was ever written', async () => {
    const h = harness();
    run(h);
    await flush();
    expect(h.writes).toEqual([{ emptyText: 'Play a book and it shows up here.' }]);
  });

  it('corrects a book a killed app left "playing"', async () => {
    const left = { title: 'Old', isPlaying: true, connectionId: 'srv' };
    const h = harness({ timeline: [left] });
    run(h);
    await flush();
    expect(h.writes).toEqual([{ ...left, isPlaying: false }]);
  });

  it('writes the book on load, coalesces bursts, and adds the cover once it is ready', async () => {
    const h = harness();
    run(h);
    loadBook(0);
    expect(h.writes.at(-1)).toMatchObject({ title: 'Book', chapterTitle: 'One', isPlaying: true });
    expect('coverFile' in h.writes.at(-1)!).toBe(false);
    const count = h.writes.length;
    // A chapter change inside the burst window waits for the trailing write.
    now += 500;
    player.usePlayer.setState({ bookPosition: 700 });
    expect(h.writes.length).toBe(count);
    now += 1500;
    jest.advanceTimersByTime(1500);
    expect(h.writes.at(-1)).toMatchObject({ chapterTitle: 'Two' });
    // The cover arrives: one more write with it.
    now += 5000;
    h.resolveCovers({ widget: 'file:///g/cover-w.jpg', activity: 'file:///g/cover-a.jpg' });
    await flush();
    expect(h.writes.at(-1)).toMatchObject({ coverFile: 'file:///g/cover-w.jpg' });
  });

  it('keeps the book but stops calling it playing when playback stops', () => {
    const h = harness();
    run(h);
    loadBook(100);
    now += 10_000;
    player.usePlayer.setState({ nowPlaying: null });
    expect(h.writes.at(-1)).toMatchObject({ title: 'Book', isPlaying: false });
  });

  it('skips the progress ticks of steady playback', () => {
    const h = harness();
    run(h);
    loadBook(100);
    const count = h.writes.length;
    for (let i = 1; i <= 10; i++) {
      now += 1000;
      player.usePlayer.setState({ bookPosition: 100 + i });
    }
    jest.advanceTimersByTime(10_000);
    expect(h.writes.length).toBe(count);
  });

  it('clears on sign-out of the book connection, and only that one', () => {
    const h = harness();
    run(h);
    loadBook(100);
    for (const fn of mockRemoval.fns) fn('other');
    expect(h.writes.at(-1)).toMatchObject({ title: 'Book' });
    mockConnections.ids = [];
    for (const fn of mockRemoval.fns) fn('srv');
    expect(h.writes.at(-1)).toEqual({ emptyText: 'Play a book and it shows up here.' });
    expect(h.deps.clearCovers).toHaveBeenCalled();
    // The player's next tick does not write the signed-out book back.
    now += 120_000;
    player.usePlayer.setState({ bookPosition: 300 });
    jest.advanceTimersByTime(5000);
    expect(h.writes.at(-1)).toEqual({ emptyText: 'Play a book and it shows up here.' });
  });
});

describe('the sleep timer Live Activity', () => {
  it('ends the activities a previous process left behind', () => {
    const h = harness();
    run(h);
    expect(h.stale[0].end).toHaveBeenCalledWith('immediate');
  });

  it('starts when a timer counts down in the foreground, with the book and the end', () => {
    const h = harness();
    run(h);
    loadBook(100);
    setTimer({ phase: 'running', endsAt: now + 600_000, bookKey: KEY });
    expect(h.started).toEqual([
      expect.objectContaining({ title: 'Book', chapterTitle: 'One', endsAt: now + 600_000 }),
    ]);
  });

  it('waits for the foreground when the timer was armed in the background', () => {
    const h = harness();
    h.foreground.active = false;
    run(h);
    loadBook(100);
    setTimer({ phase: 'running', endsAt: now + 600_000, bookKey: KEY });
    expect(h.started).toHaveLength(0);
    h.foreground.active = true;
    h.foreground.fire();
    expect(h.started).toHaveLength(1);
  });

  it('updates when the end moves, not for jitter', () => {
    const h = harness();
    run(h);
    loadBook(100);
    setTimer({ phase: 'running', endsAt: now + 600_000, bookKey: KEY });
    setTimer({ remaining: 599 }); // a tick: same end
    expect(h.updates).not.toHaveBeenCalled();
    setTimer({ endsAt: now + 1_800_000 }); // extended
    expect(h.updates).toHaveBeenCalledWith(expect.objectContaining({ endsAt: now + 1_800_000 }));
    setTimer({ frozenAt: now }); // paused
    expect(h.updates).toHaveBeenLastCalledWith(expect.objectContaining({ pausedAt: now }));
  });

  it('follows an end-of-chapter timer through a seek', () => {
    const h = harness();
    run(h);
    loadBook(100);
    setTimer({ phase: 'running', pauseAtPosition: 600, bookKey: KEY });
    expect(h.started[0].endsAt).toBe(now + 500_000);
    player.usePlayer.setState({ bookPosition: 400 });
    expect(h.updates).toHaveBeenLastCalledWith(expect.objectContaining({ endsAt: now + 200_000 }));
  });

  it('ends immediately when the timer fires, and when it is cancelled', () => {
    const h = harness();
    run(h);
    loadBook(100);
    setTimer({ phase: 'running', endsAt: now + 1000, bookKey: KEY });
    setTimer({ phase: 'grace', endsAt: null, graceUntil: now + 30_000 });
    expect(h.ends).toHaveBeenCalledWith('immediate');
    setTimer({ ...IDLE_TIMER, graceUntil: null });
    setTimer({ phase: 'running', endsAt: now + 60_000, bookKey: KEY });
    expect(h.started).toHaveLength(2);
    setTimer({ ...IDLE_TIMER });
    expect(h.ends).toHaveBeenCalledTimes(2);
  });

  it('does not retry a start ActivityKit refused until that timer ends', () => {
    const h = harness({ startThrows: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    run(h);
    loadBook(100);
    setTimer({ phase: 'running', endsAt: now + 60_000, bookKey: KEY });
    setTimer({ endsAt: now + 120_000 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not bring back an activity the listener swiped away', async () => {
    const h = harness();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    run(h);
    loadBook(100);
    setTimer({ phase: 'running', endsAt: now + 600_000, bookKey: KEY });
    h.updates.mockImplementationOnce(() => Promise.reject(new Error('not found')));
    setTimer({ endsAt: now + 1_200_000 });
    await flush();
    setTimer({ endsAt: now + 1_800_000 });
    h.foreground.fire();
    expect(h.started).toHaveLength(1);
    warn.mockRestore();
  });

  it('rebuilds its words only when the chapter or the cover changes, not on a tick', async () => {
    const h = harness();
    const tFor = jest.fn(() => t);
    h.deps.t = tFor;
    run(h);
    loadBook(100);
    setTimer({ phase: 'running', endsAt: now + 600_000, bookKey: KEY });
    expect(h.started).toHaveLength(1);
    tFor.mockClear();
    setTimer({ remaining: 599 }); // a tick: same book, chapter, cover and end
    player.usePlayer.setState({ bookPosition: 110 });
    expect(tFor).not.toHaveBeenCalled();
    expect(h.updates).not.toHaveBeenCalled();
    player.usePlayer.setState({ bookPosition: 700 }); // chapter Two, same end
    expect(h.updates).toHaveBeenLastCalledWith(expect.objectContaining({ chapterTitle: 'Two' }));
    h.resolveCovers({ activity: 'file:///group/a.jpg' });
    await flush();
    expect(h.updates).toHaveBeenLastCalledWith(
      expect.objectContaining({ coverFile: 'file:///group/a.jpg' }),
    );
  });
});

describe('prepareCovers', () => {
  /** A JPEG header (SOI, APP0, SOF0) of a `width` x `height` image. */
  const jpeg = (width: number, height: number) =>
    new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x04,
      0x00,
      0x00,
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      0x03,
      0,
      0,
      0,
      0,
    ]);
  const np = (cover: string) =>
    ({ connectionId: 'srv', libraryId: 1, path: 'Book', cover }) as NowPlaying;
  const fetched: string[] = [];
  const bodies = new Map<string, Uint8Array>();

  beforeEach(() => {
    jest.useRealTimers();
    mockFiles.clear();
    mockCoverSizes.value = undefined;
    fetched.length = 0;
    bodies.clear();
    globalThis.fetch = jest.fn(async (url: string) => {
      fetched.push(url);
      const body = bodies.get(url);
      return {
        ok: !!body,
        arrayBuffer: async () => body!.buffer,
      } as Response;
    }) as unknown as typeof fetch;
  });

  it("writes the server's thumbnails, both at once", async () => {
    bodies.set('https://s/cover?size=320', jpeg(320, 320));
    bodies.set('https://s/cover?size=160', jpeg(160, 160));
    const covers = await prepareCovers(new Directory('x'), np(''));
    expect(covers.widget).toMatch(/^file:\/\/\/group\/cover-[0-9a-f]{8}-w\.jpg$/);
    expect(covers.activity).toMatch(/-a\.jpg$/);
    expect(fetched.sort()).toEqual(['https://s/cover?size=160', 'https://s/cover?size=320']);
  });

  it("reads the player's cover once for both, and skips sizes a server lacks", async () => {
    mockCoverSizes.value = false;
    bodies.set('https://s/full.jpg', jpeg(150, 150));
    const covers = await prepareCovers(new Directory('x'), np('https://s/full.jpg'));
    expect(covers.widget).toBeDefined();
    expect(covers.activity).toBeDefined();
    expect(fetched).toEqual(['https://s/full.jpg']);
  });

  it('leaves out a cover nothing small enough was found for', async () => {
    bodies.set('https://s/cover?size=320', jpeg(320, 320));
    bodies.set('https://s/cover?size=160', jpeg(2000, 2000)); // a size the server ignored
    const covers = await prepareCovers(new Directory('x'), np(''));
    expect(covers.widget).toBeDefined();
    expect(covers).not.toHaveProperty('activity');
  });
});
