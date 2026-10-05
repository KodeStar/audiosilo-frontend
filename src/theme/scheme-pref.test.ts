import { defaultSchemePref, isSchemePref, restoredSchemePref } from './scheme-pref';

describe('restoredSchemePref', () => {
  it('keeps an explicit stored pick', () => {
    for (const pref of ['light', 'dark', 'system'] as const) {
      expect(restoredSchemePref(pref)).toBe(pref);
    }
  });

  it('falls back to dark for a stored value this build does not know', () => {
    for (const saved of ['auto', 42, { theme: 'light' }, '', null, undefined]) {
      expect(restoredSchemePref(saved)).toBe('dark');
    }
  });
});

describe('defaultSchemePref', () => {
  it('is dark for an existing install that never chose a theme', () => {
    expect(defaultSchemePref(true)).toBe('dark');
  });

  it('is system for a new install', () => {
    expect(defaultSchemePref(false)).toBe('system');
  });
});

describe('isSchemePref', () => {
  it('accepts only the three prefs', () => {
    expect(isSchemePref('light')).toBe(true);
    expect(isSchemePref('system')).toBe(true);
    expect(isSchemePref('Dark')).toBe(false);
    expect(isSchemePref(null)).toBe(false);
  });
});
