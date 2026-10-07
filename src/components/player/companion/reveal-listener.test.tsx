import { act, render } from '@testing-library/react-native';

import type { PlayerStoreMock } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  useSegments: () => ['(app)'],
}));
jest.mock('@/api/provider', () => ({
  ConnectionScope: ({ children }: { children: unknown }) => children,
}));
// Six chapters of 100 s; Holden is there from the start, Prax from chapter 3,
// Avasarala and Bobbie from chapter 4.
let mockFinished = false;
let mockMetadata = true;
jest.mock('@/api/hooks', () => ({
  useCapability: () => mockMetadata,
  useBook: () => ({ data: { asin: 'B0' } }),
  useBookProgress: () => ({ data: { position: 150, finished: mockFinished } }),
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

  it('does not fire while paused or buffering at the boundary', async () => {
    await mountAt(299);
    await tick(299.5, 'paused');
    await tick(300.5, 'loading');
    await tick(301);
    expect(toast).not.toHaveBeenCalled();
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
