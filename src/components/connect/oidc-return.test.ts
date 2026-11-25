import { holdOidcIntent, peekOidcIntent } from './oidc-intent';
import { endOidcTripOnLoad, oidcFlowKey, oidcReturnCleared } from './oidc-return';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
// The player the server serves at /web.
jest.mock('@/lib/base-url', () => {
  const actual = jest.requireActual('@/lib/base-url');
  return {
    ...actual,
    productionWebOrigin: () => 'https://books.example.com',
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
    expect(peekOidcIntent()).toBeNull();
  });

  it("keeps it for the return's own load", () => {
    const tag = holdOidcIntent();
    loadAt('/web/connect', '?oidc=1');
    // Allowed: the trip came back.
    expect(peekOidcIntent()).toMatchObject({ tag });
    expect(store.size).toBe(1);
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

// server#406: the key of the flow a return names, for the finish to take this tab's sign-in.
describe('oidcFlowKey', () => {
  it('takes a key as the server makes it', () => {
    expect(oidcFlowKey('aZ09-_aZ09-_aZ09')).toBe('aZ09-_aZ09-_aZ09');
    expect(oidcFlowKey(['aZ09-_aZ09-_aZ09', 'x'])).toBe('aZ09-_aZ09-_aZ09');
  });

  it('drops anything that can be no key', () => {
    for (const flow of [
      undefined,
      '',
      'short',
      'aZ09-_aZ09-_aZ09x',
      'aZ09/aZ09.aZ09+a',
      'aZ09 aZ09 aZ09 a',
    ]) {
      expect(oidcFlowKey(flow)).toBeUndefined();
    }
  });
});

// Every param a return brings: one left on the address would stay for a reload, and in the
// history (`public/sw.js` keeps no page carrying `flow`).
it("clears both of a return's params", () => {
  expect(Object.keys(oidcReturnCleared).sort()).toEqual(['flow', 'oidc']);
  expect(Object.values(oidcReturnCleared)).toEqual([undefined, undefined]);
});
