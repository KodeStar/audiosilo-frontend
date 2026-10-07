import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';

import { playerStoreMock } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { GraceCard } from '@/components/player/grace-card';
import { GRACE_SECONDS, useSleepTimer } from '@/playback/sleep-timer';
import { useSettings } from '@/stores/settings';
/* eslint-enable import/first */

const player = playerStoreMock();

async function mount() {
  await act(async () => {
    render(<GraceCard />);
  });
}

/** Let the fire path's `pause().finally(restore)` microtasks settle. */
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

describe('GraceCard', () => {
  const prevOS = Platform.OS;

  beforeEach(() => {
    jest.useFakeTimers();
    player.reset();
    player.patch({
      nowPlaying: {
        connectionId: 'srv-1',
        libraryId: 1,
        path: 'b.m4b',
        queue: { chapters: [], total: 36_000 },
      },
      bookPosition: 100,
    });
    player.setPlayState('playing');
    useSleepTimer.getState().cancel();
    useSettings.setState({ shakeToExtend: true });
    Platform.OS = 'ios';
  });

  afterEach(async () => {
    Platform.OS = prevOS;
    await act(async () => {
      useSleepTimer.getState().cancel();
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('shows nothing while no timer is in its last seconds', async () => {
    await mount();
    expect(screen.queryByTestId('sleep-grace-card')).toBeNull();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    expect(screen.queryByTestId('sleep-grace-card')).toBeNull();
  });

  it('counts down a duration timer fading out, with the shake hint', async () => {
    await mount();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    await advance(36_000);
    expect(screen.getByText('Fading out in 24 s')).toBeTruthy();
    expect(
      screen.getByText('Still awake? Shake your phone or tap to keep listening.'),
    ).toBeTruthy();
  });

  it('says a chapter timer stops rather than fades', async () => {
    await mount();
    await act(async () => {
      useSleepTimer.getState().startUntilPosition(120, { key: 'player.sleepTimer.endOfBook' });
    });
    expect(screen.getByText('Stopping in 20 s')).toBeTruthy();
    expect(screen.queryByText(/Fading/)).toBeNull();
  });

  it('asks whether the listener is still awake once the timer has paused', async () => {
    await mount();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    await advance(60_000);
    expect(useSleepTimer.getState().phase).toBe('grace');
    expect(screen.getByText('Paused by the sleep timer')).toBeTruthy();
    expect(
      screen.getByText('Still awake? Shake your phone or tap to pick up where it stopped.'),
    ).toBeTruthy();
    await advance(GRACE_SECONDS * 1000);
    expect(screen.queryByTestId('sleep-grace-card')).toBeNull();
  });

  it('keeps listening from its button', async () => {
    await mount();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    await advance(50_000);
    await fireEvent.press(screen.getByText('Keep listening'));
    expect(useSleepTimer.getState().phase).toBe('running');
    expect(screen.queryByTestId('sleep-grace-card')).toBeNull();
  });

  it('does not mention the shake on the web, or when it is switched off', async () => {
    Platform.OS = 'web';
    await mount();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    await advance(40_000);
    expect(screen.getByText('Still awake? Keep listening.')).toBeTruthy();

    Platform.OS = 'android';
    await act(async () => {
      useSettings.setState({ shakeToExtend: false });
    });
    expect(screen.getByText('Still awake? Keep listening.')).toBeTruthy();
  });

  it('is a polite live region, not a dialog that takes focus', async () => {
    await mount();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    await advance(40_000);
    const hint = screen.getByText('Still awake? Shake your phone or tap to keep listening.');
    expect(hint.props.accessibilityLiveRegion).toBe('polite');
    expect(hint.props['aria-live']).toBe('polite');
    expect(JSON.stringify(screen.toJSON())).not.toContain('alertdialog');
  });

  it('announces itself once on iOS, not every second', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    await mount();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    await advance(40_000);
    await advance(5_000);
    expect(announce).toHaveBeenCalledTimes(1);
    announce.mockRestore();
  });
});
