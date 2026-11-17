import { act, renderHook, waitFor } from '@testing-library/react-native';

import { saveReaderTheme } from './reader-settings';
import { readerThemeOf, useReaderAppearance } from './use-reader-appearance';

// The app's theme (the provider pulls in the stylesheet): `readerThemeOf` is given the scheme.
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'light', highContrast: false }),
}));

describe('readerThemeOf', () => {
  it("follows the app's scheme, its card under its text", () => {
    expect(readerThemeOf('follow', 'dark', false)).toEqual({
      scheme: 'dark',
      background: '#10172b',
      foreground: '#e7ebf4',
    });
    expect(readerThemeOf('follow', 'light', false).scheme).toBe('light');
  });

  it('takes the scheme chosen over the app', () => {
    expect(readerThemeOf('light', 'dark', false)).toEqual({
      scheme: 'light',
      background: '#ffffff',
      foreground: '#121c36',
    });
    expect(readerThemeOf('dark', 'light', false).scheme).toBe('dark');
  });

  it("is a pure black page under the dark scheme's text for black, high contrast too", () => {
    expect(readerThemeOf('black', 'light', false)).toEqual({
      scheme: 'dark',
      background: '#000000',
      foreground: '#e7ebf4',
    });
    expect(readerThemeOf('black', 'light', true)).toEqual({
      scheme: 'dark',
      background: '#000000',
      foreground: '#f4f6fb',
    });
  });
});

describe('useReaderAppearance', () => {
  afterEach(() => saveReaderTheme('follow'));

  it('shows a theme chosen on one surface on the other one mounted (fe#246)', async () => {
    const reader = await renderHook(() => useReaderAppearance());
    const textTab = await renderHook(() => useReaderAppearance());
    await waitFor(() => expect(textTab.result.current.fontScale).not.toBeNull());
    await act(async () => reader.result.current.chooseTheme('black'));
    expect(reader.result.current.theme.background).toBe('#000000');
    expect(textTab.result.current.themeChoice).toBe('black');
    expect(textTab.result.current.theme.background).toBe('#000000');
    // A surface gone hears nothing more.
    await textTab.unmount();
    await act(async () => reader.result.current.chooseTheme('light'));
    expect(reader.result.current.themeChoice).toBe('light');
  });
});
