import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Book, Library, Progress } from '@/api/types';

const mockClient = {
  serverInfo: jest.fn(async () => ({ capabilities: {} })),
  libraries: jest.fn(async (): Promise<Library[]> => []),
  listBooks: jest.fn(async (_lib: number, _q: { cursor?: string }) => ({
    books: [] as Book[],
    next_cursor: '',
  })),
  allProgress: jest.fn(async (): Promise<Progress[]> => []),
  item: jest.fn(async (lib: number, path: string) => book(path, lib)),
};
// Lazy: the factory runs before `mockClient` is initialised (the imports are hoisted).
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    'srv.7': {
      serverInfo: () => mockClient.serverInfo(),
      libraries: () => mockClient.libraries(),
      listBooks: (lib: number, q: { cursor?: string }) => mockClient.listBooks(lib, q),
      allProgress: () => mockClient.allProgress(),
      item: (lib: number, path: string) => mockClient.item(lib, path),
    },
  }),
);

/* eslint-disable import/first */
import { useReachability } from '@/api/reachability';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import { type KidsSettings, resetProfilesForTests } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';
import { seedProfile } from '@/testing/seed-profile';

import { useKidsStories } from './use-kids';
/* eslint-enable import/first */

const lib = (id: number): Library => ({
  id,
  name: `Lib ${id}`,
  root: '/',
  default_view: 'books' as Library['default_view'],
  sort_order: id,
});
const book = (path: string, libraryId = 2): Book =>
  ({ id: 0, library_id: libraryId, rel_path: path, title: path, author: '' }) as Book;

const CONN = {
  id: 'srv.7',
  serverId: 'srv',
  serverUrl: 'https://srv',
  name: 'Hearthside',
  token: 't',
  user: { id: 7, username: 'leo' },
} as Connection;

function setKids(kids: KidsSettings) {
  useSession.setState({ connections: [CONN], defaultConnectionId: CONN.id });
  seedProfile({ connectionIds: [CONN.id], kids });
}

function mount(onRender?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => {
      onRender?.();
      return useKidsStories();
    },
    { wrapper },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.libraries.mockResolvedValue([lib(1), lib(2)]);
  mockClient.listBooks.mockImplementation(async (libraryId: number) => ({
    books: libraryId === 2 ? [book('a'), book('b'), book('c')] : [book('x', 1)],
    next_cursor: '',
  }));
  mockClient.allProgress.mockResolvedValue([]);
  useReachability.setState({ online: {} });
  useDownloads.setState({ entries: {} });
});

afterEach(() => {
  resetProfilesForTests();
  useSession.setState({ connections: [], defaultConnectionId: null });
});

it("shows the profile's picked library while GET /libraries still lists it", async () => {
  setKids({ bedtime: '19:30', library: { connectionId: CONN.id, libraryId: 2 } });
  const { result } = await mount();
  await waitFor(() => expect(result.current.stories.status).toBe('ready'));
  expect(result.current.library?.id).toBe(2);
  expect(mockClient.listBooks.mock.calls[0][0]).toBe(2);
});

it('falls back to the first library listed when the pick is gone', async () => {
  setKids({ bedtime: '19:30', library: { connectionId: CONN.id, libraryId: 9 } });
  const { result } = await mount();
  await waitFor(() => expect(result.current.stories.status).toBe('ready'));
  expect(result.current.library?.id).toBe(1);
});

it('puts the stories in progress first', async () => {
  setKids({ bedtime: '19:30', library: { connectionId: CONN.id, libraryId: 2 } });
  mockClient.allProgress.mockResolvedValue([
    {
      library_id: 2,
      path: 'c',
      position: 60,
      duration: 600,
      finished: false,
      playback_speed: 1,
      version: 0,
      device_id: 'd',
      updated_at: '2026-10-01T00:00:00.000Z',
    },
  ]);
  const { result } = await mount();
  await waitFor(() => {
    const s = result.current.stories;
    expect(s.status === 'ready' && s.books[0].rel_path).toBe('c');
  });
  const s = result.current.stories;
  expect(s.status === 'ready' && s.books.map((b) => b.rel_path)).toEqual(['c', 'a', 'b']);
});

it('says so when the account sees no library', async () => {
  setKids({ bedtime: '19:30' });
  mockClient.libraries.mockResolvedValue([]);
  const { result } = await mount();
  await waitFor(() =>
    expect(result.current.stories).toEqual({ status: 'empty', serverName: 'Hearthside' }),
  );
});

