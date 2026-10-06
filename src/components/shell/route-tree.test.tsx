import { renderRouter } from 'expo-router/testing-library';

import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// RNTL 14 makes render async, and renderRouter returns its promise.
const mount = (initialUrl: string) =>
  renderRouter(realRouteTree(), { initialUrl }) as unknown as Promise<unknown>;

const tabOf = () => routeInfo().segments.slice(0, 2);

describe('the real route tree', () => {
  it('opens each tab root at its unchanged URL', async () => {
    await mount('/');
    for (const [url, tab] of [
      ['/', '(home)'],
      ['/library', '(library)'],
      ['/search', '(search)'],
      ['/downloads', '(offline)'],
      ['/settings', '(me)'],
    ] as const) {
      await nav(() => router.navigate(url));
      expect(routeInfo().pathname).toBe(url);
      expect(tabOf()).toEqual(['(app)', tab]);
    }
  });

  it('keeps a book pushed from a tab in that tab, and back returns to it', async () => {
    await mount('/');
    for (const [tab, root] of [
      ['(home)', '/'],
      ['(library)', '/library'],
      ['(search)', '/search'],
      ['(offline)', '/downloads'],
      ['(me)', '/settings'],
    ] as const) {
      await nav(() => router.navigate(root));
      await nav(() => router.push('/book/1?connection=c&path=a%2Fb'));
      expect(tabOf()).toEqual(['(app)', tab]);
      expect(routeInfo().pathname).toBe('/book/1');
      expect(routeInfo().params).toMatchObject({ connection: 'c', path: 'a/b', libraryId: '1' });
      await nav(() => router.back());
      expect(routeInfo().pathnameWithParams).toBe(root);
    }
  });

  it('drills folders inside the Library stack and backs out one level at a time', async () => {
    await mount('/library');
    await nav(() => router.push('/library/1?connection=c'));
    await nav(() => router.push('/library/1?connection=c&path=A'));
    await nav(() => router.push('/library/1?connection=c&path=A%2FB'));
    await nav(() => router.push('/book/1?connection=c&path=A%2FB%2FC'));
    expect(tabOf()).toEqual(['(app)', '(library)']);
    expect(routeInfo().params).toMatchObject({ path: 'A/B/C' });

    await nav(() => router.back());
    expect(routeInfo().pathname).toBe('/library/1');
    expect(routeInfo().params).toMatchObject({ path: 'A/B' });
    await nav(() => router.back());
    expect(routeInfo().params).toMatchObject({ path: 'A' });
    await nav(() => router.back());
    expect(routeInfo().params).not.toHaveProperty('path');
    await nav(() => router.back());
    expect(routeInfo().pathname).toBe('/library');
  });

  it("keeps each tab's stack when switching tabs with JUMP_TO", async () => {
    await mount('/library');
    await nav(() => router.push('/book/1?connection=c&path=x'));
    await nav(() => router.navigate('/'));
    expect(tabOf()).toEqual(['(app)', '(home)']);
    const { store } = jest.requireActual('expo-router/build/global-state/router-store');
    await nav(() =>
      store.navigationRef.dispatch({ type: 'JUMP_TO', payload: { name: '(library)' } }),
    );
    expect(tabOf()).toEqual(['(app)', '(library)']);
    expect(routeInfo().pathname).toBe('/book/1');
  });

  it('opens the account screen inside the tab that pushed it', async () => {
    await mount('/settings');
    await nav(() => router.push('/account?connection=c'));
    expect(routeInfo().segments).toEqual(['(app)', '(me)', 'account']);
  });

  it('keeps the player as a root modal over the tabs', async () => {
    await mount('/library');
    await nav(() => router.push('/player'));
    expect(routeInfo().segments).toEqual(['player']);
    await nav(() => router.back());
    expect(routeInfo().pathname).toBe('/library');
  });
});
