import type { Book, ChaptersResponse, ListeningEvent, Progress } from '@/api/types';

import type { OpenSpan } from './listening-outbox';
import type { ResumeLookup } from './progress-sync';
import type { PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

// Sync v2's spans in the store (Track W1): what the store hands the outbox on a server with
// `listening_sync`, and that it hands it nothing (the PUT path, as before) without it. The
// engine is a fake whose snapshots a test pushes; the outbox's storage and sending are
// captured, its pure event builders are the real ones.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
let remoteMove: (trackIndex: number, position: number) => void = () => {};
const mockSvc = {
  onRemoteSeek: jest.fn(),
  onRemoteMove: jest.fn((cb: (trackIndex: number, position: number) => void) => {
    remoteMove = cb;
  }),
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

const mockSaveProgress = jest.fn(async (..._a: unknown[]) => {});
const mockWriteMirror = jest.fn(async (..._a: unknown[]) => {});
const mockAckVersion = jest.fn(async (..._a: unknown[]) => {});
const mockLoadInitialProgress = jest.fn(async (..._a: unknown[]): Promise<ResumeLookup> => ({
  kind: 'empty',
}));
const mockReadMirror = jest.fn(async (..._a: unknown[]): Promise<unknown> => null);
// Sessions whose guarded save the queue has PUT since (`guardSettled`).
const mockSettled = new Set<string>();
jest.mock('./progress-sync', () => ({
  saveProgress: (...a: unknown[]) => mockSaveProgress(...a),
  writeMirror: (...a: unknown[]) => mockWriteMirror(...a),
  ackVersion: (...a: unknown[]) => mockAckVersion(...a),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  cachedDeviceId: () => 'dev-1',
  loadInitialProgress: (...a: unknown[]) => mockLoadInitialProgress(...a),
  readMirror: (...a: unknown[]) => mockReadMirror(...a),
  guardSettled: (id: string) => mockSettled.has(id),
}));

// The outbox: the path choice is the test's, storage and sending are captured.
let mockSync = true;
const mockClosed: OpenSpan[] = [];
const mockAppended: ListeningEvent[] = [];
const mockSendOnPageHide = jest.fn((..._a: unknown[]) => {});
const mockFlushOutbox = jest.fn(async (..._a: unknown[]) => {});
const mockStoreOpenSpan = jest.fn(async (..._a: unknown[]): Promise<OpenSpan | null> => null);
jest.mock('./listening-outbox', () => {
  const actual = jest.requireActual('./listening-outbox');
  return {
    spanToEvent: actual.spanToEvent,
    finishEvent: actual.finishEvent,
    newEventId: actual.newEventId,
    usesListeningSync: () => mockSync,
    closeSpan: jest.fn(async (span: OpenSpan) => {
      mockClosed.push(structuredClone(span));
    }),
    storeOpenSpan: (...a: unknown[]) => mockStoreOpenSpan(...a),
    appendEvents: jest.fn(async (_cid: string, events: ListeningEvent[]) => {
      mockAppended.push(...events);
    }),
    flushOutbox: (...a: unknown[]) => mockFlushOutbox(...a),
    sendOnPageHide: (...a: unknown[]) => mockSendOnPageHide(...a),
    withdrawFinish: (...a: unknown[]) => mockWithdraw(...a),
  };
});
// What an Undo's withdrawal took back (`unsent`: a finish the server never got).
const mockWithdraw = jest.fn(async (..._a: unknown[]) => ({
  unsent: true,
  restore: async () => {},
}));

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
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import * as reachability from '@/api/reachability';
import { useSettings } from '@/stores/settings';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';

import { finishTakesEvent, recordFinishEvent, undoFinish } from './finish-route';
import { appendEvents, closeSpan } from './listening-outbox';
import { flushHistoryOnHide, saveLoadedPlace, standByPlace, usePlayer } from './store';
/* eslint-enable import/first */

// A two-file folder book; the server now plays "2.mp3" before "10.mp3" (natural order).
const folder = 'A/Folder';
const order = ['A/Folder/2.mp3', 'A/Folder/10.mp3'];
const chapters: ChaptersResponse = {
  library_id: 2,
  path: folder,
  duration: 100,
  is_folder: true,
  files: order.map((rel_path, seq) => ({ rel_path, seq, duration: 50, format: 'mp3', size: 1 })),
  chapters: order.map((file_path, index) => ({
    index,
    title: `Chapter ${index + 1}`,
    file_index: index,
    file_path,
    start: 0,
    end: 50,
    book_offset: index * 50,
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
  duration: 100,
  format: 'mp3',
  size: 0,
};

const row = (p: Partial<Progress> = {}): Progress => ({
  library_id: 2,
  path: folder,
  position: 0,
  duration: 100,
  finished: false,
  playback_speed: 1,
  version: 0,
  device_id: 'dev-1',
  updated_at: '2026-01-01T00:00:00Z',
  ...p,
});

/** The book, downloaded on this device. */
const downloadedEntry = (): DownloadEntry => ({
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
    files: order.map((relPath) => ({ relPath, localUri: `file:///d/${relPath}` })),
    coverUri: 'file:///d/cover.jpg',
    savedAt: '2026-01-01T00:00:00.000Z',
  },
});

/** The save loop's pace for a book this device holds (`saveIntervalMs`); a streamed one
 * saves every 15 s. */
const LOCAL_SAVE_MS = 60_000;

const snap = (state: PlaybackState, trackIndex: number, position: number): PlaybackSnapshot => ({
  state,
  trackIndex,
  position,
  duration: 50,
  rate: 1,
});

async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Start the book: resume (no place given), or at `at` seconds. */
async function start(at?: number) {
  await usePlayer.getState().playBook('c1', 2, book, chapters, at);
  await settle();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockClosed.length = 0;
  mockAppended.length = 0;
  mockSync = true;
  mockReadMirror.mockResolvedValue({ ack_version: 41 });
  mockLoadInitialProgress.mockResolvedValue({ kind: 'empty' });
  useSettings.setState({ autoDownloadNext: 'never' });
  usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL }, rate: 1 });
  useDownloads.setState({ entries: {} });
});

