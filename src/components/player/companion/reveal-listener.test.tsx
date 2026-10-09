import { act, render, screen } from '@testing-library/react-native';

import type { PlayerStoreMock } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
const mockPush = jest.fn();
let mockSegments = ['(app)'];
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  useSegments: () => mockSegments,
}));
jest.mock('@/api/provider', () => ({
  ConnectionScope: ({ children }: { children: unknown }) => children,
}));
// Six chapters of 100 s; Holden is there from the start, Prax from chapter 3,
// Avasarala and Bobbie from chapter 4.
let mockFinished = false;
let mockMetadata = true;
let mockSaved = 150;
jest.mock('@/api/hooks', () => ({
  useCapability: () => mockMetadata,
  useBook: () => ({ data: { asin: 'B0' } }),
  useBookProgress: () => ({ data: { position: mockSaved, finished: mockFinished } }),
  useChapters: () => ({
    data: {
      files: [],
      chapters: Array.from({ length: 6 }, (_, i) => ({ title: `C${i + 1}`, book_offset: i * 100 })),
    },
  }),
  useBookMeta: (_l: number, _p: string, enabled: boolean) => ({
    data: enabled
      ? {
          matched: true,
          web_url: 'u',
          work: {
            id: 'w',
            characters: [
              { id: 'holden', name: 'Holden', reveal: { chapter: 1 } },
              { id: 'prax', name: 'Prax', reveal: { chapter: 3 } },
              { id: 'ava', name: 'Avasarala', reveal: { chapter: 4 } },
              { id: 'bobbie', name: 'Bobbie', reveal: { chapter: 4 } },
            ],
          },
        }
      : undefined,
  }),
}));

/* eslint-disable import/first */
import { toast } from '@/components/ui/toast';
import { playerStoreMock } from '@/testing/player-store-mock';

import { usePlayerSheets } from '../player-sheets';
import { useCompanion } from './companion-store';
import { CompanionRevealListener } from './reveal-listener';
/* eslint-enable import/first */

const BOOK = {
  connectionId: 'a',
  libraryId: 1,
  path: 'Corey/Calibans War',
  queue: { chapters: [], total: 600 },
};
let player: PlayerStoreMock;

/** One store write, as an engine tick makes. */
const tick = (bookPosition: number, state = 'playing') =>
  act(() => {
    player.usePlayer.setState({
      bookPosition,
      snapshot: { ...player.usePlayer.getState().snapshot, state },
    });
  });

beforeEach(() => {
  player = playerStoreMock();
  player.reset();
  mockFinished = false;
  mockMetadata = true;
  mockSaved = 150;
  mockSegments = ['(app)'];
  mockPush.mockClear();
  (toast as jest.Mock).mockClear();
  useCompanion.setState({ justMet: null, tab: null });
});

async function mountAt(position: number, state = 'playing') {
  player.patch({ nowPlaying: BOOK, bookPosition: position });
  player.usePlayer.setState({ snapshot: { ...player.usePlayer.getState().snapshot, state } });
  await act(async () => {
    render(<CompanionRevealListener />);
  });
}

