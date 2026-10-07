import { act, renderHook } from '@testing-library/react-native';

import type { MyBookmark, MyNote, Page } from '@/api/types';

import type { Source } from './use-journal-sources';

const mockSave = jest.fn(async (..._a: unknown[]) => 'file');
jest.mock('./export-save', () => ({ saveExport: (...a: unknown[]) => mockSave(...a) }));
const mockCopy = jest.fn(async (_text: string) => true);
jest.mock('@/lib/clipboard', () => ({ copyText: (t: string) => mockCopy(t) }));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/components/annotations', () => ({
  labelText: jest.requireActual('@/components/annotations/labels').labelText,
  // The chapter is named only where this device holds the book's chapters.
  chapterNamer: (chapters: { title: string }[] | undefined) => () =>
    chapters ? chapters[0].title : null,
}));

const mockMyBookmarks = jest.fn();
const mockMyNotes = jest.fn();
const mockMaya = jest.fn();
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    c1: {
      myBookmarks: (...a: unknown[]) => mockMyBookmarks(...a),
      myNotes: (...a: unknown[]) => mockMyNotes(...a),
    },
    c2: {
      myBookmarks: (...a: unknown[]) => mockMaya(...a),
      myNotes: () => Promise.resolve({ items: [] }),
    },
    c3: { myBookmarks: jest.fn(), myNotes: jest.fn() },
  }),
);

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';

import { useJournalExport } from './use-journal-export';
/* eslint-enable import/first */

const bm = (id: number, note: string): MyBookmark => ({
  id,
  library_id: 1,
  path: 'Sanderson/Kings',
  position: 61,
  note,
  label: 'quote',
  created_at: `2026-10-0${id}T10:00:00Z`,
  book: { title: 'The Way of Kings', author: 'Brandon Sanderson' } as MyBookmark['book'],
});

function source<T>(connectionId: string, status: Source<T>['status']): Source<T> {
  return {
    connectionId,
    connectionName: connectionId === 'c1' ? 'Hearthside' : connectionId === 'c2' ? 'Maya' : 'Old',
    status,
    supported: status !== 'unsupported',
    rows: [],
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
    refetch: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryClient.clear();
});

