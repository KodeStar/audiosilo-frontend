import type { Book, ChaptersResponse, ListeningEvent, Progress } from '@/api/types';

import type { OpenSpan } from './listening-outbox';
import type { ResumeLookup } from './progress-sync';
import type { PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

// Sync v2's spans in the store (Track W1): what the store hands the outbox on a server with
// `listening_sync`, and that it hands it nothing (the PUT path, as before) without it. The
// engine is a fake whose snapshots a test pushes; the outbox's storage and sending are
// captured, its pure event builders are the real ones.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
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
}));

// The outbox: the path choice is the test's, storage and sending are captured.
let mockSync = true;
const mockClosed: OpenSpan[] = [];
const mockAppended: ListeningEvent[] = [];
const mockSendOnPageHide = jest.fn((..._a: unknown[]) => {});
const mockFlushOutbox = jest.fn(async (..._a: unknown[]) => {});
jest.mock('./listening-outbox', () => {
  const actual = jest.requireActual('./listening-outbox');
  return {
    spanToEvent: actual.spanToEvent,
    finishEvent: actual.finishEvent,
    usesListeningSync: () => mockSync,
    closeSpan: jest.fn(async (span: OpenSpan) => {
      mockClosed.push(structuredClone(span));
    }),
    storeOpenSpan: jest.fn(async () => {}),
    appendEvents: jest.fn(async (_cid: string, events: ListeningEvent[]) => {
      mockAppended.push(...events);
    }),
    flushOutbox: (...a: unknown[]) => mockFlushOutbox(...a),
    sendOnPageHide: (...a: unknown[]) => mockSendOnPageHide(...a),
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
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { useSettings } from '@/stores/settings';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';

import { flushHistoryOnHide, standByPlace, usePlayer } from './store';
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

describe('a span opens whenever the book plays', () => {
  const historyBody = (call: number) =>
    (mockClient.addHistory.mock.calls[call] as unknown[])[2] as {
      from_pos: number;
      to_pos: number;
    };

  it('a play the engine reports while the load holds the place opens its span on the next tick', async () => {
    (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('playing', 0, 5)); // Android keeps playWhenReady through a load
    });
    await start();
    pushSnapshot(snap('playing', 0, 8));
    jest.advanceTimersByTime(15_000);
    await settle();
    pushSnapshot(snap('paused', 0, 25));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 8, 25]]);
  });

  it('a server that takes listening events only since the book began gets a span from the next tick', async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000); // a PUT save
    mockSync = true; // its `/server` was read while the book played
    pushSnapshot(snap('playing', 0, 30));
    jest.advanceTimersByTime(15_000);
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
    const downloaded = (): DownloadEntry => ({
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
    const loaded = { connectionId: 'c1', libraryId: 2, path: folder, rate: 1 };
    beforeEach(() => useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloaded() } }));

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
