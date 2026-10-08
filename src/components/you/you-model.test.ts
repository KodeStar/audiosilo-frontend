import {
  parseYouSection,
  youSectionLabelKey,
  youSectionParams,
  youSectionsFor,
  youTitleKey,
} from './you-model';

describe('parseYouSection', () => {
  it('opens each named section', () => {
    for (const s of ['stats', 'year', 'journal', 'settings', 'account'] as const) {
      expect(parseYouSection(s)).toBe(s);
    }
  });

  it('falls back to Stats for an absent, unknown or odd value', () => {
    expect(parseYouSection(undefined)).toBe('stats');
    expect(parseYouSection('')).toBe('stats');
    expect(parseYouSection('Journal')).toBe('stats');
    expect(parseYouSection('devices')).toBe('stats');
    expect(parseYouSection(['year', 'journal'])).toBe('year');
  });
});

describe('youSectionsFor', () => {
  it('offers all five sections on a phone', () => {
    expect(youSectionsFor('phone')).toEqual(['stats', 'year', 'journal', 'settings', 'account']);
  });

  it('offers Stats, Year and Journal where the top bar has the gear and profile menu', () => {
    expect(youSectionsFor('tablet')).toEqual(['stats', 'year', 'journal']);
    expect(youSectionsFor('desktop')).toEqual(['stats', 'year', 'journal']);
  });
});

describe('labels and titles', () => {
  it('shortens the Year segment on a phone only', () => {
    expect(youSectionLabelKey('year', 'phone')).toBe('you.sections.year');
    expect(youSectionLabelKey('year', 'desktop')).toBe('you.titles.year');
    expect(youSectionLabelKey('journal', 'tablet')).toBe('you.sections.journal');
  });

  it("titles a phone's hub after its section", () => {
    expect(youTitleKey('stats')).toBe('you.titles.stats');
    expect(youTitleKey('account')).toBe('you.titles.account');
  });
});

describe('youSectionParams', () => {
  it("keeps Stats the bare root and drops the Journal's tab on every move", () => {
    expect(youSectionParams('stats')).toEqual({ section: undefined, tab: undefined });
    expect(youSectionParams('journal')).toEqual({ section: 'journal', tab: undefined });
    expect(youSectionParams('settings')).toEqual({ section: 'settings', tab: undefined });
  });
});
