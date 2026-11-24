import type { Book, ChaptersResponse } from '@/api/types';

import type { BookRef, PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

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
/** Android's word that the engine was asked to play (`onPlayAsked`). */
let playAsked: (() => void) | null = null;
/** The engine's word of a move made outside the app (`onRemoteMove`) and of a speed the OS
 * set (`onRateChange`). */
let remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
let rateChange: ((rate: number) => void) | null = null;
/** The route switch's word of a load it made itself (`onOwnLoad`). */
let ownLoad: ((trackIndex: number, position: number, loaded: Promise<unknown>) => void) | null =
  null;
/** The route switch's ask for the loaded book's place as a Cast session begins
 * (`onLoadedPlace`). */
let loadedPlace: (() => PlaybackSnapshot | null) | null = null;
/** The book the engine's last report named (`reportedBook`); null: it named none. */
let engineBook: BookRef | null = null;
const mockSvc = {
  reportedBook: jest.fn(() => engineBook),
  onRemoteSeek: jest.fn(),
  onPlayAsked: jest.fn((handler: (() => void) | null) => {
    playAsked = handler;
  }),
  onRemoteMove: jest.fn((handler: typeof remoteMove) => {
    remoteMove = handler;
  }),
  onRateChange: jest.fn((handler: typeof rateChange) => {
    rateChange = handler;
  }),
  onOwnLoad: jest.fn((handler: typeof ownLoad) => {
    ownLoad = handler;
  }),
  onLoadedPlace: jest.fn((handler: typeof loadedPlace) => {
    loadedPlace = handler;
  }),
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
/** This device's own record between two saves (`placeLoop`: the mirror, every 15 s). */
const mockWriteMirror = jest.fn(async (..._args: unknown[]) => {});
jest.mock('./progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  writeMirror: (...args: unknown[]) => mockWriteMirror(...args),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  loadInitialProgress: jest.fn(async () => ({ kind: 'empty' })),
  readMirror: jest.fn(async () => null),
  guardSettled: () => false,
}));

