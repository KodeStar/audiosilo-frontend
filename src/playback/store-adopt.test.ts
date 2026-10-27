import type { Book, ChaptersResponse } from '@/api/types';

import type { PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

// `adoptLoaded` (Phase 6): the store takes over a book the Android playback service loaded
// itself. Its own file (beside store.test.ts, same harness) so the Phase 6 branches that edit
// the store in parallel don't collide in one test file. Each regression test below fails
// without the change (there is no `adoptLoaded` before it).

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
const INITIAL: PlaybackSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};
const mockSvc = {
  onRemoteSeek: jest.fn(),
  setup: jest.fn(async () => {}),
  configure: jest.fn(async () => {}),
  load: jest.fn(async () => {}),
  play: jest.fn(async () => {}),
  pause: jest.fn(async () => {}),
  seekTo: jest.fn(async () => {}),
  skipToTrack: jest.fn(async () => {}),
  setRate: jest.fn(async () => {}),
  setVolume: jest.fn(async () => {}),
  reset: jest.fn(async () => {}),
  adoptPlace: jest.fn(),
  rememberLoad: jest.fn(),
  isCasting: jest.fn(() => false),
  getSnapshot: jest.fn(() => ({ ...INITIAL })),
  subscribe: jest.fn((listener: (s: PlaybackSnapshot) => void) => {
    pushSnapshot = listener;
    return () => {};
  }),
} as unknown as PlaybackService & {
  adoptPlace: jest.Mock;
  rememberLoad: jest.Mock;
  isCasting: jest.Mock;
};

jest.mock('./service', () => ({ createPlaybackService: () => mockSvc }));

const mockSaveProgress = jest.fn(async (..._args: unknown[]) => {});
jest.mock('./progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  loadInitialProgress: jest.fn(async () => ({ kind: 'empty' })),
  readMirror: jest.fn(async () => null),
}));

const mockFetchQuery = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({}));
// The query cache's listeners (`startChapterRefresh` subscribes one).
const mockCacheListeners = new Set<(event: unknown) => void>();
jest.mock('@/api/provider', () => ({
  queryClient: {
    getQueryCache: () => ({
      getAll: () => [],
      subscribe: (l: (event: unknown) => void) => {
        mockCacheListeners.add(l);
        return () => mockCacheListeners.delete(l);
      },
    }),
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    setQueryDefaults: jest.fn(),
    fetchQuery: (...a: unknown[]) => mockFetchQuery(...a),
    getQueryData: jest.fn(() => undefined),
    cancelQueries: jest.fn(async () => {}),
  },
}));
jest.mock('@/lib/network', () => ({ canAutoDownload: jest.fn(async () => false) }));

