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
import { useSession } from '@/stores/session';

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
  await waitFor(() => expect(result.current.place?.chapter?.number).toBe(2));
  expect(result.current.place).toEqual({
    book: { connectionId: 'c1', libraryId: 1, path: 'kings' },
    title: 'The Way of Kings',
    chapter: { number: 2, title: 'Two' },
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
  await waitFor(() => expect(result.current.place?.chapter?.number).toBe(1));
  expect(result.current.place).toMatchObject({
    title: 'The Way of Kings',
    chapter: { number: 1, title: 'One' },
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

// BRIDGE-16: a podcast library's shows are no books.
it('leaves podcast libraries out of the count and the names', async () => {
  mockClient.serverInfo.mockResolvedValue(caps(true));
  mockClient.libraries.mockResolvedValue([
    { id: 1, name: 'Fiction' },
    { id: 3, name: 'Podcasts', kind: 'podcasts' },
  ]);
  const result = await mount();
  await waitFor(() => expect(result.current.line).not.toBeNull());
  expect(result.current.line).toEqual({ kind: 'booksIn', books: 4, names: ['Fiction'] });
  expect(mockClient.authors).not.toHaveBeenCalledWith(3, expect.anything());
});

// CONNECT-02: the admin of a server with nothing to play is pointed at the console.
describe('the admin on an empty server', () => {
  afterEach(() => useSession.setState({ connections: [] } as never));

  const signIn = (role: 'admin' | 'user') =>
    useSession.setState({
      connections: [
        {
          id: 'c1',
          serverUrl: 'https://h:8080',
          name: 'Hearthside',
          token: 't',
          user: { id: 1, username: 'a', role },
        },
      ],
    } as never);

  it("gets the console's setup flow when there is no library", async () => {
    signIn('admin');
    mockClient.serverInfo.mockResolvedValue(caps(true));
    mockClient.libraries.mockResolvedValue([]);
    const result = await mount();
    await waitFor(() => expect(result.current.line).toEqual({ kind: 'empty' }));
    expect(result.current.admin).toEqual({ url: 'https://h:8080/admin/setup', noLibraries: true });
  });

  it('gets the console when the libraries hold no books', async () => {
    signIn('admin');
    mockClient.serverInfo.mockResolvedValue(caps(true));
    mockClient.authors.mockResolvedValue({ people: [], unknown: 0 });
    const result = await mount();
    await waitFor(() => expect(result.current.line).toEqual({ kind: 'empty' }));
    expect(result.current.admin).toEqual({ url: 'https://h:8080/admin', noLibraries: false });
  });

  it('is nothing for a listener, or for a server with books', async () => {
    signIn('user');
    mockClient.serverInfo.mockResolvedValue(caps(true));
    mockClient.libraries.mockResolvedValue([]);
    const listener = await mount();
    await waitFor(() => expect(listener.current.line).toEqual({ kind: 'empty' }));
    expect(listener.current.admin).toBeNull();

    signIn('admin');
    mockClient.libraries.mockResolvedValue([{ id: 1, name: 'Fiction' }]);
    const stocked = await mount();
    await waitFor(() => expect(stocked.current.line).not.toBeNull());
    expect(stocked.current.admin).toBeNull();
  });
});