afterEach(async () => {
  // Unload the book so the next test's start is a fresh span, not a switch.
  await usePlayer.getState().stop();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('without listening_sync (the PUT path, unchanged)', () => {
  it('saves by PUT and hands the outbox nothing', async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(21_000); // one 15 s save, and long enough for a history span
    pushSnapshot(snap('paused', 0, 20));
    await settle();
    expect(mockSaveProgress).toHaveBeenCalledTimes(2);
    expect(mockSaveProgress.mock.calls[1][1]).toMatchObject({ position: 20 });
    expect(mockClosed).toEqual([]);
    expect(mockAppended).toEqual([]);
    expect(mockClient.addHistory).toHaveBeenCalled(); // POST /history as before
  });
});

// fe#198: a session that began where the server was not checked guards its PUT saves.
describe('the replay guard on the PUT path', () => {
  const guards = () =>
    mockSaveProgress.mock.calls.map((c) => (c[1] as { guard?: boolean }).guard === true);

  beforeEach(() => {
    mockSync = false;
    mockSettled.clear();
  });

  /** `tick`: the save loop's pace for the book (`LOCAL_SAVE_MS` for a downloaded one). */
  async function playedTwoSaves(outcome: string, tick = 15_000) {
    mockSaveProgress.mockResolvedValueOnce(outcome as never);
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(tick);
    await settle();
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(tick);
    await settle();
  }

  it('an unchecked resume guards its saves until one is PUT', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    await playedTwoSaves('saved');
    expect(guards()).toEqual([true, false]);
  });

  it('a queued save replayed later lifts the guard (no read before every later save)', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    mockSaveProgress.mockResolvedValueOnce('queued' as never);
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000);
    await settle();
    const first = mockSaveProgress.mock.calls[0]?.[1] as { guard_session?: string };
    expect(first.guard_session).toEqual(expect.any(String));
    mockSettled.add(first.guard_session as string);
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(guards()).toEqual([true, false]);
  });

  it('a held save keeps the guard on', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    await playedTwoSaves('held');
    expect(guards()).toEqual([true, true]);
  });

  // The other device was still playing: its row had moved on from the one the offer named,
  // so the Stay's own save was held again, and each save after it, with no new offer.
  it("Stay on a held save's offer lifts the guard, whatever the other device saved since", async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    mockSaveProgress.mockResolvedValueOnce('held' as never);
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(guards()).toEqual([true]);
    saveLoadedPlace();
    await settle();
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(guards()).toEqual([true, false, false]);
  });

  it('a downloaded book that could not ask its server (started at 0) is guarded too', async () => {
    mockLoadInitialProgress.mockResolvedValue({ kind: 'failed' });
    useDownloads.setState({
      entries: { [`c1:2:${folder}`]: downloadedEntry() },
    });
    await start();
    await playedTwoSaves('queued', LOCAL_SAVE_MS);
    expect(guards()).toEqual([true, true]);
  });

  it('an adopted book (its place never looked up) is guarded too', async () => {
    useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloadedEntry() } });
    const adopted = await usePlayer.getState().adoptLoaded({
      connectionId: 'c1',
      libraryId: 2,
      path: folder,
      rate: 1,
      trackIndex: 0,
      position: 10,
      playing: true,
    });
    expect(adopted).toBe(true);
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await settle();
    expect(guards()).toEqual([true]);
  });

  it('a checked resume and an explicit place are not guarded', async () => {
    mockLoadInitialProgress.mockResolvedValue({ kind: 'progress', progress: row({ position: 5 }) });
    await start();
    await playedTwoSaves('saved');
    await usePlayer.getState().stop();
    await start(5);
    await playedTwoSaves('saved');
    expect(guards().every((g) => !g)).toBe(true);
  });

  it("an earlier session's save PUT late does not lift the next session's guard", async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    let landed: (o: string) => void = () => {};
    mockSaveProgress.mockImplementationOnce(
      () => new Promise((resolve) => (landed = resolve as (o: string) => void)) as never,
    );
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000);
    await settle();
    await usePlayer.getState().stop();
    await start();
    landed('saved');
    await settle();
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(guards().at(-1)).toBe(true);
  });

  it('a finish is never held back', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    pushSnapshot(snap('playing', 1, 45));
    await settle();
    usePlayer.getState().finishBook();
    await settle();
    expect(mockSaveProgress.mock.calls.at(-1)?.[1]).toMatchObject({ finished: true });
    expect(mockSaveProgress.mock.calls.at(-1)?.[1]).not.toHaveProperty('guard');
  });
});

