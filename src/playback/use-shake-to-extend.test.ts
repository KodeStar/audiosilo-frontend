import { act, renderHook } from '@testing-library/react-native';
import Accelerometer from 'expo-sensors/build/Accelerometer';
import { Platform } from 'react-native';

import { playerStoreMock } from '@/testing/player-store-mock';

// The detector and the tuning are pure; the sensor itself is mocked (it needs a device).
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('expo-sensors/build/Accelerometer', () => ({
  setUpdateInterval: jest.fn(),
  addListener: jest.fn(() => ({ remove: jest.fn() })),
}));

/* eslint-disable import/first */
import { useSleepTimer } from '@/playback/sleep-timer';
import { createShakeDetector, shakeTuning, useShakeToExtend } from '@/playback/use-shake-to-extend';
import { useSettings } from '@/stores/settings';
/* eslint-enable import/first */

const player = playerStoreMock();

/** A sample of total acceleration `g`, all on one axis. */
const g = (force: number) => ({ x: force, y: 0, z: 0 });

describe('shakeTuning', () => {
  it('keeps medium at the tuning the detector always had', () => {
    expect(shakeTuning('medium')).toEqual({ thresholdG: 1.4, hits: 2 });
  });

  it('orders the settings by how easily a shake counts', () => {
    const high = shakeTuning('high');
    const medium = shakeTuning('medium');
    const low = shakeTuning('low');
    expect(high.thresholdG).toBeLessThan(medium.thresholdG);
    expect(medium.thresholdG).toBeLessThan(low.thresholdG);
    expect(low.hits).toBeGreaterThanOrEqual(medium.hits);
    expect(high.hits).toBeLessThanOrEqual(medium.hits);
  });
});

describe('createShakeDetector', () => {
  it('needs a burst, not one bump', () => {
    const onShake = jest.fn();
    const detect = createShakeDetector(shakeTuning('medium'), onShake);
    detect(g(2), 0);
    expect(onShake).not.toHaveBeenCalled();
    detect(g(2), 100);
    expect(onShake).toHaveBeenCalledTimes(1);
  });

  it('ignores samples at or under the threshold', () => {
    const onShake = jest.fn();
    const detect = createShakeDetector(shakeTuning('medium'), onShake);
    for (let t = 0; t < 1000; t += 100) detect(g(1.4), t);
    expect(onShake).not.toHaveBeenCalled();
  });

  it('starts a new burst when the window has passed', () => {
    const onShake = jest.fn();
    const detect = createShakeDetector(shakeTuning('medium'), onShake);
    detect(g(2), 0);
    detect(g(2), 1500); // too late for the first burst: the start of a new one
    expect(onShake).not.toHaveBeenCalled();
    detect(g(2), 1600);
    expect(onShake).toHaveBeenCalledTimes(1);
  });

  it('counts one shake per debounce period', () => {
    const onShake = jest.fn();
    const detect = createShakeDetector(shakeTuning('medium'), onShake);
    for (let t = 0; t < 1900; t += 100) detect(g(2), t);
    expect(onShake).toHaveBeenCalledTimes(1);
    detect(g(2), 2100);
    detect(g(2), 2200);
    expect(onShake).toHaveBeenCalledTimes(2);
  });

  it('asks low sensitivity for a harder, longer shake', () => {
    const onShake = jest.fn();
    const detect = createShakeDetector(shakeTuning('low'), onShake);
    detect(g(1.6), 0);
    detect(g(1.6), 100);
    detect(g(1.6), 200);
    expect(onShake).not.toHaveBeenCalled(); // medium would have counted this
    detect(g(2), 300);
    detect(g(2), 400);
    expect(onShake).not.toHaveBeenCalled();
    detect(g(2), 500);
    expect(onShake).toHaveBeenCalledTimes(1);
  });

  it('lets high sensitivity count a gentler shake', () => {
    const onShake = jest.fn();
    const detect = createShakeDetector(shakeTuning('high'), onShake);
    detect(g(1.3), 0);
    detect(g(1.3), 100);
    expect(onShake).toHaveBeenCalledTimes(1);
  });
});

describe('useShakeToExtend', () => {
  const prevOS = Platform.OS;
  const addListener = Accelerometer.addListener as jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    addListener.mockClear();
    player.reset();
    player.patch({
      nowPlaying: {
        connectionId: 'srv-1',
        libraryId: 1,
        path: 'b.m4b',
        queue: { chapters: [], total: 36_000 },
      },
    });
    player.setPlayState('playing');
    useSettings.setState({ shakeToExtend: true, shakeSensitivity: 'medium' });
    Platform.OS = 'ios';
  });

  afterEach(async () => {
    Platform.OS = prevOS;
    await act(async () => useSleepTimer.getState().cancel());
    jest.useRealTimers();
  });

  /** A timer in its last seconds: the window the sensor listens in. */
  async function ending() {
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(45_000);
    });
    expect(useSleepTimer.getState().phase).toBe('ending');
  }

  it('listens only in the ending window', async () => {
    await renderHook(() => useShakeToExtend());
    expect(addListener).not.toHaveBeenCalled();
    await ending();
    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it('a shake at the chosen sensitivity keeps listening', async () => {
    useSettings.setState({ shakeSensitivity: 'high' });
    await renderHook(() => useShakeToExtend());
    await ending();
    const onSample = addListener.mock.calls[0][0] as (s: object) => void;
    await act(async () => {
      onSample({ x: 1.3, y: 0, z: 0 }); // under medium's bar, over high's
      jest.advanceTimersByTime(100);
      onSample({ x: 1.3, y: 0, z: 0 });
    });
    expect(useSleepTimer.getState().phase).toBe('running');
  });

  it('leaves the sensor off when the listener switched shaking off', async () => {
    useSettings.setState({ shakeToExtend: false });
    await renderHook(() => useShakeToExtend());
    await ending();
    expect(addListener).not.toHaveBeenCalled();
  });

  it('leaves the sensor off on the web', async () => {
    Platform.OS = 'web';
    await renderHook(() => useShakeToExtend());
    await ending();
    expect(addListener).not.toHaveBeenCalled();
  });
});
