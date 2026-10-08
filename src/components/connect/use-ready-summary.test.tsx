import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

const mockClient = {
  serverInfo: jest.fn(),
  libraries: jest.fn(),
  authors: jest.fn(),
  recentBooks: jest.fn(),
  allProgress: jest.fn(),
  item: jest.fn(),
  chapters: jest.fn(),
};
jest.mock('@/api/provider', () => ({
  useCid: (id?: string) => id ?? 'c1',
  useOptionalApi: () => mockClient,
}));
/** The book loaded in the player (its key) and its place, else none. */
let mockLoaded: { key: string; position: number } | null = null;
jest.mock('@/playback/store', () => ({
  usePlayer: (sel: (s: object) => unknown) => sel({ nowPlaying: null, snapshot: {} }),
  selectBookKey: () => mockLoaded?.key ?? null,
  selectBookPosition: () => mockLoaded?.position ?? 0,
}));

/* eslint-disable import/first */
import { contentKey } from '@/lib/content-key';

import { useReadySummary } from './use-ready-summary';
/* eslint-enable import/first */

const caps = (browse: boolean) => ({
  name: 'Hearthside',
  server_id: 'c1',
  version: '1.17.0',
  api: 'v1',
  capabilities: { browse_people: browse },
  auth: { methods: [] },
});

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return (await renderHook(() => useReadySummary('c1'), { wrapper })).result;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockLoaded = null;
  mockClient.libraries.mockResolvedValue([
    { id: 1, name: 'Fiction' },
    { id: 2, name: 'Kids' },
  ]);
  mockClient.authors.mockImplementation(async (lib: number) =>
    lib === 1
      ? { people: [{ name: 'A', books: 3, duration: 0 }], unknown: 1 }
      : { people: [{ name: 'B', books: 2, duration: 0 }], unknown: 0 },
  );
  mockClient.recentBooks.mockResolvedValue([]);
  mockClient.allProgress.mockResolvedValue([]);
});

it('counts the books across the libraries from their authors lists', async () => {
  mockClient.serverInfo.mockResolvedValue(caps(true));
  const result = await mount();
  await waitFor(() => expect(result.current.line).not.toBeNull());
  expect(result.current.line).toEqual({ kind: 'booksIn', books: 6, names: ['Fiction', 'Kids'] });
  expect(result.current.place).toBeNull();
});

it('names the libraries without a count on a server without browse_people', async () => {
  mockClient.serverInfo.mockResolvedValue(caps(false));
  const result = await mount();
  await waitFor(() => expect(result.current.line).not.toBeNull());
  expect(result.current.line).toEqual({
    kind: 'librariesIn',
    libraries: 2,
    names: ['Fiction', 'Kids'],
  });
  expect(mockClient.authors).not.toHaveBeenCalled();
});

it('says where the listener was: the newest book in progress, its chapter and percent', async () => {
  mockClient.serverInfo.mockResolvedValue(caps(true));
  mockClient.allProgress.mockResolvedValue([
    {
      library_id: 1,
      path: 'kings',
      position: 380,
      duration: 1000,
      finished: false,
      updated_at: '2026-10-01T00:00:00Z',
    },
  ]);
  mockClient.item.mockResolvedValue({ title: 'The Way of Kings', duration: 1000 });
  mockClient.chapters.mockResolvedValue({
    duration: 1000,
    files: [],
    chapters: [
      { title: 'One', start: 0, end: 300, book_offset: 0, file_index: 0, file_path: 'a' },
      { title: 'Two', start: 300, end: 1000, book_offset: 300, file_index: 0, file_path: 'a' },
    ],
  });
  const result = await mount();
  await waitFor(() => expect(result.current.place?.chapter).toBe(2));
  expect(result.current.place).toEqual({
    book: { connectionId: 'c1', libraryId: 1, path: 'kings' },
    title: 'The Way of Kings',
    chapter: 2,
    percent: 38,
  });
});

it("names the loaded book's chapter and percent from the same place, the player's", async () => {
  mockClient.serverInfo.mockResolvedValue(caps(true));
  mockClient.allProgress.mockResolvedValue([
    {
      library_id: 1,
      path: 'kings',
      position: 380,
      duration: 1000,
      finished: false,
      updated_at: '2026-10-01T00:00:00Z',
    },
  ]);
  mockClient.item.mockResolvedValue({ title: 'The Way of Kings', duration: 1000 });
  mockClient.chapters.mockResolvedValue({
    duration: 1000,
    files: [],
    chapters: [
      { title: 'One', start: 0, end: 300, book_offset: 0, file_index: 0, file_path: 'a' },
      { title: 'Two', start: 300, end: 1000, book_offset: 300, file_index: 0, file_path: 'a' },
    ],
  });
  // Loaded here and paused at 120 s: the chapter said 1 while the percent said 38.
  mockLoaded = { key: contentKey('c1', 1, 'kings'), position: 120 };
  const result = await mount();
  await waitFor(() => expect(result.current.place?.chapter).toBe(1));
  expect(result.current.place).toMatchObject({
    title: 'The Way of Kings',
    chapter: 1,
    percent: 12,
  });
});

it('reports libraries it could not read', async () => {
  mockClient.serverInfo.mockResolvedValue(caps(true));
  mockClient.libraries.mockRejectedValue(new Error('offline'));
  const result = await mount();
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.line).toBeNull();
});