describe('with listening_sync', () => {
  it('a play to a pause is one span with both file places, and no PUT and no POST /history', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 1, 10));
    pushSnapshot(snap('paused', 1, 10));
    await settle();
    expect(mockClosed).toHaveLength(1);
    expect(mockClosed[0]).toMatchObject({
      connectionId: 'c1',
      libraryId: 2,
      path: folder,
      from: { pos: 5, file: 'A/Folder/2.mp3', filePos: 5 },
      to: { pos: 60, file: 'A/Folder/10.mp3', filePos: 10 },
      duration: 100,
      start: 'resume',
      baseVersion: 41,
    });
    expect(mockSaveProgress).not.toHaveBeenCalled();
    expect(mockClient.addHistory).not.toHaveBeenCalled();
    // The local place is still mirrored, with its file (fe#188).
    expect(mockWriteMirror).toHaveBeenCalledWith(
      expect.objectContaining({ position: 60, file: 'A/Folder/10.mp3', file_pos: 10 }),
    );
    expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
  });

  it('the 15 s tick cuts the span while reachable; the next one continues', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 20));
    jest.advanceTimersByTime(21_000);
    await settle();
    pushSnapshot(snap('paused', 0, 30));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 5, 20],
      ['continue', 20, 30],
    ]);
    // Past the history minimum, still no POST /history: the spans are the history.
    expect(mockClient.addHistory).not.toHaveBeenCalled();
  });

  it('a seek while playing ends the span where it was; the next begins with the move', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    await usePlayer.getState().seekBook(70);
    pushSnapshot(snap('playing', 1, 20));
    await usePlayer.getState().seekBook(10);
    pushSnapshot(snap('playing', 0, 10));
    pushSnapshot(snap('paused', 0, 12));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 30, 30],
      ['jump', 70, 70],
      ['moved_back', 10, 12],
    ]);
  });

  it('a seek while paused sends the move as a span of its own', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    pushSnapshot(snap('paused', 0, 30));
    await settle();
    await usePlayer.getState().seekBook(80);
    await settle();
    expect(mockAppended).toEqual([
      expect.objectContaining({
        kind: 'listen',
        from_pos: 80,
        to_pos: 80,
        to_file: 'A/Folder/10.mp3',
        to_file_pos: 30,
        start: 'jump',
        base_version: 41,
      }),
    ]);
  });

  it('an explicit 0 is a restart; an explicit place is a jump', async () => {
    await start(0);
    pushSnapshot(snap('playing', 0, 1));
    pushSnapshot(snap('paused', 0, 4));
    await settle();
    await usePlayer.getState().stop();
    await start(40);
    pushSnapshot(snap('playing', 0, 40));
    pushSnapshot(snap('paused', 0, 45));
    await settle();
    expect(mockClosed.map((s) => s.start)).toEqual(['restart', 'jump']);
  });

  it('a finished book started again sends unfinish, then a restart span', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 100, finished: true, version: 9, device_id: 'phone' }),
    });
    await start();
    pushSnapshot(snap('playing', 0, 0.5));
    await settle();
    pushSnapshot(snap('paused', 0, 6));
    await settle();
    expect(mockAppended).toEqual([
      expect.objectContaining({ kind: 'unfinish', library_id: 2, path: folder, base_version: 41 }),
    ]);
    expect(mockClosed.map((s) => s.start)).toEqual(['restart']);
    // Resumed from the server's row: its version is acknowledged.
    expect(mockAckVersion).toHaveBeenCalledWith('c1', 2, folder, 9, expect.anything());
  });

  it('the natural end closes the span, then sends finish once', async () => {
    await start();
    pushSnapshot(snap('playing', 1, 45));
    await settle();
    pushSnapshot(snap('ended', 1, 50));
    await settle();
    usePlayer.getState().finishBook();
    await settle();
    expect(mockClosed).toHaveLength(1);
    expect(mockAppended.filter((e) => e.kind === 'finish')).toHaveLength(1);
  });

  // server#359: a 12 s book's finish was sent before its only span, in a batch of its own.
  it('a short book ends: its span goes into the outbox before the finish, then one send', async () => {
    const order: string[] = [];
    (closeSpan as jest.Mock).mockImplementationOnce(async (closing: OpenSpan) => {
      await settle(6); // the close waits its turn (the open-span lock, the base read)
      mockClosed.push(structuredClone(closing));
      order.push('listen');
    });
    (appendEvents as jest.Mock).mockImplementationOnce(
      async (_cid: string, events: ListeningEvent[]) => {
        mockAppended.push(...events);
        order.push(...events.map((e) => e.kind));
      },
    );
    mockFlushOutbox.mockImplementation(async () => {
      order.push('flush');
    });
    try {
      await start();
      pushSnapshot(snap('playing', 0, 0));
      await settle();
      jest.advanceTimersByTime(12_000);
      pushSnapshot(snap('ended', 1, 50));
      await settle(20);
      expect(order).toEqual(['listen', 'finish', 'flush']);
      expect(mockAppended).toEqual([
        expect.objectContaining({ kind: 'finish', library_id: 2, path: folder, base_version: 41 }),
      ]);
      // The finish is dated at or after the span's end.
      const finish = mockAppended[0] as { at: string };
      expect(Date.parse(finish.at)).toBeGreaterThanOrEqual(Date.parse(mockClosed[0].endedAt));
    } finally {
      mockFlushOutbox.mockImplementation(async () => {});
    }
  });

  // The web reports `paused` for the last file before `ended`: that pause's close was still
  // on its way into the outbox when the end's finish was appended, and went after it.
  it('a close still on its way at the end goes before the finish, in one send', async () => {
    const order: string[] = [];
    (closeSpan as jest.Mock).mockImplementationOnce(async (closing: OpenSpan) => {
      await settle(6);
      mockClosed.push(structuredClone(closing));
      order.push('listen');
    });
    (appendEvents as jest.Mock).mockImplementationOnce(
      async (_cid: string, events: ListeningEvent[]) => {
        mockAppended.push(...events);
        order.push(...events.map((e) => e.kind));
      },
    );
    mockFlushOutbox.mockImplementation(async () => {
      order.push('flush');
    });
    try {
      await start();
      pushSnapshot(snap('playing', 0, 0));
      await settle();
      jest.advanceTimersByTime(12_000);
      pushSnapshot(snap('paused', 1, 50));
      pushSnapshot(snap('ended', 1, 50));
      await settle(30);
      expect(order).toEqual(['listen', 'finish', 'flush']);
    } finally {
      mockFlushOutbox.mockImplementation(async () => {});
    }
  });

  it('a finish still goes when its span could not be stored', async () => {
    (closeSpan as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('storage full');
    });
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('ended', 1, 50));
    await settle(12);
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
    expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
  });

  it('after Stay, the next span begins as a jump', async () => {
    await start();
    standByPlace();
    pushSnapshot(snap('playing', 0, 5));
    pushSnapshot(snap('paused', 0, 9));
    await settle();
    expect(mockClosed.map((s) => s.start)).toEqual(['jump']);
  });

  it('the web page going closes the span and sends it with keepalive', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 25));
    flushHistoryOnHide(true);
    expect(mockSendOnPageHide).toHaveBeenCalledTimes(1);
    const [extra, deviceId] = mockSendOnPageHide.mock.calls[0] as [
      { connectionId: string; event: ListeningEvent }[],
      string,
    ];
    expect(deviceId).toBe('dev-1');
    expect(extra).toEqual([
      {
        connectionId: 'c1',
        event: expect.objectContaining({ kind: 'listen', from_pos: 5, to_pos: 25 }),
      },
    ]);
    expect(mockClient.addHistory).not.toHaveBeenCalled();
  });
});