describe('useJournalExport', () => {
  it('exports the loaded pages plus the rest, from every server that can list, as CSV', async () => {
    // The Journal loaded one page of c1's bookmarks; the export fetches the next.
    queryClient.setQueryData(qk.myBookmarks('c1'), {
      pages: [{ items: [bm(1, 'loaded')], next_cursor: 'k1' }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(qk.chapters('c1', 1, 'Sanderson/Kings'), {
      chapters: [{ title: 'Bridge Four' }],
      files: [],
    });
    mockMyBookmarks.mockResolvedValue({ items: [bm(2, 'fetched')] } satisfies Page<MyBookmark>);
    mockMyNotes.mockResolvedValue({ items: [] } satisfies Page<MyNote>);
    const { result } = await renderHook(() =>
      useJournalExport({
        bookmarks: [source('c1', 'ready'), source('c3', 'unsupported')],
        notes: [source('c1', 'ready'), source('c3', 'loading')],
      }),
    );
    await act(() => result.current.run('csv', 'save'));

    expect(mockMyBookmarks).toHaveBeenCalledWith({ limit: 500, cursor: 'k1' });
    expect(mockMyNotes).toHaveBeenCalledWith({ limit: 500, cursor: undefined });
    const [file, title] = mockSave.mock.calls[0] as [
      { name: string; content: string; mimeType: string },
      string,
    ];
    expect(file.name).toMatch(/^journal-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.mimeType).toBe('text/csv');
    expect(title).toBe('Export the journal');
    const lines = file.content.split('\r\n');
    expect(lines[0]).toBe('﻿Type,Book,Author,Position,Chapter,Label,Text,Created');
    expect(lines.slice(1, 3).map((l) => l.split(',').slice(0, 7).join(','))).toEqual([
      'Bookmark,The Way of Kings,Brandon Sanderson,1:01,Bridge Four,Quote,fetched',
      'Bookmark,The Way of Kings,Brandon Sanderson,1:01,Bridge Four,Quote,loaded',
    ]);
    expect(result.current.preparing).toBeNull();
  });

  it('leaves out a server that fails, names it, and still exports the rest', async () => {
    mockMyBookmarks.mockResolvedValue({ items: [bm(1, 'kept')] });
    mockMyNotes.mockResolvedValue({ items: [] });
    mockMaya.mockRejectedValue(new Error('offline'));
    const { result } = await renderHook(() =>
      useJournalExport({
        bookmarks: [source('c1', 'ready'), source('c2', 'error')],
        notes: [source('c1', 'ready')],
      }),
    );
    await act(() => result.current.run('md', 'save'));
    expect(mockToast).toHaveBeenCalledWith({ title: "Couldn't include Maya" });
    const [file] = mockSave.mock.calls[0] as [{ content: string; mimeType: string }];
    expect(file.mimeType).toBe('text/markdown');
    expect(file.content).toContain('## The Way of Kings');
    expect(file.content).toContain('  kept');
  });

  it('copies Markdown and says so only when the copy landed', async () => {
    mockMyBookmarks.mockResolvedValue({ items: [bm(1, 'a')] });
    mockMyNotes.mockResolvedValue({ items: [] });
    const { result } = await renderHook(() =>
      useJournalExport({ bookmarks: [source('c1', 'ready')], notes: [source('c1', 'ready')] }),
    );
    await act(() => result.current.run('md', 'copy'));
    expect(mockCopy.mock.calls[0][0]).toContain('# Journal');
    expect(mockToast).toHaveBeenCalledWith({ title: 'Journal copied as Markdown' });

    mockToast.mockClear();
    mockCopy.mockResolvedValueOnce(false);
    await act(() => result.current.run('md', 'copy'));
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  // The share sheet stays up until the listener closes it, and "Gathering N entries"
  // stayed visible under it and after it: it ends once the file is written.
  it('ends "Gathering" once the file is written, before the share sheet closes', async () => {
    mockMyBookmarks.mockResolvedValue({ items: [bm(1, 'a')] });
    mockMyNotes.mockResolvedValue({ items: [] });
    let closeSheet: () => void = () => {};
    mockSave.mockImplementationOnce(async (...a: unknown[]) => {
      (a[2] as () => void)(); // the file is written
      await new Promise<void>((r) => (closeSheet = r)); // the share sheet is up
      return 'file';
    });
    const { result } = await renderHook(() =>
      useJournalExport({ bookmarks: [source('c1', 'ready')], notes: [source('c1', 'ready')] }),
    );
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.run('md', 'save');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(result.current.preparing).toBeNull();
    // Still one export at a time while the sheet is up.
    await act(() => result.current.run('md', 'save'));
    expect(mockSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      closeSheet();
      await done;
    });
    expect(result.current.preparing).toBeNull();
  });

  it('ends "Gathering" when the share fails, and lets the listener try again', async () => {
    mockMyBookmarks.mockResolvedValue({ items: [bm(1, 'a')] });
    mockMyNotes.mockResolvedValue({ items: [] });
    mockSave.mockRejectedValueOnce(new Error('no room'));
    const { result } = await renderHook(() =>
      useJournalExport({ bookmarks: [source('c1', 'ready')], notes: [source('c1', 'ready')] }),
    );
    await act(() => result.current.run('csv', 'save'));
    expect(result.current.preparing).toBeNull();
    expect(mockToast).toHaveBeenCalledWith({ title: expect.any(String) });
    await act(() => result.current.run('csv', 'save'));
    expect(mockSave).toHaveBeenCalledTimes(2);
  });

  it('says when there is nothing to export', async () => {
    mockMyBookmarks.mockResolvedValue({ items: [] });
    mockMyNotes.mockResolvedValue({ items: [] });
    const { result } = await renderHook(() =>
      useJournalExport({ bookmarks: [source('c1', 'ready')], notes: [source('c1', 'ready')] }),
    );
    await act(() => result.current.run('csv', 'save'));
    expect(mockToast).toHaveBeenCalledWith({ title: 'No bookmarks or notes to export yet' });
    expect(mockSave).not.toHaveBeenCalled();
  });
});
