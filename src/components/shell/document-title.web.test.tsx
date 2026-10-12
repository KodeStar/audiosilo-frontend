import { Stack, Tabs } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import { Text } from 'react-native';

jest.mock('@/playback/store', () =>
  // `require` because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { usePageTitleStore } from '@/lib/document-title';
import { usePageTitle } from '@/lib/use-page-title.web';
import { playerStoreMock } from '@/testing/player-store-mock';
import { nav, router } from '@/testing/route-tree';

import { DocumentTitle } from './document-title.web';
/* eslint-enable import/first */

// Jest runs the native platform, which resolves the no-op `usePageTitle` and
// `DocumentTitle`: this suite drives the web pair over a real router.
const page = (name: string, title?: string) =>
  function Page() {
    usePageTitle(title);
    return <Text>{name}</Text>;
  };

const stack = () => <Stack screenOptions={{ headerShown: false }} />;

const tree = {
  _layout: {
    default: () => (
      <>
        <Stack screenOptions={{ headerShown: false }} />
        <DocumentTitle />
      </>
    ),
    unstable_settings: { anchor: '(app)' },
  },
  '(app)/_layout': () => <Tabs screenOptions={{ headerShown: false }} />,
  '(app)/(home)/_layout': stack,
  '(app)/(home)/index': page('home'),
  '(app)/(home)/book': page('book', 'Dune'),
  '(app)/(home)/author': page('author', 'Frank Herbert'),
  '(app)/(home)/loading': page('loading'),
  '(app)/(library)/_layout': stack,
  '(app)/(library)/library': page('library'),
  // A root modal that names nothing (the tab's name doesn't stand in outside the tabs).
  finished: page('finished'),
};

const g = globalThis as unknown as { document?: { title: string } };
const savedDocument = g.document;
const title = () => g.document?.title;

beforeEach(() => {
  g.document = { title: '' };
  playerStoreMock().reset();
});
afterEach(() => {
  g.document = savedDocument;
  usePageTitleStore.setState({ claim: null });
});

it("names the tab after the focused page, else the tab, and Back restores the last page's", async () => {
  await (renderRouter(tree, { initialUrl: '/' }) as unknown as Promise<unknown>);
  expect(title()).toBe('Home · AudioSilo');

  await nav(() => router.push('/book'));
  expect(title()).toBe('Dune · AudioSilo');
  await nav(() => router.push('/author'));
  expect(title()).toBe('Frank Herbert · AudioSilo');

  await nav(() => router.back());
  expect(title()).toBe('Dune · AudioSilo');
  // A page with no title yet (its data loading) leaves the tab's name, not the last page's.
  await nav(() => router.push('/loading'));
  expect(title()).toBe('Home · AudioSilo');
  await nav(() => router.back());
  await nav(() => router.back());
  expect(title()).toBe('Home · AudioSilo');

  await nav(() => router.navigate('/library'));
  expect(title()).toBe('Library · AudioSilo');
});

it('releases the page under a root modal and claims it again on the way back', async () => {
  await (renderRouter(tree, { initialUrl: '/' }) as unknown as Promise<unknown>);
  await nav(() => router.push('/book'));
  await nav(() => router.push('/finished'));
  expect(title()).toBe('AudioSilo');
  await nav(() => router.back());
  expect(title()).toBe('Dune · AudioSilo');
});

it('names the book playing over the page, and the page again once it pauses', async () => {
  await (renderRouter(tree, { initialUrl: '/book' }) as unknown as Promise<unknown>);
  const player = playerStoreMock();
  await act(async () => {
    player.usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 1, path: 'Weir/Project Hail Mary', title: '' },
      snapshot: { ...player.usePlayer.getState().snapshot, state: 'playing' },
    } as never);
  });
  // An untitled book goes by its folder name, as everywhere else.
  expect(title()).toBe('▶ Project Hail Mary · AudioSilo');
  await act(async () => {
    player.usePlayer.setState({
      snapshot: { ...player.usePlayer.getState().snapshot, state: 'paused' },
    });
  });
  expect(title()).toBe('Dune · AudioSilo');
});
