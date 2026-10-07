// top-bar -> profile-menu -> theme-provider side-effect-imports global.css (unparseable
// in Node).
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'light', pref: 'light', setPref: jest.fn() }),
}));
// top-bar -> the Up next button -> the playback store (a native module).
jest.mock('@/components/upnext/up-next-button', () => ({ UpNextButton: () => null }));

/* eslint-disable import/first */
import {
  PHONE_TABS,
  rootOfPathname,
  rootOfRoute,
  TAB_STACK_SETTINGS,
  TABS,
  tabOfSegments,
  tabStackListeners,
  TOP_BAR_TABS,
  wideLabelKey,
} from './destinations';
import { OMNISEARCH_MIN, omnisearchFits, serverLine } from './top-bar';
/* eslint-enable import/first */

describe('destinations', () => {
  it('lists the five tabs in bar order, Downloads as the (offline) group', () => {
    expect(TABS.map((t) => t.name)).toEqual([
      '(home)',
      '(library)',
      '(search)',
      '(offline)',
      '(me)',
    ]);
  });

  it('finds the tab from route segments, and none outside the tabs', () => {
    expect(tabOfSegments(['(app)', '(library)', 'book', '[libraryId]'])).toBe('(library)');
    expect(tabOfSegments(['(app)', '(home)'])).toBe('(home)');
    expect(tabOfSegments(['player'])).toBeNull();
    expect(tabOfSegments(['connect', 'sign-in'])).toBeNull();
  });

  it('tells a tab root from a pushed page, by route name and by pathname', () => {
    expect(rootOfRoute('library/index')?.name).toBe('(library)');
    expect(rootOfRoute('you')?.name).toBe('(me)');
    expect(rootOfRoute('you')?.titleKey).toBe('nav.you');
    // Settings is a page of the array group, never a tab root.
    expect(rootOfRoute('settings')).toBeNull();
    expect(rootOfPathname('/you')?.name).toBe('(me)');
    expect(rootOfPathname('/settings')).toBeNull();
    expect(rootOfRoute('book/[libraryId]')).toBeNull();
    expect(rootOfPathname('/')?.name).toBe('(home)');
    expect(rootOfPathname('/downloads')?.name).toBe('(offline)');
    expect(rootOfPathname('/library/1')).toBeNull();
  });
});

describe('tabStackListeners', () => {
  const chain = (rootName = 'index', tab = '(home)') => {
    const calls: string[] = [];
    const replaced: Record<string, object> = {};
    type Nav = { replaceParams: (p: object) => void; getParent: () => Nav | undefined };
    const nav = (name: string, parent?: Nav): Nav => ({
      replaceParams: (p) => {
        calls.push(name);
        replaced[name] = p;
      },
      getParent: () => parent,
    });
    return { calls, replaced, navigation: nav(rootName, nav(tab, nav('(app)'))) };
  };

  it('clears params a cold link left on a tab root, and on every ancestor', () => {
    const { calls, navigation } = chain();
    tabStackListeners({ route: { name: 'index', params: { libraryId: '1' } }, navigation }).focus();
    expect(calls).toEqual(['index', '(home)', '(app)']);
  });

  it('leaves a clean root and every pushed page alone', () => {
    const { calls, navigation } = chain();
    tabStackListeners({ route: { name: 'index', params: {} }, navigation }).focus();
    tabStackListeners({
      route: { name: 'book/[libraryId]', params: { libraryId: '1' } },
      navigation,
    }).focus();
    expect(calls).toEqual([]);
  });

  it("keeps a root's own params (Library's mode) and clears only the rest", () => {
    const own = chain('library/index', '(library)');
    tabStackListeners({
      route: { name: 'library/index', params: { mode: 'authors' } },
      navigation: own.navigation,
    }).focus();
    expect(own.calls).toEqual([]);

    const mixed = chain('library/index', '(library)');
    tabStackListeners({
      route: { name: 'library/index', params: { mode: 'series', libraryId: '1' } },
      navigation: mixed.navigation,
    }).focus();
    expect(mixed.calls).toEqual(['library/index', '(library)', '(app)']);
    expect(mixed.replaced['library/index']).toEqual({ mode: 'series' });
    expect(mixed.replaced['(app)']).toEqual({});
  });

  it("keeps the You hub's section and the Journal's tab", () => {
    const { calls, replaced, navigation } = chain('you', '(me)');
    tabStackListeners({
      route: { name: 'you', params: { section: 'journal', tab: 'notes', connection: 'c' } },
      navigation,
    }).focus();
    expect(calls).toEqual(['you', '(me)', '(app)']);
    expect(replaced.you).toEqual({ section: 'journal', tab: 'notes' });
  });

  it("does not let another root keep Library's params", () => {
    const { replaced, navigation } = chain();
    tabStackListeners({
      route: { name: 'index', params: { mode: 'authors' } },
      navigation,
    }).focus();
    expect(replaced.index).toEqual({});
  });
});

describe('serverLine', () => {
  const a = { id: 'a', name: 'Hearthside' };
  const b = { id: 'b', name: "Maya's Shelf" };

  it('names the default server and counts the rest', () => {
    expect(serverLine([a, b], 'a', {})).toEqual({ kind: 'server', name: 'Hearthside', more: 1 });
    expect(serverLine([a, b], 'b', {})).toEqual({ kind: 'server', name: "Maya's Shelf", more: 1 });
    expect(serverLine([a], null, {})).toEqual({ kind: 'server', name: 'Hearthside', more: 0 });
  });

  it('says offline when the default server is unreachable', () => {
    expect(serverLine([a, b], 'a', { a: false })).toEqual({ kind: 'offline' });
    expect(serverLine([a, b], 'a', { b: false }).kind).toBe('server');
  });

  it('says the default server needs signing in again before anything else', () => {
    const flagged = { ...a, needsReconnect: 'auth' as const };
    expect(serverLine([flagged, b], 'a', { a: false })).toEqual({ kind: 'reconnect' });
    expect(serverLine([flagged, b], 'b', {}).kind).toBe('server');
  });

  it('is empty with no connection', () => {
    expect(serverLine([], null, {})).toEqual({ kind: 'none' });
  });
});

describe('derived destination lists', () => {
  it('keys each tab stack setting by bare group name, rooted at the tab root', () => {
    expect(TAB_STACK_SETTINGS).toEqual({
      home: { initialRouteName: 'index' },
      library: { initialRouteName: 'library/index' },
      search: { initialRouteName: 'search' },
      offline: { initialRouteName: 'downloads' },
      me: { initialRouteName: 'you' },
    });
  });

  it('lists the top bar destinations without Search, You last', () => {
    expect(TOP_BAR_TABS.map((t) => t.name)).toEqual(['(home)', '(library)', '(offline)', '(me)']);
    expect(PHONE_TABS).toHaveLength(5);
  });

  it('names the Me tab "Me" on the tab bar and "You" in the top bar', () => {
    const me = TABS.find((t) => t.name === '(me)')!;
    expect(me.labelKey).toBe('nav.me');
    expect(wideLabelKey(me)).toBe('nav.you');
    expect(wideLabelKey(TABS[0])).toBe('nav.home');
  });
});

describe('omnisearchFits', () => {
  it('keeps the field while the middle has room beside the destinations', () => {
    expect(omnisearchFits(140 + 16 + OMNISEARCH_MIN, 140)).toBe(true);
    expect(omnisearchFits(140 + 16 + OMNISEARCH_MIN - 1, 140)).toBe(false);
  });

  it('counts an unmeasured bar as fitting', () => {
    expect(omnisearchFits(0, 0)).toBe(true);
  });
});
