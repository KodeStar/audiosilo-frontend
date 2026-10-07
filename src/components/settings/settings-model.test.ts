import {
  parseSettingsSection,
  sectionParam,
  settingsGroups,
  settingsLayout,
  SPLIT_MIN,
} from './settings-model';

describe('settingsGroups', () => {
  it('groups the panes as Listening, App and Servers, each pane once', () => {
    const groups = settingsGroups(true);
    expect(groups.map((g) => g.key)).toEqual(['listening', 'app', 'servers']);
    const panes = groups.flatMap((g) => g.panes);
    expect(panes).toEqual([
      'playback',
      'sleep',
      'downloads',
      'appearance',
      'language',
      'household',
      'accounts',
      'support',
    ]);
    expect(new Set(panes).size).toBe(panes.length);
  });

  it('drops Support where the build may not link to it (Apple)', () => {
    const panes = settingsGroups(false).flatMap((g) => g.panes);
    expect(panes).not.toContain('support');
    expect(panes).toContain('accounts');
  });
});

describe('parseSettingsSection', () => {
  it('opens preferences on the first pane and accounts on the servers', () => {
    expect(parseSettingsSection('preferences', true)).toBe('playback');
    expect(parseSettingsSection('accounts', true)).toBe('accounts');
  });

  it('opens any pane by name', () => {
    expect(parseSettingsSection('sleep', true)).toBe('sleep');
    expect(parseSettingsSection('household', true)).toBe('household');
    expect(parseSettingsSection(['language', 'sleep'], true)).toBe('language');
  });

  it('falls back to the first pane for an absent, unknown or hidden one', () => {
    expect(parseSettingsSection(undefined, true)).toBe('playback');
    expect(parseSettingsSection('accessibility', true)).toBe('playback');
    expect(parseSettingsSection('support', false)).toBe('playback');
    expect(parseSettingsSection('support', true)).toBe('support');
  });
});

describe('sectionParam', () => {
  it('keeps the first pane the bare page', () => {
    expect(sectionParam('playback')).toBeUndefined();
    expect(sectionParam('accounts')).toBe('accounts');
  });
});

describe('settingsLayout', () => {
  it('splits from the measured width and stacks below it', () => {
    expect(settingsLayout(SPLIT_MIN, false)).toBe('split');
    expect(settingsLayout(SPLIT_MIN - 1, false)).toBe('stacked');
    // A desktop page narrowed by the Up next drawer stacks too.
    expect(settingsLayout(1024 - 480, false)).toBe('stacked');
  });

  it('guesses from the form factor before the first measure', () => {
    expect(settingsLayout(0, true)).toBe('stacked');
    expect(settingsLayout(0, false)).toBe('split');
  });
});
