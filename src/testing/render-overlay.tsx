import { PortalHost } from '@rn-primitives/portal';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RootInsetsProvider } from '@/components/ui/overlay';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

type Measure = (
  cb: (x: number, y: number, w: number, h: number, pageX: number, pageY: number) => void,
) => void;

/**
 * Renders `ui` the way the app does for the portal-based primitives (Dialog, Select,
 * Popover, menus): inside a SafeAreaProvider + RootInsetsProvider, with the root
 * `<PortalHost />` after it -
 * without the host, rn-primitives' native portals render nothing.
 *
 * The positioned overlays (Select, Popover, DropdownMenu, Tooltip) only render once
 * they have measured their trigger, and React Native's jest preset stubs `measure` with
 * a no-op; this answers it with a fixed box instead.
 *
 * Await it (RNTL 14's render is async) and `await fireEvent...` after it: an un-awaited
 * call can detach the later renders in the same file.
 */
export function mountWithPortal(ui: ReactElement) {
  const { default: nativeMethods } = jest.requireActual<{
    default: { measure: jest.Mock<ReturnType<Measure>, Parameters<Measure>> };
  }>('@react-native/jest-preset/jest/MockNativeMethods');
  nativeMethods.measure.mockImplementation((cb) => cb(0, 0, 160, 40, 16, 120));
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <RootInsetsProvider>
        {ui}
        <PortalHost />
      </RootInsetsProvider>
    </SafeAreaProvider>,
  );
}
