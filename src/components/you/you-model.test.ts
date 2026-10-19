import {
  isCoreYouSection,
  parseYouSection,
  youModuleSections,
  youSectionLabelKey,
  youSectionParams,
  youSectionsFor,
  youTitleKey,
} from './you-model';

describe('parseYouSection', () => {
  it('opens each named section', () => {
    for (const s of ['stats', 'year', 'journal', 'settings', 'household', 'account'] as const) {
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
  it('offers all six sections on a phone, Household between Settings and Account', () => {
    expect(youSectionsFor('phone')).toEqual([
      'stats',
      'year',
      'journal',
      'settings',
      'household',
      'account',
    ]);
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
    expect(youTitleKey('household')).toBe('you.titles.household');
  });
});

describe('youSectionParams', () => {
  it("keeps Stats the bare root and drops the Journal's tab on every move", () => {
    expect(youSectionParams('stats')).toEqual({ section: undefined, tab: undefined });
    expect(youSectionParams('journal')).toEqual({ section: 'journal', tab: undefined });
    expect(youSectionParams('settings')).toEqual({ section: 'settings', tab: undefined });
  });
});

describe("a module's sections (Bridge Phase 2a)", () => {
  it("opens an active module's section, and falls back to Stats once it is off", () => {
    expect(parseYouSection('contribute', ['contribute'])).toBe('contribute');
    expect(parseYouSection('contribute', [])).toBe('stats');
    expect(parseYouSection('contribute')).toBe('stats');
    expect(parseYouSection(undefined, ['contribute'])).toBe('stats');
    // The hub's own still open with modules about.
    expect(parseYouSection('journal', ['contribute'])).toBe('journal');
  });

  it("never lets a module's key stand for one of the hub's own", () => {
    const section = (key: string, label = key) => ({ key, label, render: () => null });
    const first = section('contribute', 'First');
    const sections = youModuleSections([
      { id: 'contributions', youSections: [section('stats'), first, section('')] },
      { id: 'bridge', youSections: [section('contribute', 'Second')] },
    ]);
    expect([...sections.keys()]).toEqual(['contribute']);
    expect(sections.get('contribute')).toBe(first);
    expect(youSectionsFor('phone', [...sections.keys()])).toEqual([
      'stats',
      'year',
      'journal',
      'settings',
      'household',
      'account',
      'contribute',
    ]);
    expect(youModuleSections([])).toEqual(new Map());
  });

  it("follows the hub's own sections on every form factor", () => {
    expect(youSectionsFor('desktop', ['contribute'])).toEqual([
      'stats',
      'year',
      'journal',
      'contribute',
    ]);
    // None: the very list the hub had before modules.
    expect(youSectionsFor('tablet', [])).toBe(youSectionsFor('tablet'));
  });

  it('tells the two apart', () => {
    expect(isCoreYouSection('account')).toBe(true);
    expect(isCoreYouSection('contribute')).toBe(false);
  });
});
