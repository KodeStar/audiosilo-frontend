import { act, renderHook } from '@testing-library/react-native';

import type { Book, ChaptersResponse } from '@/api/types';

import type { OpenSpan } from './listening-outbox';
import type { ResumeLookup } from './progress-sync';
import type { PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

// The store while the app is away (perf P4). The periodic save's pace (`saveIntervalMs`):
// every 15 s while the app is in front and the playing file streams, every 60 s with the app
// away or the file on this device, switched mid-play with no save dropped or doubled, and
// never slowing a save that goes at once. And what `usePlayer`, the hook, shows off screen
// (`quietOffScreen`): no tick of the place, everything else at once, while the store's own
// logic goes on reading the live state. The engine is a fake whose snapshots a test pushes,
// about once a second as a real one does; the app's state is the test's.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
let mockCasting = false;
const mockSvc = {
  onRemoteSeek: jest.fn(),
  onRemoteMove: jest.fn(),
  onRateChange: jest.fn(),
  onSilenceSaved: jest.fn(),
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
  isCasting: () => mockCasting,
  getSnapshot: jest.fn(() => ({ ...INITIAL })),
  subscribe: jest.fn((listener: (s: PlaybackSnapshot) => void) => {
    pushSnapshot = listener;
    return () => {};
  }),
} as unknown as PlaybackService;

const INITIAL: PlaybackSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};

jest.mock('./service', () => ({ createPlaybackService: () => mockSvc }));

/** When each save was made (the PUT path's `saveProgress`, the sync path's mirror write). */
const mockSaves: number[] = [];
/** The whole-book place each of them saved. */
const mockSavedAt: number[] = [];
const mockLoadInitialProgress = jest.fn(async (..._a: unknown[]): Promise<ResumeLookup> => ({
  kind: 'empty',
}));
jest.mock('./progress-sync', () => ({
  saveProgress: jest.fn(async (_api: unknown, save: { position: number }) => {
    mockSaves.push(Date.now());
    mockSavedAt.push(save.position);
    return 'saved';
  }),
  writeMirror: jest.fn(async (save: { position: number }) => {
    mockSaves.push(Date.now());
    mockSavedAt.push(save.position);
  }),
  ackVersion: jest.fn(async () => {}),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  cachedDeviceId: () => 'dev-1',
  loadInitialProgress: (...a: unknown[]) => mockLoadInitialProgress(...a),
  readMirror: jest.fn(async () => null),
  guardSettled: () => false,
}));

let mockSync = false;
/** When each span was closed into the outbox (a cut, a pause). */
const mockCuts: number[] = [];
/** When the open span was stored (the 5 s keeper). */
const mockKept: number[] = [];
jest.mock('./listening-outbox', () => {
  const actual = jest.requireActual('./listening-outbox');
  return {
    spanToEvent: actual.spanToEvent,
    finishEvent: actual.finishEvent,
    newEventId: actual.newEventId,
    usesListeningSync: () => mockSync,
    closeSpan: jest.fn(async (_span: OpenSpan) => {
      mockCuts.push(Date.now());
    }),
    storeOpenSpan: jest.fn(async () => {
      mockKept.push(Date.now());
      return null;
    }),
    appendEvents: jest.fn(async () => {}),
    flushOutbox: jest.fn(async () => {}),
    sendOnPageHide: jest.fn(),
    withdrawFinish: jest.fn(async () => ({ unsent: true, restore: async () => {} })),
  };
});

jest.mock('./time-saved', () => ({ noteSilenceSaved: jest.fn(), flushTimeSaved: jest.fn() }));
jest.mock('@/api/provider', () => ({
  queryClient: {
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    setQueryDefaults: jest.fn(),
    fetchQuery: jest.fn(async () => ({})),
    getQueryData: jest.fn(() => undefined),
    cancelQueries: jest.fn(async () => {}),
  },
}));
jest.mock('@/lib/network', () => ({ canAutoDownload: jest.fn(() => Promise.resolve(false)) }));
const mockClient = {
  coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
  streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  authHeaders: () => ({ Authorization: 'Bearer x' }),
  addHistory: jest.fn(async () => {}),
};
jest.mock('@/api/connection-clients', () => ({
  resolveClient: () => mockClient,
  sessionReady: jest.fn(() => true),
}));

/* eslint-disable import/first */
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import { useSettings } from '@/stores/settings';
import { driveAppState } from '@/testing/app-state';

