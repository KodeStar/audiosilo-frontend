import { act, render, screen } from '@testing-library/react-native';
import { Dimensions, Text } from 'react-native';

import { DESKTOP_MIN_WIDTH, layoutFor, TABLET_MIN_WIDTH, useLayout } from './layout';

describe('layoutFor', () => {
  it('is a phone below 640', () => {
    expect(layoutFor(0)).toBe('phone');
    expect(layoutFor(390)).toBe('phone');
    expect(layoutFor(639)).toBe('phone');
    expect(layoutFor(639.5)).toBe('phone');
  });

  it('is a tablet from 640 up to 1023', () => {
    expect(layoutFor(640)).toBe('tablet');
    expect(layoutFor(834)).toBe('tablet');
    expect(layoutFor(1023)).toBe('tablet');
  });

  it('is a desktop from 1024', () => {
    expect(layoutFor(1024)).toBe('desktop');
    expect(layoutFor(1440)).toBe('desktop');
  });

  it('exports the thresholds it uses', () => {
    expect(layoutFor(TABLET_MIN_WIDTH - 1)).toBe('phone');
    expect(layoutFor(TABLET_MIN_WIDTH)).toBe('tablet');
    expect(layoutFor(DESKTOP_MIN_WIDTH - 1)).toBe('tablet');
    expect(layoutFor(DESKTOP_MIN_WIDTH)).toBe('desktop');
  });
});

describe('useLayout', () => {
  const setWidth = (width: number) =>
    act(async () => {
      Dimensions.set({ window: { width, height: 800, scale: 1, fontScale: 1 } });
    });

  afterEach(async () => {
    await setWidth(750);
  });

  it('re-renders only when the window crosses a threshold', async () => {
    await setWidth(700);
    const onRender = jest.fn();
    function Probe() {
      onRender();
      return <Text testID="layout">{useLayout()}</Text>;
    }
    await render(<Probe />);
    expect(screen.getByTestId('layout')).toHaveTextContent('tablet');
    const before = onRender.mock.calls.length;
    await setWidth(800);
    await setWidth(1000);
    expect(onRender.mock.calls.length).toBe(before);
    await setWidth(1200);
    expect(screen.getByTestId('layout')).toHaveTextContent('desktop');
    expect(onRender.mock.calls.length).toBe(before + 1);
  });
});
