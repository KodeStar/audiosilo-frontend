/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { UserStats } from '@/api/types';

import { yearStats } from './year-fixture';

// Gestures run on the UI thread (no jest runtime for that): the detector just renders and
// records its gesture, so a test can call the pull's handler directly.
const mockGestures: { handlers: { onEnd?: (e: { translationY: number }) => void } }[] = [];
jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureDetector: ({ children, gesture }: { children: React.ReactNode; gesture: never }) => {
    mockGestures.push(gesture);
    return children;
  },
}));
const mockRouter = { canGoBack: jest.fn(() => true), back: jest.fn(), dismissTo: jest.fn() };
jest.mock('expo-router', () => ({
  router: {
    canGoBack: () => mockRouter.canGoBack(),
    back: () => mockRouter.back(),
    dismissTo: (h: string) => mockRouter.dismissTo(h),
  },
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/api/provider', () => ({ useCid: (id?: string) => id ?? 'a' }));
jest.mock('@/stores/session', () => ({
  useSession: (sel: (s: object) => unknown) =>
    sel({ connections: [{ id: 'a', name: 'Hearthside', user: { username: 'alex' } }] }),
}));
jest.mock('@/components/library/book-cover', () => ({
  BookCover: () => null,
  coverSizeFor: () => 640,
  MAX_COVER_SIZE: 640,
}));
const mockShare = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('./use-share-card', () => ({
  useShareCard: () => ({ busy: false, coversOff: false, share: mockShare }),
}));
let mockSupported: boolean | undefined = true;
let mockStats: Record<string, { data?: UserStats }> = {};
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: undefined, isError: false }),
  useCapability: () => mockSupported,
  useMyStats: (range: string) => mockStats[range] ?? {},
  useMyListening: () => ({ data: undefined, isError: true }),
  useListeningGoal: () => ({ data: undefined, isError: true }),
}));

/* eslint-disable import/first */
import { YearStoryScreen } from './year-story-screen';
/* eslint-enable import/first */

const os = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks();
  mockSupported = true;
  mockStats = { year: { data: yearStats() }, '2025': { data: yearStats({ range: '2025' }) } };
});
afterEach(() => {
  Platform.OS = os;
});

describe('YearStoryScreen', () => {
  it('opens on the card it was asked for, of the year asked for', async () => {
    await render(<YearStoryScreen year="2025" card="2" />);
    expect(screen.getByLabelText(/^Card 3 of 8\. Your book of the year\./)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Share this card' }));
    expect(mockShare).toHaveBeenCalledWith(expect.anything(), {
      fileName: 'audiosilo-2025-03-book.png',
      title: 'My 2025 in listening',
    });
  });

  it('closes back to where it was opened from, else home', async () => {
    await render(<YearStoryScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Close the story' }));
    expect(mockRouter.back).toHaveBeenCalled();
    mockRouter.canGoBack.mockReturnValueOnce(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Close the story' }));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/');
  });

  it('moves with the arrow keys and closes on Escape on the web', async () => {
    Platform.OS = 'web';
    await render(<YearStoryScreen />);
    const press = (key: string) =>
      act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    await press('ArrowRight');
    expect(screen.getByLabelText(/^Card 2 of 8$/)).toBeTruthy();
    await press('ArrowLeft');
    expect(screen.getByLabelText(/^Card 1 of 8$/)).toBeTruthy();
    await press('Escape');
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('closes on a pull down, not a short one', async () => {
    await render(<YearStoryScreen />);
    const pull = mockGestures.at(-1)!;
    await act(async () => pull.handlers.onEnd?.({ translationY: 40 }));
    expect(mockRouter.back).not.toHaveBeenCalled();
    await act(async () => pull.handlers.onEnd?.({ translationY: 200 }));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('says calmly why there is no story, with a way out', async () => {
    mockSupported = false;
    await render(<YearStoryScreen />);
    expect(screen.getByText(/Hearthside doesn't keep listening stats yet/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Close the story' }));
    expect(mockRouter.back).toHaveBeenCalled();
  });
});
