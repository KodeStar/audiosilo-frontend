import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AnimatedPressable } from './animated-pressable';

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

describe('AnimatedPressable', () => {
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
