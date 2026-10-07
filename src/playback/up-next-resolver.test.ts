import type { Book, Capabilities, FsEntry, NextBook, QueueEntry } from '@/api/types';

import {
  entryHolds,
  finishedKey,
  pickQueueHead,
  resolveUpNext,
  type UpNextSources,
} from './up-next-resolver';

// --- Fixtures --------------------------------------------------------------

function book(path: string, p: Partial<Book> = {}): Book {
  return {
    id: 1,
    library_id: 1,
    rel_path: path,
    is_folder: true,
    title: path.split('/').pop() ?? path,
    author: 'Author',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 3600,
    format: 'm4b',
    size: 0,
    ...p,
  };
}

function entry(path: string, p: Partial<QueueEntry> = {}): QueueEntry {
  return { library_id: 1, path, added_at: '2026-10-01T00:00:00Z', book: book(path), ...p };
}

const FINISHED = { connectionId: 'c1', libraryId: 1, path: 'Series/Book 1' };

const ALL: Capabilities = {
  admin_ui: false,
  web_player: true,
  transcode: false,
  upload: false,
  websocket: false,
  queue: true,
  next_book: true,
};

function sources(over: Partial<UpNextSources> = {}): UpNextSources & {
  [K in keyof UpNextSources]: jest.Mock;
} {
  return {
    capabilities: jest.fn(async () => ALL),
    queue: jest.fn(async () => [] as QueueEntry[]),
    finished: jest.fn(async () => new Set<string>()),
    nextBook: jest.fn(async (): Promise<NextBook> => ({ source: 'none' })),
    folderNext: jest.fn(async (): Promise<FsEntry | null> => null),
    ...over,
  } as never;
}

const seriesNext: NextBook = {
  source: 'series',
  next: { library_id: 1, path: 'Series/Book 2' },
  book: book('Series/Book 2', { title: 'Book Two', series: 'The Saga', series_index: 2 }),
};

const folderSibling: FsEntry = {
  name: 'Book 2',
  path: 'Series/Book 2',
  is_dir: true,
  is_audio: false,
  size: 0,
  mod_time: 0,
  is_book: true,
  title: 'Book Two',
  author: 'Author',
  duration: 1800,
};

// --- entryHolds / pickQueueHead ----------------------------------------------

describe('entryHolds', () => {
  it('matches the exact path and a part path under the entry', () => {
    expect(entryHolds({ library_id: 1, path: 'A/Book' }, 1, 'A/Book')).toBe(true);
    expect(entryHolds({ library_id: 1, path: 'A/Book' }, 1, 'A/Book/CD1')).toBe(true);
  });
  it('does not match a sibling with a shared prefix, or another library', () => {
    expect(entryHolds({ library_id: 1, path: 'A/Book' }, 1, 'A/Book 2')).toBe(false);
    expect(entryHolds({ library_id: 1, path: 'A/Book' }, 2, 'A/Book')).toBe(false);
  });
});

describe('pickQueueHead', () => {
  it('takes the first entry', () => {
    const q = [entry('X/One'), entry('X/Two')];
    expect(pickQueueHead(q, FINISHED, new Set())?.path).toBe('X/One');
  });

  it('skips the finished book itself, unindexed entries and finished books', () => {
    const q = [
      entry('Series/Book 1'),
      entry('X/Gone', { book: undefined }),
      entry('X/Done'),
      entry('X/Next'),
    ];
    const head = pickQueueHead(q, FINISHED, new Set([finishedKey(1, 'X/Done')]));
    expect(head?.path).toBe('X/Next');
  });

  it('skips the entry that holds the finished part path', () => {
    const q = [entry('Series/Book 1'), entry('X/Next')];
    const head = pickQueueHead(q, { libraryId: 1, path: 'Series/Book 1/CD2' }, new Set());
    expect(head?.path).toBe('X/Next');
  });

  it('is undefined when nothing can play', () => {
    expect(pickQueueHead([entry('Series/Book 1')], FINISHED, new Set())).toBeUndefined();
  });
});

// --- resolveUpNext -----------------------------------------------------------