const mockFetchQuery = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({}));
// The query cache's listeners (`startChapterRefresh` subscribes one).
const mockCacheListeners = new Set<(event: unknown) => void>();
jest.mock('@/api/provider', () => ({
  queryClient: {
    getQueryCache: () => ({
      subscribe: (l: (event: unknown) => void) => {
        mockCacheListeners.add(l);
        return () => mockCacheListeners.delete(l);
      },
    }),
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    setQueryDefaults: jest.fn(),
    fetchQuery: (...a: unknown[]) => mockFetchQuery(...a),
    // A server without listening_sync (the PUT path), unless a test says otherwise.
    getQueryData: jest.fn((k: readonly unknown[]) =>
      k?.[0] === 'server' ? { capabilities: {} } : undefined,
    ),
    cancelQueries: jest.fn(async () => {}),
  },
}));
jest.mock('@/lib/network', () => ({ canAutoDownload: jest.fn(async () => false) }));
/** The device's network (`isDeviceOnline`): online unless a test says otherwise. */
const mockDeviceOnline = jest.fn((): boolean | undefined => true);
const mockFirstNetwork = jest.fn<Promise<boolean | undefined>, []>();
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  isDeviceOnline: () => mockDeviceOnline(),
  waitForDeviceOnline: () => mockFirstNetwork(),
}));

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
import { useReachability } from '@/api/reachability';
import { startChapterRefresh, useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import { setConnectionAliases } from '@/lib/connection-id';
import { resetProfilesForTests, switchProfile, useProfiles } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';

import {
  engineOtherBook,
  engineOtherBookPlays,
  FAULT_HOLD_MS,
  landingOf,
  onOtherBookPlays,
  onOtherBookReported,
  onPartialDownloadEnd,
  onPickedUpAgain,
  resumeOtherBook,
  usePlayer,
} from './store';
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

/** The save loop's pace for a book this device holds, as every adopted one here is
 * (`saveIntervalMs`); a streamed book saves every 15 s. */
const LOCAL_SAVE_MS = 60_000;

function snap(state: PlaybackState, trackIndex: number, position: number): PlaybackSnapshot {
  return { state, trackIndex, position, duration: 100, rate: 1.5 };
}

/** Enough turns for a start's resume to reach its lookup past the launch's span recovery
 * (`spanRecovered`). */
async function flushMicrotasks(turns = 12) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** The books (their paths) anything was saved under: the saves, and this device's own
 * record between them. */
const savedPaths = () => [
  ...new Set([
    ...mockSaveProgress.mock.calls.map((c) => (c[1] as { path: string }).path),
    ...mockWriteMirror.mock.calls.map((c) => (c[0] as { path: string }).path),
  ]),
];
/** Nothing was saved, and nothing written to this device's own record either: every guard
 * that holds a save holds the mirror's capture between two saves too. */
function expectNothingSaved() {
  expect(mockSaveProgress).not.toHaveBeenCalled();
  expect(mockWriteMirror).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  engineBook = null;
  useSettings.setState({ autoDownloadNext: 'never' });
  usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL }, rate: 1, loadingBook: null });
  useDownloads.setState({ entries: {} });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  mockDeviceOnline.mockReturnValue(true);
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
      expectNothingSaved();
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
      jest.advanceTimersByTime(LOCAL_SAVE_MS);
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
    jest.advanceTimersByTime(LOCAL_SAVE_MS); // one save tick
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
    jest.advanceTimersByTime(LOCAL_SAVE_MS); // one save tick
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
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await flushMicrotasks();
    expectNothingSaved();

    // Within the floor's tolerance it saves (the floor is 145, not 0 and not the end).
    pushSnapshot(snap('playing', 1, 40));
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await flushMicrotasks();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 140 });
  });

  it('a paused adoption saves nothing until the book plays', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expectNothingSaved();
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

  it('streams with the token of a re-pair made while the book was read', async () => {
    const repaired = {
      ...fakeClient,
      coverUrl: (lib: number, path: string) => `cover:${lib}:${path}?token=new`,
      streamUrl: (lib: number, path: string) => `stream:${lib}:${path}?token=new`,
    };
    mockFetchQuery.mockImplementation(async (opts: unknown) => {
      const key = (opts as { queryKey: unknown[] }).queryKey;
      mockResolveClient.mockReturnValue(repaired);
      return key[0] === 'item' ? twoFileBook : twoFileChapters;
    });
    try {
      expect(await usePlayer.getState().adoptLoaded(loadedB({}))).toBe(true);
      const np = usePlayer.getState().nowPlaying!;
      expect(np.queue.tracks.map((t) => t.url)).toEqual([
        'stream:2:B/1.mp3?token=new',
        'stream:2:B/2.mp3?token=new',
      ]);
      expect(np.cover).toBe('cover:2:B?token=new');
    } finally {
      mockResolveClient.mockReturnValue(fakeClient);
      mockFetchQuery.mockReset();
      mockFetchQuery.mockImplementation(async () => ({}));
    }
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
          audio: 0,
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

  // fe#134: Android's JS restarted while a start's load ran, so the service may play the
  // server's new file order while the download keeps its own. B's files are 100 s (B/1) and
  // 60 s (B/2) here, so a track index read through the wrong order lands somewhere else.
  describe("the engine's own file order (fe#134)", () => {
    const uneven: ChaptersResponse = {
      ...twoFileChapters,
      duration: 160,
      files: [
        { rel_path: 'B/1.mp3', seq: 0, duration: 100, format: 'mp3', size: 1 },
        { rel_path: 'B/2.mp3', seq: 1, duration: 60, format: 'mp3', size: 1 },
      ],
    };
    /** The server's natural order: B/2 first. */
    const serverOrder: ChaptersResponse = {
      ...uneven,
      files: [
        { ...uneven.files[1], seq: 0 },
        { ...uneven.files[0], seq: 1 },
      ],
    };
    const downloadedUneven = (): DownloadEntry => {
      const e = downloadedB();
      return {
        ...e,
        manifest: { ...e.manifest, book: { ...twoFileBook, duration: 160 }, chapters: uneven },
      };
    };
    const engine = (files: string[], p: Parameters<typeof loadedB>[0]) => ({
      ...loadedB(p),
      files,
    });
    /** The server's chapters answer (the item is never asked: the download holds it). */
    const serverAnswers = (chapters: ChaptersResponse | Error) =>
      mockFetchQuery.mockImplementation(async (opts: unknown) => {
        const key = (opts as { queryKey: unknown[] }).queryKey;
        if (key[0] !== 'chapters') throw new Error(`unexpected ${String(key[0])}`);
        if (chapters instanceof Error) throw chapters;
        return chapters;
      });
    const saveTick = async () => {
      jest.advanceTimersByTime(LOCAL_SAVE_MS);
      await flushMicrotasks();
    };
    /** Until `mock` was called: the first adoption of a run also creates the service, which
     * takes more turns than a later one. */
    const untilCalled = async (mock: jest.Mock) => {
      for (let i = 0; i < 200 && mock.mock.calls.length === 0; i++) await Promise.resolve();
    };
    /** A load that lands only when `land` is called. */
    const heldLoad = () => {
      const held = { land: () => {} };
      (mockSvc.load as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            held.land = resolve;
          }),
      );
      return held;
    };

    afterEach(() => {
      mockFetchQuery.mockReset();
      mockFetchQuery.mockImplementation(async () => ({}));
      mockResolveClient.mockReturnValue(fakeClient);
    });

    it('changes nothing when the service reports no order (iOS, Cast, older binaries)', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      await usePlayer.getState().adoptLoaded(loadedB({ trackIndex: 1, position: 30 }));
      expect(mockFetchQuery).not.toHaveBeenCalled();
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 30 });
    });

    it("changes nothing when the service plays the download's own order", async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3'], { trackIndex: 1, position: 30 }));
      expect(mockFetchQuery).not.toHaveBeenCalled();
      expect(mockSvc.load).not.toHaveBeenCalled();
      pushSnapshot(snap('playing', 1, 45));
      await saveTick();
      expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 145 });
    });

    it("takes the server's chapters in the engine's order, with no reload", async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(serverOrder);
      // The engine plays B/2 (60 s) then B/1 (100 s): index 0, 30 s in, is B/2.
      const adopted = await usePlayer
        .getState()
        .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
      expect(adopted).toBe(true);
      expect(mockSvc.load).not.toHaveBeenCalled();
      // Asked afresh: a cached copy can be the download's own (`seedQueryCache`).
      expect(mockFetchQuery.mock.calls[0][0]).toMatchObject({ staleTime: 0 });
      const { nowPlaying, snapshot } = usePlayer.getState();
      expect(nowPlaying!.queue.tracks.map((t) => t.url)).toEqual([
        'file:///d/2.mp3',
        'file:///d/1.mp3',
      ]);
      expect(snapshot).toMatchObject({ state: 'playing', trackIndex: 0, position: 30 });
      // The download keeps that order for the next start (`adoptStartedChapters`).
      expect(useDownloads.getState().entries['c1:2:B'].manifest.chapters).toBe(serverOrder);
      // A later tick counts in the engine's order: index 1 is B/1, after B/2's 60 s.
      pushSnapshot(snap('playing', 1, 45));
      await saveTick();
      expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 105 });
    });

    it("reloads in the download's order at the same file and in-file place when the server can't answer", async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      let during: { loadingBook: string | null } | null = null;
      (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
        during = { loadingBook: usePlayer.getState().loadingBook };
      });
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
      // B/2 is index 1 in the download's order, still 30 s in.
      expect(mockSvc.load).toHaveBeenCalledTimes(1);
      const [tracks, index, inFile] = (mockSvc.load as jest.Mock).mock.calls[0];
      expect((tracks as { url: string }[]).map((t) => t.url)).toEqual([
        'file:///d/1.mp3',
        'file:///d/2.mp3',
      ]);
      expect([index, inFile]).toEqual([1, 30]);
      // Saves and remote moves were held while it loaded; the play state is kept.
      expect(during).toEqual({ loadingBook: 'c1:2:B' });
      expect(usePlayer.getState().loadingBook).toBeNull();
      expect(mockSvc.setRate).toHaveBeenCalledWith(1.5);
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
      expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 30 });

      // The resume floor moved with it (100 + 30): a stray low place is refused...
      pushSnapshot(snap('playing', 0, 10));
      await saveTick();
      expectNothingSaved();
      // ...and a later tick maps through the download's order: B/2 after B/1's 100 s.
      pushSnapshot(snap('playing', 1, 45));
      await saveTick();
      expect(mockSaveProgress).toHaveBeenCalledTimes(1);
      expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 145 });
    });

    it('reloads a paused one offline without playing it or saving its place until it plays', async () => {
      mockResolveClient.mockReturnValue(null); // no connection: the server can't be asked
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      const picked = jest.fn();
      const stop = onPickedUpAgain(picked);
      try {
        await usePlayer
          .getState()
          .adoptLoaded(
            engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30, playing: false }),
          );
        expect(mockFetchQuery).not.toHaveBeenCalled();
        expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 30]);
        expect(mockSvc.play).not.toHaveBeenCalled();
        // Paused again once loaded: an engine that ended or failed still wants to play, and
        // Android's load keeps that.
        expect((mockSvc.pause as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
          (mockSvc.load as jest.Mock).mock.invocationCallOrder[0],
        );
        mockResolveClient.mockReturnValue(fakeClient); // back online: saves could go out
        // The paused load reports `ready` then `paused`: neither saves the place.
        pushSnapshot(snap('ready', 1, 30));
        pushSnapshot(snap('paused', 1, 30));
        await saveTick();
        expectNothingSaved();
        // Its next play is a pick-up, then it saves on the download's timeline.
        pushSnapshot(snap('playing', 1, 31));
        expect(picked).toHaveBeenCalledTimes(1);
        await saveTick();
        expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 131 });
      } finally {
        stop();
      }
    });

    it('saves nothing of a paused reload whose engine reports playing during its load', async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      const held = heldLoad();
      const adopting = usePlayer
        .getState()
        .adoptLoaded(
          engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30, playing: false }),
        );
      await untilCalled(mockSvc.load as jest.Mock);
      // Android's load keeps playWhenReady from an engine that ended: it plays by itself.
      pushSnapshot(snap('playing', 1, 30));
      held.land();
      expect(await adopting).toBe(true);
      expect(mockSvc.pause).toHaveBeenCalled();
      mockResolveClient.mockReturnValue(fakeClient); // back online: saves could go out
      // The adoption's pause lands: the engine's unchecked place is still not saved.
      pushSnapshot(snap('paused', 1, 31));
      await saveTick();
      expectNothingSaved();
    });

    it('saves a playing reload once its own play stands after the engine played during its load', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      const held = heldLoad();
      const adopting = usePlayer
        .getState()
        .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
      await untilCalled(mockSvc.load as jest.Mock);
      pushSnapshot(snap('playing', 1, 30));
      held.land();
      expect(await adopting).toBe(true);
      // Still playing, with no transition after the load: its later ticks save.
      pushSnapshot(snap('playing', 1, 35));
      await saveTick();
      expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 135 });
    });

    it("reloads when the server's chapters are in another order than the engine's", async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(uneven); // the download's own order, not the engine's
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 1, position: 50 }));
      // B/1 is index 0 in the download's order.
      expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([0, 50]);
      expect(useDownloads.getState().entries['c1:2:B'].manifest.chapters).toBe(uneven);
    });

    it("streams the server's files the download lacks when they are the engine's, with no reload", async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      // The lost start streamed the server's other files (B/1, B/2 of 100 s, then B/3, which
      // the download lacks): the download can't take those chapters, so the queue is built
      // from them as that start built it, and the engine plays on in B/3.
      const added: ChaptersResponse = {
        ...uneven,
        duration: 180,
        files: [
          ...uneven.files,
          { rel_path: 'B/3.mp3', seq: 2, duration: 20, format: 'mp3', size: 1 },
        ],
      };
      serverAnswers(added);
      expect(
        await usePlayer
          .getState()
          .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 2, position: 10 })),
      ).toBe(true);
      expect(mockSvc.load).not.toHaveBeenCalled();
      const { nowPlaying, snapshot } = usePlayer.getState();
      expect(nowPlaying!.queue.tracks.map((t) => t.url)).toEqual([
        'file:///d/1.mp3',
        'file:///d/2.mp3',
        'stream:2:B/3.mp3',
      ]);
      expect(snapshot).toMatchObject({ state: 'playing', trackIndex: 2, position: 10 });
      expect(useDownloads.getState().entries['c1:2:B'].manifest.chapters).toBe(uneven);
      // A later tick counts on that timeline: B/3 after 100 + 60.
      pushSnapshot(snap('playing', 2, 15));
      await saveTick();
      expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 175 });
    });

    it('lands a file the download lacks at the same whole-book seconds when the server is not there', async () => {
      mockResolveClient.mockReturnValue(null); // no connection: the server can't be asked
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      // The engine plays B/1 (100 s, the download has it) then B/9, which it lacks: 10 s into
      // B/9 is 110 s on the engine's timeline, B/2 at 10 s in the download's.
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/1.mp3', 'B/9.mp3'], { trackIndex: 1, position: 10 }));
      expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 10]);
      mockResolveClient.mockReturnValue(fakeClient); // back online: saves could go out
      // The resume floor is that place (110): a place more than a minute below is refused...
      pushSnapshot(snap('playing', 0, 40));
      await saveTick();
      expectNothingSaved();
      // ...and one at it saves.
      pushSnapshot(snap('playing', 1, 12));
      await saveTick();
      expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 112 });
    });

    it("stays paused at the downloaded part's end, with the notice, when the place is past it (D3, fe#185)", async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      const told = jest.fn();
      const stopTelling = onPartialDownloadEnd(told);
      // 20 s into B/3, which the download lacks, is 180 s: past its 160.
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 2, position: 20 }));
      // Short of the last 5 s (`FINISHED_TOLERANCE`): 154 s is B/2 at 54, paused there.
      expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 54]);
      expect(mockSvc.play).not.toHaveBeenCalled();
      expect(mockSvc.pause).toHaveBeenCalled();
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', trackIndex: 1 });
      expect(told).toHaveBeenCalledTimes(1);
      mockResolveClient.mockReturnValue(fakeClient);
      jest.advanceTimersByTime(3_000);
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('paused');
      expectNothingSaved();
      stopTelling();
    });

    it('tells of a stop past the downloaded part once someone listens (a car start with no screen)', async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      // Nobody to tell: the root's services have not started.
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 2, position: 20 }));
      expect(usePlayer.getState().snapshot.state).toBe('paused');
      const told = jest.fn();
      const stopTelling = onPartialDownloadEnd(told);
      expect(told).toHaveBeenCalledTimes(1);
      stopTelling();
      // Told once: a later listener hears nothing of it.
      const again = jest.fn();
      onPartialDownloadEnd(again)();
      expect(again).not.toHaveBeenCalled();
    });

    it('pauses at the end of a download that lacks the rest of the book, never finishing it (D3, fe#185)', async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      const told = jest.fn();
      const stopTelling = onPartialDownloadEnd(told);
      // Offline in B/2, which the download holds, of an engine order that ends with B/3: the
      // download's queue ends after B/2, short of the book.
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 1, position: 30 }));
      // The download keeps that it ends early, for a later start of it.
      expect(useDownloads.getState().entries['c1:2:B'].manifest.endsBefore).toBe('B/3.mp3');
      mockResolveClient.mockReturnValue(fakeClient);
      mockDeviceOnline.mockReturnValue(false); // still offline at the end
      pushSnapshot(snap('playing', 1, 50));
      await flushMicrotasks();
      expect(told).not.toHaveBeenCalled();
      // The engine reaches the queue's end: a pause there with the notice, not the book's end.
      pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('paused');
      expect(told).toHaveBeenCalledTimes(1);
      const saves = mockSaveProgress.mock.calls.map((c) => c[1] as { finished: boolean });
      expect(saves.length).toBeGreaterThan(0);
      expect(saves.every((save) => !save.finished)).toBe(true);
      // Each says it was taken in a queue ending early, for a span recovered past it.
      expect(saves.every((save) => (save as { partial?: true }).partial)).toBe(true);
      stopTelling();
    });

    it("keeps a download's early end through an adoption of its own order (a cold offline Resume, then a JS restart)", async () => {
      mockResolveClient.mockReturnValue(null);
      const e = downloadedUneven();
      useDownloads.setState({
        entries: { 'c1:2:B': { ...e, manifest: { ...e.manifest, endsBefore: 'B/3.mp3' } } },
      });
      const told = jest.fn();
      const stopTelling = onPartialDownloadEnd(told);
      // The engine plays the download's own copy (B/1, B/2): it says nothing of the book's end.
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3'], { trackIndex: 1, position: 30 }));
      expect(useDownloads.getState().entries['c1:2:B'].manifest.endsBefore).toBe('B/3.mp3');
      mockResolveClient.mockReturnValue(fakeClient);
      mockDeviceOnline.mockReturnValue(false); // still offline at the end
      pushSnapshot(snap('playing', 1, 50));
      await flushMicrotasks();
      pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('paused');
      expect(told).toHaveBeenCalledTimes(1);
      const saves = mockSaveProgress.mock.calls.map((c) => c[1] as { finished: boolean });
      expect(saves.every((save) => !save.finished)).toBe(true);
      stopTelling();
    });

    it("finishes a download that lacks only an earlier file at the book's real end (D3, fe#185)", async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      const told = jest.fn();
      const stopTelling = onPartialDownloadEnd(told);
      // Offline in B/1 of an engine order that starts with B/3 (an intro the download lacks)
      // and ends with B/2, which it holds: the download's end is the book's.
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/3.mp3', 'B/1.mp3', 'B/2.mp3'], { trackIndex: 1, position: 30 }));
      expect(useDownloads.getState().entries['c1:2:B'].manifest.endsBefore).toBeUndefined();
      mockResolveClient.mockReturnValue(fakeClient);
      // B/1 plays to its end, then B/2 (an engine never leaves a file it was put in the middle
      // of without playing on from there: `engineFault`).
      pushSnapshot(snap('playing', 0, 100));
      pushSnapshot(snap('playing', 1, 50));
      await flushMicrotasks();
      pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('ended');
      expect(told).not.toHaveBeenCalled();
      const saves = mockSaveProgress.mock.calls.map((c) => c[1] as { finished: boolean });
      expect(saves.some((save) => save.finished)).toBe(true);
      stopTelling();
    });

    it('pauses a cold offline start of a download that ends before its book, never finishing it (D3, fe#185)', async () => {
      mockResolveClient.mockReturnValue(null);
      const e = downloadedUneven();
      useDownloads.setState({
        entries: { 'c1:2:B': { ...e, manifest: { ...e.manifest, endsBefore: 'B/3.mp3' } } },
      });
      // The place the pause left: the end of the downloaded part (160 s), not finished.
      const progressSync = jest.requireMock('./progress-sync') as {
        loadInitialProgress: jest.Mock;
      };
      progressSync.loadInitialProgress.mockResolvedValueOnce({
        kind: 'progress',
        progress: { position: 158, duration: 160, finished: false, playback_speed: 1, version: 0 },
      });
      const told = jest.fn();
      const stopTelling = onPartialDownloadEnd(told);
      const { manifest } = useDownloads.getState().entries['c1:2:B'];
      await usePlayer.getState().playBook('c1', 2, manifest.book, manifest.chapters ?? undefined);
      expect(usePlayer.getState().nowPlaying?.queue.tracks).toHaveLength(2);
      pushSnapshot(snap('playing', 1, 58));
      await flushMicrotasks();
      pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('paused');
      expect(told).toHaveBeenCalledTimes(1);
      const finished = [...mockSaveProgress.mock.calls, ...mockWriteMirror.mock.calls].some(
        (c) => (c[c.length === 1 ? 0 : 1] as { finished?: boolean }).finished,
      );
      expect(finished).toBe(false);
      stopTelling();
      await usePlayer.getState().pause();
    });

    describe("a cold start given the server's cached chapters, which name the file the download lacks", () => {
      /** The server's answer the cache kept: the book goes on in B/3 (20 s). */
      const withB3: ChaptersResponse = {
        ...uneven,
        duration: 180,
        files: [
          ...uneven.files,
          { rel_path: 'B/3.mp3', seq: 2, duration: 20, format: 'mp3', size: 1 },
        ],
      };
      const startCold = async () => {
        const e = downloadedUneven();
        useDownloads.setState({
          entries: { 'c1:2:B': { ...e, manifest: { ...e.manifest, endsBefore: 'B/3.mp3' } } },
        });
        const progressSync = jest.requireMock('./progress-sync') as {
          loadInitialProgress: jest.Mock;
        };
        progressSync.loadInitialProgress.mockResolvedValueOnce({
          kind: 'progress',
          progress: {
            position: 150,
            duration: 180,
            finished: false,
            playback_speed: 1,
            version: 0,
          },
        });
        const { manifest } = useDownloads.getState().entries['c1:2:B'];
        await usePlayer.getState().playBook('c1', 2, { ...manifest.book, duration: 180 }, withB3);
      };
      afterEach(() => mockDeviceOnline.mockReturnValue(true));

      it('waits for the first network reading before choosing files for a cold resume', async () => {
        mockDeviceOnline.mockReturnValue(undefined);
        let answer!: (online: boolean) => void;
        mockFirstNetwork.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        const start = startCold();
        await flushMicrotasks();
        expect(mockFirstNetwork).toHaveBeenCalled();
        answer(false);
        await start;
        expect(usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url)).toEqual([
          'file:///d/1.mp3',
          'file:///d/2.mp3',
        ]);
        await usePlayer.getState().pause();
      });

      it("offline, plays the download's own copy and pauses at its end, never finishing (D3, fe#185)", async () => {
        mockDeviceOnline.mockReturnValue(false);
        const told = jest.fn();
        const stopTelling = onPartialDownloadEnd(told);
        await startCold();
        // No stream of B/3 to stall on at the downloaded part's end.
        expect(usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url)).toEqual([
          'file:///d/1.mp3',
          'file:///d/2.mp3',
        ]);
        pushSnapshot(snap('playing', 1, 58));
        await flushMicrotasks();
        pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
        await flushMicrotasks();
        expect(usePlayer.getState().snapshot.state).toBe('paused');
        expect(told).toHaveBeenCalledTimes(1);
        const finished = [...mockSaveProgress.mock.calls, ...mockWriteMirror.mock.calls].some(
          (c) => (c[c.length === 1 ? 0 : 1] as { finished?: boolean }).finished,
        );
        expect(finished).toBe(false);
        stopTelling();
        await usePlayer.getState().pause();
      });

      it("with the device online but the server unreachable, plays the download's own copy", async () => {
        useReachability.setState({ online: { c1: false } });
        try {
          await startCold();
          expect(usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url)).toEqual([
            'file:///d/1.mp3',
            'file:///d/2.mp3',
          ]);
          await usePlayer.getState().pause();
        } finally {
          useReachability.setState({ online: {} });
        }
      });

      it('online, streams the rest of the book on', async () => {
        await startCold();
        expect(usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url)).toEqual([
          'file:///d/1.mp3',
          'file:///d/2.mp3',
          'stream:2:B/3.mp3',
        ]);
        await usePlayer.getState().pause();
      });
    });

    it("finishes a cold offline start of a download that holds its book's end", async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      const progressSync = jest.requireMock('./progress-sync') as {
        loadInitialProgress: jest.Mock;
      };
      progressSync.loadInitialProgress.mockResolvedValueOnce({
        kind: 'progress',
        progress: { position: 158, duration: 160, finished: false, playback_speed: 1, version: 0 },
      });
      const { manifest } = useDownloads.getState().entries['c1:2:B'];
      await usePlayer.getState().playBook('c1', 2, manifest.book, manifest.chapters ?? undefined);
      pushSnapshot(snap('playing', 1, 58));
      await flushMicrotasks();
      pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('ended');
    });

    // Owner (Pixel 6a, iPhone): back online in the same session, Play at that end showed the
    // notice again and stayed; only a relaunch streamed on (D3: online it streams on).
    describe('online again at that end', () => {
      /** The server's book goes on in B/3 (20 s), which the download lacks. */
      const withB3: ChaptersResponse = {
        ...uneven,
        duration: 180,
        files: [
          ...uneven.files,
          { rel_path: 'B/3.mp3', seq: 2, duration: 20, format: 'mp3', size: 1 },
        ],
      };
      /** Adopted offline at B/2, of an engine order ending with B/3, then at its end. */
      const atPartialEnd = async () => {
        mockResolveClient.mockReturnValue(null);
        useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
        await usePlayer
          .getState()
          .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 1, position: 30 }));
        mockDeviceOnline.mockReturnValue(false);
        pushSnapshot(snap('playing', 1, 50));
        pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
        await flushMicrotasks();
        expect(usePlayer.getState().snapshot.state).toBe('paused');
        // The network back.
        mockResolveClient.mockReturnValue(fakeClient);
        mockDeviceOnline.mockReturnValue(true);
        (mockSvc.load as jest.Mock).mockClear();
      };

      it("Play streams on from the downloaded part's end, with the server's chapters", async () => {
        const told = jest.fn();
        const stopTelling = onPartialDownloadEnd(told);
        await atPartialEnd();
        expect(told).toHaveBeenCalledTimes(1);
        serverAnswers(withB3);
        await usePlayer.getState().toggle();
        await flushMicrotasks();
        expect(told).toHaveBeenCalledTimes(1);
        const queue = usePlayer.getState().nowPlaying?.queue;
        expect(queue?.tracks.map((t) => t.url)).toEqual([
          'file:///d/1.mp3',
          'file:///d/2.mp3',
          'stream:2:B/3.mp3',
        ]);
        // At the start of B/3: 100 + 60 s in.
        expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([2, 0]);
        stopTelling();
        await usePlayer.getState().pause();
      });

      it('tells again and stays when the server does not answer', async () => {
        const told = jest.fn();
        const stopTelling = onPartialDownloadEnd(told);
        await atPartialEnd();
        serverAnswers(new TypeError('Network request failed'));
        await usePlayer.getState().toggle();
        expect(told).toHaveBeenCalledTimes(2);
        expect(mockSvc.load).not.toHaveBeenCalled();
        expect(usePlayer.getState().snapshot.state).toBe('paused');
        stopTelling();
      });

      it('a pause on the spinner while it asks stands: nothing starts when the answer lands', async () => {
        const told = jest.fn();
        const stopTelling = onPartialDownloadEnd(told);
        await atPartialEnd();
        let answer: (c: ChaptersResponse) => void = () => undefined;
        mockFetchQuery.mockImplementation(
          () => new Promise<ChaptersResponse>((resolve) => (answer = resolve)),
        );
        const pressed = usePlayer.getState().toggle();
        await flushMicrotasks();
        expect(usePlayer.getState().snapshot.state).toBe('loading');
        await usePlayer.getState().toggle();
        answer(withB3);
        await pressed;
        await flushMicrotasks();
        expect(mockSvc.load).not.toHaveBeenCalled();
        expect(usePlayer.getState().snapshot.state).toBe('paused');
        expect(told).toHaveBeenCalledTimes(1);
        stopTelling();
      });

      it('plays on by itself when the engine reaches that end online', async () => {
        const told = jest.fn();
        const stopTelling = onPartialDownloadEnd(told);
        mockResolveClient.mockReturnValue(null);
        useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
        await usePlayer
          .getState()
          .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 1, position: 30 }));
        // The network came back while it played.
        mockResolveClient.mockReturnValue(fakeClient);
        serverAnswers(withB3);
        (mockSvc.load as jest.Mock).mockClear();
        pushSnapshot(snap('playing', 1, 50));
        pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
        await untilCalled(mockSvc.load as jest.Mock);
        expect(told).not.toHaveBeenCalled();
        expect(usePlayer.getState().nowPlaying?.queue.tracks).toHaveLength(3);
        stopTelling();
        await usePlayer.getState().pause();
      });
    });

    it('tells again, with no play attempt, when Play is pressed at that end', async () => {
      jest.useFakeTimers();
      try {
        mockResolveClient.mockReturnValue(null);
        useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
        const told = jest.fn();
        const stopTelling = onPartialDownloadEnd(told);
        await usePlayer
          .getState()
          .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 1, position: 30 }));
        pushSnapshot(snap('playing', 1, 50));
        pushSnapshot({ ...snap('ended', 1, 60), duration: 60 });
        expect(told).toHaveBeenCalledTimes(1);
        (mockSvc.play as jest.Mock).mockClear();
        // The engine, ended, plays nothing: an attempt would sit until the stall watchdog
        // called it an error.
        await usePlayer.getState().toggle();
        expect(mockSvc.play).not.toHaveBeenCalled();
        expect(told).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(60_000);
        expect(usePlayer.getState().snapshot.state).toBe('paused');
        // Moved back from the end, the engine reports another state: Play plays again.
        pushSnapshot(snap('paused', 1, 20));
        await usePlayer.getState().toggle();
        expect(mockSvc.play).toHaveBeenCalledTimes(1);
        expect(told).toHaveBeenCalledTimes(2);
        stopTelling();
      } finally {
        await usePlayer.getState().pause();
        jest.useRealTimers();
      }
    });

    it("streams on, online, in a file the download lacks when the server's order is another (D3, fe#185)", async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      // The server holds B/3 too, first now; the engine played it last.
      serverAnswers({
        ...uneven,
        duration: 180,
        files: [
          { rel_path: 'B/3.mp3', seq: 0, duration: 20, format: 'mp3', size: 1 },
          { ...uneven.files[0], seq: 1 },
          { ...uneven.files[1], seq: 2 },
        ],
      });
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 2, position: 10 }));
      const [tracks, index, inFile] = (mockSvc.load as jest.Mock).mock.calls[0];
      expect((tracks as { url: string }[]).map((t) => t.url)).toEqual([
        'stream:2:B/3.mp3',
        'file:///d/1.mp3',
        'file:///d/2.mp3',
      ]);
      expect([index, inFile]).toEqual([0, 10]);
      expect(mockSvc.play).toHaveBeenCalled();
      // The download keeps its own chapters: it doesn't hold B/3.
      expect(useDownloads.getState().entries['c1:2:B'].manifest.chapters).toBe(uneven);
    });

    it('streams on, online, past the downloaded part when the engine is in a file the download holds', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      const told = jest.fn();
      const stopTelling = onPartialDownloadEnd(told);
      // The server holds B/3 too, first now; the engine, in its old order, plays B/1.
      serverAnswers({
        ...uneven,
        duration: 180,
        files: [
          { rel_path: 'B/3.mp3', seq: 0, duration: 20, format: 'mp3', size: 1 },
          { ...uneven.files[0], seq: 1 },
          { ...uneven.files[1], seq: 2 },
        ],
      });
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/1.mp3', 'B/2.mp3', 'B/3.mp3'], { trackIndex: 0, position: 10 }));
      // The whole book, the server's: B/3 streams, and the engine goes on in B/1.
      const [tracks, index, inFile] = (mockSvc.load as jest.Mock).mock.calls[0];
      expect((tracks as { url: string }[]).map((t) => t.url)).toEqual([
        'stream:2:B/3.mp3',
        'file:///d/1.mp3',
        'file:///d/2.mp3',
      ]);
      expect([index, inFile]).toEqual([1, 10]);
      // Its end is the book's: no pause there with "the rest isn't downloaded".
      pushSnapshot(snap('playing', 1, 100));
      pushSnapshot(snap('playing', 2, 50));
      pushSnapshot({ ...snap('ended', 2, 60), duration: 60 });
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('ended');
      expect(told).not.toHaveBeenCalled();
      stopTelling();
    });

    it('lands a missing file on the first tied track, including when no duration is known', () => {
      const queue = { tracks: [{ id: '2:a' }, { id: '2:b' }], offsets: [0, 0], total: 0 };
      const at = { trackIndex: 1, position: 20 };
      expect(landingOf(queue as never, ['2:x', '2:y'], at, new Map())).toEqual({
        index: 0,
        positionInTrack: 20,
        beyond: false,
      });
      expect(landingOf(queue as never, ['2:x', '2:y'], at, new Map([['2:x', 30]]))).toMatchObject({
        index: 0,
        positionInTrack: 50,
      });
      expect(landingOf(queue as never, ['2:x', '2:b'], at, new Map())).toMatchObject({
        index: 1,
        positionInTrack: 20,
      });
    });

    it("keeps the engine's in-file place within the landing file's length (fe#185)", () => {
      const queue = {
        tracks: [{ duration: 100 }, { duration: 60 }],
        offsets: [0, 100],
        total: 160,
      };
      const ids = (files: string[]) => files.map((f) => `2:${f}`);
      // B/0's length is known nowhere: index 1 (B/2, 60 s) at the engine's 50 s stands...
      expect(
        landingOf(
          queue as never,
          ids(['B/0.mp3', 'B/9.mp3']),
          { trackIndex: 1, position: 50 },
          new Map(),
        ),
      ).toEqual({ index: 1, positionInTrack: 50, beyond: false });
      // ...90 s into the engine's file is past B/2's 60 s and the queue's end: short of it.
      expect(
        landingOf(
          queue as never,
          ids(['B/0.mp3', 'B/9.mp3']),
          { trackIndex: 1, position: 90 },
          new Map(),
        ),
      ).toEqual({ index: 1, positionInTrack: 54, beyond: true });
      // An index past the queue's files: its last file.
      expect(
        landingOf(
          { ...queue, tracks: [{ duration: 100 }, { duration: 0 }] } as never,
          ids(['B/0.mp3', 'B/8.mp3', 'B/9.mp3']),
          { trackIndex: 2, position: 500 },
          new Map(),
        ),
      ).toMatchObject({ index: 1 });
    });

    it("lands at the engine's file index when an earlier file's length is not known", async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      // Neither file is the download's (renamed since), and B/0's length is known nowhere: the
      // whole-book seconds can't be read, so it is the engine's index at the same place.
      await usePlayer
        .getState()
        .adoptLoaded(engine(['B/0.mp3', 'B/9.mp3'], { trackIndex: 1, position: 10 }));
      expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 10]);
    });

    it('gives the engine back to a stop made while the reload ran', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      const held = heldLoad();
      const adopting = usePlayer
        .getState()
        .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
      await untilCalled(mockSvc.load as jest.Mock);
      expect(usePlayer.getState().loadingBook).toBe('c1:2:B');
      usePlayer.setState({ nowPlaying: null, loadingBook: null }); // a stop took the store
      held.land();
      await adopting;
      expect(mockSvc.play).not.toHaveBeenCalled();
      expect(mockSvc.reset).toHaveBeenCalled();
    });

    it('keeps a pause made while the reload ran', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      const held = heldLoad();
      const adopting = usePlayer
        .getState()
        .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
      await untilCalled(mockSvc.load as jest.Mock);
      expect(usePlayer.getState().snapshot.state).toBe('loading');
      await usePlayer.getState().pause(); // the spinner's tap, the sleep timer
      held.land();
      expect(await adopting).toBe(true);
      expect(mockSvc.play).not.toHaveBeenCalled();
    });

    it('runs the pick-up check once the reload lands when the engine plays during its load', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      // The place reconcile skips while a load holds the store: a check told then is lost.
      const heldWhenTold: (string | null)[] = [];
      const stop = onPickedUpAgain(() => heldWhenTold.push(usePlayer.getState().loadingBook));
      try {
        const held = heldLoad();
        const adopting = usePlayer
          .getState()
          .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
        await untilCalled(mockSvc.load as jest.Mock);
        // Android's load keeps playWhenReady: the engine reports `playing` before it returns.
        pushSnapshot(snap('playing', 1, 30));
        expect(heldWhenTold).toEqual([]);
        held.land();
        expect(await adopting).toBe(true);
        expect(heldWhenTold).toEqual([null]);
      } finally {
        stop();
      }
    });

    it('checks on the next play when the reload lands with the book no longer playing', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      const picked = jest.fn();
      const stop = onPickedUpAgain(picked);
      try {
        const held = heldLoad();
        const adopting = usePlayer
          .getState()
          .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
        await untilCalled(mockSvc.load as jest.Mock);
        pushSnapshot(snap('playing', 1, 30));
        pushSnapshot(snap('paused', 1, 31)); // paused before the load returned
        held.land();
        await adopting;
        expect(picked).not.toHaveBeenCalled();
        pushSnapshot(snap('playing', 1, 31));
        expect(picked).toHaveBeenCalledTimes(1);
      } finally {
        stop();
      }
    });

    it("keeps a play pressed while a paused one's reload ran", async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      const held = heldLoad();
      const adopting = usePlayer
        .getState()
        .adoptLoaded(
          engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30, playing: false }),
        );
      await untilCalled(mockSvc.load as jest.Mock);
      expect(usePlayer.getState().snapshot.state).toBe('paused');
      await usePlayer.getState().toggle(); // the play button, while the load is out
      held.land();
      expect(await adopting).toBe(true);
      expect(mockSvc.pause).not.toHaveBeenCalled();
      expect(Math.max(...(mockSvc.play as jest.Mock).mock.invocationCallOrder)).toBeGreaterThan(
        (mockSvc.load as jest.Mock).mock.invocationCallOrder[0],
      );
    });

    it("leaves a same-book start's hold to that start's own load", async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      const reloadLoad = heldLoad();
      const adopting = usePlayer
        .getState()
        .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
      await untilCalled(mockSvc.load as jest.Mock);
      // A chapter tap starts the same book while the reload's load is out.
      const startLoad = heldLoad();
      const starting = usePlayer
        .getState()
        .playBook('c1', 2, { ...twoFileBook, duration: 160 }, uneven, 130);
      let heldMeanwhile: string | null = null;
      try {
        for (let i = 0; i < 200 && (mockSvc.load as jest.Mock).mock.calls.length < 2; i++) {
          await Promise.resolve();
        }
        expect(mockSvc.load).toHaveBeenCalledTimes(2);
        reloadLoad.land();
        await adopting;
        heldMeanwhile = usePlayer.getState().loadingBook;
      } finally {
        // Landed whatever happened: a start left out would hold every later adoption back.
        startLoad.land();
        await starting;
      }
      // The start's load had not landed: its book's place was still not the engine's.
      expect(heldMeanwhile).toBe('c1:2:B');
      expect(usePlayer.getState().loadingBook).toBeNull();
    });

    it("doesn't reload while casting (the receiver streams the book)", async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      mockSvc.isCasting.mockImplementation(() => true);
      try {
        expect(
          await usePlayer
            .getState()
            .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 })),
        ).toBe(true);
        expect(mockSvc.load).not.toHaveBeenCalled();
        expect(usePlayer.getState().loadingBook).toBeNull();
      } finally {
        mockSvc.isCasting.mockImplementation(() => false);
      }
    });

    it('shows an error when the reload fails', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(new TypeError('Network request failed'));
      (mockSvc.load as jest.Mock).mockRejectedValueOnce(new Error('no player'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(
          await usePlayer
            .getState()
            .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 })),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
      expect(usePlayer.getState()).toMatchObject({ loadingBook: null });
      expect(usePlayer.getState().snapshot.state).toBe('error');
      expect(mockSvc.play).not.toHaveBeenCalled();
    });

    it("holds a reloaded place through the download hot-swap's new book object, until a move", async () => {
      mockResolveClient.mockReturnValue(null);
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      await usePlayer
        .getState()
        .adoptLoaded(
          engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30, playing: false }),
        );
      mockResolveClient.mockReturnValue(fakeClient);
      // The hot-swap commits the same book as a new object; its load reports `ready`, `paused`.
      const np = usePlayer.getState().nowPlaying!;
      usePlayer.setState({ nowPlaying: { ...np } });
      pushSnapshot(snap('ready', 1, 30));
      pushSnapshot(snap('paused', 1, 30));
      await saveTick();
      expectNothingSaved();
      // The listener's own move is a new place: it saves.
      await usePlayer.getState().seekBook(120);
      await flushMicrotasks();
      expect(savedPaths()).toEqual(['B']);
    });

    it('waits at most 3 s for the server, then reloads', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      mockFetchQuery.mockImplementation(() => new Promise(() => {})); // a server that hangs
      const adopting = usePlayer
        .getState()
        .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }));
      await untilCalled(mockFetchQuery);
      await flushMicrotasks();
      expect(mockSvc.load).not.toHaveBeenCalled();
      jest.advanceTimersByTime(3_000);
      expect(await adopting).toBe(true);
      expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 30]);
    });

    it('adopts the place, play state and speed the engine has once the book is read', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(serverOrder);
      // Paused and moved on into B/1 (index 1) at 1x while the server was asked.
      const reread = jest.fn(async () =>
        engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 1, position: 5, playing: false, rate: 1 }),
      );
      expect(
        await usePlayer
          .getState()
          .adoptLoaded(engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }), reread),
      ).toBe(true);
      expect(reread).toHaveBeenCalledTimes(1);
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(usePlayer.getState()).toMatchObject({
        rate: 1,
        snapshot: { state: 'paused', trackIndex: 1, position: 5 },
      });
      expect(mockSvc.adoptPlace).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'paused', trackIndex: 1, position: 5 }),
      );
    });

    it('adopts nothing once the engine plays another order or book', async () => {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedUneven() } });
      serverAnswers(serverOrder);
      const again = engine(['B/1.mp3', 'B/2.mp3'], { trackIndex: 0, position: 30 });
      expect(
        await usePlayer
          .getState()
          .adoptLoaded(
            engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }),
            async () => again,
          ),
      ).toBe(false);
      expect(
        await usePlayer
          .getState()
          .adoptLoaded(
            engine(['B/2.mp3', 'B/1.mp3'], { trackIndex: 0, position: 30 }),
            async () => null,
          ),
      ).toBe(false);
      expect(usePlayer.getState().nowPlaying).toBeNull();
      expect(mockSvc.adoptPlace).not.toHaveBeenCalled();
      expect(mockSvc.load).not.toHaveBeenCalled();
    });
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

