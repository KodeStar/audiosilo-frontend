import { create } from 'zustand';

/**
 * Chrome sizes the shell measures for overlays that live outside it (the root
 * `ShellToastHost`): the web phone tab bar and the docked player bar, safe area
 * included. Unset until first laid out.
 */
type ShellMetrics = {
  tabBarHeight?: number;
  dockHeight?: number;
};

export const useShellMetrics = create<ShellMetrics>(() => ({}));

export function setShellMetric(key: keyof ShellMetrics, value: number) {
  if (useShellMetrics.getState()[key] !== value) useShellMetrics.setState({ [key]: value });
}
