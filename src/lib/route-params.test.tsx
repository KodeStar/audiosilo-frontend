// eslint-disable-next-line no-restricted-imports -- the test shows the double decode it avoids
import { useLocalSearchParams } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { Text } from 'react-native';

import { useRouteParams } from '@/lib/route-params';
import { nav, router } from '@/testing/route-tree';

// CONNECT-01: a route param is decoded exactly once. Expo Router's own
// `useLocalSearchParams` decodes the already-decoded value again.

function Book() {
  const { path } = useRouteParams<{ path?: string }>();
  return <Text testID="path">{path ?? '(none)'}</Text>;
}

function Raw() {
  const { path } = useLocalSearchParams<{ path?: string }>();
  return <Text testID="raw">{path ?? '(none)'}</Text>;
}

const tree = { index: Book, raw: Raw };
const mount = (url: string) =>
  renderRouter(tree, { initialUrl: url }) as unknown as Promise<unknown>;
const shown = (id = 'path') => screen.getByTestId(id).props.children as string;

it('keeps a literal %xx in a folder name from a URL (a reload)', async () => {
  await mount('/?path=Zed%20Unscanned%2FLit%2520Book');
  expect(shown()).toBe('Zed Unscanned/Lit%20Book');
});

it('decodes a double-encoded link once, so it names no book', async () => {
  await mount('/?path=Jane%2520Austen%252FPride');
  expect(shown()).toBe('Jane%20Austen%2FPride');
});

it('keeps a literal %xx through an in-app push', async () => {
  await mount('/raw');
  await nav(() => router.push({ pathname: '/', params: { path: 'A/Lit%20Book' } }));
  expect(shown()).toBe('A/Lit%20Book');
});

it('passes other characters through untouched', async () => {
  await mount('/?path=Rock%20%26%20Roll%20%231%20%3FWhy%2BNot');
  expect(shown()).toBe('Rock & Roll #1 ?Why+Not');
});

it('is the decode useLocalSearchParams gets wrong (the reason this hook exists)', async () => {
  await mount('/raw?path=Lit%2520Book');
  expect(shown('raw')).toBe('Lit Book');
});