// fe#208: the book page's Mark as finished is a `finish` event on a Sync v2 server.
describe('Mark as finished outside the player (finish-route)', () => {
  const ref = { connectionId: 'c1', libraryId: 2, path: folder, position: 100, duration: 100 };
  const undoRef = { connectionId: 'c1', libraryId: 2, path: 'Other/Book', position: 48 };

  it('the loaded, playing book: its span closes first, then the finish; the mirror reads finished', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 9));
    await expect(recordFinishEvent(ref)).resolves.toBe(true);
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 5, 9]]);
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
    expect(mockWriteMirror).toHaveBeenCalledWith(
      expect.objectContaining({ path: folder, finished: true, position: 100, duration: 100 }),
    );
    expect(mockSaveProgress).not.toHaveBeenCalled();
    // Still playing: the next tick opens the next span.
    pushSnapshot(snap('playing', 1, 40));
    jest.advanceTimersByTime(15_000);
    await settle();
    pushSnapshot(snap('paused', 1, 45));
    await settle();
    expect(mockClosed.at(-1)).toMatchObject({ from: { pos: 90 }, to: { pos: 95 } });
  });

  // The server applies a batch in time order (request order only breaks ties): a finish
  // dated before its book's last span was applied first, as server#359's was.
  it("the finish is dated no earlier than the loaded book's last span", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 9));
    // A clock that ticks between any two readings.
    let n = 0;
    const iso = jest
      .spyOn(Date.prototype, 'toISOString')
      .mockImplementation(() => `2026-10-25T08:00:00.${String(n++).padStart(3, '0')}Z`);
    try {
      await recordFinishEvent(ref);
    } finally {
      iso.mockRestore();
    }
    const finish = mockAppended.find((e) => e.kind === 'finish') as { at: string };
    expect(mockClosed).toHaveLength(1);
    expect(finish.at >= (mockClosed[0].endedAt ?? '')).toBe(true);
  });

  // An offline Mark as finished then Undo: the PATCH would fail, and the finish put back
  // went out on reconnect and finished the book after all.
  it('Undo of a finish that never left: the mirror goes back to before it, no edit', async () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1.2,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
      ack_version: 7,
    };
    mockReadMirror.mockResolvedValueOnce(before);
    try {
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      expect(mockWriteMirror).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: 'Other/Book', finished: true }),
      );
      // The mirror holds the finish's record by the Undo.
      const finishedRec = mockWriteMirror.mock.calls.at(-1)?.[0] as { updated_at: string };
      mockReadMirror.mockResolvedValueOnce(finishedRec);
      const edit = jest.fn(async () => true);
      await expect(undoFinish(undoRef, edit)).resolves.toBe(true);
      expect(mockWithdraw).toHaveBeenCalledWith('c1', 2, 'Other/Book');
      expect(edit).not.toHaveBeenCalled();
      // Stamped just after the finish it replaces: the mirror refuses an older record, and a
      // read of the finished row still on its way, stamped as the finish, loses to it (fe#258).
      const finishedAt = finishedRec.updated_at;
      const after = new Date(Date.parse(finishedAt) + 1).toISOString();
      // Its Sync v2 fields are left to the mirror's own (an ack since the finish is newer).
      expect(mockWriteMirror).toHaveBeenLastCalledWith({
        ...before,
        ack_version: undefined,
        answered: undefined,
        updated_at: after,
      });
      expect(after > finishedAt && finishedAt > before.updated_at).toBe(true);
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: qk.progress('c1', 2, 'Other/Book'),
      });
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it('Undo here with no record before the finish: only the finished record is undone', async () => {
    const finishedRec = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 100,
      duration: 100,
      finished: true,
      device_id: 'dev-1',
      updated_at: '2026-01-02T00:00:00Z',
    };
    try {
      mockReadMirror.mockResolvedValueOnce(null);
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      mockReadMirror.mockResolvedValueOnce(finishedRec);
      await undoFinish(
        undoRef,
        jest.fn(async () => true),
      );
      expect(mockWriteMirror).toHaveBeenLastCalledWith({
        ...finishedRec,
        finished: false,
        position: 48,
        updated_at: '2026-01-02T00:00:00.001Z',
      });
      // A place saved since the finish is not undone.
      mockReadMirror.mockResolvedValueOnce(null);
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      const writes = mockWriteMirror.mock.calls.length;
      mockReadMirror.mockResolvedValueOnce({ ...finishedRec, finished: false, position: 70 });
      await undoFinish(
        undoRef,
        jest.fn(async () => true),
      );
      expect(mockWriteMirror).toHaveBeenCalledTimes(writes);
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  // The edit's answer only reaches the query caches: the mirror kept the finish's record
  // (finished, at the end), and the next offline Play started the book again at 0.
  it('Undo of a finish the server has: the edit, then the mirror back to before it', async () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
    };
    mockReadMirror.mockResolvedValueOnce(before);
    try {
      mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      // The server answered for the finish and its row was read again: a downloaded book's
      // record is that row by now, stamped by the server's clock, later than the finish's
      // own time. A record stamped with the finish's time was refused as older.
      const echo = {
        ...(mockWriteMirror.mock.calls.at(-1)?.[0] as object),
        updated_at: '2999-01-01T00:00:00.000Z',
      };
      mockReadMirror.mockResolvedValueOnce(echo);
      const edit = jest.fn(async () => true);
      await expect(undoFinish(undoRef, edit)).resolves.toBe(true);
      expect(edit).toHaveBeenCalledTimes(1);
      expect(mockWriteMirror).toHaveBeenLastCalledWith(
        expect.objectContaining({
          path: 'Other/Book',
          finished: false,
          position: 48,
          updated_at: '2999-01-01T00:00:00.001Z',
        }),
      );
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it('Undo after a place saved since the finish: that place stays', async () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
    };
    mockReadMirror.mockResolvedValueOnce(before);
    try {
      mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      const writes = mockWriteMirror.mock.calls.length;
      mockReadMirror.mockResolvedValueOnce({
        ...before,
        position: 70,
        updated_at: '2999-01-01T00:00:00.000Z',
      });
      await undoFinish(
        undoRef,
        jest.fn(async () => true),
      );
      expect(mockWriteMirror).toHaveBeenCalledTimes(writes);
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it('Undo whose edit failed: the mirror keeps the finish (it is sent again)', async () => {
    mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
    await recordFinishEvent({ ...ref, path: 'Other/Book' });
    const writes = mockWriteMirror.mock.calls.length;
    await expect(
      undoFinish(
        undoRef,
        jest.fn(async () => false),
      ),
    ).resolves.toBe(false);
    expect(mockWriteMirror).toHaveBeenCalledTimes(writes);
  });

  // Marked finished from its page while loaded and paused, then undone: the player's own
  // Mark as finished was taken for a second finish of the same end, and sent nothing.
  it('after an Undo the player can finish the loaded book again', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('paused', 0, 9));
    await settle();
    mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
    await recordFinishEvent(ref);
    await undoFinish(
      { connectionId: 'c1', libraryId: 2, path: folder, position: 9 },
      jest.fn(async () => true),
    );
    mockAppended.length = 0;
    usePlayer.getState().finishBook();
    await settle();
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
  });

  it("keeps the book's own speed in the mirror (the book page gives none)", async () => {
    mockReadMirror.mockResolvedValue({ ack_version: 41, playback_speed: 1.6 });
    await recordFinishEvent({ ...ref, path: 'Other/Book' });
    expect(mockWriteMirror).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Other/Book', finished: true, playback_speed: 1.6 }),
    );
  });

  it('a book that is not loaded: only the finish, queued even with its server away', async () => {
    const reach = jest.spyOn(reachability, 'isReachable').mockReturnValue(false);
    try {
      await start();
      pushSnapshot(snap('playing', 0, 5));
      await settle();
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      expect(mockClosed).toEqual([]);
      expect(mockAppended).toEqual([
        expect.objectContaining({ kind: 'finish', path: 'Other/Book' }),
      ]);
    } finally {
      reach.mockRestore();
    }
  });

  it('the lists read again once the finish was sent (the caller read them before the send)', async () => {
    await start();
    let sent: () => void = () => {};
    mockFlushOutbox.mockImplementation(() => new Promise<void>((resolve) => (sent = resolve)));
    try {
      const invalidate = queryClient.invalidateQueries as jest.Mock;
      invalidate.mockClear();
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.allProgress('c1') });
      sent();
      await settle();
      expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.allProgress('c1') });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.progress('c1', 2, 'Other/Book') });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.myStatsAll('c1') });
    } finally {
      mockFlushOutbox.mockImplementation(async () => {});
    }
  });

  it('a server without listening events: not recorded, the caller saves by PUT', async () => {
    mockSync = false;
    expect(finishTakesEvent('c1')).toBe(false);
    await expect(recordFinishEvent(ref)).resolves.toBe(false);
    expect(mockAppended).toEqual([]);
    expect(mockWriteMirror).not.toHaveBeenCalled();
  });
});

