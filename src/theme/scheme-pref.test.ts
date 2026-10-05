import { initialSchemePref, isSchemePref } from './scheme-pref';

describe('initialSchemePref', () => {
  it('keeps an explicit stored pick on any install', () => {
    for (const pref of ['light', 'dark', 'system'] as const) {
      expect(initialSchemePref(pref, true)).toEqual({ pref, persist: false });
      expect(initialSchemePref(pref, false)).toEqual({ pref, persist: false });
    }
  });

  it('writes dark once for an existing install that never chose a theme', () => {
    expect(initialSchemePref(null, true)).toEqual({ pref: 'dark', persist: true });
    expect(initialSchemePref(undefined, true)).toEqual({ pref: 'dark', persist: true });
  });

  it('writes system for a new install, so it is not "existing" next launch', () => {
    expect(initialSchemePref(null, false)).toEqual({ pref: 'system', persist: true });
  });

  it('falls back to dark, unwritten, for a stored value this build does not know', () => {
    for (const saved of ['auto', 42, { theme: 'light' }, '']) {
      expect(initialSchemePref(saved, false)).toEqual({ pref: 'dark', persist: false });
      expect(initialSchemePref(saved, true)).toEqual({ pref: 'dark', persist: false });
    }
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
