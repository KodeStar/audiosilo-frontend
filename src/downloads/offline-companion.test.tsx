/**
 * The offline companion end to end: a downloaded book whose community metadata was kept
 * (`offline-meta.ts`), opened after a launch with NO network. The registry and the
 * payload file are hydrated by the real downloads store; the screens' real hooks then
 * read the seeded cache while every request fails, and the spoiler gate (meta-gating,
 * unchanged) still decides what shows.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { BookMeta, BookMetaWork, ChaptersResponse, ServerInfo } from '@/api/types';
import type { DownloadEntry } from '@/downloads/types';

const PATH = 'Corey/Abaddons Gate';

// The payload the download kept, as its file holds it.
const mockFiles = new Map<string, string>();
jest.mock('@/downloads/engine', () => ({
  engine: {
    supported: true,
    fileExists: jest.fn(async () => true),
    removeBook: jest.fn(async () => {}),
    downloadFile: jest.fn(),
    storageEstimate: jest.fn(async () => null),
    totalBytesUsed: jest.fn(async () => 0),
    writeText: jest.fn(async () => true),
    readText: jest.fn(
      async (c: string, l: number, p: string, n: string) =>
        mockFiles.get(`${c}|${l}|${p}|${n}`) ?? null,
    ),
    removeFile: jest.fn(async () => {}),
  },
}));

// No network: every request the client makes fails like a dropped connection.
const mockCalls: string[] = [];
const mockClient = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === 'then'
        ? undefined
        : (..._a: unknown[]) => {
            mockCalls.push(String(prop));
            return Promise.reject(new TypeError('Network request failed'));
          },
  },
);
jest.mock('@/api/provider', () => {
  const { QueryClient: QC } = jest.requireActual('@tanstack/react-query');
  return {
    // gcTime Infinity: an unwatched entry's 5 min collection timer would hold jest open.
    queryClient: new QC({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }),
    useOptionalApi: () => mockClient,
    useApi: () => mockClient,
    useCid: (id?: string) => id || 'c1',
    useScopedCid: () => 'c1',
  };
});
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
// The failed requests are noted against the server's reachability, whose probe loop
// would otherwise outlive the test.
jest.mock('@/api/reachability', () => ({
  ...jest.requireActual('@/api/reachability'),
  noteError: jest.fn(),
}));

/* eslint-disable import/first */
import { useBook, useBookMeta, useMetaWork, useServerInfo } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { BookAbout } from '@/components/book/book-about';
import { BookMetaCharactersTab, matchedMeta } from '@/components/library/book-meta';
import { metaEnabledFor } from '@/components/library/meta-gating';
import { previousWorks, seriesRails } from '@/components/library/series-rails';
import { useBookCommunity } from '@/components/library/use-book-community';
import { useCompanionData } from '@/components/player/companion/use-companion-data';
import { WhoPanel } from '@/components/player/companion/who-panel';
import { downloadKey, useDownloads } from '@/downloads/store';
import { playerStoreMock } from '@/testing/player-store-mock';
/* eslint-enable import/first */

const qc = queryClient as QueryClient;
const target = { connectionId: 'c1', libraryId: 2, path: PATH };

const previousWork: BookMetaWork = {
  id: 'w2',
  title: "Caliban's War",
  authors: [],
  language: 'en',
  characters: [{ id: 'prax', name: 'Prax Meng', reveal: { chapter: 1 } } as never],
};

const meta: BookMeta = {
  matched: true,
  web_url: 'https://meta/w3',
  work: {
    id: 'w3',
    title: "Abaddon's Gate",
    authors: [],
    language: 'en',
    description: 'The Ring opens.',
    community_description: { text: 'A gate in the dark.' },
    attribution: {
      credit: 'AudioSilo Meta contributors',
      license: 'CC BY-SA 4.0',
      license_url: 'https://cc/by-sa',
      source_url: 'https://meta/w3',
    },
    characters: [
      { id: 'holden', name: 'Jim Holden', reveal: { chapter: 1 } } as never,
      { id: 'clarissa', name: 'Clarissa Mao', reveal: { chapter: 5 } } as never,
    ],
  },
  series: [
    {
      id: 's',
      name: 'The Expanse',
      position: '3',
      works: [
        { id: 'w2', title: "Caliban's War", position: '2', authors: [], web_url: 'https://m/2' },
        { id: 'w3', title: "Abaddon's Gate", position: '3', authors: [], web_url: 'https://m/3' },
      ],
    },
  ],
  previous: [previousWork],
};

const chapters = {
  files: [],
  chapters: Array.from({ length: 6 }, (_, i) => ({
    title: `C${i + 1}`,
    start: i * 100,
    end: (i + 1) * 100,
    book_offset: i * 100,
  })),
} as unknown as ChaptersResponse;

function server(): ServerInfo {
  return {
    name: 'Hearthside',
    server_id: 'c1',
    version: '1',
    api: '1',
    capabilities: { metadata: true, meta_bundle: true } as never,
    auth: { methods: [] },
  };
}

function downloaded(): DownloadEntry {
  return {
    connectionId: 'c1',
    libraryId: 2,
    path: PATH,
    title: "Abaddon's Gate",
    status: 'downloaded',
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest: {
      book: {
        id: 1,
        library_id: 2,
        rel_path: PATH,
        is_folder: true,
        title: "Abaddon's Gate",
        author: 'James S. A. Corey',
        series: 'The Expanse',
        series_index: 3,
        narrator: '',
        duration: 600,
        format: 'mp3',
        size: 0,
        asin: 'B0',
      },
      chapters,
      files: [{ relPath: `${PATH}/01.mp3`, localUri: 'file:///01.mp3' }],
      coverUri: null,
      savedAt: '2026-05-01T10:00:00Z',
      meta: { savedAt: '2026-05-01T10:00:00.000Z' },
    },
  };
}