import { selectBookPosition, selectCurrentChapter, selectIsPlaying, usePlayer } from './store';
/* eslint-enable import/first */

// The app's state: the store began watching it as it was imported.
const { becomes: appBecomes } = driveAppState();

const folder = 'A/Folder';
const files = ['A/Folder/1.mp3', 'A/Folder/2.mp3'];
const chapters: ChaptersResponse = {
  library_id: 2,
  path: folder,
  duration: 2000,
  is_folder: true,
  files: files.map((rel_path, seq) => ({ rel_path, seq, duration: 1000, format: 'mp3', size: 1 })),
  chapters: files.map((file_path, index) => ({
    index,
    title: `Chapter ${index + 1}`,
    file_index: index,
    file_path,
    start: 0,
    end: 1000,
    book_offset: index * 1000,
  })),
};
const book: Book = {
  id: 1,
  library_id: 2,
  rel_path: folder,
  is_folder: true,
  title: 'A Book',
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 2000,
  format: 'mp3',
  size: 0,
};

/** The book's download: every file, or only `held`. */
const downloaded = (held = files): DownloadEntry => ({
  connectionId: 'c1',
  libraryId: 2,
  path: folder,
  title: 'A Book',
  status: 'downloaded',
  progress: 1,
  bytes: 0,
  totalBytes: 0,
  manifest: {
    book,
    chapters,
    files: held.map((relPath) => ({ relPath, localUri: `file:///d/${relPath}` })),
    coverUri: 'file:///d/cover.jpg',
    savedAt: '2026-01-01T00:00:00.000Z',
  },
});

const snap = (state: PlaybackState, trackIndex: number, position: number): PlaybackSnapshot => ({
  state,
  trackIndex,
  position,
  duration: 1000,
  rate: 1,
});

async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Where the fake engine is. */
let track = 0;
let position = 0;
/** When the book began to play: the times below are seconds since. */
let began = 0;

/** Start the book playing at 5 s of its first file. */
async function play() {
  await usePlayer.getState().playBook('c1', 2, book, chapters, 5);
  await settle();
  track = 0;
  position = 5;
  pushSnapshot(snap('playing', track, position));
  await settle();
  began = Date.now();
  mockSaves.length = 0;
  mockSavedAt.length = 0;
  mockCuts.length = 0;
  mockKept.length = 0;
}

/** `seconds` of playing: the clock, the JS timers and an engine event each second. With
 * `timers: false` only the events come (Android, the screen off: its JS timers paused). */
async function played(seconds: number, { timers = true } = {}) {
  for (let i = 0; i < seconds; i++) {
    if (timers) jest.advanceTimersByTime(1_000);
    else jest.setSystemTime(Date.now() + 1_000);
    position += 1;
    pushSnapshot(snap('playing', track, position));
    await settle();
  }
}

/** Seconds into the play of each time in `times`. */
const at = (times: number[]) => times.map((t) => Math.round((t - began) / 1_000));

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockSync = false;
  mockCasting = false;
  mockLoadInitialProgress.mockResolvedValue({ kind: 'empty' });
  useSettings.setState({ autoDownloadNext: 'never' });
  usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL }, rate: 1 });
  useDownloads.setState({ entries: {} });
});

