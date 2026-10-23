import { renderRouter } from 'expo-router/testing-library';

import { findShowsHref } from '@/lib/paths';
import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// Find shows (Bridge Phase 2d-2) is the Library tab's own page: only the Library's Shows
// mode opens it, and a cold link (a reload, a pasted URL) lands in the Library tab, so the
// top bar marks Library, not Home (the first tab group, which owns a cold shared page).

const mount = (initialUrl: string) =>
  renderRouter(realRouteTree(), { initialUrl }) as unknown as Promise<unknown>;

it('opens a cold /find-shows link in the Library tab', async () => {
  // A pasted URL (a string: `renderRouter` reads no Href object).
  await mount('/find-shows?connection=c1&library=4');
  expect(routeInfo().segments).toEqual(['(app)', '(library)', 'find-shows']);
  expect(routeInfo().params).toMatchObject({ connection: 'c1', library: '4' });
});

it('pushes it over the Library, and back returns there', async () => {
  await mount('/library');
  await nav(() => router.push(findShowsHref('c1', 4)));
  expect(routeInfo().segments).toEqual(['(app)', '(library)', 'find-shows']);
  await nav(() => router.back());
  expect(routeInfo().pathname).toBe('/library');
});