describe('CompanionRevealListener', () => {
  it('announces the people a chapter introduces when the book plays into it', async () => {
    await mountAt(295);
    await tick(297);
    await tick(299.5);
    expect(toast).not.toHaveBeenCalled();
    await tick(300.6);
    expect(toast).toHaveBeenCalledTimes(1);
    expect((toast as jest.Mock).mock.calls[0][0].title).toBe("New in Who's who: Avasarala, Bobbie");
    expect(useCompanion.getState().justMet).toEqual({
      key: 'a:1:Corey/Calibans War',
      ids: ['ava', 'bobbie'],
    });
  });

  it('does not fire on load or resume, even into a chapter with new people', async () => {
    await mountAt(0, 'loading');
    // The resume lands at the saved place (a jump, while loading), then plays on.
    await tick(450, 'loading');
    await tick(450.5);
    await tick(451);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does not fire on a seek or a skip across chapters', async () => {
    await mountAt(250);
    await tick(251);
    await tick(420); // a jump over the chapter 3 and 4 boundaries
    await tick(421);
    expect(toast).not.toHaveBeenCalled();
  });

  it('fires when the chapter starts a new file, which pauses and buffers on the way (web)', async () => {
    await mountAt(299);
    await tick(299.5, 'paused');
    await tick(300.5, 'loading');
    await tick(301);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('fires when a file change is reported track first, then place (iOS)', async () => {
    await mountAt(298);
    await tick(299.5);
    await tick(399.5); // the next file's index with the old file's place: a file too far
    await tick(300.4);
    expect(toast).toHaveBeenCalledTimes(1);
    expect((toast as jest.Mock).mock.calls[0][0].title).toBe("New in Who's who: Avasarala, Bobbie");
  });

  it('fires when a file change is reported place first, then track (Android)', async () => {
    await mountAt(298);
    await tick(299.5);
    await tick(200.4); // the new place in the old file
    await tick(300.4);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a seek over the boundary made while paused', async () => {
    await mountAt(250);
    await tick(251, 'paused');
    await tick(420, 'paused');
    await tick(420.5);
    await tick(421);
    expect(toast).not.toHaveBeenCalled();
  });

  it("fires at the chapter's start, where Who's who's gate turns over (the exact live place)", async () => {
    // Prax arrives with chapter 3, at 200 s: not on a 15 s step, so a bucketed place
    // (195) would hold the reveal back to 210.
    await mountAt(198);
    await tick(199.6);
    expect(toast).not.toHaveBeenCalled();
    await tick(200.1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect((toast as jest.Mock).mock.calls[0][0].title).toBe("New in Who's who: Prax");
  });

  it("announces nobody the saved place already shows in Who's who", async () => {
    // Another device saved a place in chapter 4; this one plays on from chapter 3, where
    // Who's who (never below the saved place) already shows Avasarala and Bobbie.
    mockSaved = 350;
    await mountAt(298);
    await tick(299.5);
    await tick(300.6);
    expect(toast).not.toHaveBeenCalled();
  });

  it("never reads the previous book's place as a new book's while its load is in flight", async () => {
    // The new book arrives with the old snapshot: 450 s is chapter 5 of THIS book.
    player.patch({ nowPlaying: BOOK, bookPosition: 450, loadingBook: 'a:1:Corey/Calibans War' });
    player.usePlayer.setState({
      snapshot: { ...player.usePlayer.getState().snapshot, state: 'playing' },
    });
    await act(async () => {
      render(<CompanionRevealListener />);
    });
    await tick(451);
    // The load lands at the book's own place, and it plays on into chapter 4.
    await act(() => {
      player.usePlayer.setState({ loadingBook: null, bookPosition: 296 });
    });
    await tick(297);
    await tick(299.5);
    await tick(300.6);
    expect(toast).toHaveBeenCalledTimes(1);
    expect((toast as jest.Mock).mock.calls[0][0].title).toBe("New in Who's who: Avasarala, Bobbie");
  });

  it('Show reads where the listener is when pressed, not when the toast went up', async () => {
    await mountAt(299);
    await tick(300.5);
    const show = (toast as jest.Mock).mock.calls[0][0].action.onPress as () => void;
    // The full player opened while the toast was up.
    mockSegments = ['player'];
    await act(async () => {
      await screen.rerender(<CompanionRevealListener />);
    });
    show();
    expect(mockPush).not.toHaveBeenCalled();
    expect(usePlayerSheets.getState().open).toBe('companion');
  });

  it('never announces the same people twice in a session', async () => {
    await mountAt(299);
    await tick(300.5);
    expect(toast).toHaveBeenCalledTimes(1);
    await tick(280); // back into chapter 3
    await tick(299.6);
    await tick(300.4);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a finished book and on a server without metadata', async () => {
    mockFinished = true;
    await mountAt(299);
    await tick(300.5);
    mockFinished = false;
    mockMetadata = false;
    await mountAt(299);
    await tick(300.5);
    expect(toast).not.toHaveBeenCalled();
  });
});