// The launch's restore waits for the JS thread to be idle: here, the next turn.
(globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback = (cb) =>
  setTimeout(cb, 0);

/** A cold launch with no network: the registry, the kept payload and the server's kept
 * `/server` answer come back from storage, the cache starts empty. */
async function launchOffline() {
  const savedAt = Date.parse('2026-05-01T10:00:00Z');
  mockFiles.set(
    `c1|2|${PATH}|meta.json`,
    JSON.stringify({
      v: 1,
      savedAt,
      previous: true,
      meta,
      works: [],
    }),
  );
  await AsyncStorage.setItem(
    'audiosilo.offlineServers',
    JSON.stringify({ c1: { info: server(), savedAt } }),
  );
  await AsyncStorage.setItem(
    'audiosilo.downloads',
    JSON.stringify({ [downloadKey('c1', 2, PATH)]: downloaded() }),
  );
  await useDownloads.getState().hydrate();
  // The payload is read and seeded once the launch is idle, after the registry.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

/** Let the screens' (failing) refetches land. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

/** The book page's own chain (`components/book/book-page.tsx`): `/server`, the book, the
 * gate, the one `useBookMeta`, then the blocks it places (the aside's About card, as
 * `BookAside` places it, and the Characters tab). */
function BookPageCommunity() {
  const { data: book } = useBook(2, PATH);
  const { data: info } = useServerInfo();
  const enabled = metaEnabledFor(!!info?.capabilities.metadata, book);
  const { data } = useBookMeta(2, PATH, enabled);
  const matched = matchedMeta(data, enabled);
  if (!book || !matched) return null;
  return (
    <>
      <BookAbout book={book} meta={matched} />
      <BookMetaCharactersTab
        characters={matched.work.characters ?? []}
        progress={{ chapter: 0, finished: false }}
        showSpoilers={false}
        onToggleSpoilers={() => {}}
        previousBooks={previousWorks(seriesRails(matched.series, matched.work.id))}
      />
    </>
  );
}

beforeEach(async () => {
  qc.clear();
  mockCalls.length = 0;
  mockFiles.clear();
  await AsyncStorage.clear();
  useDownloads.setState({ entries: {}, hydrated: false });
  playerStoreMock().reset();
});

describe('a downloaded book opened offline', () => {
  it('the book page shows its community data, gated as online, and the previous book', async () => {
    await launchOffline();
    await act(async () => {
      render(<BookPageCommunity />, { wrapper });
    });
    await settle();
    // About leads with the kept community description, credited, with Improve this.
    expect(screen.getByText('A gate in the dark.')).toBeTruthy();
    expect(screen.getByText('CC BY-SA 4.0')).toBeTruthy();
    expect(screen.getByText('Improve this')).toBeTruthy();
    expect(screen.getByText('Jim Holden')).toBeTruthy();
    // Not reached yet (chapter 5): the gate still holds it back.
    expect(screen.queryByText('Clarissa Mao')).toBeNull();
    // The catch-up row opens onto the previous book's kept work, with no request.
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Caliban's War"));
    });
    await settle();
    expect(screen.getByText('Prax Meng')).toBeTruthy();
    // The screens did ask the network (the seeds are dated when they were saved, so they
    // are stale): every request failed, and the kept data stayed on screen.
    expect(mockCalls).toEqual(expect.arrayContaining(['serverInfo', 'bookMeta', 'metaWork']));
  });

  it("the companion's Who's who reads the kept data", async () => {
    await launchOffline();
    function Who() {
      return <WhoPanel data={useCompanionData(target)} />;
    }
    await act(async () => {
      render(<Who />, { wrapper });
    });
    await settle();
    expect(screen.getByText('Jim Holden')).toBeTruthy();
    expect(screen.queryByText('Clarissa Mao')).toBeNull();
  });

  it('useBookCommunity (the companion, Previously on, the reveal toast) is ready, not loading', async () => {
    await launchOffline();
    const { result } = await renderHook(() => useBookCommunity(target), { wrapper });
    await settle();
    expect(result.current.metadata).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.work?.id).toBe('w3');
    expect(result.current.work?.community_description?.text).toBe('A gate in the dark.');
    expect(result.current.work?.attribution).toBeDefined();
    expect(result.current.chapterStarts).toHaveLength(6);
  });

  it('the previous work answers by its id', async () => {
    await launchOffline();
    const { result } = await renderHook(() => useMetaWork('w2', true), { wrapper });
    await settle();
    expect(result.current.data?.title).toBe("Caliban's War");
  });

  it('without a kept payload, it shows nothing (as before) and asks nothing it cannot', async () => {
    mockFiles.clear();
    const entry = downloaded();
    delete entry.manifest.meta;
    await AsyncStorage.setItem(
      'audiosilo.downloads',
      JSON.stringify({ [downloadKey('c1', 2, PATH)]: entry }),
    );
    await useDownloads.getState().hydrate();
    const { result } = await renderHook(() => useBookCommunity(target), { wrapper });
    await settle();
    expect(result.current.work).toBeUndefined();
    expect(result.current.metadata).toBeUndefined();
  });
});
