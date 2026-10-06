import { type ToastChrome, toastBottomOffset } from './toast-offset';

const base: ToastChrome = { overTabs: true, hasChrome: true, safeBottom: 0 };

describe('toastBottomOffset', () => {
  it('sits above the measured top edge of the bottom chrome', () => {
    // The web phone tab bar alone, then with the mini player card on it.
    expect(toastBottomOffset({ ...base, chromeTop: 64 })).toBe(76);
    expect(toastBottomOffset({ ...base, chromeTop: 130 })).toBe(142);
    // The docked player bar, safe area included.
    expect(toastBottomOffset({ ...base, safeBottom: 20, chromeTop: 105 })).toBe(117);
  });

  it('estimates a tab bar past the home indicator only before the first layout', () => {
    expect(toastBottomOffset({ ...base, safeBottom: 34 })).toBe(34 + 64 + 12);
  });

  it('sits near the bottom edge on tablet and desktop with nothing loaded', () => {
    expect(toastBottomOffset({ ...base, hasChrome: false })).toBe(20);
    expect(toastBottomOffset({ ...base, hasChrome: false, safeBottom: 20 })).toBe(40);
  });

  it('drops to the bottom edge over a full-screen modal', () => {
    expect(toastBottomOffset({ ...base, overTabs: false, safeBottom: 34, chromeTop: 200 })).toBe(
      50,
    );
  });
});
