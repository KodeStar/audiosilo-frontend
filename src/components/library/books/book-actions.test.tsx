import { act, renderHook } from '@testing-library/react-native';

import type { Book, Progress } from '@/api/types';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

let mockCaps: Record<string, boolean | undefined> = {};
const mockEdit = jest.fn();
const mockMarkFinished = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useCapability: (flag: string) => mockCaps[flag],
    useEditProgress: () => ({ mutateAsync: mockEdit }),
    useMarkFinished: () => ({ mutate: mockMarkFinished }),
  };
});
let mockQueueSupported = true;
const mockQueue = jest.fn();
jest.mock('../use-queue-actions', () => ({
  useQueueActions: () => ({
    supported: mockQueueSupported,
    isQueued: () => false,
    queue: mockQueue,
    unqueue: jest.fn(),
  }),
}));
let mockDownloadsSupported = true;
const mockDownload = jest.fn();
const mockRemove = jest.fn();
let mockEntry: { status: string } | undefined;
jest.mock('@/downloads/store', () => ({
  useDownloadEntry: () => mockEntry,
  useDownloads: Object.assign(
    (select: (s: { supported: boolean }) => unknown) =>
      select({ supported: mockDownloadsSupported }),
    { getState: () => ({ download: mockDownload, remove: mockRemove, cancel: jest.fn() }) },
  ),
}));
const mockOpenSeries = jest.fn();
jest.mock('@/lib/open', () => ({ useOpen: () => ({ openSeries: mockOpenSeries }) }));
const mockPlay = jest.fn();
jest.mock('@/components/player/use-play-book', () => ({ usePlayBook: () => mockPlay }));

/* eslint-disable import/first */
import { CapabilityError } from '@/api/hooks';

import { useBookActions } from './book-actions';
/* eslint-enable import/first */

const H = 3600;
const book = (over: Partial<Book> = {}): Book => ({
  id: 1,
  library_id: 1,
  rel_path: 'Author/Series/01 - Book',
  is_folder: true,
  title: 'Book',
  author: 'Author',
  series: 'Series',
  series_index: 1,
  narrator: '',
  duration: 3 * H,
  format: 'm4b',
  size: 0,
  ...over,
});
const progress = (over: Partial<Progress> = {}): Progress => ({
  library_id: 1,
  path: 'Author/Series/01 - Book',
  position: 600,
  duration: 3 * H,
  finished: false,
  playback_speed: 1,
  version: 1,
  device_id: 'd',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const ALL = { collections: true, progress_edit: true };

async function actions(b: Book, p?: Progress) {
  const openCollect = jest.fn();
  const confirmRemove = jest.fn();
  const { result } = await renderHook(() =>
    useBookActions(
      { connectionId: 'c', libraryId: 1, book: b, progress: p },
      { openCollect, confirmRemove },
    ),
  );
  return {
    list: result.current,
    openCollect,
    confirmRemove,
    find: (key: string) => result.current.find((a) => a.key === key),
  };
}

describe('useBookActions', () => {
  beforeEach(() => {
    mockCaps = { ...ALL };
    mockQueueSupported = true;
    mockDownloadsSupported = true;
    [
      mockToast,
      mockEdit,
      mockMarkFinished,
      mockQueue,
      mockDownload,
      mockOpenSeries,
      mockPlay,
    ].forEach((m) => m.mockReset());
  });

  it('offers everything a server with every capability allows, in order', async () => {
    const { list } = await actions(book(), progress());
    expect(list.map((a) => [a.key, a.label])).toEqual([
      ['play', 'Resume'],
      ['queue', 'Add to Up next'],
      ['collect', 'Add to collection...'],
      ['download', 'Download for offline'],
      ['finish', 'Mark as finished'],
      ['series', 'More in this series'],
    ]);
  });

  it('hides what the server lacks or has not confirmed yet', async () => {
    mockCaps = { collections: undefined, progress_edit: undefined };
    mockQueueSupported = false;
    mockDownloadsSupported = false;
    const { list } = await actions(book({ series: '' }));
    expect(list.map((a) => [a.key, a.label])).toEqual([['play', 'Play']]);
  });

  it('marks finished through a progress edit with an Undo that restores the place', async () => {
    mockEdit.mockResolvedValue(progress({ finished: true }));
    const { find } = await actions(book(), progress({ position: 900 }));
    await act(async () => find('finish')!.onPress());
    expect(mockEdit).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: true, position: undefined },
    });
    const t = mockToast.mock.calls.at(-1)![0];
    expect(t.title).toBe('Marked as finished');
    await act(async () => t.action.onPress());
    expect(mockEdit).toHaveBeenLastCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: 900 },
    });
  });

  it('marks finished on an older server through the save at the end, without an Undo', async () => {
    mockCaps = { collections: true, progress_edit: false };
    const { find } = await actions(book(), progress());
    await act(async () => find('finish')!.onPress());
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockMarkFinished.mock.calls[0][0]).toEqual({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      position: 3 * H,
      duration: 3 * H,
    });
  });

  it('marks a book finished at its end not finished from the start', async () => {
    mockEdit.mockResolvedValue(progress());
    const { find } = await actions(book(), progress({ finished: true, position: 3 * H }));
    expect(find('finish')!.label).toBe('Mark as not finished');
    await act(async () => find('finish')!.onPress());
    expect(mockEdit).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: 0 },
    });
  });

  it('offers no way back on a server that cannot edit progress', async () => {
    mockCaps = { collections: true, progress_edit: false };
    const { find } = await actions(book(), progress({ finished: true }));
    expect(find('finish')).toBeUndefined();
  });

  it('says nothing when the edit was never sent', async () => {
    mockEdit.mockRejectedValue(new CapabilityError('progress_edit', true));
    const { find } = await actions(book(), progress());
    await act(async () => find('finish')!.onPress());
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('plays, queues, collects, downloads and opens the series on this connection', async () => {
    mockPlay.mockResolvedValue(undefined);
    const b = book();
    const { find, openCollect } = await actions(b);
    find('play')!.onPress();
    expect(mockPlay).toHaveBeenCalledWith(
      { connectionId: 'c', libraryId: 1, path: b.rel_path },
      { viaBookPage: true },
    );
    find('queue')!.onPress();
    expect(mockQueue).toHaveBeenCalledWith(1, b.rel_path);
    find('collect')!.onPress();
    expect(openCollect).toHaveBeenCalled();
    find('download')!.onPress();
    expect(mockDownload).toHaveBeenCalledWith('c', 1, b, undefined);
    find('series')!.onPress();
    expect(mockOpenSeries).toHaveBeenCalledWith('c', 1, { name: 'Series' });
  });
});

describe('useBookActions, a downloaded book', () => {
  it('asks before removing the download (the confirm does the removing)', async () => {
    mockEntry = { status: 'downloaded' };
    const { find, confirmRemove } = await actions(book());
    expect(find('download')!.label).toBe('Remove download');
    find('download')!.onPress();
    expect(confirmRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).not.toHaveBeenCalled();
    mockEntry = undefined;
  });
});
