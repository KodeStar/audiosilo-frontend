// Links into the app through Expo Router's own linking pipeline (getRoutes ->
// getLinkingConfig -> getInitialURL / subscribe -> extractExpoPathFromURL -> getStateFromPath),
// the way a native cold start and a 'url' event while running do, with the app's real
// `+native-intent`.
const mockLinkingURL: { current: string | null } = { current: '' };
const mockUrlListeners: ((e: { url: string }) => unknown)[] = [];
jest.mock('expo-linking', () => {
  const actual = jest.requireActual('expo-linking');
  return {
    ...actual,
    getLinkingURL: () => mockLinkingURL.current,
    addEventListener: (_: string, cb: (e: { url: string }) => unknown) => {
      mockUrlListeners.push(cb);
      return { remove: () => {} };
    },
    createURL: (p: string) => `audiosilo://${p.startsWith('/') ? '/' + p : p}`,
  };
});
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import { Platform } from 'react-native';

import * as nativeIntent from '@/app/+native-intent';
import { playerDeepLink } from '@/widgets/widget-model';

import { appLinkPath } from './native-intent';

const { getRoutes } = require('expo-router/build/getRoutes');
const { getLinkingConfig } = require('expo-router/build/getLinkingConfig');
const { extractExpoPathFromURL } = require('expo-router/build/fork/extractPathFromURL');
const { inMemoryContext } = require('expo-router/build/testing-library/context-stubs');
/* eslint-enable import/first, @typescript-eslint/no-require-imports */

type Route = { name: string; params?: Record<string, string>; state?: { routes: Route[] } };

function find(state: { routes?: Route[] } | undefined, name: string): Route | undefined {
  for (const r of state?.routes ?? []) {
    if (r.name === name) return r;
    const f = find(r.state, name);
    if (f) return f;
  }
  return undefined;
}

function linking(withIntent: boolean) {
  const files: Record<string, unknown> = {
    _layout: { default: () => null, unstable_settings: { anchor: '(app)' } },
    '(app)/_layout': () => null,
    '(app)/index': () => null,
    player: () => null,
    'connect/_layout': () => null,
    'connect/index': () => null,
    ...(withIntent ? { '+native-intent': nativeIntent } : {}),
  };
  const ctx = inMemoryContext(files);
  const routes = getRoutes(ctx, {
    skipGenerated: true,
    ignoreEntryPoints: true,
    platform: Platform.OS,
    preserveRedirectAndRewrites: true,
  });
  return getLinkingConfig(routes, ctx, () => ({ segments: [] }), {
    metaOnly: true,
    serverUrl: undefined,
    redirects: [],
    skipGenerated: true,
    sitemap: true,
    notFound: true,
  });
}

/** A cold start from `url` (expo-router's native initial state). */
function coldStart(withIntent: boolean, url: string | null) {
  mockLinkingURL.current = url;
  const l = linking(withIntent);
  let path = extractExpoPathFromURL(l.prefixes, l.getInitialURL());
  if (!path.startsWith('/')) path = '/' + path;
  return l.getStateFromPath(path, l.config);
}

/** A link arriving while the app runs (expo-router's 'url' subscription). */
async function whileRunning(withIntent: boolean, url: string) {
  const l = linking(withIntent);
  mockUrlListeners.length = 0;
  let href = '';
  const unsubscribe = l.subscribe((h: string) => {
    href = h;
  });
  await mockUrlListeners[0]({ url });
  unsubscribe();
  return l.getStateFromPath(extractExpoPathFromURL(l.prefixes, href), l.config);
}

const PATHS = [
  'Author/Book One',
  'Austen/Pride & Prejudice',
  'Series/Dresden Files #1',
  'A/C++ for Kids',
  'A/50%20Off',
  'A/100% Pure',
  'Ünïcødé/Livre',
];
const CID = 'Zm9vYmFyMTIzNDU2Nzg5MA';

describe('appLinkPath', () => {
  it("opens the app's own links as paths, with their query as encoded", () => {
    expect(appLinkPath('audiosilo://player?path=A%20%26%20B')).toBe('/player?path=A%20%26%20B');
    expect(appLinkPath('audiosilo:///player?x=1')).toBe('/player?x=1');
    expect(appLinkPath('AudioSilo://connect?server=s')).toBe('/connect?server=s');
  });

  it('leaves every other link as it is', () => {
    for (const url of [
      '/player?x=1',
      'https://example.com/a?b=c',
      'audiosilo://expo-development-client/?url=x',
      'exp+audiosilo-frontend://expo-development-client/?url=x',
    ]) {
      expect(appLinkPath(url)).toBe(url);
    }
  });
});

describe('the widget link through Expo Router', () => {
  it('without the hook, a path holding & comes apart (the reason the hook exists)', () => {
    const url = playerDeepLink(CID, 3, 'Austen/Pride & Prejudice');
    expect(find(coldStart(false, url), 'player')?.params?.path).toBe('Austen/Pride ');
  });

  it("opens the player on the widget's book, on a cold start and while running", async () => {
    for (const p of PATHS) {
      const url = playerDeepLink(CID, 3, p);
      const cold = find(coldStart(true, url), 'player')?.params;
      const warm = find(await whileRunning(true, url), 'player')?.params;
      expect({ cold, warm }).toEqual({
        cold: expect.objectContaining({ connection: CID, libraryId: '3', path: p }),
        warm: expect.objectContaining({ connection: CID, libraryId: '3', path: p }),
      });
    }
  });

  it('still opens a plain launch on the app, and a pairing link keeps its server address', () => {
    expect(find(coldStart(true, null), 'player')).toBeUndefined();
    const server = 'https://a.example/books?x=1&y=2';
    const link = `audiosilo://connect?server=${encodeURIComponent(server)}&token=ab-_c`;
    const params = find(coldStart(true, link), 'index')?.params;
    expect(params).toEqual(expect.objectContaining({ server, token: 'ab-_c' }));
  });
});
