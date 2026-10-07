import { act, render, renderHook, screen } from '@testing-library/react-native';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
// Six chapters of 100 s; Holden is there from the start, Prax from chapter 3,
// Avasarala from chapter 5. The listener's saved place is 150 s (chapter 2).
let mockMetadata: boolean | undefined = true;
jest.mock('@/api/hooks', () => ({
  useCapability: () => mockMetadata,
  useMetaWork: () => ({ data: undefined, isError: false }),
  useBook: () => ({ data: { asin: 'B0' }, isLoading: false }),
  useBookProgress: () => ({ data: { position: 150, finished: false } }),
  useChapters: () => ({
    data: {
      files: [],
      chapters: Array.from({ length: 6 }, (_, i) => ({ title: `C${i + 1}`, book_offset: i * 100 })),
    },
    isLoading: false,
  }),
  useBookMeta: (_l: number, _p: string, enabled: boolean) => ({
    isLoading: false,
    data: enabled
      ? {
          matched: true,
          web_url: 'u',
          work: {
            id: 'w',
            characters: [
              { id: 'holden', name: 'Holden', reveal: { chapter: 1 } },
              { id: 'prax', name: 'Prax', reveal: { chapter: 3 } },
              { id: 'ava', name: 'Avasarala', reveal: { chapter: 5 } },
            ],
          },
        }
      : undefined,
  }),
}));

/* eslint-disable import/first */
import { playerStoreMock } from '@/testing/player-store-mock';

import { useCompanion } from './companion-store';
import { useCompanionData } from './use-companion-data';
import { WhoPanel } from './who-panel';
/* eslint-enable import/first */

const target = { connectionId: 'a', libraryId: 1, path: 'Corey/Calibans War' };
const KEY = 'a:1:Corey/Calibans War';
const nowPlaying = { ...target, queue: { chapters: [], total: 600 } };

function Who() {
  return <WhoPanel data={useCompanionData(target)} />;
}

beforeEach(() => {
  playerStoreMock().reset();
  mockMetadata = true;
  useCompanion.setState({ tab: null, revealedKey: null, justMet: null });
});

describe('useCompanionData', () => {
  it("never gates a new book on the previous book's place while its load is in flight", async () => {
    // The new book arrives with the old snapshot: 450 s would be chapter 5 of THIS book.
    const player = playerStoreMock();
    player.patch({ nowPlaying, bookPosition: 450, loadingBook: KEY });
    await act(async () => {
      render(<Who />);
    });
    expect(screen.getByText('Holden')).toBeTruthy();
    expect(screen.queryByText('Avasarala')).toBeNull();
    expect(screen.queryByText('Prax')).toBeNull();
    // The load lands at the book's own place, still chapter 2.
    await act(() => player.usePlayer.setState({ loadingBook: null, bookPosition: 160 }));
    expect(screen.queryByText('Avasarala')).toBeNull();
    // From there the live place counts.
    await act(() => player.usePlayer.setState({ bookPosition: 215 }));
    expect(screen.getByText('Prax')).toBeTruthy();
  });

  it("is off while the server's metadata capability is unknown, as the phone's chips are", async () => {
    mockMetadata = undefined;
    const { result } = await renderHook(() => useCompanionData(target));
    expect(result.current.status).toBe('off');
    mockMetadata = true;
    const known = await renderHook(() => useCompanionData(target));
    expect(known.result.current.status).toBe('ready');
  });
});