// The review: after "Playback stopped", the car, a headset or a resumption started another
// book in the engine. The store followed that play as a press of its own book, and its stall
// watchdog paused the other book when it took longer than the grace to start (its adoption
// reads the book first). It is the asked play of the book adopted.
describe('a play asked from outside of another book after playback stopped', () => {
  const book = makeBook({ rel_path: 'S', title: 'S' });
  const chapters: ChaptersResponse = {
    library_id: 2,
    path: 'S',
    duration: 100,
    is_folder: false,
    files: [{ rel_path: 'S', seq: 0, duration: 100, format: 'm4b', size: 1 }],
    chapters: [],
  };
  const loadedS = {
    connectionId: 'c1',
    libraryId: 2,
    path: 'S',
    trackIndex: 0,
    position: 5,
    rate: 1,
    playing: true,
  };

  /** B adopted paused (at `at`, else its second file, 30 s), then stopped (`error`); the
   * engine asked to play S, still loading; S's adoption under way, its book still being read.
   * Returns the read's answer. `reread`: the car sync's read of the engine as it lands.
   * `heard`: the place of the engine's unnamed `loading` report before the adoption began
   * (B's own unless a test says S's). */
  async function askedForS(
    at: { trackIndex: number; position: number } = { trackIndex: 1, position: 30 },
    reread?: () => Promise<ReturnType<typeof loadedB> | null>,
    heard: { trackIndex: number; position: number } = at,
  ): Promise<() => Promise<boolean>> {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false, ...at }));
    const { snapshot } = usePlayer.getState();
    usePlayer.setState({ snapshot: { ...snapshot, state: 'error' } });
    jest.clearAllMocks();
    playAsked?.();
    pushSnapshot(snap('loading', heard.trackIndex, heard.position));
    const answers: (() => void)[] = [];
    mockFetchQuery.mockImplementation(
      (opts: unknown) =>
        new Promise((resolve) => {
          const key = (opts as { queryKey: unknown[] }).queryKey;
          answers.push(() => resolve(key[0] === 'item' ? book : chapters));
        }),
    );
    (mockSvc.getSnapshot as jest.Mock).mockReturnValueOnce(snap('loading', 0, 5));
    const adopting = usePlayer.getState().adoptLoaded(loadedS, reread);
    await flushMicrotasks();
    return async () => {
      for (const answer of answers) answer();
      return adopting;
    };
  }

  afterEach(() => {
    mockFetchQuery.mockReset();
    mockFetchQuery.mockImplementation(async () => ({}));
  });

  // FE-ANDROID-4 (c): an older binary names no book. The app's Pause during the adoption ended
  // the followed play, and S's paused report was then taken, and saved, as B's place.
  it("never takes an unnamed report as the store's book's after a Pause during the adoption", async () => {
    const read = await askedForS();
    expect(engineBook).toBeNull();
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'paused', trackIndex: 1, position: 30 },
    });
    pushSnapshot(snap('paused', 0, 7));
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await flushMicrotasks();
    expectNothingSaved();
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 30 });
    // The adoption lands: S's reports are its own from here, and B was never saved.
    expect(await read()).toBe(true);
    expect(usePlayer.getState().nowPlaying?.path).toBe('S');
    pushSnapshot(snap('paused', 0, 8));
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 0, position: 8 });
    expect(savedPaths()).not.toContain('B');
  });

  // An unnamed move and speed of the engine after that Pause are S's too, as its reports are:
  // never B's move or speed, and a move of B's is never asked of the engine (it would move S).
  it("holds an unnamed move and speed of the engine as the adopted book's after a Pause", async () => {
    const read = await askedForS();
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    remoteMove?.(0, 60);
    rateChange?.(2);
    await flushMicrotasks();
    expect(usePlayer.getState().rate).toBe(1.5);
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await flushMicrotasks();
    expectNothingSaved();
    await usePlayer.getState().seekBook(150);
    await usePlayer.getState().setRate(2);
    await flushMicrotasks();
    expect(mockSvc.seekTo).not.toHaveBeenCalled();
    expect(mockSvc.skipToTrack).not.toHaveBeenCalled();
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    expect(savedPaths()).toEqual(['B']);
    expect(await read()).toBe(true);
    expect(usePlayer.getState().nowPlaying?.path).toBe('S');
  });

  // A play press after that Pause reloads B, as with a report naming S: never a resume of
  // the engine's S as B's press, and B's reports, naming none, are its own from that load on
  // (S's adoption gives up), so its play is heard and the watchdog leaves it.
  it("reloads the store's book on a play press after a Pause, its unnamed reports its own", async () => {
    const read = await askedForS(undefined, async () => loadedB({}));
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    jest.clearAllMocks();
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'playing', trackIndex: 1, position: 31 },
    });
    expect(await read()).toBe(false);
    jest.advanceTimersByTime(5_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  // With no book in the store (a Cast session resumed with none loaded, on the web too) there
  // is no place of the store's to keep an unnamed report from: it is taken as before.
  it('takes an unnamed report as before while a book is adopted into a store holding none', async () => {
    const answers: (() => void)[] = [];
    mockFetchQuery.mockImplementation(
      (opts: unknown) =>
        new Promise((resolve) => {
          const key = (opts as { queryKey: unknown[] }).queryKey;
          answers.push(() => resolve(key[0] === 'item' ? book : chapters));
        }),
    );
    const adopting = usePlayer.getState().adoptLoaded(loadedS);
    await flushMicrotasks();
    expect(usePlayer.getState().nowPlaying).toBeNull();
    pushSnapshot(snap('playing', 0, 6));
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 6 });
    for (const answer of answers) answer();
    expect(await adopting).toBe(true);
    expect(usePlayer.getState().nowPlaying?.path).toBe('S');
  });

  // An adoption that gives up once another landed meanwhile leaves no hold on the book that
  // one adopted: the engine holds that book, and its unnamed reports are its own.
  it('holds nothing of a book adopted while an earlier adoption was under way', async () => {
    const answers: (() => void)[] = [];
    mockFetchQuery.mockImplementation(
      (opts: unknown) =>
        new Promise((resolve) => {
          const key = (opts as { queryKey: unknown[] }).queryKey;
          answers.push(() => resolve(key[0] === 'item' ? book : chapters));
        }),
    );
    const adoptingS = usePlayer.getState().adoptLoaded(loadedS);
    await flushMicrotasks();
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    expect(await usePlayer.getState().adoptLoaded(loadedB({ playing: false }))).toBe(true);
    for (const answer of answers) answer();
    expect(await adoptingS).toBe(false);
    expect(usePlayer.getState().nowPlaying?.path).toBe('B');
    pushSnapshot(snap('paused', 1, 40));
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 40 });
  });

  // The car sync's read of the engine can answer before that reload lands in it, still naming
  // S: the adoption gives up all the same, as the engine holds B once the load lands (taken, S
  // would be the store's book with B's unnamed reports saved as its place).
  it("gives up once the store's book is reloaded, though its read still named the engine's", async () => {
    const read = await askedForS(undefined, async () => loadedS);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect(await read()).toBe(false);
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'playing', trackIndex: 1, position: 31 },
    });
  });

  // FE-ANDROID-5: the adoption gave up (the engine read again holds nothing it names) with the
  // play still followed, and the app's Pause in the watchdog's grace ended that play: the
  // engine's unnamed reports, still S's, were then taken, and saved, as B's place.
  it("holds an unnamed other book's reports after its adoption gave up and a Pause", async () => {
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    expect(usePlayer.getState().nowPlaying?.path).toBe('B');
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'paused',
      trackIndex: 1,
      position: 30,
    });
    pushSnapshot(snap('paused', 1, 80));
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await flushMicrotasks();
    // The car plays S on: still none of B's.
    pushSnapshot(snap('playing', 1, 81));
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await flushMicrotasks();
    expectNothingSaved();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'paused',
      trackIndex: 1,
      position: 30,
    });
    // A stop saves nothing of S as B's either.
    await usePlayer.getState().stop();
    expectNothingSaved();
  });

  // The listener's own move of B during that hold is B's, saved; never asked of the engine,
  // which holds S.
  it("saves the store's book's own move made during that hold", async () => {
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    await usePlayer.getState().seekBook(150);
    await flushMicrotasks();
    expect(mockSvc.seekTo).not.toHaveBeenCalled();
    expect(mockSvc.skipToTrack).not.toHaveBeenCalled();
    expect(savedPaths()).toEqual(['B']);
  });

  // That hold ends once a report names a book again (the store's own here): its reports are
  // B's from there, saved as such.
  it('takes the reports again once one names the store’s book after that hold', async () => {
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
    pushSnapshot(snap('paused', 1, 40));
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 40 });
    engineBook = null;
    pushSnapshot(snap('paused', 1, 41));
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 41 });
  });

  // Also when that report names the other book: a later one that names none (a queue loaded
  // without a book, a Cast receiver) is not held for it again.
  it('holds no unnamed report again after one named the other book during that hold', async () => {
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'S' };
    pushSnapshot(snap('playing', 1, 80));
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 30 });
    engineBook = null;
    pushSnapshot(snap('paused', 1, 41));
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 41 });
  });

  // And once the store loads its own book (a play press reloads it): its unnamed reports are
  // its own, its play heard.
  it("takes the store's book's unnamed reports once a play press reloaded it after that hold", async () => {
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    jest.clearAllMocks();
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'playing', trackIndex: 1, position: 31 },
    });
  });

  // The engine's unnamed `loading` report of S, heard before S's adoption began, was taken as
  // B's place. B stands where it was when the play was asked from the moment the adoption
  // begins: the listener's speed change, which lifts the hold on B's saves, saved S's place
  // as B's, during the adoption and after a Pause in the watchdog's grace alike (a place past
  // B's own: one well before it the resume floor refused, the speed going unsaved).
  it("saves the store's book where it stood on a speed change after a Pause, never the other book's place", async () => {
    const read = await askedForS(undefined, async () => null, { trackIndex: 1, position: 80 });
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 30 });
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'paused',
      trackIndex: 1,
      position: 30,
    });
    expectNothingSaved();
    await usePlayer.getState().setRate(2);
    await flushMicrotasks();
    expect(savedPaths()).toEqual(['B']);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 130 });
  });

  it("saves the store's book where it stood on a speed change during the adoption", async () => {
    const read = await askedForS(undefined, undefined, { trackIndex: 1, position: 80 });
    await usePlayer.getState().setRate(2);
    await flushMicrotasks();
    expect(savedPaths()).toEqual(['B']);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 130 });
    expect(await read()).toBe(true);
  });

  // A play press after that Pause reloads B where it stood, never at S's place.
  it("reloads the store's book where it stood on a play press after a Pause", async () => {
    const read = await askedForS(undefined, async () => null, { trackIndex: 1, position: 80 });
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    jest.clearAllMocks();
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 30]);
  });

  // The sleep timer stops whatever plays (FE-ANDROID-4): the other book's play is known from
  // its held reports though they name none, so the timer counts down on it (`onOtherBookPlays`)
  // and the store's `pause` reaches the engine while the store's book shows paused.
  it("knows an unnamed other book plays during that hold, and the store's pause stops it", async () => {
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    pushSnapshot(snap('paused', 0, 80));
    expect(engineOtherBookPlays()).toBe(false);
    const told = jest.fn();
    const off = onOtherBookPlays(told);
    try {
      jest.clearAllMocks();
      // The car plays S on.
      pushSnapshot(snap('playing', 0, 81));
      expect(engineOtherBookPlays()).toBe(true);
      expect(told).toHaveBeenCalledTimes(1);
      // A buffer of a book heard playing is still its play.
      pushSnapshot(snap('loading', 0, 82));
      expect(engineOtherBookPlays()).toBe(true);
      expect(told).toHaveBeenCalledTimes(1);
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 30 });
      await usePlayer.getState().pause();
      expect(mockSvc.pause).toHaveBeenCalledTimes(1);
      pushSnapshot(snap('paused', 0, 82));
      expect(engineOtherBookPlays()).toBe(false);
      expect(told).toHaveBeenCalledTimes(2);
      // The shake in the timer's grace plays that book again, never a reload of B.
      expect(await resumeOtherBook()).toBe(true);
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
      expect(mockSvc.load).not.toHaveBeenCalled();
      expectNothingSaved();
    } finally {
      off();
    }
  });

  // Nothing of it once the hold is over (a play press reloaded B): B's own unnamed play is
  // the store's book's, not another's.
  it("reads no other book's play once the store's book was reloaded after that hold", async () => {
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    pushSnapshot(snap('playing', 0, 81));
    expect(engineOtherBookPlays()).toBe(true);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(engineOtherBookPlays()).toBe(false);
    pushSnapshot(snap('playing', 1, 31));
    expect(engineOtherBookPlays()).toBe(false);
    expect(await resumeOtherBook()).toBe(false);
  });

  // The route switch loads B back into the phone's engine by itself (the book could not be
  // cast, a session ended): the engine is B's from that load, and its reports, naming none,
  // were held as S's for good, B's place never saved again.
  it("takes the store's book's unnamed reports once the route switch loaded it during that hold", async () => {
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    ownLoad?.(1, 30, Promise.resolve());
    await flushMicrotasks();
    pushSnapshot(snap('paused', 1, 30));
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'playing',
      trackIndex: 1,
      position: 31,
    });
  });

  // A Cast session that begins during that hold hands B over from B's own place, at B's
  // speed (the route switch asks, `onLoadedPlace`): the engine's place is S's.
  it("gives the route switch the store's book's place during that hold, none without one", async () => {
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    expect(loadedPlace?.()).toBeNull();
    const read = await askedForS(undefined, async () => null);
    expect(await read()).toBe(false);
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    pushSnapshot(snap('playing', 0, 81));
    expect(loadedPlace?.()).toMatchObject({
      state: 'paused',
      trackIndex: 1,
      position: 30,
      rate: 1.5,
    });
    // The receiver's reports name B (the route switch's word): the hold is over.
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
    pushSnapshot(snap('paused', 1, 30));
    expect(loadedPlace?.()).toBeNull();
  });

  /** The item and chapter fetches wait: each answers when its function in the list is called. */
  function heldFetches(): (() => void)[] {
    const answers: (() => void)[] = [];
    mockFetchQuery.mockImplementation(
      (opts: unknown) =>
        new Promise((resolve) => {
          const key = (opts as { queryKey: unknown[] }).queryKey;
          answers.push(() => resolve(key[0] === 'item' ? book : chapters));
        }),
    );
    return answers;
  }

  /** B adopted paused at (1, 30); the engine asked to play from outside (no error, so no play
   * followed) and its unnamed report at `heard` taken; S's adoption then begins and
   * gives up (the engine read again names nothing). Returns once it gave up. */
  async function askedForSWhilePaused(heard: {
    trackIndex: number;
    position: number;
    state?: PlaybackState;
  }) {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    jest.clearAllMocks();
    playAsked?.();
    pushSnapshot(snap(heard.state ?? 'loading', heard.trackIndex, heard.position));
    const answers = heldFetches();
    const adopting = usePlayer.getState().adoptLoaded(loadedS, async () => null);
    await flushMicrotasks();
    // From the moment the adoption begins, B stands where it was.
    const during = usePlayer.getState().snapshot;
    for (const answer of answers) answer();
    expect(await adopting).toBe(false);
    return during;
  }

  // FE-ANDROID-5: B stood paused (not stopped in error), so the play asked from outside was not
  // followed and left no place to stand B at: S's unnamed report, taken as B's before its
  // adoption began, stayed B's place, and a speed change saved it as B's.
  it("stands a paused store's book where it was when another book's adoption begins", async () => {
    const during = await askedForSWhilePaused({ trackIndex: 1, position: 80 });
    expect(during).toMatchObject({ trackIndex: 1, position: 30 });
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { trackIndex: 1, position: 30 },
    });
    await usePlayer.getState().setRate(2);
    await flushMicrotasks();
    expect(savedPaths()).toEqual(['B']);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ path: 'B', position: 130 });
  });

  it.each(['ready', 'playing'] as const)(
    'restores the paused book when the car reports %s without naming its book before adoption',
    async (state) => {
      const during = await askedForSWhilePaused({ trackIndex: 1, position: 80, state });
      expect(during).toMatchObject({ state: 'paused', trackIndex: 1, position: 30 });
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'paused',
        trackIndex: 1,
        position: 30,
      });
    },
  );

  // Not once the store's book played from that ask (the lock screen's play of B itself): its
  // place is its own from there, and a later adoption of another book leaves it.
  it("keeps the place a paused store's book played to before another book's adoption", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    playAsked?.();
    pushSnapshot(snap('loading', 1, 30));
    pushSnapshot(snap('playing', 1, 31));
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
    pushSnapshot(snap('playing', 1, 60));
    engineBook = null;
    pushSnapshot(snap('paused', 1, 60));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 60 });
    const answers = heldFetches();
    const adopting = usePlayer.getState().adoptLoaded(loadedS, async () => null);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 60 });
    for (const answer of answers) answer();
    expect(await adopting).toBe(false);
  });

  // FE-ANDROID-5: the store's book had faulted (its engine ran off the asked file) when the car
  // played S, whose reports name none. The fault's check ran before the hold, so S's play was
  // paused again and B reloaded over it. The hold wins, during the adoption and once it gave up.
  it("neither pauses nor reloads over an unnamed other book while the store's book is faulted", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 50);
    await flushMicrotasks();
    // The engine runs off its asked file into the next: a fault, paused there.
    pushSnapshot(snap('playing', 1, 0.4));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    expect(mockSvc.pause).toHaveBeenCalled();
    pushSnapshot(snap('paused', 1, 0.5));
    await flushMicrotasks();
    jest.clearAllMocks();
    // The car plays S; its adoption is under way.
    const answers = heldFetches();
    playAsked?.();
    const adopting = usePlayer.getState().adoptLoaded(loadedS, async () => null);
    await flushMicrotasks();
    pushSnapshot(snap('playing', 0, 6));
    await flushMicrotasks();
    expect(mockSvc.pause).not.toHaveBeenCalled();
    expect(mockSvc.load).not.toHaveBeenCalled();
    // It gives up: the engine holds S all the same, and S plays on.
    for (const answer of answers) answer();
    expect(await adopting).toBe(false);
    pushSnapshot(snap('playing', 0, 7));
    await flushMicrotasks();
    expect(mockSvc.pause).not.toHaveBeenCalled();
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'error' },
    });
  });

  // An adoption that began after the store's own start asked for its load (so not marked
  // `ownLoad`) gives up, and the engine is the start's book from that load: its unnamed
  // reports are that book's, never held as the other book's.
  it("holds nothing after an adoption that gave up while the store's own load was out", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    let land!: () => void;
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const starting = usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 0);
    await flushMicrotasks();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect(await usePlayer.getState().adoptLoaded(loadedS)).toBe(false);
    land();
    await starting;
    await flushMicrotasks();
    pushSnapshot(snap('playing', 0, 3));
    await flushMicrotasks();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'playing', trackIndex: 0, position: 3 },
    });
  });

  it("is never paused by the store's watchdog while it is adopted", async () => {
    const read = await askedForS();
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(mockSvc.pause).not.toHaveBeenCalled();
    expect(await read()).toBe(true);
    expect(usePlayer.getState().nowPlaying?.path).toBe('S');
    expect(usePlayer.getState().snapshot.state).toBe('loading');
    pushSnapshot(snap('playing', 0, 6));
    await flushMicrotasks();
    jest.advanceTimersByTime(5_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  // The review: the other book reaching `playing` before its adoption landed was claimed as
  // the store's book's play: its pick-up check, its listening and its save loop began for the
  // store's book at the other book's place. The engine's reports are held until the adoption
  // lands, and the adopted book then begins its own.
  it("begins nothing of the store's book while the other book is adopted, though it plays", async () => {
    const picked = jest.fn();
    const off = onPickedUpAgain(picked);
    try {
      // B stopped at its first file, 10 s: S's place (50 s) is further on, so B's resume floor
      // would let a save of it through.
      const read = await askedForS({ trackIndex: 0, position: 10 });
      pushSnapshot(snap('playing', 0, 50));
      await flushMicrotasks();
      expect(usePlayer.getState().nowPlaying?.path).toBe('B');
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'loading', position: 10 });
      expect(picked).not.toHaveBeenCalled();
      // A move and a speed change of the engine's meanwhile are S's too.
      remoteMove?.(0, 60);
      rateChange?.(2);
      await flushMicrotasks();
      expect(usePlayer.getState().rate).toBe(1.5);
      jest.advanceTimersByTime(LOCAL_SAVE_MS);
      await flushMicrotasks();
      expectNothingSaved();
      // The adoption lands on a playing engine: S's own pick-up check, and its saves.
      (mockSvc.getSnapshot as jest.Mock).mockReset();
      (mockSvc.getSnapshot as jest.Mock).mockImplementation(() => snap('playing', 0, 60));
      expect(await read()).toBe(true);
      expect(usePlayer.getState().nowPlaying?.path).toBe('S');
      expect(usePlayer.getState().snapshot.state).toBe('playing');
      expect(picked).toHaveBeenCalledTimes(1);
      pushSnapshot(snap('playing', 0, 70));
      jest.advanceTimersByTime(LOCAL_SAVE_MS);
      await flushMicrotasks();
      expect(savedPaths()).toEqual(['S']);
    } finally {
      off();
      (mockSvc.getSnapshot as jest.Mock).mockReset();
      (mockSvc.getSnapshot as jest.Mock).mockImplementation(() => ({ ...INITIAL }));
    }
  });

  // The review: the app's own move of the store's book while the other book's adoption was
  // under way was shown and never saved (`listenerMove`): the adoption landed, and it was gone.
  it("saves the store's book's own move made while the other book is adopted", async () => {
    const read = await askedForS();
    await usePlayer.getState().seekBook(150);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 50 });
    expect(mockSvc.seekTo).not.toHaveBeenCalled();
    expect(mockSvc.skipToTrack).not.toHaveBeenCalled();
    expect(savedPaths()).toEqual(['B']);
    expect(await read()).toBe(true);
    expect(usePlayer.getState().nowPlaying?.path).toBe('S');
  });

  // The review: the app's speed set while the other book was adopted was that book's speed,
  // and the store's book's was never saved before the adoption replaced it.
  it("saves the store's book's own speed set while the other book is adopted", async () => {
    const read = await askedForS();
    await usePlayer.getState().setRate(2);
    await flushMicrotasks();
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    expect(savedPaths()).toEqual(['B']);
    expect(mockSaveProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      path: 'B',
      playback_speed: 2,
    });
    // Set back to the speed it had when the play was asked: saved too, not left at 2.
    await usePlayer.getState().setRate(1);
    await flushMicrotasks();
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    expect(mockSaveProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      path: 'B',
      playback_speed: 1,
    });
    expect(await read()).toBe(true);
    expect(usePlayer.getState()).toMatchObject({ nowPlaying: { path: 'S' }, rate: 1 });
  });

  // The review: an outside play of another book that was never adopted (its adoption gave up)
  // left that book's reports in the store's book: once it played it was the store's book's
  // play, and one that never played stopped at the other book's place, saved as the store's
  // book's, and a Retry loaded it there. The watchdog stops it, and writes no place.
  it("that is never adopted is stopped, the store's book where it stood and nothing saved", async () => {
    const picked = jest.fn();
    const off = onPickedUpAgain(picked);
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
      const { snapshot } = usePlayer.getState();
      usePlayer.setState({ snapshot: { ...snapshot, state: 'error' } });
      jest.clearAllMocks();
      playAsked?.();
      // The engine holds S by now, at a place further on than B's (file 2, 30 s).
      pushSnapshot(snap('loading', 1, 80));
      // S is read, and the engine holds yet another book by then: nothing is adopted.
      const other = async () => ({ ...loadedS, path: 'Other' });
      expect(await usePlayer.getState().adoptLoaded(loadedS, other)).toBe(false);
      // That book plays: it is not the store's book's play.
      pushSnapshot(snap('playing', 1, 81));
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('loading');
      jest.advanceTimersByTime(3_000);
      await flushMicrotasks();
      const stopped = usePlayer.getState();
      expect(stopped.nowPlaying?.path).toBe('B');
      expect(stopped.snapshot).toMatchObject({ state: 'error', trackIndex: 1, position: 30 });
      expect(mockSvc.pause).toHaveBeenCalledTimes(1);
      expect(picked).not.toHaveBeenCalled();
      jest.advanceTimersByTime(LOCAL_SAVE_MS);
      await flushMicrotasks();
      expectNothingSaved();
    } finally {
      off();
    }
  });

  // The store's own book asked to play from outside is followed as before: the engine's
  // reports are its own, and one that never plays stops at the engine's place, saved.
  it("holds nothing of the store's own book asked to play from outside", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    const { snapshot } = usePlayer.getState();
    usePlayer.setState({ snapshot: { ...snapshot, state: 'error' } });
    jest.clearAllMocks();
    playAsked?.();
    pushSnapshot(snap('loading', 1, 45));
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'loading', position: 45 });
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 45 });
    expect(savedPaths()).toEqual(['B']);
  });

  // An outside play is over once it plays: a stall later on is the store's book's own, and
  // its watchdog stops it though some adoption reads a book meanwhile (the followed play was
  // never reset, so that stall read as the outside play still starting, held and never stopped).
  it("is over once the store's own book plays: a later stall stops as its own", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    const { snapshot } = usePlayer.getState();
    usePlayer.setState({ snapshot: { ...snapshot, state: 'error' } });
    jest.clearAllMocks();
    playAsked?.();
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    pushSnapshot(snap('loading', 1, 40));
    const answers: (() => void)[] = [];
    mockFetchQuery.mockImplementation(
      (opts: unknown) =>
        new Promise((resolve) => {
          const key = (opts as { queryKey: unknown[] }).queryKey;
          answers.push(() => resolve(key[0] === 'item' ? book : chapters));
        }),
    );
    const adopting = usePlayer.getState().adoptLoaded(loadedS, async () => null);
    await flushMicrotasks();
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 40 });
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
    for (const answer of answers) answer();
    expect(await adopting).toBe(false);
  });

  it('is followed as the asked play: one that never plays stops as a press would', async () => {
    const read = await askedForS();
    expect(await read()).toBe(true);
    expect(usePlayer.getState().snapshot.state).toBe('loading');
    pushSnapshot(snap('loading', 0, 5));
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
  });
});