afterEach(async () => {
  // In `act`: a reader a test mounted is shown both.
  await act(async () => {
    await usePlayer.getState().stop();
    // Back in front for the next test, with nothing playing to save.
    appBecomes('active');
  });
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the pace of the periodic save', () => {
  it('is 15 s for a streamed book with the app in front', async () => {
    await play();
    await played(60);
    expect(at(mockSaves)).toEqual([15, 30, 45, 60]);
  });

  it('is 60 s with the app in the background, after a save as it leaves', async () => {
    await play();
    await played(20);
    appBecomes('background');
    await settle();
    await played(125);
    // 15: the last at the faster pace. 20: leaving. Then a minute apart, counted from there.
    expect(at(mockSaves)).toEqual([15, 20, 80, 140]);
  });

  it("counts iOS's inactive on the way to the background as one leaving", async () => {
    await play();
    await played(10);
    appBecomes('inactive');
    appBecomes('background');
    await settle();
    await played(60);
    expect(at(mockSaves)).toEqual([10, 70]);
  });

  it('keeps the 60 s pace from engine events alone (no JS timer fires)', async () => {
    await play();
    appBecomes('background');
    await settle();
    await played(180, { timers: false });
    expect(at(mockSaves)).toEqual([0, 60, 120, 180]);
  });

  it('saves at once on coming back when the faster pace already owes one', async () => {
    await play();
    appBecomes('background');
    await settle();
    await played(40);
    expect(at(mockSaves)).toEqual([0]);
    appBecomes('active');
    await settle();
    expect(at(mockSaves)).toEqual([0, 40]);
    await played(30);
    expect(at(mockSaves)).toEqual([0, 40, 55, 70]);
  });

  it('does not save twice on coming back soon after a save', async () => {
    await play();
    await played(10);
    appBecomes('background'); // a save at 10
    await settle();
    await played(5);
    appBecomes('active');
    await settle();
    await played(25);
    // 15 s after the save made on leaving, not at the return and not at the old phase.
    expect(at(mockSaves)).toEqual([10, 25, 40]);
  });

  it('is 60 s for a downloaded book, in front too', async () => {
    useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloaded() } });
    await play();
    expect(usePlayer.getState().nowPlaying!.queue.tracks.every((t) => t.local)).toBe(true);
    await played(120);
    expect(at(mockSaves)).toEqual([60, 120]);
  });

  it('follows the playing file: 60 s in one this device holds, 15 s in one that streams', async () => {
    // Only the first file is held: the second streams.
    useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloaded([files[0]]) } });
    await play();
    expect(usePlayer.getState().nowPlaying!.queue.tracks.map((t) => !!t.local)).toEqual([
      true,
      false,
    ]);
    await played(70);
    expect(at(mockSaves)).toEqual([60]);
    // The engine goes on to the next file: 15 s from the last save, so at once here.
    track = 1;
    position = 0;
    await played(40);
    expect(at(mockSaves)).toEqual([60, 75, 90, 105]);
  });

  it('slows to 60 s from the last save when the playing book moves onto its download', async () => {
    await play();
    await played(20);
    expect(at(mockSaves)).toEqual([15]);
    useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloaded() } });
    await settle();
    expect(usePlayer.getState().nowPlaying!.queue.tracks.every((t) => t.local)).toBe(true);
    mockSaves.length = 0; // whatever the swap itself saved
    await played(130);
    const gaps = mockSaves.slice(1).map((t, i) => Math.round((t - mockSaves[i]) / 1_000));
    expect(mockSaves.length).toBeGreaterThan(1);
    expect(gaps.every((gap) => gap === 60)).toBe(true);
  });

  it('stays at 15 s for a downloaded book played on a Cast receiver', async () => {
    useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloaded() } });
    mockCasting = true;
    await play();
    await played(30);
    expect(at(mockSaves)).toEqual([15, 30]);
  });
});

describe('saves that go at once, whatever the pace', () => {
  it('saves a pause in the background at once, and nothing after it', async () => {
    await play();
    appBecomes('background');
    await settle();
    await played(7);
    pushSnapshot(snap('paused', track, position));
    await settle();
    expect(at(mockSaves)).toEqual([0, 7]);
    jest.advanceTimersByTime(120_000);
    await settle();
    expect(at(mockSaves)).toEqual([0, 7]);
  });

  it('saves a seek and a stop in the background at once', async () => {
    await play();
    appBecomes('background');
    await settle();
    await played(3);
    await usePlayer.getState().seekBook(500);
    await settle();
    expect(at(mockSaves)).toEqual([0, 3]);
    await usePlayer.getState().stop();
    await settle();
    expect(at(mockSaves).slice(0, 3)).toEqual([0, 3, 3]);
  });

  it('saves nothing as the app leaves with the book paused', async () => {
    await play();
    await played(5);
    pushSnapshot(snap('paused', track, position));
    await settle();
    mockSaves.length = 0;
    appBecomes('background');
    await settle();
    appBecomes('active');
    await settle();
    expect(mockSaves).toEqual([]);
  });
});

