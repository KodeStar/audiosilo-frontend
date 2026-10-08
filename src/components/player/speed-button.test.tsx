import { act, fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';
import { playerStoreMock } from '@/testing/player-store-mock';
import { expectNativeTarget } from '@/testing/touch-target';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

// The slider's gestures run on the UI thread (no jest runtime for that); the detector
// just renders, as in the slider's own suite.
jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
}));

/* eslint-disable import/first */
import { SpeedSheet } from '@/components/player/speed-button';
/* eslint-enable import/first */

const player = playerStoreMock();

/** A 10-hour book, 2 hours in, at `rate`. */
function load(rate: number) {
  player.reset();
  player.clearSpies();
  player.patch({
    rate,
    bookPosition: 7200,
    nowPlaying: {
      connectionId: 'srv-1',
      libraryId: 1,
      path: 'b.m4b',
      queue: { chapters: [], total: 36_000 },
    },
  });
}

async function open() {
  await mountWithPortal(<SpeedSheet visible onClose={jest.fn()} />);
}

describe('SpeedSheet', () => {
  it('reads out the speed and the time left in the book at it', async () => {
    load(1.25);
    await open();
    expect(screen.getAllByText('1.25×')).toHaveLength(2); // the readout and its preset
    // 8 hours of content at 1.25x: 6h 24m.
    expect(
      screen.getByText('6h 24m left in the book at 1.25× · remembered for this book'),
    ).toBeTruthy();
  });

  it('labels the minus and plus buttons for a screen reader, and steps by 0.05', async () => {
    load(1.25);
    await open();
    await fireEvent.press(screen.getByLabelText('Slower by 0.05'));
    expect(player.spies.setRate).toHaveBeenLastCalledWith(1.2);
    await fireEvent.press(screen.getByLabelText('Faster by 0.05'));
    expect(player.spies.setRate).toHaveBeenLastCalledWith(1.3);
  });

  // STYLEGUIDE section 14: `h-11` is 38.5 pt on native (a 14 pt rem).
  it('gives the minus and plus buttons a 44 pt target on native', async () => {
    load(1.25);
    await open();
    expectNativeTarget(screen.getByLabelText('Slower by 0.05'));
    expectNativeTarget(screen.getByLabelText('Faster by 0.05'));
  });

  it('stops the buttons at the ends of the range', async () => {
    load(2);
    await open();
    expect(screen.getByLabelText('Faster by 0.05')).toBeDisabled();
    expect(screen.getByLabelText('Slower by 0.05')).not.toBeDisabled();
  });

  it('is an adjustable slider with the speed as its value text', async () => {
    load(1.25);
    await open();
    const slider = screen.getByLabelText('Playback speed');
    expect(slider.props.accessibilityRole).toBe('adjustable');
    expect(slider.props['aria-valuetext']).toBe('1.25×');
    await act(async () => {
      slider.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    });
    expect(player.spies.setRate).toHaveBeenLastCalledWith(1.3);
  });

  it('ends with the Smart Speed and Voice Boost switches', async () => {
    load(1.25);
    await open();
    expect(screen.getByTestId('effects-settings')).toBeTruthy();
    expect(screen.getByLabelText('Smart speed')).toBeTruthy();
    expect(screen.getByLabelText('Voice boost')).toBeTruthy();
  });

  it('shows each preset with the time left at it, and checks the current one', async () => {
    load(1.25);
    await open();
    const current = screen.getByLabelText('1.25×, 6h 24m left');
    expect(current.props.accessibilityState).toMatchObject({ checked: true });
    const double = screen.getByLabelText('2×, 4h left');
    expect(double.props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(double);
    expect(player.spies.setRate).toHaveBeenLastCalledWith(2);
  });
});