// The engine's reports name their book (`reportedBook`): a report of another book than the
// store's is none of the store's book's. Before it, the car (or a resumption) starting another
// book in the engine had that book's first reports, in the moment before the car sync read
// the engine, taken as the store's book's place and play; a stalled ask read that book's file
// as a run off the asked one and paused it for good; and its play opened a listening span for
// the store's book at that book's place.
describe("a report of another book than the store's", () => {
  const book = makeBook({ rel_path: 'S', title: 'S' });
  const chapters: ChaptersResponse = {
    library_id: 2,
    path: 'S',
    duration: 100,
    is_folder: false,
    files: [{ rel_path: 'S', seq: 0, duration: 100, format: 'm4b', size: 1 }],
    chapters: [],
  };
  const refS: BookRef = { connectionId: 'c1', libraryId: 2, path: 'S' };
  const refB: BookRef = { connectionId: 'c1', libraryId: 2, path: 'B' };
  const loadedS = { ...refS, trackIndex: 0, position: 5, rate: 1, playing: true };

  beforeEach(() => {
    mockFetchQuery.mockImplementation(async (opts: unknown) =>
      (opts as { queryKey: unknown[] }).queryKey[0] === 'item' ? book : chapters,
    );
  });
  afterEach(() => {
    mockFetchQuery.mockReset();
    mockFetchQuery.mockImplementation(async () => ({}));
  });

  it("is never the store's book's place or play, and the car sync is told of it", async () => {
    const told = jest.fn();
    const off = onOtherBookReported(told);
    const picked = jest.fn();
    const offPicked = onPickedUpAgain(picked);
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
      // B's own report (named B) is taken: the car sync hears nothing of it.
      engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
      pushSnapshot(snap('paused', 1, 30));
      jest.clearAllMocks();
      // The car started S in the engine; its first reports land before the car sync's read.
      engineBook = refS;
      pushSnapshot(snap('loading', 0, 5));
      pushSnapshot(snap('playing', 0, 6));
      pushSnapshot(snap('playing', 0, 7));
      remoteMove?.(0, 50);
      rateChange?.(2);
      await flushMicrotasks();
      const held = usePlayer.getState();
      expect(held.nowPlaying?.path).toBe('B');
      expect(held.snapshot).toMatchObject({ state: 'paused', trackIndex: 1, position: 30 });
      expect(held.rate).toBe(1.5);
      expect(picked).not.toHaveBeenCalled();
      jest.advanceTimersByTime(LOCAL_SAVE_MS);
      await flushMicrotasks();
      expectNothingSaved();
      // Told when it is new and when it begins playing; a tick in the same file says nothing.
      expect(told).toHaveBeenCalledTimes(2);
      // The car sync adopts it: S's reports are the store's from here.
      expect(await usePlayer.getState().adoptLoaded(loadedS)).toBe(true);
      pushSnapshot(snap('playing', 0, 8));
      expect(usePlayer.getState()).toMatchObject({
        nowPlaying: { path: 'S' },
        snapshot: { state: 'playing', position: 8 },
      });
      expect(told).toHaveBeenCalledTimes(2);
    } finally {
      off();
      offPicked();
    }
  });

  it('is taken as before once a report names no book (an older binary)', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    engineBook = refS;
    pushSnapshot(snap('paused', 0, 40));
    expect(usePlayer.getState().snapshot.position).not.toBe(40);
    engineBook = null;
    pushSnapshot(snap('paused', 0, 12));
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 0, position: 12 });
  });

  // (a): B stopped while the engine had not taken its asked place (a seek to 50 s of its first
  // file); the car then plays S, whose report is in a later file than the asked one. Read as
  // B's, it was the engine running off the asked file: a fault, S paused for good.
  it("is no run off the store's stalled ask: the other book plays, adopted", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer
      .getState()
      .adoptLoaded(loadedB({ playing: false, trackIndex: 0, position: 10 }));
    await usePlayer.getState().seekBook(50);
    await usePlayer.getState().toggle();
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    jest.clearAllMocks();
    // S, played from the car, reports from its second file before its adoption begins.
    engineBook = refS;
    playAsked?.();
    pushSnapshot(snap('loading', 1, 5));
    pushSnapshot(snap('playing', 1, 6));
    await flushMicrotasks();
    expect(mockSvc.pause).not.toHaveBeenCalled();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    (mockSvc.getSnapshot as jest.Mock).mockReturnValueOnce(snap('playing', 0, 6));
    expect(await usePlayer.getState().adoptLoaded(loadedS)).toBe(true);
    pushSnapshot(snap('playing', 0, 7));
    jest.advanceTimersByTime(5_000);
    await flushMicrotasks();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'S' },
      snapshot: { state: 'playing', position: 7 },
    });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  // The store's book still loaded (its own play, a stall) when the car played S: no report of
  // S ends that attempt, and its watchdog paused S, the car's play, before the adoption landed.
  it("is never paused by the store's book's stall watchdog", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
    await usePlayer.getState().toggle();
    pushSnapshot(snap('loading', 1, 30));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('loading');
    jest.clearAllMocks();
    engineBook = refS;
    pushSnapshot(snap('loading', 0, 5));
    pushSnapshot(snap('playing', 0, 6));
    jest.advanceTimersByTime(3_000);
    pushSnapshot(snap('playing', 0, 9));
    await flushMicrotasks();
    expect(mockSvc.pause).not.toHaveBeenCalled();
    // The store's book's attempt is over, where it was.
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 30,
    });
    expect(await usePlayer.getState().adoptLoaded(loadedS)).toBe(true);
    pushSnapshot(snap('playing', 0, 10));
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'S' },
      snapshot: { state: 'playing', position: 10 },
    });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  // The store's book played when the car played S: its place was saved again at every save
  // period, dated now, while S played.
  it("saves the store's book once, where it was last heard, and not again", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
    pushSnapshot(snap('playing', 1, 30));
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks();
    jest.clearAllMocks();
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    await flushMicrotasks();
    expect(savedPaths()).toEqual(['B']);
    jest.clearAllMocks();
    for (let t = 6; t < 6 + 3 * 60; t += 15) {
      jest.advanceTimersByTime(15_000);
      pushSnapshot(snap('playing', 0, t));
    }
    await flushMicrotasks();
    expectNothingSaved();
  });

  // FE-ANDROID-2: S was never adopted (the car sync gave up), and B showed playing at a place
  // frozen since the car played S.
  it("shows the store's book paused where it was last heard once the other book is overdue", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
    pushSnapshot(snap('playing', 1, 30));
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks();
    jest.clearAllMocks();
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    await flushMicrotasks();
    expect(savedPaths()).toEqual(['B']);
    jest.clearAllMocks();
    jest.advanceTimersByTime(5_000);
    pushSnapshot(snap('playing', 0, 10));
    await flushMicrotasks();
    // Still the adoption's time: B as it was.
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 31 });
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'paused', trackIndex: 1, position: 31 },
    });
    // S plays on, and nothing of B is saved again.
    expect(mockSvc.pause).not.toHaveBeenCalled();
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    pushSnapshot(snap('playing', 0, 70));
    await flushMicrotasks();
    expectNothingSaved();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 31 });
    // A late adoption still takes S, playing.
    expect(await usePlayer.getState().adoptLoaded({ ...loadedS, position: 71 })).toBe(true);
    pushSnapshot(snap('playing', 0, 72));
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'S' },
      snapshot: { state: 'playing', position: 72 },
    });
  });

  it('leaves the adopted book playing when the deadline passes', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
    pushSnapshot(snap('playing', 1, 30));
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    expect(await usePlayer.getState().adoptLoaded(loadedS)).toBe(true);
    pushSnapshot(snap('playing', 0, 8));
    jest.advanceTimersByTime(6_000);
    pushSnapshot(snap('playing', 0, 14));
    await flushMicrotasks();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'S' },
      snapshot: { state: 'playing', position: 14 },
    });
  });

  it("runs a whole deadline again when the store's book is heard in between", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    const refB = { connectionId: 'c1', libraryId: 2, path: 'B' };
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 30));
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    jest.advanceTimersByTime(4_000);
    // The engine plays B again, then S once more.
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 31));
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 6));
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 31 });
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 31 });
  });

  it("reloads the store's book on a play press once it shows paused", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
    pushSnapshot(snap('playing', 1, 30));
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    jest.advanceTimersByTime(6_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 30 });
    jest.clearAllMocks();
    await usePlayer.getState().toggle();
    // The engine holds S: a plain play would be S's, so B is loaded at its place.
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 30]);
  });

  // FE-ANDROID-3: the deadline is the book's, not the object's. A `NowPlaying` replaced for the
  // same book inside the window (a chapters refresh) left it shown playing for good.
  it("shows the store's book paused at the deadline though its NowPlaying was replaced", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 30));
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    jest.advanceTimersByTime(3_000);
    const np = usePlayer.getState().nowPlaying!;
    usePlayer.setState({ nowPlaying: { ...np, queue: { ...np.queue } } });
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'paused', position: 30 },
    });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  // FE-ANDROID-3: the store's book streamed when the car played S, and its download landed
  // inside the adoption window. The hot swap loaded it over S (the car's book cut off), and
  // its own report ended the deadline.
  it("never hot-swaps the store's book over the other book the engine plays", async () => {
    await usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 130);
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 30));
    await flushMicrotasks();
    expect(usePlayer.getState().nowPlaying?.queue.tracks[0].url).toBe('stream:2:B/1.mp3');
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    await flushMicrotasks();
    jest.clearAllMocks();
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await flushMicrotasks();
    expect(mockSvc.load).not.toHaveBeenCalled();
    jest.advanceTimersByTime(6_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 30 });
    // A play press reloads B, from its download, at its place.
    await usePlayer.getState().toggle();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    const [tracks, index, at] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect((tracks as { url: string }[]).map((t) => t.url)).toEqual([
      'file:///d/1.mp3',
      'file:///d/2.mp3',
    ]);
    expect([index, at]).toEqual([1, 30]);
  });

  it('names the book the engine plays while it is not adopted (`engineOtherBook`)', async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 30));
    expect(engineOtherBook()).toBeNull();
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    expect(engineOtherBook()).toEqual(refS);
    // Played to its end: no book to resume, as the store's own finished book is not.
    (mockSvc.getSnapshot as jest.Mock).mockImplementation(() => snap('ended', 0, 50));
    try {
      expect(engineOtherBook()).toBeNull();
    } finally {
      (mockSvc.getSnapshot as jest.Mock).mockImplementation(() => ({ ...INITIAL }));
    }
    // A load of the store's holds it: the engine still reports the book that load replaces.
    usePlayer.setState({ loadingBook: 'c1:2:S' });
    expect(engineOtherBook()).toBeNull();
    usePlayer.setState({ loadingBook: null });
    expect(await usePlayer.getState().adoptLoaded(loadedS)).toBe(true);
    expect(engineOtherBook()).toBeNull();
  });

  // The other book's end changes nothing of the store's, and the car sync named it for a
  // resumption (`engineOtherBook`): told once, as an end (nothing to adopt).
  it('tells the car sync once, as an end, when the other book played to its end', async () => {
    const told = jest.fn();
    const off = onOtherBookReported(told);
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
      engineBook = refB;
      pushSnapshot(snap('paused', 1, 30));
      engineBook = refS;
      pushSnapshot(snap('playing', 0, 5));
      expect(told.mock.calls).toEqual([['playing']]);
      pushSnapshot(snap('ended', 0, 50));
      pushSnapshot(snap('ended', 0, 50));
      expect(told.mock.calls).toEqual([['playing'], ['ended']]);
      // Played again from the car: a play the car sync hears of, and a later end is one more.
      pushSnapshot(snap('playing', 0, 1));
      pushSnapshot(snap('ended', 0, 50));
      expect(told.mock.calls).toEqual([['playing'], ['ended'], ['playing'], ['ended']]);
      expect(usePlayer.getState().nowPlaying?.path).toBe('B');
    } finally {
      off();
    }
  });

  // The car sync names the other book for a resumption once it plays (`playing`), whatever
  // the store's book shows; a new book loaded paused, or the next file, is a `moved`.
  it('tells the car sync when the other book begins playing, apart from its moves', async () => {
    const told = jest.fn();
    const off = onOtherBookReported(told);
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
      engineBook = refB;
      pushSnapshot(snap('paused', 1, 30));
      engineBook = refS;
      pushSnapshot(snap('paused', 0, 5));
      pushSnapshot(snap('playing', 0, 6));
      pushSnapshot(snap('playing', 1, 0));
      expect(told.mock.calls).toEqual([['moved'], ['playing'], ['moved']]);
      // Moved on to a file that buffers first: the move is news, its return to playing is not.
      pushSnapshot(snap('loading', 0, 0));
      pushSnapshot(snap('playing', 0, 1));
      expect(told.mock.calls).toEqual([['moved'], ['playing'], ['moved'], ['moved']]);
    } finally {
      off();
    }
  });

  // The review: the app's own seek, skip or chapter jump went to the engine, which plays S,
  // while the store showed B paused: it moved the car's book. It is B's move: B shows the
  // place, and a play press reloads B there, as any play in that state does.
  it("moves the store's book, never the engine's other book, on the app's own moves", async () => {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 30));
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    jest.advanceTimersByTime(6_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 30 });
    jest.clearAllMocks();
    const p = usePlayer.getState();
    await p.seekBook(150);
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 50 });
    await p.skipSeconds(-10);
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 40 });
    await p.seekInTrack(20);
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 20 });
    await p.goToTrack(0);
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'paused',
      trackIndex: 0,
      position: 0,
    });
    await p.seekBook(60);
    expect(mockSvc.seekTo).not.toHaveBeenCalled();
    expect(mockSvc.skipToTrack).not.toHaveBeenCalled();
    expect(mockSvc.load).not.toHaveBeenCalled();
    // The play press reloads B where the moves left it.
    await usePlayer.getState().toggle();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([0, 60]);
  });

  /** B, downloaded, plays at 1/30 until the car starts S (0/5), not adopted: the mocks
   * cleared, B still shows playing within its adoption's deadline. */
  async function carPlaysSOverB() {
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await usePlayer.getState().adoptLoaded(loadedB({ playing: true }));
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 30));
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    await flushMicrotasks();
    jest.clearAllMocks();
  }

  // The review: the app's speed set while the engine played the car's S was S's speed. It is
  // B's, saved with B, and the engine takes it when B is next loaded.
  it("sets the store's book's speed, never the engine's other book's", async () => {
    await carPlaysSOverB();
    // Within the adoption's deadline, and after it.
    await usePlayer.getState().setRate(2);
    await flushMicrotasks();
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    expect(usePlayer.getState().rate).toBe(2);
    expect(mockSaveProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      path: 'B',
      position: 130,
      playback_speed: 2,
    });
    jest.advanceTimersByTime(6_000);
    await flushMicrotasks();
    await usePlayer.getState().setRate(1.25);
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    // The play press reloads B at the speed set.
    await usePlayer.getState().toggle();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect(mockSvc.setRate).toHaveBeenCalledWith(1.25);
  });

  // FE-ANDROID-4: the app's Pause that left the engine alone while a report named another
  // book left the sound playing whenever that report was wrong (the book a load replaced,
  // reporting late). A Pause pressed in the app stops whatever plays; the store's book shows
  // paused where it was last heard, nothing saved, and S's later play is S's.
  it("pauses the engine on the app's Pause while it plays the other book, B shown paused", async () => {
    await carPlaysSOverB();
    jest.advanceTimersByTime(2_000);
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    await usePlayer.getState().toggle();
    await flushMicrotasks();
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'paused', trackIndex: 1, position: 30 },
    });
    pushSnapshot(snap('paused', 0, 7));
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    pushSnapshot(snap('playing', 0, 70));
    await flushMicrotasks();
    expectNothingSaved();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 30 });
    // The car sync's adoption still takes S, playing.
    expect(await usePlayer.getState().adoptLoaded({ ...loadedS, position: 71 })).toBe(true);
    pushSnapshot(snap('playing', 0, 72));
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'S' },
      snapshot: { state: 'playing', position: 72 },
    });
  });

  // The review: the store's `pause` is the sleep timer's, which must stop whatever plays. Given
  // the app's Pause rule, it left the car's S playing.
  it("stops the other book the engine plays on the store's pause (the sleep timer)", async () => {
    await carPlaysSOverB();
    jest.advanceTimersByTime(2_000);
    await usePlayer.getState().pause();
    await flushMicrotasks();
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'paused', trackIndex: 1, position: 30 },
    });
    // S's pause is S's report: B stays where it was last heard, nothing saved, and the
    // deadline that would have shown B paused is over.
    pushSnapshot(snap('paused', 0, 7));
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await flushMicrotasks();
    expectNothingSaved();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 30 });
    // An adoption that lands takes S as the engine holds it, paused.
    expect(
      await usePlayer.getState().adoptLoaded({ ...loadedS, position: 7, playing: false }),
    ).toBe(true);
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'S' },
      snapshot: { state: 'paused', position: 7 },
    });
  });

  // FE-ANDROID-4 (a): the sleep timer's pause found B showing paused (the deadline passed) and
  // stopped nothing, so the car's S played on past the timer.
  it("stops the other book on the store's pause though the store's book shows paused", async () => {
    const told = jest.fn();
    const off = onOtherBookPlays(told);
    try {
      await carPlaysSOverB();
      expect(engineOtherBookPlays()).toBe(true);
      jest.advanceTimersByTime(6_000);
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).toBe('paused');
      expect(engineOtherBookPlays()).toBe(true);
      await usePlayer.getState().pause();
      expect(mockSvc.pause).toHaveBeenCalledTimes(1);
      // S's pause turns it off, and the sleep timer is told.
      told.mockClear();
      pushSnapshot(snap('paused', 0, 9));
      expect(engineOtherBookPlays()).toBe(false);
      expect(told).toHaveBeenCalledTimes(1);
      // Nothing plays now: the store's pause asks the engine nothing more.
      await usePlayer.getState().pause();
      expect(mockSvc.pause).toHaveBeenCalledTimes(1);
      expectNothingSaved();
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'paused', position: 30 });
    } finally {
      off();
    }
  });

  // The sleep timer's shake after it stopped S plays S again, never a reload of B.
  it('plays the other book again on `resumeOtherBook`, and only while the engine holds it', async () => {
    await carPlaysSOverB();
    jest.advanceTimersByTime(6_000);
    await usePlayer.getState().pause();
    pushSnapshot(snap('paused', 0, 9));
    expect(await resumeOtherBook()).toBe(true);
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'paused', position: 30 },
    });
    // Playing already: nothing is asked.
    pushSnapshot(snap('playing', 0, 10));
    expect(await resumeOtherBook()).toBe(false);
    // The engine holds B again: nothing is asked.
    engineBook = refB;
    pushSnapshot(snap('paused', 1, 30));
    expect(await resumeOtherBook()).toBe(false);
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
  });

  // A start of the store's that gave up before its load (its place lookup called off) left S
  // in the engine; S's pause during that lookup went unread, and S read as playing after it,
  // the sleep timer counting on with nothing heard.
  it('reads the other book as stopped after a start that gave up while it paused', async () => {
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
    await carPlaysSOverB();
    jest.advanceTimersByTime(6_000);
    await flushMicrotasks();
    expect(engineOtherBookPlays()).toBe(true);
    let superseded = false;
    const starting = usePlayer
      .getState()
      .playBook(
        'c1',
        2,
        makeBook({ rel_path: 'Y' }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => superseded,
      );
    await flushMicrotasks();
    // S pauses (the car) while Y's place is looked up, then that start is called off.
    pushSnapshot(snap('paused', 0, 9));
    superseded = true;
    answer({ kind: 'empty' });
    await starting;
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying?.path).toBe('B');
    expect(engineOtherBookPlays()).toBe(false);
    // Playing again, it is read as playing again.
    pushSnapshot(snap('playing', 0, 10));
    expect(engineOtherBookPlays()).toBe(true);
  });

  /** S plays (the engine's reports name it), then a start of B whose load is held: B is the
   * store's book while the engine's last report still names S, the book that load replaces.
   * Returns the load's landing. */
  async function startBOverPlayingS(): Promise<() => void> {
    await usePlayer.getState().playBook('c1', 2, book, chapters, 10);
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 12));
    await flushMicrotasks();
    let land!: () => void;
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    jest.clearAllMocks();
    void usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 50);
    await flushMicrotasks(30);
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'playing' },
    });
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    return () => {
      engineBook = refB;
      land();
    };
  }

  // The review: the app's Pause pressed while a start of the store's loaded read the book that
  // load replaces as the car's, and left it playing (on under the new book's error, should the
  // load fail).
  it("pauses the engine on the app's Pause while a start of the store's loads", async () => {
    const land = await startBOverPlayingS();
    await usePlayer.getState().toggle();
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
    // The start ends (its in-flight count is the store's, shared by the tests after this).
    land();
    await flushMicrotasks(30);
  });

  // FE-ANDROID-4 (b): a report of S sent before B's load and heard after it landed was read as
  // the car's book, and the app's Pause then showed B paused with the engine left playing.
  it("pauses the engine on the app's Pause when a late report names the book a load replaced", async () => {
    const land = await startBOverPlayingS();
    land();
    await flushMicrotasks(30);
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 13));
    expect(usePlayer.getState()).toMatchObject({
      nowPlaying: { path: 'B' },
      snapshot: { state: 'playing' },
    });
    jest.clearAllMocks();
    await usePlayer.getState().toggle();
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
  });

  // The review: a speed set while a start loaded left the engine alone (its report named the
  // book being replaced), and the start then set the engine to its own speed.
  it('gives the engine the speed set while a start of the store loaded', async () => {
    const land = await startBOverPlayingS();
    await usePlayer.getState().setRate(2);
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    land();
    await flushMicrotasks(30);
    expect(mockSvc.setRate).toHaveBeenLastCalledWith(2);
    expect(usePlayer.getState().rate).toBe(2);
  });

  // The review: a download landing while the engine played S was dropped (no `swapDue`), so
  // the store's book streamed on once the engine held it again, until a Retry or a start.
  it("swaps a download that landed meanwhile in once the engine holds the store's book again", async () => {
    await usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 130);
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 30));
    await flushMicrotasks();
    engineBook = refS;
    pushSnapshot(snap('playing', 0, 5));
    await flushMicrotasks();
    jest.clearAllMocks();
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await flushMicrotasks();
    expect(mockSvc.load).not.toHaveBeenCalled();
    // The engine reports B again: the swap that waited runs, at B's place.
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks(20);
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    const [tracks, index, at] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect((tracks as { url: string }[]).map((t) => t.url)).toEqual([
      'file:///d/1.mp3',
      'file:///d/2.mp3',
    ]);
    expect(index).toBe(1);
    expect(at).toBeCloseTo(31, 0);
  });

  // The review: the swap waited on S's outside play (`engineIsAnothers`), and B's report held
  // meanwhile took the only release there was (keyed on S's last report): once B was heard
  // as its own again, it streamed on with its download landed.
  it('swaps a download that waited on an outside play in once the store hears its book', async () => {
    await usePlayer.getState().playBook('c1', 2, twoFileBook, twoFileChapters, 130);
    engineBook = refB;
    pushSnapshot(snap('playing', 1, 30));
    await flushMicrotasks();
    const { snapshot } = usePlayer.getState();
    usePlayer.setState({ snapshot: { ...snapshot, state: 'error' } });
    await usePlayer.getState().pause();
    playAsked?.();
    engineBook = refS;
    pushSnapshot(snap('loading', 0, 5));
    await flushMicrotasks();
    jest.clearAllMocks();
    useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
    await flushMicrotasks();
    // B again, while the outside play is still followed as S's: held.
    engineBook = refB;
    pushSnapshot(snap('loading', 1, 30));
    await flushMicrotasks(20);
    expect(mockSvc.load).not.toHaveBeenCalled();
    // The outside play ends at its watchdog; B then plays (the car's tap on it).
    jest.advanceTimersByTime(5_000);
    await flushMicrotasks();
    pushSnapshot(snap('playing', 1, 31));
    await flushMicrotasks(20);
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    const [tracks, index] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect((tracks as { url: string }[]).map((t) => t.url)).toEqual([
      'file:///d/1.mp3',
      'file:///d/2.mp3',
    ]);
    expect(index).toBe(1);
  });

  it('tells the car sync nothing new when the other book returns from buffering', async () => {
    const told = jest.fn();
    const off = onOtherBookReported(told);
    try {
      useDownloads.setState({ entries: { 'c1:2:B': downloadedB() } });
      await usePlayer.getState().adoptLoaded(loadedB({ playing: false }));
      engineBook = { connectionId: 'c1', libraryId: 2, path: 'B' };
      pushSnapshot(snap('paused', 1, 30));
      engineBook = refS;
      pushSnapshot(snap('playing', 0, 5));
      expect(told).toHaveBeenCalledTimes(1);
      pushSnapshot(snap('loading', 0, 6));
      pushSnapshot(snap('playing', 0, 7));
      expect(told).toHaveBeenCalledTimes(1);
      // A pause and a play again is a play the car sync hears of, as before.
      pushSnapshot(snap('paused', 0, 8));
      pushSnapshot(snap('playing', 0, 9));
      expect(told).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });
});
