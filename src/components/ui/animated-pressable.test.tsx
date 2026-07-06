import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AnimatedPressable } from './animated-pressable';

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

describe('AnimatedPressable', () => {
  // Native regression guard (the reason animated-pressable.native.tsx exists).
  //
  // The shared/web impl renders a reanimated `Animated.createAnimatedComponent(Pressable)`
  // with an inline `style={useAnimatedStyle(...)}`. On device that reanimated style
  // object, fed through NativeWind's `className -> style` interop, DROPPED the
  // className-resolved layout entirely - every card/row/button collapsed to a
  // background-less vertical stack. The native impl instead renders a plain Pressable,
  // forwards className untouched (so NativeWind resolves it the normal way) and never
  // injects a reanimated style - so className (on device) and any caller inline style
  // survive. jest-expo runs this against the .native file but does NOT run NativeWind's
  // native interop (className stays an unresolved string here), so we assert the
  // structural guarantee that actually differs between broken and fixed - className is
  // forwarded and an inline style is preserved - not the resolved flexbox (that lives in
  // the on-device screenshots). Runs first: the fireEvent-based tests below leave the
  // shared `screen` in a state that trips up a later className query.
  it('forwards className untouched and keeps a caller inline style (no clobbering)', async () => {
    await mount(
      <AnimatedPressable
        className="flex-row bg-white px-3"
        style={{ backgroundColor: 'rgb(1,2,3)' }}
        accessibilityRole="button"
      />,
    );
    const node = screen.getByRole('button');
    expect(node.props.className).toBe('flex-row bg-white px-3');
    const style = node.props.style as unknown;
    const resolved =
      typeof style === 'function' ? (style as (s: object) => unknown)({ pressed: false }) : style;
    const flat = Object.assign({}, ...([] as unknown[]).concat(resolved).flat().filter(Boolean));
    expect(flat.backgroundColor).toBe('rgb(1,2,3)');
  });

  it('passes onPress through', async () => {
    const onPress = jest.fn();
    await mount(
      <AnimatedPressable onPress={onPress} className="p-4">
        <Text>Tap me</Text>
      </AnimatedPressable>,
    );

    fireEvent.press(screen.getByText('Tap me'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('forwards accessibility props and still fires the caller onPressIn/onPressOut', async () => {
    const onPressIn = jest.fn();
    const onPressOut = jest.fn();
    await mount(
      <AnimatedPressable
        accessibilityLabel="Play"
        accessibilityRole="button"
        onPressIn={onPressIn}
        onPressOut={onPressOut}
      />,
    );

    const node = screen.getByLabelText('Play');
    fireEvent(node, 'pressIn');
    fireEvent(node, 'pressOut');
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onPressOut).toHaveBeenCalledTimes(1);
  });
});
