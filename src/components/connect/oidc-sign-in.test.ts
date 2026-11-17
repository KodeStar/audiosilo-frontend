import { ApiError, NetworkError } from '@/api/client';
import type { ServerInfo } from '@/api/types';
import i18n from '@/i18n';

import { oidcButtonName, oidcFinishText, oidcReturnOnLoad } from './oidc-sign-in';

// The player the server serves at /web: its own origin, else (native, Metro dev) none.
let mockServed: string | null = null;
jest.mock('@/lib/base-url', () => {
  const actual = jest.requireActual('@/lib/base-url');
  return {
    ...actual,
    servedOrigin: () => mockServed,
    appPath: (pathname: string) => actual.appPath(pathname, '/web'),
  };
});

const t = i18n.t.bind(i18n);

describe('oidcReturnOnLoad', () => {
  const at = (pathname: string, search: string) =>
    Object.defineProperty(globalThis, 'location', {
      value: { pathname, search },
      configurable: true,
    });
  beforeEach(() => {
    mockServed = 'https://books.example.com';
  });
  afterAll(() => {
    delete (globalThis as { location?: unknown }).location;
  });

  it("is the served player's page load of /connect?oidc=1", () => {
    at('/web/connect', '?oidc=1');
    expect(oidcReturnOnLoad()).toBe(true);
    at('/web/connect/', '?oidc=1');
    expect(oidcReturnOnLoad()).toBe(true);
  });

  // Only the flow's first step finishes a return: a held intent (a grown-up's pass through
  // kids mode) must not be taken up by a route that would never settle it.
  it.each(['/web/connect/sign-in', '/web/connect/scan', '/web/connect/ready', '/web/kids', '/web'])(
    'is not ?oidc=1 on %s',
    (pathname) => {
      at(pathname, '?oidc=1');
      expect(oidcReturnOnLoad()).toBe(false);
    },
  );

  it('is not another value, a pairing link, or a player the server does not serve', () => {
    at('/web/connect', '');
    expect(oidcReturnOnLoad()).toBe(false);
    at('/web/connect', '?oidc=2');
    expect(oidcReturnOnLoad()).toBe(false);
    at('/web/connect', '?oidc=1&token=tok');
    expect(oidcReturnOnLoad()).toBe(false);
    mockServed = null;
    at('/web/connect', '?oidc=1');
    expect(oidcReturnOnLoad()).toBe(false);
  });
});

const info = (oidc?: boolean, name?: string): ServerInfo =>
  ({
    name: 'Hearthside',
    server_id: 'srv-1',
    version: '2.7.0',
    api: 'v1',
    capabilities: oidc === undefined ? {} : { oidc },
    auth: name === undefined ? { methods: [] } : { methods: ['oidc'], oidc: { name } },
  }) as ServerInfo;

it('offers the button only while the capability is on, named by the auth block', () => {
  expect(oidcButtonName(info(true, ' Keycloak '))).toBe('Keycloak');
  expect(oidcButtonName(info(true))).toBe('');
  expect(oidcButtonName(info(false, 'Keycloak'))).toBeNull();
  expect(oidcButtonName(info())).toBeNull();
  expect(oidcButtonName(null)).toBeNull();
});

describe('oidcFinishText', () => {
  it.each([
    [new ApiError(401, 'no', 'oidc_no_sign_in'), 'connect.oidc.errors.noSignIn'],
    [new ApiError(401, 'gone', 'oidc_sign_in_expired'), 'connect.oidc.errors.expired'],
    [new ApiError(400, 'invalid request'), 'connect.oidc.errors.failed'],
    [new ApiError(500, 'boom'), 'connect.oidc.errors.failed'],
    [new ApiError(403, 'disabled', 'member_disabled'), 'connect.signIn.errors.disabled'],
    [new ApiError(401, 'old server, no code'), 'connect.oidc.errors.failed'],
    [new NetworkError(new Error('offline')), 'connect.oidc.errors.reach'],
  ] as const)('words %p in our own terms', (e, key) => {
    expect(oidcFinishText(e, t)).toBe(t(key));
  });

  it('names the wait of a 429 when the server sent one', () => {
    expect(oidcFinishText(new ApiError(429, 'slow down', undefined, 600), t)).toBe(
      t('connect.signIn.errors.wait', { count: 10 }),
    );
    expect(oidcFinishText(new ApiError(429, 'slow down'), t)).toBe(t('common.tooManyTries'));
  });
});