describe('a span opens whenever the book plays', () => {
  const historyBody = (call: number) =>
    (mockClient.addHistory.mock.calls[call] as unknown[])[2] as {
      from_pos: number;
      to_pos: number;
    };

  // The 5 s keep opens it (`keepOpenSpan`), not the save loop's tick, which may be a minute
  // away (`saveIntervalMs`): what plays before a span opens is in no listening event.
  it('a play the engine reports while the load holds the place opens its span within the keep', async () => {
    (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('playing', 0, 5)); // Android keeps playWhenReady through a load
    });
    await start();
    pushSnapshot(snap('playing', 0, 8));
    jest.advanceTimersByTime(5_000);
    await settle();
    pushSnapshot(snap('paused', 0, 25));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 8, 25]]);
  });

  it('a play on its way to a pause opens none: the pause is asked for, the engine yet to report it', async () => {
    (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('playing', 0, 5));
    });
    await start();
    pushSnapshot(snap('playing', 0, 8));
    // As a tab that gives way does: the intent dropped and the engine told to pause, its
    // snapshot still `playing` (a Cast receiver takes a second or two to confirm).
    await usePlayer.getState().toggle();
    jest.advanceTimersByTime(5_000);
    await settle();
    pushSnapshot(snap('paused', 0, 9));
    await settle();
    expect(mockClosed).toEqual([]);
  });

  it('a server that takes listening events only since the book began gets a span within the keep', async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000); // a PUT save
    mockSync = true; // its `/server` was read while the book played
    pushSnapshot(snap('playing', 0, 30));
    jest.advanceTimersByTime(5_000);
    await settle();
    pushSnapshot(snap('paused', 0, 40));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 30, 40]]);
    // What the PUT path began goes by POST /history, up to where the span took over.
    expect(mockClient.addHistory).toHaveBeenCalledTimes(1);
    expect(historyBody(0)).toMatchObject({ from_pos: 5, to_pos: 30 });
  });

  it('a finished book started again from a place sends unfinish; the row it saw is acknowledged', async () => {
    const cached = row({
      position: 100,
      finished: true,
      version: 12,
      device_id: 'phone',
      updated_at: '2026-02-01T00:00:00Z',
    });
    const key = JSON.stringify(qk.progress('c1', 2, folder));
    (queryClient.getQueryData as jest.Mock).mockImplementation((k: unknown) =>
      JSON.stringify(k) === key ? cached : undefined,
    );
    try {
      await start(40); // a chapter tap on the book page
      pushSnapshot(snap('playing', 0, 40));
      pushSnapshot(snap('paused', 0, 45));
      await settle();
    } finally {
      (queryClient.getQueryData as jest.Mock).mockImplementation(() => undefined);
    }
    expect(mockAppended).toEqual([
      expect.objectContaining({ kind: 'unfinish', library_id: 2, path: folder }),
    ]);
    expect(mockClosed.map((s) => s.start)).toEqual(['jump']);
    expect(mockAckVersion).toHaveBeenCalledWith('c1', 2, folder, 12, cached);
  });

  describe('an adopted book (adoptLoaded)', () => {
    const loaded = { connectionId: 'c1', libraryId: 2, path: folder, rate: 1 };
    beforeEach(() => useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloadedEntry() } }));

    it('a playing one opens its span at once (the store set its `playing`)', async () => {
      const adopted = await usePlayer
        .getState()
        .adoptLoaded({ ...loaded, trackIndex: 1, position: 10, playing: true });
      expect(adopted).toBe(true);
      pushSnapshot(snap('playing', 1, 20));
      pushSnapshot(snap('paused', 1, 20));
      await settle();
      expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 60, 70]]);
    });

    it('a paused one reloaded in its order opens its span on its first play', async () => {
      (queryClient.fetchQuery as jest.Mock).mockRejectedValueOnce(
        new TypeError('Network request failed'),
      );
      // The engine plays 10.mp3 first (an older order): reloaded in the download's, where it
      // is the second file.
      const adopted = await usePlayer.getState().adoptLoaded({
        ...loaded,
        files: ['A/Folder/10.mp3', 'A/Folder/2.mp3'],
        trackIndex: 0,
        position: 10,
        playing: false,
      });
      expect(adopted).toBe(true);
      expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 10]);
      pushSnapshot(snap('paused', 1, 10));
      await settle();
      pushSnapshot(snap('playing', 1, 10));
      pushSnapshot(snap('paused', 1, 20));
      await settle();
      expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 60, 70]]);
    });
  });
});