describe('resolveUpNext', () => {
  it('(a) plays the queue head, with its entry to remove and why', async () => {
    const s = sources({
      queue: jest.fn(async () => [
        entry('Series/Book 1'),
        entry('Other/Queued', {
          book: book('Other/Queued', { title: 'Queued', series: 'Other', series_index: 3 }),
        }),
      ]),
      nextBook: jest.fn(async () => seriesNext),
    });
    const { next } = await resolveUpNext(s, FINISHED);
    expect(next).toMatchObject({
      connectionId: 'c1',
      libraryId: 1,
      path: 'Other/Queued',
      title: 'Queued',
      source: 'queue',
      series: { name: 'Other', position: '3' },
      queueEntry: { library_id: 1, path: 'Other/Queued' },
    });
    // The queue answered: the series is never asked.
    expect(s.nextBook).not.toHaveBeenCalled();
    expect(s.folderNext).not.toHaveBeenCalled();
  });

  it('(b) falls to the series when the queue has nothing playable', async () => {
    const s = sources({
      queue: jest.fn(async () => [entry('Series/Book 1'), entry('X/Gone', { book: undefined })]),
      nextBook: jest.fn(async () => seriesNext),
    });
    const { next } = await resolveUpNext(s, FINISHED);
    expect(next).toMatchObject({
      path: 'Series/Book 2',
      title: 'Book Two',
      source: 'series',
      series: { name: 'The Saga', position: '2' },
    });
    expect(next?.queueEntry).toBeUndefined();
    expect(s.nextBook).toHaveBeenCalledWith(1, 'Series/Book 1');
  });

  it('(b) skips a queue head the listener already finished', async () => {
    const s = sources({
      queue: jest.fn(async () => [entry('X/Done')]),
      finished: jest.fn(async () => new Set([finishedKey(1, 'X/Done')])),
      nextBook: jest.fn(async () => seriesNext),
    });
    expect((await resolveUpNext(s, FINISHED)).next?.source).toBe('series');
  });

  it('(b) falls to the series when the queue cannot be read', async () => {
    const s = sources({
      queue: jest.fn(async () => {
        throw new Error('offline');
      }),
      nextBook: jest.fn(async () => seriesNext),
    });
    expect((await resolveUpNext(s, FINISHED)).next?.path).toBe('Series/Book 2');
  });

  it('(b) a community answer plays in its own library with its rail position', async () => {
    const s = sources({
      nextBook: jest.fn(async (): Promise<NextBook> => ({
        source: 'community',
        next: { library_id: 4, path: 'Elsewhere/Book 2' },
        book: book('Elsewhere/Book 2', { title: 'Two', series: 'Saga', series_index: 0 }),
        work: {
          id: 'w2',
          title: 'Two',
          position: '2',
          authors: [],
          web_url: 'https://meta/w2',
          local: { library_id: 4, path: 'Elsewhere/Book 2' },
        },
      })),
    });
    const { next, unplaced } = await resolveUpNext(s, FINISHED);
    expect(next).toMatchObject({
      libraryId: 4,
      path: 'Elsewhere/Book 2',
      source: 'series',
      series: { name: 'Saga', position: '2' },
    });
    expect(unplaced).toBeUndefined();
  });

  it('(b) a server folder answer is labelled folder', async () => {
    const s = sources({
      nextBook: jest.fn(async (): Promise<NextBook> => ({
        source: 'folder',
        next: { library_id: 1, path: 'Series/Extra' },
      })),
    });
    const { next } = await resolveUpNext(s, FINISHED);
    expect(next).toMatchObject({ path: 'Series/Extra', title: 'Extra', source: 'folder' });
    expect(next?.series).toBeUndefined();
  });

  it('(b) never plays a community work the server could not place, but reports it', async () => {
    const s = sources({
      nextBook: jest.fn(async (): Promise<NextBook> => ({
        source: 'none',
        work: {
          id: 'w3',
          title: "Abaddon's Gate",
          position: '3',
          authors: [],
          web_url: 'https://meta/w3',
        },
      })),
    });
    const answer = await resolveUpNext(s, FINISHED);
    expect(answer.next).toBeNull();
    expect(answer.unplaced).toEqual({
      title: "Abaddon's Gate",
      position: '3',
      webUrl: 'https://meta/w3',
    });
    // The server already walked the folder: its "nothing follows" stands.
    expect(s.folderNext).not.toHaveBeenCalled();
  });

  it('(c) a server without next_book or queue uses the folder sibling', async () => {
    const s = sources({
      capabilities: jest.fn(async () => ({ ...ALL, queue: undefined, next_book: undefined })),
      folderNext: jest.fn(async () => folderSibling),
    });
    const { next } = await resolveUpNext(s, FINISHED);
    expect(next).toMatchObject({
      connectionId: 'c1',
      libraryId: 1,
      path: 'Series/Book 2',
      title: 'Book Two',
      duration: 1800,
      source: 'folder',
    });
    expect(s.queue).not.toHaveBeenCalled();
    expect(s.nextBook).not.toHaveBeenCalled();
  });

  it('(c) the folder answers when next_book fails', async () => {
    const s = sources({
      nextBook: jest.fn(async () => {
        throw new Error('timeout');
      }),
      folderNext: jest.fn(async () => folderSibling),
    });
    expect((await resolveUpNext(s, FINISHED)).next?.source).toBe('folder');
  });

  it('(c) an unknown server (no /server answer) still tries the folder', async () => {
    const s = sources({
      capabilities: jest.fn(async () => {
        throw new Error('offline');
      }),
      folderNext: jest.fn(async () => folderSibling),
    });
    expect((await resolveUpNext(s, FINISHED)).next?.path).toBe('Series/Book 2');
    expect(s.queue).not.toHaveBeenCalled();
  });

  it('is null when nothing follows anywhere', async () => {
    const s = sources({
      capabilities: jest.fn(async () => ({ ...ALL, queue: false, next_book: false })),
      folderNext: jest.fn(async () => {
        throw new Error('gone');
      }),
    });
    expect(await resolveUpNext(s, FINISHED)).toEqual({ next: null });
  });
});
