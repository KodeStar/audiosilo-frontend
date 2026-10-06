import { act, render, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Dimensions, type StyleProp, View, type ViewStyle } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useDialogFrame } from './dialog';
import { RootInsetsProvider, useOverlayInsets, withFlatStyle } from './overlay';

const metrics = (bottom: number) => ({
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom },
});

/** The app's shape: the root provider (home indicator 34) with RootInsetsProvider, and a
 * tab screen's nested provider whose bottom inset also counts the native tab bar. */
function TabScreen({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics(34)}>
      <RootInsetsProvider>
        <SafeAreaProvider initialMetrics={metrics(134)}>{children}</SafeAreaProvider>
      </RootInsetsProvider>
    </SafeAreaProvider>
  );
}

describe('root insets', () => {
  it("gives a positioned overlay the window's insets, not a tab screen's", async () => {
    const { result } = await renderHook(() => useOverlayInsets(), { wrapper: TabScreen });
    expect(result.current).toEqual({ top: 55, bottom: 42, left: 8, right: 8 });
  });

  it("frames a phone dialog from the window's insets, not a tab screen's", async () => {
    const setWidth = (width: number) =>
      act(async () => {
        Dimensions.set({ window: { width, height: 844, scale: 3, fontScale: 1 } });
      });
    await setWidth(390);
    const { result } = await renderHook(() => useDialogFrame(), { wrapper: TabScreen });
    expect(result.current.compact).toBe(true);
    // max(24, 34 + 16), not 134 + 16.
    expect(result.current.contentStyle).toEqual({ paddingBottom: 50 });
    await setWidth(750);
  });
});

describe('withFlatStyle', () => {
  it('hands the wrapped part one flat style object (never an array)', async () => {
    const seen: StyleProp<ViewStyle>[] = [];
    function Part({ style }: { style?: StyleProp<ViewStyle> }) {
      seen.push(style);
      return <View />;
    }
    const Flat = withFlatStyle(Part);
    await render(<Flat style={[{ padding: 4 }, undefined, [{ margin: 2 }, { padding: 8 }]]} />);
    expect(seen.at(-1)).toEqual({ padding: 8, margin: 2 });
    await render(<Flat />);
    expect(seen.at(-1)).toBeUndefined();
  });
});