const fakeClient = {
  coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
  streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  authHeaders: () => ({ Authorization: 'Bearer x' }),
  addHistory: jest.fn(async () => {}),
};
const mockResolveClient = jest.fn((_cid: string): typeof fakeClient | null => fakeClient);
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockResolveClient(cid),
  sessionReady: jest.fn(() => true),
}));

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { startChapterRefresh, useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import { setConnectionAliases } from '@/lib/connection-id';
import { resetProfilesForTests, switchProfile, useProfiles } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';

import { onPickedUpAgain, usePlayer } from './store';
/* eslint-enable import/first */

function makeBook(p: Partial<Book> = {}): Book {
  return {
    id: 1,
    library_id: 2,
    rel_path: 'A/Book.m4b',
    is_folder: false,
    title: 'A Book',
    author: 'Author',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 100,
    format: 'm4b',
    size: 0,
    ...p,
  };
}

/** A two-file book (100 s each): the second file starts at 100 on the book's timeline. */
const twoFileBook = makeBook({ rel_path: 'B', title: 'B', duration: 200, is_folder: true });
const twoFileChapters: ChaptersResponse = {
  library_id: 2,
  path: 'B',
  duration: 200,
  is_folder: true,
  files: [
    { rel_path: 'B/1.mp3', seq: 0, duration: 100, format: 'mp3', size: 1 },
    { rel_path: 'B/2.mp3', seq: 1, duration: 100, format: 'mp3', size: 1 },
  ],
  chapters: [],
};

function downloadedB(): DownloadEntry {
  return {
    connectionId: 'c1',
    libraryId: 2,
    path: 'B',
    title: 'B',
    status: 'downloaded',
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest: {
      book: twoFileBook,
      chapters: twoFileChapters,
      files: [
        { relPath: 'B/1.mp3', localUri: 'file:///d/1.mp3' },
        { relPath: 'B/2.mp3', localUri: 'file:///d/2.mp3' },
      ],
      coverUri: 'file:///d/cover.jpg',
      savedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

const loadedB = (p: {
  trackIndex?: number;
  position?: number;
  playing?: boolean;
  rate?: number;
}) => ({
  connectionId: 'c1',
  libraryId: 2,
  path: 'B',
  trackIndex: p.trackIndex ?? 1,
  position: p.position ?? 30,
  rate: p.rate ?? 1.5,
  playing: p.playing ?? true,
});

function snap(state: PlaybackState, trackIndex: number, position: number): PlaybackSnapshot {
  return { state, trackIndex, position, duration: 100, rate: 1.5 };
}

async function flushMicrotasks(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

const savedPaths = () => mockSaveProgress.mock.calls.map((c) => (c[1] as { path: string }).path);

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  useSettings.setState({ autoDownloadNext: 'never' });
  usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL }, rate: 1, loadingBook: null });
  useDownloads.setState({ entries: {} });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('adoptLoaded', () => {
  it('finding 5: switching profiles invalidates an adoption awaiting its source', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    useProfiles.setState({
      hydrated: true,
      activeProfileId: 'alice',
      profiles: [
        { id: 'alice', name: 'Alice', connectionIds: ['c1'] },
        { id: 'bob', name: 'Bob', connectionIds: ['c9'] },
      ],
    });
    try {
      const adopting = usePlayer.getState().adoptLoaded(loadedB({}));
      await switchProfile('bob');
      expect(await adopting).toBe(false);
      expect(mockSvc.adoptPlace).not.toHaveBeenCalled();
      expect(usePlayer.getState().nowPlaying).toBeNull();
      expect(mockSaveProgress).not.toHaveBeenCalled();
    } finally {
      resetProfilesForTests();
    }
  });

  // Decision 7 regression (Phase 8): `mayActFor` inside the adoption, which both the
  // Android car path and a Cast session resumed with a receiver's book go through.
  it("never adopts another person's book (an old car play spec, a receiver's book after a switch)", async () => {
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      useProfiles.setState({
        hydrated: true,
        profiles: [
          { id: 'sam', name: 'Sam', connectionIds: ['c9'] },
          { id: 'alex', name: 'Alex', connectionIds: ['c1'], hasPin: true },
        ],
        activeProfileId: 'sam',
      });
      expect(await usePlayer.getState().adoptLoaded(loadedB({ playing: true }))).toBe(false);
      expect(usePlayer.getState().nowPlaying).toBeNull();
      useProfiles.setState({ activeProfileId: null });
      expect(await usePlayer.getState().adoptLoaded(loadedB({ playing: true }))).toBe(false);
      // Once they are the one listening, theirs is adopted.
      useProfiles.setState({ activeProfileId: 'alex' });
      expect(await usePlayer.getState().adoptLoaded(loadedB({ playing: false }))).toBe(true);
      expect(usePlayer.getState().nowPlaying?.connectionId).toBe('c1');
    } finally {
      resetProfilesForTests();
    }
  });

  it("asks for another device's newer place before its first save when the book plays", async () => {
    // The engine's place was never checked against the server: a car start plays the place
    // its snapshot was built with, and the tablet may have played on since.
    const order: string[] = [];
    const stop = onPickedUpAgain(() => order.push('picked-up'));
    mockSaveProgress.mockImplementation(async () => {
      order.push('save');
    });
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
      pushSnapshot(snap('playing', 1, 45));
      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      expect(order[0]).toBe('picked-up');
      expect(order.filter((o) => o === 'picked-up')).toHaveLength(1);
    } finally {
      stop();
      mockSaveProgress.mockImplementation(async () => {});
    }
  });

  it('counts a paused adopted book as picked up again on its next play', async () => {
    const picked = jest.fn();
    const stop = onPickedUpAgain(picked);
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
      expect(picked).not.toHaveBeenCalled();
      // A play seconds later still asks: how long the book had been paused is unknown.
      jest.advanceTimersByTime(5_000);
      pushSnapshot(snap('playing', 1, 30));
      expect(picked).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('stands back while a start is on its way (it switches the book after its lookup)', async () => {
    const progressSync = jest.requireMock('./progress-sync') as {
      loadInitialProgress: jest.Mock;
    };
    let answer!: (r: { kind: 'empty' }) => void;
    progressSync.loadInitialProgress.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    // The listener (or the car) starts Y, whose resume lookup is still out...
    const starting = usePlayer.getState().playBook('c1', 2, makeBook({ rel_path: 'Y' }));
    await flushMicrotasks();
    // ...when the service's own book is offered for adoption: Y's start stands.
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    expect(await usePlayer.getState().adoptLoaded(loadedB({}))).toBe(false);
    answer({ kind: 'empty' });
    await starting;
    expect(usePlayer.getState().nowPlaying?.path).toBe('Y');
  });

  it('sends a speed outside the range back to the engine, clamped', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ rate: 3 }));
    expect(usePlayer.getState().rate).toBe(2);
    expect(mockSvc.setRate).toHaveBeenCalledWith(2);
  });

  it('takes the book over WITHOUT reloading the engine', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    const adopted = await usePlayer.getState().adoptLoaded(loadedB({}));
    expect(adopted).toBe(true);
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(mockSvc.play).not.toHaveBeenCalled();
    expect(mockSvc.seekTo).not.toHaveBeenCalled();
    expect(mockSvc.skipToTrack).not.toHaveBeenCalled();
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    const { nowPlaying, rate, snapshot } = usePlayer.getState();
    // Built as playBook builds a downloaded book: its local files and cover.
    expect(nowPlaying).toMatchObject({ connectionId: 'c1', libraryId: 2, path: 'B', title: 'B' });
    expect(nowPlaying!.cover).toBe('file:///d/cover.jpg');
    expect(nowPlaying!.queue.tracks.map((t) => t.url)).toEqual([
      'file:///d/1.mp3',
      'file:///d/2.mp3',
    ]);
    expect(nowPlaying!.queue.offsets).toEqual([0, 100]);
    expect(rate).toBe(1.5);
    expect(snapshot).toMatchObject({ state: 'playing', trackIndex: 1, position: 30, rate: 1.5 });
    // The bridge is told where the engine is, so its next tick maps onto the right file.
    expect(mockSvc.adoptPlace).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'playing', trackIndex: 1, position: 30 }),
    );
  });

  // The service plays B in its download's order after a JS restart; the server has since
  // re-ordered B's files (v2.4.0's natural order). Its answer landing before the adoption must
  // not move the order the adoption maps the engine's track index through.
  it('maps the engine onto the download order a re-ordered server answer left alone', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    const stop = startChapterRefresh();
    const reordered: ChaptersResponse = {
      ...twoFileChapters,
      files: [...twoFileChapters.files].reverse().map((f, seq) => ({ ...f, seq })),
    };
    for (const l of mockCacheListeners) {
      l({
        type: 'updated',
        query: { queryKey: qk.chapters('c1', 2, 'B') },
        action: { type: 'success', data: reordered },
      });
    }
    stop();
    expect(useDownloads.getState().entries['c1:2:B'].manifest.chapters).toBe(twoFileChapters);

    await usePlayer.getState().adoptLoaded(loadedB({ trackIndex: 1, position: 30 }));
    const { nowPlaying } = usePlayer.getState();
    expect(nowPlaying!.queue.tracks.map((t) => t.url)).toEqual([
      'file:///d/1.mp3',
      'file:///d/2.mp3',
    ]);
    pushSnapshot(snap('playing', 1, 45));
    jest.advanceTimersByTime(15_000); // one save tick
    await flushMicrotasks();
    // Track 1 is B/2.mp3, the second 100 s of the download's timeline.
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 145 });
  });

  it("saves the next time under the adopted book's path, at the engine's place", async () => {
    // Another book was loaded and playing in the app.
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 10);
    pushSnapshot(snap('playing', 0, 20));
    mockSaveProgress.mockClear();

    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ trackIndex: 1, position: 30 }));
    pushSnapshot(snap('playing', 1, 45));
    jest.advanceTimersByTime(15_000); // one save tick
    await flushMicrotasks();

    expect(savedPaths()).toEqual(['B']);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({
      connectionId: 'c1',
      libraryId: 2,
      path: 'B',
      position: 145,
      duration: 200,
      playback_speed: 1.5,
    });
  });

  it('sets the resume floor to the adopted place', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer
      .getState()
      .adoptLoaded(loadedB({ trackIndex: 1, position: 45, playing: false }));
    expect(usePlayer.getState().snapshot.state).toBe('paused');

    // A stray low place (a slipped restart at file 0) is far below the floor: not saved.
    pushSnapshot(snap('playing', 0, 10));
    jest.advanceTimersByTime(15_000);
    await flushMicrotasks();
    expect(mockSaveProgress).not.toHaveBeenCalled();

    // Within the floor's tolerance it saves (the floor is 145, not 0 and not the end).
    pushSnapshot(snap('playing', 1, 40));
    jest.advanceTimersByTime(15_000);
    await flushMicrotasks();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 140 });
  });

  it('a paused adoption saves nothing until the book plays', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(mockSaveProgress).not.toHaveBeenCalled();
  });

  it('reads a streaming book through the query cache', async () => {
    mockFetchQuery.mockImplementation(async (opts: unknown) => {
      const key = (opts as { queryKey: unknown[] }).queryKey;
      return key[0] === 'item' ? twoFileBook : twoFileChapters;
    });
    const adopted = await usePlayer.getState().adoptLoaded(loadedB({}));
    expect(adopted).toBe(true);
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying!.queue.tracks.map((t) => t.url)).toEqual([
      'stream:2:B/1.mp3',
      'stream:2:B/2.mp3',
    ]);
    mockFetchQuery.mockReset();
    mockFetchQuery.mockImplementation(async () => ({}));
  });

  it('gives up, changing nothing, when another book starts while it reads', async () => {
    const answers: (() => void)[] = [];
    mockFetchQuery.mockImplementation(
      (opts: unknown) =>
        new Promise((resolve) => {
          const key = (opts as { queryKey: unknown[] }).queryKey;
          answers.push(() => resolve(key[0] === 'item' ? twoFileBook : twoFileChapters));
        }),
    );
    const adopting = usePlayer.getState().adoptLoaded(loadedB({}));
    // The listener starts another book meanwhile (as playBook sets it).
    usePlayer.setState({
      nowPlaying: {
        connectionId: 'c1',
        libraryId: 2,
        path: 'X',
        title: 'X',
        author: '',
        cover: '',
        queue: {
          tracks: [],
          offsets: [],
          total: 0,
          chapters: [],
          chapterClips: [],
          syntheticChapters: false,
        },
      },
    });
    await flushMicrotasks(); // the reads are asked (`fetchFailFast` first drops a held one)
    expect(answers).toHaveLength(2);
    for (const answer of answers) answer();
    expect(await adopting).toBe(false);
    expect(usePlayer.getState().nowPlaying!.path).toBe('X');
    expect(mockSvc.adoptPlace).not.toHaveBeenCalled();
    mockFetchQuery.mockReset();
    mockFetchQuery.mockImplementation(async () => ({}));
  });

  // The engine's volume is sticky: a sleep-timer fade cut off by the switch (or by a JS
  // restart, which also forgets `outputVolume`) would leave the adopted book quiet.
  it('restores full output gain once the adopted book is loaded', async () => {
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 10);
    await usePlayer.getState().setOutputVolume(0.3); // a fade under way
    const setVolume = mockSvc.setVolume as jest.Mock;
    setVolume.mockClear();
    const pathAtRestore: (string | undefined)[] = [];
    setVolume.mockImplementation(async () => {
      pathAtRestore.push(usePlayer.getState().nowPlaying?.path);
    });

    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({}));
    expect(setVolume.mock.calls).toEqual([[1]]);
    // After the swap, so the old book's fade ticker can't write over it.
    expect(pathAtRestore).toEqual(['B']);

    // The remembered gain is 1 again: the next fade step reaches the engine.
    await usePlayer.getState().setOutputVolume(0.3);
    expect(setVolume).toHaveBeenLastCalledWith(0.3);
    setVolume.mockImplementation(async () => {});
  });

  it("drops the previous book's stall timer", async () => {
    // A start that never reaches `playing` has the stall watchdog armed.
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 10);
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    jest.advanceTimersByTime(10_000);
    expect(usePlayer.getState().snapshot.state).toBe('paused');
  });

  // Phase 8: a play spec from a car snapshot written before the identity migration names the
  // old connection id. Fails without the alias in `adoptLoadedBook`: the store would hold the
  // book under the old id (its download not found, its saves filed under a dead id).
  it('adopts a book the service names by an old connection id under the new one', async () => {
    setConnectionAliases({ c0: 'c1' });
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      expect(await usePlayer.getState().adoptLoaded({ ...loadedB({}), connectionId: 'c0' })).toBe(
        true,
      );
      const { nowPlaying } = usePlayer.getState();
      expect(nowPlaying).toMatchObject({ connectionId: 'c1', libraryId: 2, path: 'B' });
      // Its download, found under the new id.
      expect(nowPlaying!.queue.tracks.map((t) => t.url)).toEqual([
        'file:///d/1.mp3',
        'file:///d/2.mp3',
      ]);
      expect(mockResolveClient).not.toHaveBeenCalledWith('c0');
    } finally {
      setConnectionAliases({});
    }
  });

  it('gives up when the book is neither downloaded nor on a signed-in server', async () => {
    mockResolveClient.mockReturnValue(null);
    expect(await usePlayer.getState().adoptLoaded(loadedB({}))).toBe(false);
    expect(usePlayer.getState().nowPlaying).toBeNull();
    mockResolveClient.mockReturnValue(fakeClient);
  });
});

