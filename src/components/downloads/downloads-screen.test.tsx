import { act, fireEvent, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

import type { Book } from '@/api/types';
import type { KeepAheadSlot, KeepAheadStatus } from '@/downloads/keep-ahead';
import type { DownloadEntry, DownloadStatus } from '@/downloads/types';
import { mountWithPortal } from '@/testing/render-overlay';

// --- the screen's collaborators -------------------------------------------------
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
const mockPress = jest.fn();
jest.mock('@/components/shell/destinations', () => ({ useTabPress: () => ({ press: mockPress }) }));
jest.mock('@/components/shell/tab-root-nav', () => ({
  SubNavActions: ({ children }: { children: ReactNode }) => children,
}));
const mockOpenBook = jest.fn();
const mockOpenPlayer = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openBook: mockOpenBook, openPlayer: mockOpenPlayer }),
}));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({ coverUrl: () => 'https://s/cover', authHeaders: () => ({}) }),
}));
let mockProgress: unknown[] = [];
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useAllProgressAll: () => ({ progress: mockProgress, isLoading: false, error: null }),
}));
jest.mock('@/stores/session', () => {
  const connections = [
    { id: 'a', name: 'Home Library' },
    { id: 'b', name: "Maya's Shelf" },
  ];
  return {
    useSession: (sel: (s: { connections: typeof connections }) => unknown) => sel({ connections }),
  };
});
jest.mock('@/downloads/engine', () => ({
  engine: {
    supported: true,
    totalBytesUsed: async () => 0,
    storageEstimate: async () => ({
      scope: 'browser',
      capacity: 60 * 1024 ** 3,
      free: 50 * 1024 ** 3,
    }),
  },
}));
jest.mock('@/downloads/store', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create: make } = require('zustand');
  const key = (c: string, l: number, p: string) => `${c}:${l}:${p}`;
  const useDownloads = make(() => ({
    entries: {},
    supported: true,
    hydrated: true,
    download: jest.fn(),
    cancel: jest.fn(),
    remove: jest.fn(async () => {}),
  }));
  return {
    downloadKey: key,
    useDownloads,
    useDownloadEntry: (c: string, l: number, p: string) =>
      useDownloads((s: { entries: Record<string, unknown> }) => s.entries[key(c, l, p)]),
  };
});
jest.mock('@/downloads/keep-ahead-controller', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create: make } = require('zustand');
  return { useKeepAhead: make(() => ({ status: 'idle', slots: [] })) };
});

/* eslint-disable import/first */
import { useKeepAhead } from '@/downloads/keep-ahead-controller';
import { useDownloads } from '@/downloads/store';
import { useSettings } from '@/stores/settings';

import { DownloadsScreen } from './downloads-screen';
/* eslint-enable import/first */

const book = (title: string, p: Partial<Book> = {}): Book => ({
  id: 1,
  library_id: 1,
  rel_path: title,
  is_folder: true,
  title,
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 3600,
  format: 'm4b',
  size: 1000,
  ...p,
});

function entry(
  title: string,
  status: DownloadStatus,
  p: Partial<DownloadEntry> = {},
): [string, DownloadEntry] {
  const connectionId = p.connectionId ?? 'a';
  return [
    `${connectionId}:1:${title}`,
    {
      connectionId,
      libraryId: 1,
      path: title,
      title,
      status,
      progress: 0,
      bytes: 0,
      totalBytes: 0,
      ...p,
      manifest: {
        book: book(title),
        chapters: null,
        files: [],
        coverUri: null,
        savedAt: '2026-10-01',
      },
    },
  ];
}

const store = () =>
  useDownloads.getState() as unknown as {
    download: jest.Mock;
    cancel: jest.Mock;
    remove: jest.Mock;
  };

function setEntries(...pairs: [string, DownloadEntry][]) {
  useDownloads.setState({ entries: Object.fromEntries(pairs) } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLayout = 'desktop';
  mockProgress = [];
  Platform.OS = 'ios';
  useDownloads.setState({ entries: {}, supported: true, hydrated: true } as never);
  useKeepAhead.setState({ status: 'idle' as KeepAheadStatus, slots: [] as KeepAheadSlot[] });
  useSettings.setState({ keepAhead: 0, autoDownloadNext: 'wifi', autoDeleteFinished: true });
});

async function mount() {
  const r = await mountWithPortal(<DownloadsScreen />);
  await act(async () => {}); // the storage reading resolves
  return r;
}

