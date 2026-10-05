import { type ToastChrome, toastBottomOffset } from './toast-offset';

const base: ToastChrome = {
  layout: 'phone',
  platform: 'web',
  overTabs: true,
  safeBottom: 0,
  playerLoaded: false,
  accessory: false,
};

describe('toastBottomOffset', () => {
  it('sits above the measured web phone tab bar, and above the mini player too', () => {
    expect(toastBottomOffset({ ...base, tabBarHeight: 64 })).toBe(76);
    expect(toastBottomOffset({ ...base, tabBarHeight: 64, playerLoaded: true })).toBe(142);
  });

  it('estimates the native tab bars, past the home indicator', () => {
    expect(toastBottomOffset({ ...base, platform: 'ios', safeBottom: 34 })).toBe(34 + 62 + 12);
    expect(toastBottomOffset({ ...base, platform: 'android', safeBottom: 24 })).toBe(24 + 80 + 12);
  });

  it('clears the iOS 26 accessory pill instead of the floating card', () => {
    expect(
      toastBottomOffset({
        ...base,
        platform: 'ios',
        safeBottom: 34,
        playerLoaded: true,
        accessory: true,
      }),
    ).toBe(34 + 62 + 56 + 12);
  });

  it('sits above the docked player bar on tablet and desktop, measured when known', () => {
    const wide = { ...base, layout: 'desktop' as const };
    expect(toastBottomOffset(wide)).toBe(20);
    expect(toastBottomOffset({ ...wide, playerLoaded: true })).toBe(84 + 12);
    expect(toastBottomOffset({ ...wide, playerLoaded: true, dockHeight: 105 })).toBe(117);
    expect(
      toastBottomOffset({ ...wide, layout: 'tablet', safeBottom: 20, playerLoaded: true }),
    ).toBe(84 + 20 + 12);
  });

  it('drops to the bottom edge over a full-screen modal', () => {
    expect(
      toastBottomOffset({ ...base, overTabs: false, safeBottom: 34, playerLoaded: true }),
    ).toBe(50);
  });
});
