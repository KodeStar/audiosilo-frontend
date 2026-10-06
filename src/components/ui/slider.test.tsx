import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

// The gestures are gesture-handler + reanimated on the UI thread (no jest runtime for
// that); this suite covers the a11y and keyboard paths, so the detector just renders.
// It records the gesture it was handed, so a test can check its identity and call its
// handlers directly.
const mockGestures: unknown[] = [];
jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureDetector: ({ children, gesture }: { children: React.ReactNode; gesture: unknown }) => {
    mockGestures.push(gesture);
    return children;
  },
}));

/* eslint-disable import/first */
import { Slider } from './slider';
/* eslint-enable import/first */

function props(over: Partial<React.ComponentProps<typeof Slider>> = {}) {
  return {
    value: 60,
    max: 300,
    step: 15,
    accessibilityLabel: 'Playback position',
    valueText: (v: number) => `${v} of 300`,
    ...over,
    onValueCommit: jest.fn(),
  };
}

describe('Slider', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('is an adjustable control with its range and a spoken value', async () => {
    await render(<Slider {...props()} />);
    const slider = screen.getByRole('adjustable', { name: 'Playback position' });
    expect(slider).toHaveAccessibilityValue({ min: 0, max: 300, now: 60, text: '60 of 300' });
  });

  it('steps with the screen-reader actions, clamped to the range', async () => {
    const p = props({ value: 290 });
    await render(<Slider {...p} />);
    const slider = screen.getByRole('adjustable');

    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(p.onValueCommit).toHaveBeenLastCalledWith(300);
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(p.onValueCommit).toHaveBeenLastCalledWith(275);
  });

  it('moves with the arrow, page and Home/End keys on web', async () => {
    Platform.OS = 'web';
    const p = props();
    await render(<Slider {...p} />);
    const slider = screen.getByRole('adjustable');
    const key = (k: string) => fireEvent(slider, 'keyDown', { key: k, preventDefault: jest.fn() });

    await key('ArrowRight');
    expect(p.onValueCommit).toHaveBeenLastCalledWith(75);
    await key('ArrowLeft');
    expect(p.onValueCommit).toHaveBeenLastCalledWith(45);
    await key('PageUp');
    expect(p.onValueCommit).toHaveBeenLastCalledWith(210);
    await key('Home');
    expect(p.onValueCommit).toHaveBeenLastCalledWith(0);
    await key('End');
    expect(p.onValueCommit).toHaveBeenLastCalledWith(300);

    p.onValueCommit.mockClear();
    await key('a');
    expect(p.onValueCommit).not.toHaveBeenCalled();
  });

  it('ignores input while disabled', async () => {
    const p = props({ disabled: true });
    await render(<Slider {...p} />);
    await fireEvent(screen.getByRole('adjustable'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(p.onValueCommit).not.toHaveBeenCalled();
  });
  it('keeps one gesture while the callbacks change, and commits through the latest', async () => {
    // The dock's scrubber hands a fresh onSeek every second; rebuilding the gesture for
    // each reattached its handlers every tick, mid-drag included.
    mockGestures.length = 0;
    const first = jest.fn();
    const latest = jest.fn();
    const onPreview = jest.fn();
    const base = { value: 60, max: 300, step: 15, accessibilityLabel: 'Playback position' };
    await render(<Slider {...base} onValueCommit={first} />);
    const slider = screen.getByRole('adjustable');
    await fireEvent(slider, 'layout', { nativeEvent: { layout: { width: 200, height: 44 } } });
    await screen.rerender(
      <Slider {...base} value={61} onValueCommit={latest} onPreview={onPreview} />,
    );

    const gestures = new Set(mockGestures);
    expect(gestures.size).toBe(1);

    type Handlers = { onEnd: (e: { x: number }, success: boolean) => void };
    type Gestures = { toGestureArray: () => { handlers: Handlers }[] };
    const [pan, tap] = (mockGestures[0] as Gestures).toGestureArray();
    tap.handlers.onEnd({ x: 100 }, true);
    expect(latest).toHaveBeenLastCalledWith(150);
    expect(first).not.toHaveBeenCalled();
    pan.handlers.onEnd({ x: 50 }, true);
    expect(latest).toHaveBeenLastCalledWith(75);
  });
});
