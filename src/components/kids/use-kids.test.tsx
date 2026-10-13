import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Book, Collection, CollectionDetail, Library, Progress } from '@/api/types';

const mockClient = {
  serverInfo: jest.fn(async (): Promise<{ capabilities: Record<string, boolean> }> => ({
    capabilities: {},
  })),
  collections: jest.fn(async (): Promise<Collection[]> => []),
  collection: jest.fn(async (id: number): Promise<CollectionDetail> => {
    throw new Error(`no collection ${id}`);
  }),
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
      collections: () => mockClient.collections(),
      collection: (id: number) => mockClient.collection(id),
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
  mockClient.serverInfo.mockResolvedValue({ capabilities: {} });
  mockClient.collections.mockResolvedValue([]);
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

it("offline, shows only the picked library's downloads (not the grown-ups' other library)", async () => {
  setKids({ bedtime: '19:30', library: { connectionId: CONN.id, libraryId: 2 } });
  useReachability.setState({ online: { [CONN.id]: false } });
  mockClient.libraries.mockRejectedValue(new Error('offline'));
  const saved = (path: string, libraryId: number) =>
    ({
      connectionId: CONN.id,
      libraryId,
      path,
      title: path,
      status: 'downloaded',
      progress: 1,
      bytes: 0,
      totalBytes: 0,
      manifest: {
        book: book(path, libraryId),
        chapters: null,
        files: [],
        coverUri: null,
        savedAt: '2026-10-01T00:00:00.000Z',
      },
    }) as DownloadEntry;
  useDownloads.setState({ entries: { a: saved('story', 2), b: saved('thriller', 1) } });
  const { result } = await mount();
  await waitFor(() => {
    const s = result.current.stories;
    expect(s.status === 'ready' && s.offline && s.books.map((b) => b.rel_path)).toEqual(['story']);
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

describe("a household member's kids shelf: the owner's shared collections (Phase 8b-1)", () => {
  const ADAM = { id: 1, username: 'adam' };
  const MEMBER = {
    ...CONN,
    user: { ...CONN.user, managed_by: ADAM, member_kind: 'kid' },
  } as Connection;
  const collection = (id: number, name: string, owner = ADAM, owned = false): Collection => ({
    id,
    name,
    description: '',
    owner,
    owned,
    item_count: 0,
    preview: [],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  });
  const detail = (c: Collection, books: Book[]): CollectionDetail => ({
    collection: c,
    items: books.map((b) => ({
      library_id: b.library_id,
      path: b.rel_path,
      added_at: '2026-10-01T00:00:00.000Z',
      book: b,
    })),
  });
  const started = (path: string, libraryId: number): Progress => ({
    library_id: libraryId,
    path,
    position: 60,
    duration: 600,
    finished: false,
    playback_speed: 1,
    version: 0,
    device_id: 'd',
    updated_at: '2026-10-02T00:00:00.000Z',
  });

  function setMember(connection: Connection = MEMBER) {
    useSession.setState({ connections: [connection], defaultConnectionId: connection.id });
    seedProfile({ connectionIds: [connection.id], kids: { bedtime: '19:30' } });
  }

  beforeEach(() => {
    mockClient.serverInfo.mockResolvedValue({ capabilities: { collections: true } });
  });

  const evies = collection(4, "Evie's books");
  const bedtime = collection(5, 'Bedtime');

  it("one collection: the whole shelf, in the owner's order, stories in progress first", async () => {
    setMember();
    mockClient.collections.mockResolvedValue([
      collection(9, 'Mine', { id: 7, username: 'leo' }, true),
      collection(8, "Someone else's", { id: 3, username: 'bob' }),
      evies,
    ]);
    mockClient.collection.mockResolvedValue(
      detail(evies, [book('x', 1), book('y', 2), book('z', 2)]),
    );
    mockClient.allProgress.mockResolvedValue([started('z', 2)]);
    const { result } = await mount();
    await waitFor(() => expect(result.current.stories.status).toBe('ready'));
    const s = result.current.stories;
    expect(s.status === 'ready' && s.books.map((b) => b.rel_path)).toEqual(['z', 'x', 'y']);
    expect(s.status === 'ready' && s.sections).toBeUndefined();
    expect(mockClient.collection.mock.calls).toEqual([[4]]);
    // Never the one-library view.
    expect(mockClient.listBooks).not.toHaveBeenCalled();
    result.current.loadMore();
    expect(mockClient.listBooks).not.toHaveBeenCalled();
  });

  it('several collections: one titled run each, in the list order', async () => {
    setMember();
    mockClient.collections.mockResolvedValue([bedtime, evies]);
    mockClient.collection.mockImplementation(async (id: number) =>
      id === 5 ? detail(bedtime, [book('moon'), book('owl')]) : detail(evies, [book('fox')]),
    );
    const { result } = await mount();
    await waitFor(() => expect(result.current.stories.status).toBe('ready'));
    const s = result.current.stories;
    expect(
      s.status === 'ready' && s.sections?.map((x) => [x.title, x.books.map((b) => b.rel_path)]),
    ).toEqual([
      ['Bedtime', ['moon', 'owl']],
      ["Evie's books", ['fox']],
    ]);
    expect(s.status === 'ready' && s.books.map((b) => b.rel_path)).toEqual(['moon', 'owl', 'fox']);
  });

  it('collections with no stories yet: ask a grown-up', async () => {
    setMember();
    mockClient.collections.mockResolvedValue([evies]);
    mockClient.collection.mockResolvedValue(detail(evies, []));
    const { result } = await mount();
    await waitFor(() =>
      expect(result.current.stories).toEqual({
        status: 'empty',
        serverName: 'Hearthside',
        askGrownUp: true,
      }),
    );
    expect(mockClient.listBooks).not.toHaveBeenCalled();
  });

  it('a collection that fails beside one that loads: its stories, and Try again', async () => {
    setMember();
    mockClient.collections.mockResolvedValue([bedtime, evies]);
    mockClient.collection.mockImplementation(async (id: number) => {
      if (id === 5) throw new Error('down');
      return detail(evies, [book('fox')]);
    });
    const { result } = await mount();
    await waitFor(() => expect(result.current.stories.status).toBe('ready'));
    const s = result.current.stories;
    expect(s.status === 'ready' && [s.books.map((b) => b.rel_path), s.more]).toEqual([
      ['fox'],
      'failed',
    ]);
    mockClient.collection.mockImplementation(async (id: number) =>
      id === 5 ? detail(bedtime, [book('moon')]) : detail(evies, [book('fox')]),
    );
    await act(async () => result.current.retry());
    await waitFor(() => {
      const r = result.current.stories;
      expect(r.status === 'ready' && r.books.map((b) => b.rel_path)).toEqual(['moon', 'fox']);
    });
  });

  it('every collection failing is an error it can retry', async () => {
    setMember();
    mockClient.collections.mockResolvedValue([evies]);
    mockClient.collection.mockRejectedValue(new Error('down'));
    const { result } = await mount();
    await waitFor(() => expect(result.current.stories.status).toBe('error'));
  });

  it("a member nobody shares a collection with (an 'all' member): the one-library view", async () => {
    setMember();
    mockClient.collections.mockResolvedValue([
      collection(8, "Someone else's", { id: 3, username: 'bob' }),
    ]);
    const { result } = await mount();
    await waitFor(() => expect(result.current.stories.status).toBe('ready'));
    const s = result.current.stories;
    expect(s.status === 'ready' && s.books.map((b) => b.rel_path)).toEqual(['x']);
    expect(mockClient.collection).not.toHaveBeenCalled();
  });

  it('a Phase 8 account (nobody manages it): the one-library view, collections never asked', async () => {
    setKids({ bedtime: '19:30' });
    const { result } = await mount();
    await waitFor(() => expect(result.current.stories.status).toBe('ready'));
    expect(mockClient.listBooks).toHaveBeenCalled();
    expect(mockClient.collections).not.toHaveBeenCalled();
  });

  it('a server without collections: the one-library view', async () => {
    mockClient.serverInfo.mockResolvedValue({ capabilities: {} });
    setMember();
    const { result } = await mount();
    await waitFor(() => expect(result.current.stories.status).toBe('ready'));
    expect(mockClient.listBooks).toHaveBeenCalled();
    expect(mockClient.collections).not.toHaveBeenCalled();
  });

  it('waits on the collections list (loading, not the library)', async () => {
    setMember();
    mockClient.collections.mockImplementation(() => new Promise(() => {}));
    const { result } = await mount();
    await waitFor(() => expect(mockClient.collections).toHaveBeenCalled());
    expect(result.current.stories).toEqual({ status: 'loading' });
    expect(mockClient.listBooks).not.toHaveBeenCalled();
  });
});
