import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { playerStoreMock } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

const mockAddBookmark = jest.fn((..._args: unknown[]) => Promise.resolve({}));
let mockClient: { addBookmark: typeof mockAddBookmark } | null = null;
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));

/* eslint-disable import/first */
import { startDriftWatch } from '@/playback/drift-controller';
import { resetInteractions } from '@/playback/last-interaction';
import { GRACE_SECONDS, useSleepTimer } from '@/playback/sleep-timer';
/* eslint-enable import/first */

const player = playerStoreMock();

/** The app's foreground state, and the listeners waiting for it to change. */
let appState = 'active';
let appStateListeners: ((s: string) => void)[] = [];
async function becomeActive() {
  appState = 'active';
  for (const l of [...appStateListeners]) l('active');
  await settle();
}

const NOW = new Date(2026, 9, 7, 23, 41, 0).getTime();

/** Let storage's promise chains settle. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

type ToastArg = {
  title: string;
  description?: string;
  action?: { label: string; onPress: () => void };
};
const lastToast = (): ToastArg => mockToast.mock.calls[mockToast.mock.calls.length - 1][0];

/**
 * The listener presses play at 1000 s, arms a 5-minute timer and falls asleep: the timer
 * fires at 1300 s and pauses the book.
 */
async function fallAsleep() {
  player.setPlayState('playing'); // the touch: play, at 1000 s, at NOW
  useSleepTimer.getState().startDuration(5);
  jest.advanceTimersByTime(299_000);
  player.patch({ bookPosition: 1300 }); // where five minutes of playback got to
  jest.advanceTimersByTime(1_000); // fires, and pauses
  await settle();
  expect(useSleepTimer.getState().phase).toBe('grace');
}

