// top-bar -> profile-menu -> theme-provider side-effect-imports global.css (unparseable
// in Node).
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'light', pref: 'light', setPref: jest.fn() }),
}));

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
} from './destinations';
import { serverLine } from './top-bar';
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
    expect(rootOfRoute('settings')?.titleKey).toBe('settings.title');
    expect(rootOfRoute('book/[libraryId]')).toBeNull();
    expect(rootOfPathname('/')?.name).toBe('(home)');
    expect(rootOfPathname('/downloads')?.name).toBe('(offline)');
    expect(rootOfPathname('/library/1')).toBeNull();
  });
});

describe('tabStackListeners', () => {
  const chain = () => {
    const calls: string[] = [];
    type Nav = { replaceParams: () => void; getParent: () => Nav | undefined };
    const nav = (name: string, parent?: Nav): Nav => ({
      replaceParams: () => calls.push(name),
      getParent: () => parent,
    });
    return { calls, navigation: nav('index', nav('(home)', nav('(app)'))) };
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
      me: { initialRouteName: 'settings' },
    });
  });

  it('lists the top bar destinations without Search and Me', () => {
    expect(TOP_BAR_TABS.map((t) => t.name)).toEqual(['(home)', '(library)', '(offline)']);
    expect(PHONE_TABS).toHaveLength(5);
  });
});