it('says so when the library has no books', async () => {
  setKids({ bedtime: '19:30' });
  mockClient.listBooks.mockResolvedValue({ books: [], next_cursor: '' });
  const { result } = await mount();
  await waitFor(() => expect(result.current.stories.status).toBe('empty'));
});

it('reports an error it can retry when the server fails and nothing is downloaded', async () => {
  setKids({ bedtime: '19:30' });
  mockClient.libraries.mockRejectedValue(new Error('down'));
  const { result } = await mount();
  await waitFor(() =>
    expect(result.current.stories).toEqual({
      status: 'error',
      serverName: 'Hearthside',
      offline: false,
    }),
  );
  mockClient.libraries.mockResolvedValue([lib(1)]);
  result.current.retry();
  await waitFor(() => expect(result.current.stories.status).toBe('ready'));
});

it('shows the downloaded stories while the server is unreachable', async () => {
  setKids({ bedtime: '19:30' });
  useReachability.setState({ online: { [CONN.id]: false } });
  mockClient.libraries.mockRejectedValue(new Error('offline'));
  const entry = {
    connectionId: CONN.id,
    libraryId: 1,
    path: 'saved',
    title: 'saved',
    status: 'downloaded',
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest: {
      book: book('saved', 1),
      chapters: null,
      files: [],
      coverUri: null,
      savedAt: '2026-10-01T00:00:00.000Z',
    },
  } as DownloadEntry;
  useDownloads.setState({ entries: { k: entry } });
  const { result } = await mount();
  await waitFor(() => {
    const s = result.current.stories;
    expect(s.status === 'ready' && s.offline && s.books.map((b) => b.rel_path)).toEqual(['saved']);
  });
});

it('starts with a story in progress that is not on the first page yet', async () => {
  setKids({ bedtime: '19:30', library: { connectionId: CONN.id, libraryId: 2 } });
  mockClient.allProgress.mockResolvedValue([
    {
      library_id: 2,
      path: 'deep',
      position: 60,
      duration: 600,
      finished: false,
      playback_speed: 1,
      version: 0,
      device_id: 'd',
      updated_at: '2026-10-01T00:00:00.000Z',
    },
  ]);
  const { result } = await mount();
  await waitFor(() => expect(result.current.stories.status).toBe('ready'));
  const s = result.current.stories;
  expect(s.status === 'ready' && s.books.map((b) => b.rel_path)).toEqual(['deep', 'a', 'b', 'c']);
  expect(mockClient.item).toHaveBeenCalledWith(2, 'deep');
});

it('asks for the next page of stories only when the grid nears its end', async () => {
  setKids({ bedtime: '19:30', library: { connectionId: CONN.id, libraryId: 2 } });
  mockClient.listBooks.mockImplementation(async (_lib: number, q: { cursor?: string }) =>
    q.cursor ? { books: [book('d')], next_cursor: '' } : { books: [book('a')], next_cursor: 'p2' },
  );
  const { result } = await mount();
  await waitFor(() => expect(result.current.stories.status).toBe('ready'));
  let s = result.current.stories;
  expect(s.status === 'ready' && [s.books.map((b) => b.rel_path), s.more]).toEqual([
    ['a'],
    'available',
  ]);
  expect(mockClient.listBooks).toHaveBeenCalledTimes(1);

  await act(async () => result.current.loadMore());
  await waitFor(() => {
    s = result.current.stories;
    expect(s.status === 'ready' && [s.books.map((b) => b.rel_path), s.more]).toEqual([
      ['a', 'd'],
      'none',
    ]);
  });
});

it('does not re-render on a download progress tick', async () => {
  setKids({ bedtime: '19:30' });
  const entry = {
    connectionId: CONN.id,
    libraryId: 1,
    path: 'saving',
    title: 'saving',
    status: 'downloading',
    progress: 0.1,
    bytes: 10,
    totalBytes: 100,
    manifest: {
      book: book('saving', 1),
      chapters: null,
      files: [],
      coverUri: null,
      savedAt: '2026-10-01T00:00:00.000Z',
    },
  } as DownloadEntry;
  useDownloads.setState({ entries: { k: entry } });
  let renders = 0;
  const { result } = await mount(() => void renders++);
  await waitFor(() => expect(result.current.stories.status).toBe('ready'));
  const before = renders;
  await act(async () =>
    useDownloads.setState({ entries: { k: { ...entry, progress: 0.5, bytes: 50 } } }),
  );
  expect(renders).toBe(before);
});