describe('drift controller', () => {
  let stop: () => void;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    appState = 'active';
    appStateListeners = [];
    Object.defineProperty(AppState, 'currentState', { get: () => appState, configurable: true });
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      l: (s: string) => void,
    ) => {
      appStateListeners.push(l);
      return {
        remove: () => {
          appStateListeners = appStateListeners.filter((x) => x !== l);
        },
      };
    }) as unknown as typeof AppState.addEventListener);
    player.reset();
    player.clearSpies();
    resetInteractions();
    mockToast.mockClear();
    mockAddBookmark.mockClear();
    mockAddBookmark.mockImplementation(() => Promise.resolve({}));
    mockClient = { addBookmark: mockAddBookmark };
    await AsyncStorage.clear();
    player.patch({
      nowPlaying: {
        connectionId: 'srv-1',
        libraryId: 1,
        path: 'a.m4b',
        queue: { chapters: [], total: 36_000 },
      },
      bookPosition: 1000,
    });
    player.setPlayState('paused');
    stop = startDriftWatch();
  });

  afterEach(() => {
    stop();
    useSleepTimer.getState().cancel();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('bookmarks the spot and offers the jump back on the next play, once', async () => {
    await fallAsleep();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000); // slept through the grace
    await settle();

    expect(mockAddBookmark).toHaveBeenCalledWith(1, 'a.m4b', 1300, 'Fell asleep');
    expect(mockToast).not.toHaveBeenCalled(); // nothing to say until the book plays

    // The next morning.
    jest.setSystemTime(NOW + 9 * 3600_000);
    player.setPlayState('playing');
    await settle();
    expect(mockToast).toHaveBeenCalledTimes(1);
    const shown = lastToast();
    expect(shown.title).toMatch(/^You drifted off around (23:41|11:41\sPM)$/);
    expect(shown.description).toBe('Jump back 5 minutes?');
    expect(shown.action?.label).toBe('Jump back');
    shown.action?.onPress();
    expect(player.spies.seekBook).toHaveBeenCalledWith(1000);

    // Offered once.
    player.setPlayState('paused');
    player.setPlayState('playing');
    await settle();
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it('offers it at once when the morning play is what closes the grace', async () => {
    await fallAsleep();
    jest.setSystemTime(Date.now() + 9 * 3600_000); // suspended overnight: no ticks
    player.setPlayState('playing');
    await settle();
    expect(useSleepTimer.getState().phase).toBe('idle');
    expect(mockAddBookmark).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(lastToast().description).toBe('Jump back 5 minutes?');
  });

  it('does nothing when the listener keeps listening', async () => {
    await fallAsleep();
    useSleepTimer.getState().keepListening();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000);
    await settle();
    expect(mockAddBookmark).not.toHaveBeenCalled();
  });

  it('does nothing when the listener cancels the timer', async () => {
    await fallAsleep();
    useSleepTimer.getState().cancel();
    await settle();
    expect(mockAddBookmark).not.toHaveBeenCalled();
    player.setPlayState('playing');
    await settle();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('skips the bookmark offline, and still offers the jump back', async () => {
    mockAddBookmark.mockImplementation(() => Promise.reject(new TypeError('Network')));
    await fallAsleep();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000);
    await settle();
    expect(useSleepTimer.getState().phase).toBe('idle');
    player.setPlayState('playing');
    await settle();
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it('survives a connection that no longer exists', async () => {
    mockClient = null;
    await fallAsleep();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000);
    await settle();
    expect(useSleepTimer.getState().phase).toBe('idle');
    expect(mockAddBookmark).not.toHaveBeenCalled();
  });

  it('does not offer it when the book starts somewhere else', async () => {
    await fallAsleep();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000);
    await settle();
    player.patch({ bookPosition: 5000 }); // listened on another device since
    player.setPlayState('playing');
    await settle();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('does not offer it for another book', async () => {
    await fallAsleep();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000);
    await settle();
    player.usePlayer.setState({
      nowPlaying: {
        connectionId: 'srv-1',
        libraryId: 1,
        path: 'b.m4b',
        queue: { chapters: [], total: 36_000 },
      },
      snapshot: { ...player.usePlayer.getState().snapshot, state: 'playing' },
    });
    await settle();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('holds the offer for the foreground when the book plays in the background, once', async () => {
    await fallAsleep();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000);
    await settle();
    // The next morning, played from the lock screen.
    appState = 'background';
    jest.setSystemTime(NOW + 9 * 3600_000);
    player.setPlayState('playing');
    await settle();
    expect(mockToast).not.toHaveBeenCalled(); // nobody would see it
    await becomeActive();
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(lastToast().description).toBe('Jump back 5 minutes?');
    appState = 'background';
    await becomeActive();
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it('drops the held offer when the book played on far past where it stopped', async () => {
    await fallAsleep();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000);
    await settle();
    appState = 'background';
    player.setPlayState('playing');
    await settle();
    player.patch({ bookPosition: 1300 + 3600 }); // an hour listened to on the lock screen
    await becomeActive();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("does not spend the offer on the old book's snapshot when a book starts", async () => {
    // Book B fell asleep last night; book A is playing now.
    await fallAsleep();
    jest.advanceTimersByTime(GRACE_SECONDS * 1000);
    await settle();
    player.patch({
      nowPlaying: {
        connectionId: 'srv-1',
        libraryId: 1,
        path: 'other.m4b',
        queue: { chapters: [], total: 36_000 },
      },
      bookPosition: 20_000,
    });
    player.setPlayState('playing');
    await settle();
    // playBook shows a.m4b first, still with other.m4b's playing snapshot (and position).
    player.usePlayer.setState({
      nowPlaying: {
        connectionId: 'srv-1',
        libraryId: 1,
        path: 'a.m4b',
        queue: { chapters: [], total: 36_000 },
      },
    });
    await settle();
    expect(mockToast).not.toHaveBeenCalled();
    // Its engine then loads it where it stopped and plays.
    player.usePlayer.setState({
      bookPosition: 1300,
      snapshot: { ...player.usePlayer.getState().snapshot, state: 'loading' },
    });
    player.setPlayState('playing');
    await settle();
    expect(mockToast).toHaveBeenCalledTimes(1);
  });
});
