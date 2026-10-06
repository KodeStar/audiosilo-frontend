import { QueryClient } from '@tanstack/react-query';

import type { Book } from '@/api/types';

// The controller's collaborators, faked: one connection whose client answers from the
// maps below, a player store holding `nowPlaying`, and a downloads store recording what
// was queued.
jest.mock('@/api/provider', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { QueryClient: QC } = require('@tanstack/react-query');
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});
jest.mock('@/api/connection-clients', () => ({ resolveClient: jest.fn() }));
jest.mock('@/lib/network', () => ({
  canAutoDownload: jest.fn(async () => true),
  onNetworkChange: jest.fn(() => () => undefined),
}));
jest.mock('@/playback/next-book', () => ({ resolveNextBook: jest.fn(async () => null) }));
jest.mock('@/playback/store', () => ({
  usePlayer: {
    getState: jest.fn(() => ({ nowPlaying: null })),
    subscribe: jest.fn(() => () => {}),
  },
}));
jest.mock('@/downloads/engine', () => ({
  engine: { storageEstimate: jest.fn(async () => null) },
}));
jest.mock('@/downloads/store', () => ({
  isDeclined: jest.fn(() => false),
  useDownloads: { getState: jest.fn(), subscribe: jest.fn(() => () => {}) },
}));

