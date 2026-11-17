import {
  bytesToGo,
  downloadedPaths,
  entryBytes,
  episodeShowTitle,
  groupByServer,
  isEpisodeEntry,
  orphanDownloads,
  splitDownloads,
  growingBytes,
  storageBar,
  unsupportedReason,
  visibleDownloads,
} from './downloads-view';
import type { DownloadEntry, DownloadStatus } from './types';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function entry(
  path: string,
  status: DownloadStatus,
  p: Partial<DownloadEntry> & { savedAt?: string } = {},
): DownloadEntry {
  return {
    connectionId: 'a',
    libraryId: 1,
    path,
    title: path,
    status,
    progress: 0,
    bytes: 0,
    totalBytes: 0,
    ...p,
    manifest: {
      book: {} as DownloadEntry['manifest']['book'],
      chapters: null,
      files: [],
      coverUri: null,
      savedAt: p.savedAt ?? '2026-10-01T00:00:00Z',
    },
  };
}

describe('entryBytes / bytesToGo', () => {
  it('counts a finished download at its full size', () => {
    expect(entryBytes(entry('x', 'downloaded', { bytes: 90, totalBytes: 100 }))).toBe(100);
    expect(entryBytes(entry('x', 'downloaded', { bytes: 90, totalBytes: 0 }))).toBe(90);
    expect(entryBytes(entry('x', 'downloading', { bytes: 40, totalBytes: 100 }))).toBe(40);
  });
  it('knows what is left only with a total', () => {
    expect(bytesToGo({ bytes: 40, totalBytes: 100 })).toBe(60);
    expect(bytesToGo({ bytes: 40, totalBytes: 0 })).toBeNull();
  });
});

describe('splitDownloads', () => {
  it('puts running first, then waiting by age, then failed; ready newest first', () => {
    const { active, ready } = splitDownloads([
      entry('failed', 'error'),
      entry('q2', 'queued', { savedAt: '2026-10-03T00:00:00Z' }),
      entry('q1', 'queued', { savedAt: '2026-10-02T00:00:00Z' }),
      entry('run', 'downloading'),
      entry('old', 'downloaded', { savedAt: '2026-09-01T00:00:00Z' }),
      entry('new', 'downloaded', { savedAt: '2026-10-05T00:00:00Z' }),
    ]);
    expect(active.map((e) => e.path)).toEqual(['run', 'q1', 'q2', 'failed']);
    expect(ready.map((e) => e.path)).toEqual(['new', 'old']);
  });
});

describe('visibleDownloads', () => {
  it("splits only the given connections' (the person listening's) downloads", () => {
    const entries = {
      mine: entry('mine', 'downloaded', { connectionId: 'a' }),
      running: entry('running', 'downloading', { connectionId: 'a' }),
      theirs: entry('theirs', 'downloaded', { connectionId: 'b' }),
    };
    const { active, ready } = visibleDownloads(entries, ['a']);
    expect(active.map((e) => e.path)).toEqual(['running']);
    expect(ready.map((e) => e.path)).toEqual(['mine']);
    expect(visibleDownloads(entries, [])).toEqual({ active: [], ready: [] });
  });
});

describe('groupByServer', () => {
  it('groups in server order with their sizes, unknown servers last', () => {
    const groups = groupByServer(
      [
        entry('gone', 'downloaded', { connectionId: 'zzz', totalBytes: 5 }),
        entry('b1', 'downloaded', { connectionId: 'b', totalBytes: 10 }),
        entry('a1', 'downloaded', { totalBytes: 1 }),
        entry('a2', 'downloaded', { totalBytes: 2 }),
      ],
      [
        { id: 'a', name: 'Home' },
        { id: 'b', name: "Maya's Shelf" },
      ],
    );
    expect(groups.map((g) => [g.name, g.bytes, g.entries.length])).toEqual([
      ['Home', 3, 2],
      ["Maya's Shelf", 10, 1],
      ['', 5, 1],
    ]);
  });
});