describe('DownloadsScreen', () => {
  it('shows the empty state with one way out', async () => {
    await mount();
    expect(screen.getByText('Nothing downloaded yet')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Browse the library' }));
    expect(mockPress).toHaveBeenCalledWith('(library)');
  });

  it('lists a running, a waiting and a failed download, with honest failure copy', async () => {
    setEntries(
      entry('Running', 'downloading', { progress: 0.4, bytes: 400, totalBytes: 1000 }),
      entry('Queued', 'queued'),
      entry('Broken', 'error', {
        progress: 0.41,
        failure: { kind: 'network', kept: 1 / 3 },
      }),
    );
    await mount();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('40% · 600 B to go')).toBeTruthy();
    expect(screen.getByText('Waiting to start')).toBeTruthy();
    expect(screen.getByText('Stopped at 41%')).toBeTruthy();
    expect(screen.getByText('Home Library stopped responding. Your 33% is kept.')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Retry downloading Broken' }));
    expect(store().download).toHaveBeenCalledWith(
      'a',
      1,
      expect.objectContaining({ title: 'Broken' }),
      undefined,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel downloading Running' }));
    expect(store().cancel).toHaveBeenCalledWith('a', 1, 'Running');
  });

  it('says a retry starts over when nothing was kept', async () => {
    setEntries(entry('Broken', 'error', { failure: { kind: 'server', status: 503, kept: 0 } }));
    await mount();
    expect(
      screen.getByText("Home Library couldn't send the book (error 503). Retry starts it again."),
    ).toBeTruthy();
  });

  it('says when the app closed in the middle, and what is kept', async () => {
    setEntries(entry('Cut', 'error', { failure: { kind: 'interrupted', kept: 0.5 } }));
    await mount();
    expect(screen.getByText('The app closed before it finished. Your 50% is kept.')).toBeTruthy();
  });

  it('groups books ready offline by server and asks before removing one', async () => {
    mockProgress = [
      {
        connectionId: 'a',
        library_id: 1,
        path: 'Dune',
        position: 380,
        duration: 1000,
        finished: false,
      },
    ];
    setEntries(
      entry('Dune', 'downloaded', { totalBytes: 2048, origin: 'keep-ahead' }),
      entry('Emma', 'downloaded', { connectionId: 'b', totalBytes: 1024 }),
    );
    await mount();
    expect(screen.getByText('Ready offline')).toBeTruthy();
    expect(screen.getByText('2 books · play with no connection')).toBeTruthy();
    expect(screen.getByText('Home Library · 2 KB')).toBeTruthy();
    expect(screen.getByText("Maya's Shelf · 1 KB")).toBeTruthy();
    expect(screen.getByText('Author · 38% · Kept ahead')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Play Dune' }));
    expect(mockOpenPlayer).toHaveBeenCalledWith('a', 1, 'Dune');

    await fireEvent.press(screen.getByRole('button', { name: 'Remove Emma' }));
    expect(store().remove).not.toHaveBeenCalled();
    expect(screen.getByText('Remove this download?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(store().remove).toHaveBeenCalledWith('b', 1, 'Emma');
  });

  it('shows the books keep-ahead is holding back, and cancelling declines them', async () => {
    useKeepAhead.setState({
      status: 'waiting',
      slots: [
        {
          state: 'waiting',
          book: {
            connectionId: 'a',
            libraryId: 1,
            path: 'Next',
            title: 'Next',
            size: 0,
            duration: 0,
            source: 'series',
          },
        },
      ],
    });
    useSettings.setState({ keepAhead: 1 });
    await mount();
    expect(screen.getByText('Waiting for Wi-Fi')).toBeTruthy();
    expect(screen.getByText('Waiting for Wi-Fi.')).toBeTruthy(); // the rules card's status
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel downloading Next' }));
    expect(store().cancel).toHaveBeenCalledWith('a', 1, 'Next');
  });

  it('binds the rules to the settings store', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('radio', { name: '2' }));
    expect(useSettings.getState().keepAhead).toBe(2);
    await fireEvent.press(screen.getByRole('radio', { name: 'Never' }));
    expect(useSettings.getState().autoDownloadNext).toBe('never');
    expect(screen.getByText('Turn on automatic downloads to use this.')).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('switch', { name: 'Remove a download when you finish the book' }),
    );
    expect(useSettings.getState().autoDeleteFinished).toBe(false);
  });

  it('explains why downloads are off in a browser that cannot keep them', async () => {
    Platform.OS = 'web';
    useDownloads.setState({ supported: false } as never);
    await mount();
    expect(screen.getByText("Downloads aren't available here")).toBeTruthy();
  });

  it('shows cover-shaped placeholders until the registry loads', async () => {
    useDownloads.setState({ hydrated: false } as never);
    await mount();
    expect(screen.getAllByTestId('cover-skeleton')).toHaveLength(3);
    expect(screen.queryByText('Nothing downloaded yet')).toBeNull();
  });
});
