import { holdOidcIntent, takeOidcIntent } from './oidc-intent';
import { endOidcTripOnLoad } from './oidc-return';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
// The player the server serves at /web.
jest.mock('@/lib/base-url', () => {
  const actual = jest.requireActual('@/lib/base-url');
  return {
    ...actual,
    servedOrigin: () => 'https://books.example.com',
    appPath: (pathname: string) => actual.appPath(pathname, '/web'),
  };
});

const store = new Map<string, string>();
beforeAll(() => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
});
afterAll(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { location?: unknown }).location;
});
beforeEach(() => store.clear());

const loadAt = (pathname: string, search: string) => {
  Object.defineProperty(globalThis, 'location', {
    value: { pathname, search },
    configurable: true,
  });
  endOidcTripOnLoad();
};

// audiosilo#202: a trip abandoned at the provider leaves its tag in the tab. While it is
// held, the server's start URL sent again from the history would complete that trip.
describe('a page load with a single sign-on trip still held in the tab', () => {
  it.each([
    ['the library', '/web', ''],
    ['kids mode', '/web/kids', ''],
    ['the connect flow', '/web/connect', '?add=1&profile=new'],
    ["another of the flow's routes", '/web/connect/sign-in', '?oidc=1'],
    ['a pairing link', '/web/connect', '?oidc=1&token=tok'],
  ])('ends the trip on %s', (_, pathname, search) => {
    expect(holdOidcIntent()).toMatch(/^[0-9a-f]{64}$/);
    loadAt(pathname, search);
    // Denied: nothing left for a later return to take as its own.
    expect(store.size).toBe(0);
    expect(takeOidcIntent(true)).toBeNull();
  });

  it("keeps it for the return's own load, which takes it", () => {
    const tag = holdOidcIntent();
    loadAt('/web/connect', '?oidc=1');
    // Allowed: the trip came back.
    expect(takeOidcIntent(true)).toMatchObject({ tag });
    expect(store.size).toBe(0);
  });
});

// The root layout's module runs it as the page loads: on every route, before anything renders.
it('runs as the root layout loads', () => {
  expect(holdOidcIntent()).toBeDefined();
  Object.defineProperty(globalThis, 'location', {
    value: { pathname: '/web', search: '' },
    configurable: true,
  });
  jest.isolateModules(() => {
    // The layout's own weight (playback, the API, the shell) is not what is asked here.
    for (const heavy of [
      '@/api/provider',
      '@/components/kids/kids-route-guard',
      '@/components/shell/document-title',
      '@/components/shell/root-services',
      '@/components/shell/shell-toast-host',
      '@/lib/app-resume',
      '@/lib/bootstrap',
      '@/theme/static-fonts',
      '@/theme/theme-provider',
    ]) {
      jest.doMock(heavy, () => ({}));
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded here, mocked
    require('@/app/_layout');
  });
  expect(store.size).toBe(0);
});