describe('storageBar', () => {
  const g = (connectionId: string, bytes: number) => ({ connectionId, name: connectionId, bytes });

  it('gives each server a colour in order, pink last, and shows other apps on a device', () => {
    const bar = storageBar(
      [g('a', 2 * GB), g('b', GB)],
      { scope: 'device', capacity: 128 * GB, free: 100 * GB },
      null,
    );
    expect(bar.used).toBe(3 * GB);
    expect(bar.scale).toBe(128 * GB);
    expect(bar.segments).toEqual([
      { kind: 'server', connectionId: 'a', name: 'a', bytes: 2 * GB, colour: 2 },
      { kind: 'server', connectionId: 'b', name: 'b', bytes: GB, colour: 3 },
      { kind: 'other-apps', bytes: 25 * GB },
    ]);
  });

  it('never claims to know other apps in a browser', () => {
    const bar = storageBar(
      [g('a', GB)],
      { scope: 'browser', capacity: 60 * GB, free: 50 * GB },
      null,
    );
    expect(bar.segments.map((s) => s.kind)).toEqual(['server']);
    expect(bar.scale).toBe(60 * GB);
  });

  it('folds a sixth server and on into one segment', () => {
    const bar = storageBar(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => g(id, 1)),
      null,
      null,
    );
    expect(bar.segments.slice(5)).toEqual([{ kind: 'more-servers', count: 2, bytes: 2 }]);
    // Five colours, pink (chart-1) only for the fifth server.
    expect(bar.segments.slice(0, 5).map((s) => (s.kind === 'server' ? s.colour : 0))).toEqual([
      2, 3, 4, 5, 1,
    ]);
    expect(bar.scale).toBe(7);
  });

  // PLAYER-05: the figure grows while a download runs, not only once it lands.
  it('counts what the downloads under way have written', () => {
    expect(storageBar([g('a', 10 * MB)], null, 12 * MB, 5 * MB).used).toBe(15 * MB);
    // A measure read mid-download that already holds those bytes is not counted twice.
    expect(storageBar([g('a', 10 * MB)], null, 18 * MB, 5 * MB).used).toBe(18 * MB);
    // A measure above the list (covers, another person's books) grows by what was written
    // since it was read.
    expect(storageBar([g('a', 10 * MB)], null, 900 * MB, 5 * MB, 3 * MB).used).toBe(903 * MB);
    // No measure: another person's running download is not counted on this person's list.
    expect(storageBar([g('a', 10 * MB)], null, null, 5 * MB, 30 * MB).used).toBe(15 * MB);
  });

  // `free` is as old as the measure: what was written since is ours, never taken off the
  // other apps' share (it would shrink while a download runs and come back as it lands).
  it("keeps other apps' share while a download grows", () => {
    const disk = { scope: 'device' as const, capacity: 128 * GB, free: 100 * GB };
    const other = (grown: number) =>
      storageBar([g('a', 2 * GB)], disk, 3 * GB, 0, grown).segments.find(
        (s) => s.kind === 'other-apps',
      )?.bytes;
    expect(other(0)).toBe(25 * GB);
    expect(other(GB)).toBe(25 * GB);
    expect(storageBar([g('a', 2 * GB)], disk, 3 * GB, 0, GB).used).toBe(4 * GB);
  });

  it('prefers the measured total, and skips empty servers', () => {
    const bar = storageBar([g('a', 10), g('b', 0)], null, 25);
    expect(bar.used).toBe(25);
    expect(bar.segments).toHaveLength(1);
  });
});

describe('unsupportedReason', () => {
  it('names the most fundamental cause', () => {
    expect(unsupportedReason({ secure: false, caches: false })).toBe('insecure');
    expect(unsupportedReason({ secure: true, caches: false })).toBe('no-cache');
    expect(unsupportedReason({ secure: true, caches: true })).toBe('no-worker');
  });
});

describe('downloadedPaths', () => {
  it("lists one library's downloaded books, unmoved by a running download's progress", () => {
    const entries = {
      x: entry('B', 'downloaded'),
      y: entry('A', 'downloaded'),
      z: entry('C', 'downloading', { progress: 0.4 }),
      w: entry('D', 'downloaded', { libraryId: 2 }),
      v: entry('E', 'downloaded', { connectionId: 'b' }),
    };
    expect(downloadedPaths(entries, 'a', 1)).toBe('A\nB');
    const ticked = { ...entries, z: entry('C', 'downloading', { progress: 0.5 }) };
    expect(downloadedPaths(ticked, 'a', 1)).toBe(downloadedPaths(entries, 'a', 1));
  });
});

describe('orphanDownloads', () => {
  const e = (connectionId: string, savedAt: string) =>
    ({
      connectionId,
      libraryId: 1,
      path: savedAt,
      status: 'downloaded',
      manifest: { savedAt },
    }) as unknown as DownloadEntry;

  it("lists the entries of connections the session doesn't hold, newest first, once it was read", () => {
    const entries = { a: e('a.1', '1'), b: e('gone.2', '2'), c: e('gone.3', '3') };
    expect(orphanDownloads(entries, ['a.1'], true).map((x) => x.connectionId)).toEqual([
      'gone.3',
      'gone.2',
    ]);
    expect(orphanDownloads(entries, ['a.1'], false)).toEqual([]);
  });
});

// fe#166: episodes have their own section, under their show's name.
describe('episode downloads', () => {
  const withBook = (book: object, showTitle?: string): DownloadEntry => {
    const e = entry('Show/Monday.mp3', 'downloaded');
    return {
      ...e,
      manifest: {
        ...e.manifest,
        book: book as DownloadEntry['manifest']['book'],
        ...(showTitle ? { showTitle } : {}),
      },
    };
  };

  it('tells an episode from a book', () => {
    expect(isEpisodeEntry(withBook({ episode: { show_path: 'Show' } }))).toBe(true);
    expect(isEpisodeEntry(withBook({}))).toBe(false);
  });

  it("names the show by the title kept with it, else its folder's name", () => {
    expect(episodeShowTitle(withBook({ episode: { show_path: 'Pods/Daily' } }, 'The Daily'))).toBe(
      'The Daily',
    );
    expect(episodeShowTitle(withBook({ episode: { show_path: 'Pods/Daily' } }))).toBe('Daily');
  });
});

describe('growingBytes', () => {
  const entry = (connectionId: string, status: DownloadEntry['status'], bytes: number) =>
    ({ connectionId, status, bytes }) as DownloadEntry;

  it("sums the listener's running downloads, in whole megabytes", () => {
    const entries = {
      a: entry('c1', 'downloading', 3 * MB + 500),
      b: entry('c1', 'queued', 0),
      c: entry('c1', 'error', MB),
      d: entry('c1', 'downloaded', 40 * MB),
      e: entry('c2', 'downloading', 9 * MB),
    };
    expect(growingBytes(entries, ['c1'])).toBe(3 * MB);
    expect(growingBytes(entries, [])).toBe(0);
    // Every connection's, as the engine's measure counts them.
    expect(growingBytes(entries)).toBe(12 * MB);
  });
});
