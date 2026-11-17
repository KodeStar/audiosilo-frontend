import { readerThemeOf } from './use-reader-appearance';

// The app's theme (the provider pulls in the stylesheet): `readerThemeOf` is given the scheme.
jest.mock('@/theme/theme-provider', () => ({}));

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