describe('what a span carries', () => {
  it("sends the audio's length, not a timeline a chapter overhangs", async () => {
    const overhang: ChaptersResponse = {
      ...chapters,
      chapters: [...chapters.chapters, { ...chapters.chapters[1], index: 2, start: 50, end: 80 }],
    };
    await usePlayer.getState().playBook('c1', 2, book, overhang, undefined);
    await settle();
    expect(usePlayer.getState().nowPlaying?.queue.total).toBeGreaterThan(100);
    pushSnapshot(snap('playing', 0, 5));
    pushSnapshot(snap('paused', 0, 20));
    await settle();
    expect(mockClosed.map((s) => s.duration)).toEqual([100]);
  });

  // Pixel 6a: a download that ends before its book played from its own copy sent the
  // downloaded part's length, and the server refused every listen (duration_mismatch).
  describe('over a download that ends before its book does (D3)', () => {
    const withEnd = (bookDuration?: number): DownloadEntry => {
      const e = downloadedEntry();
      return {
        ...e,
        manifest: {
          ...e.manifest,
          endsBefore: 'A/Folder/30.mp3',
          ...(bookDuration === undefined ? {} : { bookDuration }),
        },
      };
    };
    const playOffline = async (entry: DownloadEntry) => {
      useDownloads.setState({ entries: { [`c1:2:${folder}`]: entry } });
      const reach = jest.spyOn(reachability, 'isReachable').mockReturnValue(false);
      try {
        await usePlayer.getState().playBook('c1', 2, book, chapters, undefined);
        await settle();
      } finally {
        reach.mockRestore();
      }
      pushSnapshot(snap('playing', 0, 5));
      pushSnapshot(snap('paused', 0, 20));
      await settle();
    };

    it("sends the book's length on its server, and saves it", async () => {
      await playOffline(withEnd(160));
      expect(usePlayer.getState().nowPlaying?.queue.audio).toBe(100);
      expect(mockClosed.map((s) => s.duration)).toEqual([160]);
      await usePlayer.getState().pause();
      await settle();
      const durations = mockWriteMirror.mock.calls.map(
        (c) => (c[0] as { duration: number }).duration,
      );
      expect(durations.length).toBeGreaterThan(0);
      expect(durations.every((d) => d === 160)).toBe(true);
    });

    it('sends no length when the download does not know it (the server checks none)', async () => {
      await playOffline(withEnd());
      expect(mockClosed.map((s) => s.duration)).toEqual([0]);
    });
  });

  it('never takes a place that is not a number', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, Number.NaN));
    jest.advanceTimersByTime(15_000); // a cut while the engine reports NaN
    await settle();
    await usePlayer.getState().seekBook(Number.NaN);
    pushSnapshot(snap('paused', 0, Number.NaN));
    await settle();
    expect(mockClosed.length).toBeGreaterThan(0);
    const numbers = mockClosed.flatMap((s) => [s.from.pos, s.to.pos, s.from.filePos ?? 0]);
    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(mockAppended.every((e) => e.kind !== 'listen' || Number.isFinite(e.to_pos))).toBe(true);
    const saved = mockWriteMirror.mock.calls.map((c) => (c[0] as { position: number }).position);
    expect(saved.every(Number.isFinite)).toBe(true);
  });
});

