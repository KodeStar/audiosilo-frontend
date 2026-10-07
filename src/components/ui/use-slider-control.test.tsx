import { fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureDetector, PointerType, State } from 'react-native-gesture-handler';
import { fireGestureHandler } from 'react-native-gesture-handler/jest-utils';

import { useSliderControl } from './use-slider-control';

// The real detector, driven by gesture-handler's own `fireGestureHandler`: the events
// reach the callbacks through its JS event receiver, with the state machine (BEGAN,
// ACTIVE, then END, CANCELLED or FAILED) that decides `onEnd`'s `success`. The detector
// also asks Reanimated for `useEvent` (its UI-thread receiver, unused here), which the
// shared reanimated mock in jest.setup.ts does not have.
Object.assign(jest.requireMock('react-native-reanimated'), { useEvent: () => undefined });

type Gesture = Parameters<typeof fireGestureHandler>[0];
type Config = Record<string, unknown>;
type Composed = { toGestureArray: () => (Gesture & { config: Config })[] };

/** 0..100 on a 200-point track: a value is half the x it lands on. */
const WIDTH = 200;

function Harness({
  onGesture,
  ...callbacks
}: {
  onGesture: (gesture: Composed) => void;
  onValueCommit: (v: number) => void;
  onPreview: (v: number | null) => void;
}) {
  const control = useSliderControl({
    value: 40,
    max: 100,
    step: 1,
    accessibilityLabel: 'Position',
    ...callbacks,
  });
  useEffect(() => onGesture(control.gesture as unknown as Composed), [control.gesture, onGesture]);
  return (
    <GestureDetector gesture={control.gesture}>
      <View {...control.controlProps} />
    </GestureDetector>
  );
}

async function mount() {
  const onGesture = jest.fn();
  const onValueCommit = jest.fn();
  const onPreview = jest.fn();
  await render(
    <Harness onGesture={onGesture} onValueCommit={onValueCommit} onPreview={onPreview} />,
  );
  await fireEvent(screen.getByRole('adjustable'), 'layout', {
    nativeEvent: { layout: { width: WIDTH, height: 44 } },
  });
  const [pan, tap] = (onGesture.mock.lastCall![0] as Composed).toGestureArray();
  return { pan, tap, onValueCommit, onPreview };
}

describe('useSliderControl gestures', () => {
  it('commits a tap where it lands', async () => {
    const { tap, onValueCommit } = await mount();
    fireGestureHandler(tap, [{ x: 50, pointerType: PointerType.TOUCH }]);
    expect(onValueCommit).toHaveBeenCalledWith(25);
  });

  it('ignores the press Space or Enter makes at the centre of the focused slider (web)', async () => {
    // Gesture-handler's web keyboard manager turns either key into a KEY pointer at the
    // view's centre. Space there is play/pause; the slider's own onKeyDown has the keys.
    const { pan, tap, onValueCommit, onPreview } = await mount();
    const key = { x: WIDTH / 2, pointerType: PointerType.KEY };
    fireGestureHandler(tap, [key]);
    fireGestureHandler(pan, [key, key, key]);
    expect(onValueCommit).not.toHaveBeenCalled();
    // No scrub preview either: only the finalize's "drag over".
    expect(onPreview.mock.calls).toEqual([[null]]);
  });

  it('scrubs sideways and commits on release', async () => {
    const { pan, onValueCommit, onPreview } = await mount();
    fireGestureHandler(pan, [
      { state: State.BEGAN, x: 20 },
      { state: State.ACTIVE, x: 40 },
      { state: State.ACTIVE, x: 150 },
      { state: State.END, x: 150 },
    ]);
    expect(onPreview.mock.calls).toEqual([[10], [75], [null]]);
    expect(onValueCommit).toHaveBeenCalledWith(75);
  });

  it.each([
    ['cancelled', State.CANCELLED],
    ['failed', State.FAILED],
  ])('seeks nothing when the drag is %s (the scroll view took the swipe)', async (_, end) => {
    const { pan, onValueCommit, onPreview } = await mount();
    fireGestureHandler(pan, [
      { state: State.BEGAN, x: 20 },
      { state: State.ACTIVE, x: 40 },
      { state: State.ACTIVE, x: 150 },
      { state: end, x: 150 },
    ]);
    expect(onValueCommit).not.toHaveBeenCalled();
    // The preview still ends.
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it('activates only on a sideways move: a vertical one fails the pan first', async () => {
    // The movement thresholds are gesture-handler's (native, and the web's pointer
    // tracking), so the config is what a test can hold: past 10 points sideways the drag
    // scrubs; past 10 up or down, before that, the scroll view keeps the swipe.
    const { pan } = await mount();
    expect(pan.config).toMatchObject({
      activeOffsetXStart: -10,
      activeOffsetXEnd: 10,
      failOffsetYStart: -10,
      failOffsetYEnd: 10,
    });
  });
});
