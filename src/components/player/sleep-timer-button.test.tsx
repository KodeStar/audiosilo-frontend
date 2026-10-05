import { act, render, screen } from '@testing-library/react-native';

import { playerStoreMock } from '@/testing/player-store-mock';

// The button needs only the sleep-timer store. Mock the player store it pulls in
// transitively (through `sleep-timer`) so no engine / API layer loads in the test -
// the shared double the timer's own suite uses (`@/testing/player-store-mock`).
jest.mock('@/playback/store', () =>
  // `require` (not an import) because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { SleepTimerButton } from '@/components/player/sleep-timer-button';
import { FADE_SECONDS, useSleepTimer } from '@/playback/sleep-timer';
/* eslint-enable import/first */

const player = playerStoreMock();

async function mount() {
  await act(async () => {
    render(<SleepTimerButton onPress={jest.fn()} />);
  });
}

describe('SleepTimerButton', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // A book that is playing: a duration timer's countdown freezes while the transport
    // is stopped, so a paused stand-in would never reach the ending window below.
    player.setPlayState('playing');
    useSleepTimer.getState().cancel();
  });

  afterEach(async () => {
    // Still mounted at this point (RNTL's own cleanup runs after ours), so the store
    // write has to be wrapped like any other.
    await act(async () => {
      useSleepTimer.getState().cancel();
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('announces the sheet it opens, both idle and while a timer merely runs', async () => {
    await mount();
    expect(screen.getByLabelText('Sleep timer')).toBeTruthy();

    // A timer with 25 minutes left: tapping opens the presets sheet, exactly as when
    // idle. The a11y label overrides the visible children, so promising a screen-reader
    // user "Keep listening" here would describe a button that does no such thing.
    await act(async () => {
      useSleepTimer.getState().startDuration(25);
    });
    expect(screen.getByLabelText('Sleep timer')).toBeTruthy();
    expect(screen.queryByLabelText('Keep listening')).toBeNull();
  });

  it('announces "Keep listening" once a tap would actually keep the book going', async () => {
    await mount();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    // Into the ending window - one of the two windows where the tap re-arms the timer.
    act(() => {
      jest.advanceTimersByTime(60_000 - FADE_SECONDS * 1000);
    });
    expect(useSleepTimer.getState().phase).toBe('ending');
    expect(screen.getByLabelText('Keep listening')).toBeTruthy();
  });
});
