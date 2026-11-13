import { renderRouter } from 'expo-router/testing-library';

import { findLibrivoxHref } from '@/lib/paths';
import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// Find on LibriVox (LibriVox L6) is the Library tab's own page, like Find shows: only the
// Books mode's menu opens it, and a cold link (a reload, a pasted URL) lands in the Library
// tab, so the top bar marks Library, not Home.

const mount = (initialUrl: string) =>
  renderRouter(realRouteTree(), { initialUrl }) as unknown as Promise<unknown>;

it('opens a cold /find-librivox link in the Library tab', async () => {
  await mount('/find-librivox?connection=c1&library=4');
  expect(routeInfo().segments).toEqual(['(app)', '(library)', 'find-librivox']);
  expect(routeInfo().params).toMatchObject({ connection: 'c1', library: '4' });
});

it('pushes it over the Library, and back returns there', async () => {
  await mount('/library');
  await nav(() => router.push(findLibrivoxHref('c1', 4)));
  expect(routeInfo().segments).toEqual(['(app)', '(library)', 'find-librivox']);
  await nav(() => router.back());
  expect(routeInfo().pathname).toBe('/library');
});