/* eslint-disable import/first */
import { resolveClient } from '@/api/connection-clients';
import { queryClient } from '@/api/provider';
import { engine } from '@/downloads/engine';
import {
  runKeepAhead,
  SETTLE_MS,
  startKeepAhead,
  useKeepAhead,
} from '@/downloads/keep-ahead-controller';
import { isDeclined, useDownloads } from '@/downloads/store';
import { canAutoDownload } from '@/lib/network';
import { resolveNextBook } from '@/playback/next-book';
import { usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';
/* eslint-enable import/first */

const GB = 1024 ** 3;

function book(path: string, p: Partial<Book> = {}): Book {
  return {
    id: 1,
    library_id: 1,
    rel_path: path,
    is_folder: true,
    title: path,
    author: 'Author',
    series: 'S',
    series_index: 1,
    narrator: '',
    duration: 3600,
    format: 'm4b',
    size: 100 * 1024 ** 2,
    ...p,
  };
}

// Book N's next is book N+1, up to 5.
const nextOf = (path: string) => {
  const n = Number(path.replace('B', ''));
  return n < 5
    ? { source: 'series', next: { library_id: 1, path: `B${n + 1}` }, book: book(`B${n + 1}`) }
    : { source: 'none' };
};

let caps: Record<string, boolean>;
let queue: { library_id: number; path: string; added_at: string; book?: Book }[];
let progress: { library_id: number; path: string; finished: boolean }[];
const download = jest.fn();
let entries: Record<
  string,
  { status: string; bytes: number; totalBytes: number; manifest: unknown }
>;

const client = {
  serverInfo: jest.fn(async () => ({ capabilities: caps })),
  queue: jest.fn(async () => queue),
  allProgress: jest.fn(async () => progress),
  nextBook: jest.fn(async (_lib: number, path: string) => nextOf(path)),
  item: jest.fn(async (_lib: number, path: string) => book(path)),
  chapters: jest.fn(async (_lib: number, path: string) => ({ path, chapters: [], files: [] })),
};

beforeEach(() => {
  jest.clearAllMocks();
  (queryClient as QueryClient).clear();
  caps = { queue: true, next_book: true };
  queue = [];
  progress = [];
  entries = {};
  (resolveClient as jest.Mock).mockReturnValue(client);
  // Implementations a test installed don't outlive it.
  (isDeclined as jest.Mock).mockReset().mockReturnValue(false);
  (resolveNextBook as jest.Mock).mockReset().mockResolvedValue(null);
  (canAutoDownload as jest.Mock).mockReset().mockResolvedValue(true);
  (usePlayer.getState as jest.Mock).mockReturnValue({
    nowPlaying: { connectionId: 'c1', libraryId: 1, path: 'B1' },
  });
  (useDownloads.getState as jest.Mock).mockImplementation(() => ({
    supported: true,
    hydrated: true,
    entries,
    download,
  }));
  (engine.storageEstimate as jest.Mock).mockResolvedValue({
    scope: 'device',
    capacity: 128 * GB,
    free: 60 * GB,
  });
  useSettings.setState({ keepAhead: 2, autoDownloadNext: 'wifi' });
});

const queued = () => download.mock.calls.map((c) => `${c[2].rel_path}:${c[4]}`);

describe('runKeepAhead', () => {
  it('does nothing while the setting is off', async () => {
    useSettings.setState({ keepAhead: 0 });
    await runKeepAhead();
    expect(useKeepAhead.getState().status).toBe('off');
    expect(client.serverInfo).not.toHaveBeenCalled();
  });

  it('downloads the next books in the series, marked as kept ahead', async () => {
    await runKeepAhead();
    expect(queued()).toEqual(['B2:keep-ahead', 'B3:keep-ahead']);
    expect(useKeepAhead.getState().status).toBe('working');
    // The chain stops at the window: no third /next.
    expect(client.nextBook).toHaveBeenCalledTimes(2);
  });

  it('takes Up next first, skipping finished and unindexed entries', async () => {
    queue = [
      { library_id: 1, path: 'Done', added_at: '', book: book('Done') },
      { library_id: 1, path: 'Ghost', added_at: '' },
      { library_id: 1, path: 'Q1', added_at: '', book: book('Q1') },
    ];
    progress = [{ library_id: 1, path: 'Done', finished: true }];
    await runKeepAhead();
    expect(queued()).toEqual(['Q1:keep-ahead', 'B2:keep-ahead']);
  });

  it('skips the series when the queue fills the window', async () => {
    queue = ['Q1', 'Q2'].map((p) => ({ library_id: 1, path: p, added_at: '', book: book(p) }));
    await runKeepAhead();
    expect(queued()).toEqual(['Q1:keep-ahead', 'Q2:keep-ahead']);
    expect(client.nextBook).not.toHaveBeenCalled();
  });

  it('asks nothing a server lacks: no queue read, folder order for the series', async () => {
    caps = {};
    (resolveNextBook as jest.Mock).mockImplementation(async (_c, _l, path: string) =>
      path === 'B1' ? { name: 'B2', path: 'B2', is_dir: true, is_book: true, size: 0 } : null,
    );
    await runKeepAhead();
    expect(client.queue).not.toHaveBeenCalled();
    expect(client.nextBook).not.toHaveBeenCalled();
    expect(queued()).toEqual(['B2:keep-ahead']);
  });

  it('respects the network rule', async () => {
    useSettings.setState({ autoDownloadNext: 'never' });
    await runKeepAhead();
    expect(useKeepAhead.getState().status).toBe('never');
    useSettings.setState({ autoDownloadNext: 'wifi' });
    (canAutoDownload as jest.Mock).mockResolvedValueOnce(false);
    await runKeepAhead();
    expect(useKeepAhead.getState().status).toBe('waiting');
    expect(download).not.toHaveBeenCalled();
  });

  it('never fetches again what the listener removed this session', async () => {
    (isDeclined as jest.Mock).mockImplementation((_c, _l, path: string) => path === 'B2');
    await runKeepAhead();
    expect(queued()).toEqual(['B3:keep-ahead']);
  });

  it('waits for the registry, and leaves what it already holds', async () => {
    (useDownloads.getState as jest.Mock).mockImplementation(() => ({
      supported: true,
      hydrated: false,
      entries,
      download,
    }));
    await runKeepAhead();
    expect(download).not.toHaveBeenCalled();
    (useDownloads.getState as jest.Mock).mockImplementation(() => ({
      supported: true,
      hydrated: true,
      entries: { 'c1:1:B2': { status: 'downloaded', bytes: 1, totalBytes: 1, manifest: {} } },
      download,
    }));
    await runKeepAhead();
    expect(queued()).toEqual(['B3:keep-ahead']);
    expect(client.nextBook).toHaveBeenCalled();
  });

  it('does not fill the disk', async () => {
    (engine.storageEstimate as jest.Mock).mockResolvedValue({
      scope: 'device',
      capacity: 32 * GB,
      free: 1.1 * GB,
    });
    await runKeepAhead();
    expect(download).not.toHaveBeenCalled();
    expect(useKeepAhead.getState().status).toBe('no-space');
  });

  it('plans nothing, quietly, when the server is unreachable', async () => {
    client.serverInfo.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await runKeepAhead();
    expect(useKeepAhead.getState().status).toBe('idle');
    expect(download).not.toHaveBeenCalled();
  });

  it('is idle with nothing loaded', async () => {
    (usePlayer.getState as jest.Mock).mockReturnValue({ nowPlaying: null });
    await runKeepAhead();
    expect(useKeepAhead.getState().status).toBe('idle');
  });
});

describe('startKeepAhead', () => {
  afterEach(() => jest.useRealTimers());
  // Let a plan that has started finish its awaited reads (React Query settles its
  // fetches on zero-delay timers).
  const drain = async () => {
    for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(0);
  };

  it('plans once things settle, once per burst of changes, and stops on teardown', async () => {
    jest.useFakeTimers();
    const stop = startKeepAhead();
    expect(client.serverInfo).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(SETTLE_MS);
    await drain();
    expect(download).toHaveBeenCalledTimes(2);

    // Three quick changes to the setting: one plan, SETTLE_MS after the last.
    (queryClient as QueryClient).clear();
    entries = {};
    download.mockClear();
    useSettings.setState({ keepAhead: 1 });
    await jest.advanceTimersByTimeAsync(SETTLE_MS / 2);
    useSettings.setState({ keepAhead: 3 });
    await jest.advanceTimersByTimeAsync(SETTLE_MS / 2);
    useSettings.setState({ keepAhead: 2 });
    await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
    expect(download).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await drain();
    expect(queued()).toEqual(['B2:keep-ahead', 'B3:keep-ahead']);

    stop();
    download.mockClear();
    useSettings.setState({ keepAhead: 3 });
    await jest.advanceTimersByTimeAsync(SETTLE_MS * 2);
    await drain();
    expect(download).not.toHaveBeenCalled();
  });
});