describe('a start racing a stop, a cast or a download (Phase 8 review)', () => {
  afterEach(() => {
    resetProfilesForTests();
    mockSvc.isCasting.mockImplementation(() => false);
    (mockSvc.load as jest.Mock).mockImplementation(async () => {});
    mockSaveProgress.mockImplementation(async () => {});
  });

  it("gives the route the adopted book's queue (a cast started later hands it over)", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({}));
    expect(mockSvc.rememberLoad).toHaveBeenCalledWith(
      expect.objectContaining({
        book: { connectionId: 'c1', libraryId: 2, path: 'B' },
        tracks: [
          expect.objectContaining({ url: 'file:///d/1.mp3' }),
          expect.objectContaining({ url: 'file:///d/2.mp3' }),
        ],
      }),
    );
  });

  it("a download landing while casting doesn't reload the receiver; the route keeps the copy", async () => {
    await usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 50);
    pushSnapshot(snap('playing', 0, 50));
    (mockSvc.load as jest.Mock).mockClear();
    mockSvc.isCasting.mockImplementation(() => true);
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await flushMicrotasks(20);
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(mockSvc.rememberLoad).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tracks: [
          expect.objectContaining({ url: 'file:///d/1.mp3' }),
          expect.objectContaining({ url: 'file:///d/2.mp3' }),
        ],
      }),
    );
    // The store plays the local copy from here (it comes back to the phone with it).
    expect(usePlayer.getState().nowPlaying!.queue.tracks[0].url).toBe('file:///d/1.mp3');
  });

  it("a switch of person while a new book loads never saves the previous book's place under it", async () => {
    useProfiles.setState({
      hydrated: true,
      activeProfileId: 'alice',
      profiles: [
        { id: 'alice', name: 'Alice', connectionIds: ['c1'] },
        { id: 'bob', name: 'Bob', connectionIds: ['c9'] },
      ],
    });
    // Alice is deep into book A...
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 10);
    pushSnapshot(snap('playing', 0, 3100));
    jest.advanceTimersByTime(15_000);
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    // ...and starts B, whose load is on its way (a receiver's load takes seconds).
    let land!: () => void;
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const starting = usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 0);
    await flushMicrotasks(20);
    expect(usePlayer.getState().loadingBook).toBe('c1:2:B');
    await switchProfile('bob');
    land();
    await starting;
    expect(savedPaths()).not.toContain('B');
  });

  it('a start whose load fails leaves no book "loading" behind (saves and moves go on)', async () => {
    (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('No session'); // the Cast session ended mid-load
    });
    await expect(
      usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 0),
    ).rejects.toThrow('No session');
    expect(usePlayer.getState().loadingBook).toBeNull();
  });

  it('a start another start overtook while it loaded neither sets its speed nor plays', async () => {
    let landFirst!: () => void;
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          landFirst = resolve;
        }),
    );
    const first = usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 0, undefined, 1.75);
    await flushMicrotasks(20);
    await usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 0); // a second tap
    (mockSvc.setRate as jest.Mock).mockClear();
    (mockSvc.play as jest.Mock).mockClear();
    landFirst();
    await first;
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    expect(mockSvc.play).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying?.path).toBe('B');
  });

  it("a stop still saving never cuts off a book started meanwhile (a switch's route starts it)", async () => {
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 10);
    pushSnapshot(snap('playing', 0, 40));
    let saved!: () => void;
    mockSaveProgress.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    (mockSvc.reset as jest.Mock).mockClear();
    const stopping = usePlayer.getState().stop();
    await flushMicrotasks();
    // The new person's book starts while the old place is still being saved.
    await usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 0);
    saved();
    await stopping;
    expect(mockSvc.reset).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying?.path).toBe('B');
  });
});