describe('a long offline run', () => {
  it('is cut every hour of wall clock, though no server is there to cut it', async () => {
    const reach = jest.spyOn(reachability, 'isReachable').mockReturnValue(false);
    try {
      await start();
      pushSnapshot(snap('playing', 0, 1));
      await settle();
      for (let i = 0; i < 8 * 60 + 2; i++) {
        pushSnapshot(snap('playing', 0, 1 + (i % 40)));
        jest.advanceTimersByTime(15_000);
        await settle(2);
      }
      await settle();
      // Two hours and half a minute of ticks: two whole-hour spans closed, one still open.
      expect(mockClosed.map((s) => s.start)).toEqual(['resume', 'continue']);
      const hours = mockClosed.map((s) => Date.parse(s.endedAt) - Date.parse(s.startedAt));
      expect(hours.every((ms) => ms >= 60 * 60_000 && ms < 61 * 60_000)).toBe(true);
    } finally {
      reach.mockRestore();
    }
  });
});

// W2 F1: a force-stop between two 15 s cuts lost the open span, which lived only in memory.
describe('the open span is kept every 5 s', () => {
  const stored = () =>
    mockStoreOpenSpan.mock.calls.map((c) => {
      const span = c[0] as OpenSpan;
      return [span.start, span.from.pos, span.to.pos];
    });

  it('online too, up to where the engine is, from the span the last cut opened', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    pushSnapshot(snap('playing', 0, 6));
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(stored()).toEqual([['resume', 1, 6]]);
    pushSnapshot(snap('playing', 0, 16));
    jest.advanceTimersByTime(10_000); // the 15 s cut, then the next span is kept
    await settle();
    pushSnapshot(snap('playing', 0, 23));
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(stored().at(-1)).toEqual(['continue', 16, 23]);
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 1, 16]]);
  });

  // A native lock-screen move: the engine's landed place reaches the store before the move.
  it('never moves the span back: a remote move landing as the keep is due ends where it was', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    pushSnapshot(snap('playing', 0, 6));
    jest.advanceTimersByTime(5_000);
    await settle();
    jest.advanceTimersByTime(4_950); // the next keep is due (within its slack)
    pushSnapshot(snap('playing', 0, 2)); // landed 4 s back: the keep runs on this snapshot
    remoteMove(0, 2);
    await settle();
    expect(stored().at(-1)).toEqual(['resume', 1, 6]);
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 1, 6]]);
    pushSnapshot(snap('paused', 0, 3));
    await settle();
    expect(mockClosed.at(-1)).toMatchObject({ start: 'moved_back', from: { pos: 2 } });
  });

  // fe#211 review: the keep's rule on the cut froze the span at a stale place.
  it('the 15 s cut ends where the engine is, after a seek back and a late old place', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 40));
    await settle();
    await usePlayer.getState().seekBook(10);
    jest.advanceTimersByTime(4_950); // the keep is due
    pushSnapshot(snap('playing', 0, 40)); // a late event from before the seek
    pushSnapshot(snap('playing', 0, 12));
    jest.advanceTimersByTime(10_000); // the cut is due
    pushSnapshot(snap('playing', 0, 22));
    await settle();
    pushSnapshot(snap('paused', 0, 24));
    await settle();
    expect(mockClosed.slice(1).map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['moved_back', 10, 22],
      ['continue', 22, 24],
    ]);
  });

  it('stops with the playing: a pause stores nothing more', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    pushSnapshot(snap('paused', 0, 3));
    await settle();
    mockStoreOpenSpan.mockClear();
    jest.advanceTimersByTime(20_000);
    await settle();
    expect(mockStoreOpenSpan).not.toHaveBeenCalled();
  });
});

describe('resume by file (fe#188)', () => {
  it("lands in the saved file at its own seconds, though the server's order moved it", async () => {
    // Saved on the download's old order (10.mp3 first): 10 s into 10.mp3 was book second
    // 10 there, which is 2.mp3 in the order the server plays now.
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 10 }),
      file: { path: 'A/Folder/10.mp3', pos: 10 },
    });
    await start();
    const [, index, positionInTrack] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect([index, positionInTrack]).toEqual([1, 10]);
  });

  it('a file the queue no longer has resumes by the book position', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 10 }),
      file: { path: 'A/Folder/gone.mp3', pos: 30 },
    });
    await start();
    const [, index, positionInTrack] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect([index, positionInTrack]).toEqual([0, 10]);
  });

  it('clamps the seconds to the file length', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 10 }),
      file: { path: 'A/Folder/2.mp3', pos: 400 },
    });
    await start();
    const [, index, positionInTrack] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect([index, positionInTrack]).toEqual([0, 50]);
  });
});