describe('the Sync v2 span cut', () => {
  beforeEach(() => {
    mockSync = true;
  });

  it('follows the pace: every 15 s in front, every 60 s away', async () => {
    await play();
    await played(60);
    expect(at(mockCuts)).toEqual([15, 30, 45, 60]);
    mockCuts.length = 0;
    appBecomes('background'); // the cut on leaving is `listening-sync.ts`'s, not wired here
    await settle();
    await played(120);
    expect(at(mockCuts)).toEqual([120, 180]);
  });

  it('still stores the open span every 5 s in the background', async () => {
    await play();
    appBecomes('background');
    await settle();
    await played(60);
    // A kill loses at most 5 s of listening, as before: 12 keeps in the minute between cuts.
    expect(mockKept).toHaveLength(12);
    expect(at(mockCuts)).toEqual([60]);
  });
});

describe('what the hook shows off screen', () => {
  /** A component reading the place, the chapter and whether it plays, and its renders. */
  async function reader() {
    let renders = 0;
    const hook = await renderHook(() => {
      renders++;
      return {
        position: usePlayer(selectBookPosition),
        chapter: usePlayer(selectCurrentChapter)?.index ?? null,
        playing: usePlayer(selectIsPlaying),
        file: usePlayer((s) => s.snapshot.trackIndex),
      };
    });
    return { shown: () => hook.result.current, renders: () => renders };
  }
  /** `played`, inside React's `act` so a mounted reader renders what it is shown. */
  const playedShown = (seconds: number) => act(() => played(seconds));
  const appShown = (state: 'active' | 'background') => act(async () => appBecomes(state));

  it('redraws the place every second in front', async () => {
    await play();
    const { shown, renders } = await reader();
    const before = renders();
    await playedShown(10);
    expect(shown().position).toBe(15);
    expect(renders() - before).toBe(10);
  });

  it('redraws nothing while the book plays in the background, then the live place at once', async () => {
    await play();
    const { shown, renders } = await reader();
    await appShown('background');
    const before = renders();
    // Other readers of the store (the car, the widgets) hear every tick as before.
    const heard = jest.fn();
    const stop = usePlayer.subscribe(heard);
    await playedShown(120);
    stop();
    expect(renders()).toBe(before);
    expect(shown().position).toBe(5);
    expect(selectBookPosition(usePlayer.getState())).toBe(125);
    expect(heard.mock.calls.length).toBeGreaterThanOrEqual(120);

    await appShown('active');
    expect(shown().position).toBe(125);
    expect(renders()).toBe(before + 1);
    await playedShown(1);
    expect(shown().position).toBe(126);
  });

  it('saves the live place, not the one shown, while off screen', async () => {
    await play();
    const { shown } = await reader();
    await appShown('background'); // a save at 5
    await playedShown(60);
    expect(shown().position).toBe(5);
    // The minute's save took the engine's place (the timer fires just before the 65th
    // second's event here), a minute on from the 5 the screen still shows.
    expect(mockSavedAt).toEqual([5, 64]);
  });

  it('shows a pause in the background at once, at the place it paused', async () => {
    await play();
    const { shown } = await reader();
    await appShown('background');
    await playedShown(30);
    expect(shown()).toMatchObject({ position: 5, playing: true });
    await act(async () => {
      pushSnapshot(snap('paused', track, position));
      await settle();
    });
    expect(shown()).toMatchObject({ position: 35, playing: false });
  });

  it('shows the next file in the background, and the chapter with it', async () => {
    await play();
    const { shown } = await reader();
    await appShown('background');
    await playedShown(20);
    expect(shown()).toMatchObject({ file: 0, chapter: 0, position: 5 });
    track = 1;
    position = 0;
    await playedShown(1);
    expect(shown()).toMatchObject({ file: 1, chapter: 1, position: 1001 });
    await playedShown(10);
    expect(shown().position).toBe(1001);
  });

  it('shows the end of the book in the background (what starts the next one)', async () => {
    await play();
    const ended = await renderHook(() => usePlayer((s) => s.snapshot.state === 'ended'));
    await appShown('background');
    await playedShown(5);
    await act(async () => {
      pushSnapshot(snap('ended', 1, 1000));
      await settle();
    });
    expect(ended.result.current).toBe(true);
  });

  it('shows another book loading in the background', async () => {
    await play();
    const title = await renderHook(() => usePlayer((s) => s.nowPlaying?.title ?? null));
    await appShown('background');
    await playedShown(3);
    await act(async () => {
      await usePlayer
        .getState()
        .playBook('c1', 2, { ...book, rel_path: 'B/Other', title: 'Another' }, undefined, 0);
      await settle();
    });
    expect(title.result.current).toBe('Another');
  });
});
