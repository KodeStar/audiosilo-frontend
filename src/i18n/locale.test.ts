let mockDevice: { languageTag: string; languageCode: string | null }[] = [];
jest.mock('expo-localization', () => ({ getLocales: () => mockDevice }));

/* eslint-disable import/first */
import { act, renderHook } from '@testing-library/react-native';
import type { getLocales } from 'expo-localization';
import i18next from 'i18next';
import { AppState } from 'react-native';

import { regionalLocale, useLocale } from './locale';
/* eslint-enable import/first */

const en = (languageTag: string) => ({ languageTag, languageCode: languageTag.split('-')[0] });

describe('regionalLocale', () => {
  it("takes the device's region for the UI language", () => {
    expect(regionalLocale('en', [en('en-GB')])).toBe('en-GB');
    expect(regionalLocale('pt', [en('en-US'), en('pt-BR')])).toBe('pt-BR');
  });

  it('keeps the bare language when the device has none for it, or names no region', () => {
    expect(regionalLocale('de', [en('en-GB')])).toBe('de');
    expect(regionalLocale('en', [en('en')])).toBe('en');
    expect(regionalLocale('en', [])).toBe('en');
    expect(regionalLocale('pt-BR', [en('pt-PT')])).toBe('pt-BR');
  });
});

describe('getLocale', () => {
  // fe#204: en-GB listeners saw "Nov 12, 2026". Fresh modules: the test setup has already
  // read the locale through the default device mock.
  it("formats dates the device's way in its language", () => {
    mockDevice = [en('en-GB')];
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const i18nModule = require('i18next');
      const i18n: { language: string } = i18nModule.default ?? i18nModule;
      const { getLocale: locale } = require('./locale') as typeof import('./locale');
      const { formatReleaseDate: release } =
        require('@/lib/format') as typeof import('@/lib/format');
      /* eslint-enable @typescript-eslint/no-require-imports */
      i18n.language = 'en';
      expect(locale()).toBe('en-GB');
      expect(release('2026-11-12')).toBe('12 Nov 2026');
      // Another UI language than the device's keeps its own conventions.
      i18n.language = 'de';
      expect(locale()).toBe('de');
    });
  });
});

describe('useLocale', () => {
  // fe#358: the device's region changed in its settings while the app was away; back in
  // front, a memoized caller's dates follow it.
  it("follows the device's region once the app is back in front", async () => {
    const listeners: ((state: string) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, fn) => {
      listeners.push(fn as (state: string) => void);
      return { remove: () => void listeners.splice(listeners.indexOf(fn as never), 1) };
    });
    // The module the test setup's own read of the locale bound to, not this file's mock.
    const device = jest
      .spyOn(
        jest.requireActual<typeof import('expo-localization')>('expo-localization'),
        'getLocales',
      )
      .mockImplementation(() => mockDevice as ReturnType<typeof getLocales>);
    const back = () => act(async () => listeners.slice().forEach((fn) => fn('active')));
    const language = i18next.language;
    i18next.language = 'en';
    try {
      const { result, unmount } = await renderHook(() => useLocale());
      mockDevice = [en('en-GB')];
      await back();
      expect(result.current).toBe('en-GB');
      mockDevice = [en('en-AU')];
      await back();
      expect(result.current).toBe('en-AU');
      await unmount();
      expect(listeners).toHaveLength(0);
    } finally {
      spy.mockRestore();
      device.mockRestore();
      mockDevice = [];
      i18next.language = language;
    }
  });
});
