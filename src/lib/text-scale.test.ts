import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { setFontScale } from '@/testing/font-scale';

import {
  isLargeText,
  LARGE_TEXT_SCALE,
  linesFor,
  readFontScale,
  scaleCapped,
  useFontScale,
  useLargeText,
} from './text-scale';

afterEach(async () => {
  await setFontScale(1);
});

describe('text scale', () => {
  it('is large from the threshold up', () => {
    expect(LARGE_TEXT_SCALE).toBe(1.3);
    expect(isLargeText(1)).toBe(false);
    expect(isLargeText(1.15)).toBe(false);
    expect(isLargeText(1.3)).toBe(true);
    expect(isLargeText(2)).toBe(true);
    expect(isLargeText(3.12)).toBe(true);
  });

  it('scales a size up to its cap and never below the base', () => {
    expect(scaleCapped(48, 1, 1.5)).toBe(48);
    expect(scaleCapped(48, 1.2, 1.5)).toBe(58);
    expect(scaleCapped(48, 3.1, 1.5)).toBe(72);
    expect(scaleCapped(48, 0.85, 1.5)).toBe(48);
  });

  it('lifts a line cap only under large text', () => {
    expect(linesFor(1, false)).toBe(1);
    expect(linesFor(2, true)).toBeUndefined();
  });

  it('reads the system font scale on native and follows its changes', async () => {
    const scale = await renderHook(() => useFontScale());
    const large = await renderHook(() => useLargeText());
    expect(scale.result.current).toBe(1);
    expect(large.result.current).toBe(false);
    await setFontScale(2);
    expect(readFontScale()).toBe(2);
    expect(scale.result.current).toBe(2);
    expect(large.result.current).toBe(true);
  });

  it('reads the root font size against 16 px on the web', () => {
    const os = Platform.OS;
    const doc = (globalThis as { document?: unknown }).document;
    const gcs = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      (globalThis as { document?: unknown }).document = { documentElement: {} };
      (globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({
        fontSize: '24px',
      });
      expect(readFontScale()).toBe(1.5);
      (globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({ fontSize: '' });
      expect(readFontScale()).toBe(1);
      // The static export has no document.
      delete (globalThis as { document?: unknown }).document;
      expect(readFontScale()).toBe(1);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
      (globalThis as { document?: unknown }).document = doc;
      (globalThis as { getComputedStyle?: unknown }).getComputedStyle = gcs;
    }
  });
});
