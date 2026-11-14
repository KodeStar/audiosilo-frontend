import { AccessibilityInfo, Platform } from 'react-native';

import { readOsHighContrast, watchOsHighContrast } from './os-contrast';
import * as web from './os-contrast.web';

const prevOS = Platform.OS;
afterEach(() => {
  Platform.OS = prevOS;
  jest.restoreAllMocks();
});

describe('os-contrast (native)', () => {
  it('reads Increase Contrast on iOS', async () => {
    Platform.OS = 'ios';
    const darker = jest
      .spyOn(AccessibilityInfo, 'isDarkerSystemColorsEnabled')
      .mockResolvedValue(true);
    const android = jest.spyOn(AccessibilityInfo, 'isHighTextContrastEnabled');
    await expect(readOsHighContrast()).resolves.toBe(true);
    expect(darker).toHaveBeenCalled();
    expect(android).not.toHaveBeenCalled();
  });

  it('reads high contrast text on Android', async () => {
    Platform.OS = 'android';
    jest.spyOn(AccessibilityInfo, 'isHighTextContrastEnabled').mockResolvedValue(true);
    await expect(readOsHighContrast()).resolves.toBe(true);
  });

  it('counts a failed read as off', async () => {
    Platform.OS = 'android';
    jest
      .spyOn(AccessibilityInfo, 'isHighTextContrastEnabled')
      .mockRejectedValue(new Error('not available'));
    await expect(readOsHighContrast()).resolves.toBe(false);
  });

  it.each([
    ['ios', 'darkerSystemColorsChanged'],
    ['android', 'highTextContrastChanged'],
  ] as const)('on %s listens to %s and unsubscribes', (os, event) => {
    Platform.OS = os;
    const remove = jest.fn();
    let handler: ((on: boolean) => void) | undefined;
    const add = jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_name, h) => {
      handler = h as (on: boolean) => void;
      return { remove } as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>;
    });
    const onChange = jest.fn();
    const stop = watchOsHighContrast(onChange);
    expect(add).toHaveBeenCalledWith(event, expect.any(Function));
    handler?.(true);
    expect(onChange).toHaveBeenCalledWith(true);
    stop();
    expect(remove).toHaveBeenCalled();
  });
});

describe('os-contrast (web)', () => {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  let matches = false;
  beforeEach(() => {
    listeners.clear();
    matches = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn((query: string) => ({
        media: query,
        get matches() {
          return matches;
        },
        addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.add(l),
        removeEventListener: (_: string, l: (e: { matches: boolean }) => void) =>
          listeners.delete(l),
      })),
    });
  });

  it('reads prefers-contrast: more', async () => {
    await expect(web.readOsHighContrast()).resolves.toBe(false);
    matches = true;
    await expect(web.readOsHighContrast()).resolves.toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-contrast: more)');
  });

  it('follows a change and stops listening', () => {
    const onChange = jest.fn();
    const stop = web.watchOsHighContrast(onChange);
    expect(listeners.size).toBe(1);
    listeners.forEach((l) => l({ matches: true }));
    expect(onChange).toHaveBeenCalledWith(true);
    stop();
    expect(listeners.size).toBe(0);
  });
});
