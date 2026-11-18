import { ApiError, NetworkError } from '@/api/client';
import type { ServerInfo } from '@/api/types';
import i18n from '@/i18n';

import { oidcButtonName, oidcFinishText, oidcRetryWait, oidcReturnOnLoad } from './oidc-sign-in';

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
    // A repeated param reaches the screen as a list, which it takes for a pairing link: read
    // the same way here, or the layout would wait on a finish the screen never starts.
    at('/web/connect', '?oidc=1&token=&token=tok');
    expect(oidcReturnOnLoad()).toBe(false);
    at('/web/connect', '?oidc=1&oidc=2');
    expect(oidcReturnOnLoad()).toBe(true);
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
    [new ApiError(403, 'other', 'oidc_intent_mismatch'), 'connect.oidc.errors.notThisTrip'],
    [new ApiError(403, 'old server, no code'), 'connect.oidc.errors.failed'],
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

  // With Try again offered (`oidcRetryWait`), no answer and a 5xx say to try again, never to
  // sign in again; a refusal reads as it does without one.
  it.each([
    [new NetworkError(new Error('offline')), 'connect.oidc.errors.reachRetry'],
    [new ApiError(500, 'boom'), 'connect.oidc.errors.failedRetry'],
    [new ApiError(503, 'busy'), 'connect.oidc.errors.failedRetry'],
    [new ApiError(408, 'request timeout'), 'connect.oidc.errors.failedRetry'],
    [new ApiError(400, 'invalid request'), 'connect.oidc.errors.failed'],
    [new ApiError(401, 'no', 'oidc_no_sign_in'), 'connect.oidc.errors.noSignIn'],
  ] as const)('words %p with Try again offered', (e, key) => {
    expect(oidcFinishText(e, t, true)).toBe(t(key));
  });
});

describe('oidcRetryWait', () => {
  it.each([
    ['no answer', new NetworkError(new Error('offline')), 0],
    ['a 500', new ApiError(500, 'boom'), 0],
    ['a 502 from a proxy', new ApiError(502, 'bad gateway'), 0],
    ['a 429 with no Retry-After', new ApiError(429, 'slow down'), 0],
    ['a 429 with Retry-After', new ApiError(429, 'slow down', undefined, 30), 30_000],
    ["a proxy's 408", new ApiError(408, 'request timeout'), 0],
  ] as const)('lets %s go again', (_, e, ms) => {
    expect(oidcRetryWait(e)).toBe(ms);
  });

  it.each([
    ['a 400', new ApiError(400, 'invalid request')],
    ['a 401', new ApiError(401, 'x', 'oidc_sign_in_expired')],
    ['a 403', new ApiError(403, 'x', 'oidc_intent_mismatch')],
    ['a 429 asking a wait past the trip itself', new ApiError(429, 'slow', undefined, 3600)],
    // The lockout's minutes outlive the done cookie's one (`OIDC_DONE_MS`).
    ['a 429 asking a wait past the done cookie', new ApiError(429, 'slow', undefined, 300)],
  ] as const)('never lets %s go again', (_, e) => {
    expect(oidcRetryWait(e)).toBeUndefined();
  });

  // What is left of the done cookie's minute: none left, nothing goes again; a wait must end
  // within what is left.
  it.each([
    ['no answer, the minute over', new NetworkError(new Error('offline')), 0, undefined],
    ['a 500, the minute over', new ApiError(500, 'boom'), -5, undefined],
    ['a 500, a second left', new ApiError(500, 'boom'), 1_000, 0],
    [
      'a 429 waiting past what is left',
      new ApiError(429, 'slow', undefined, 30),
      20_000,
      undefined,
    ],
    ['a 429 waiting within what is left', new ApiError(429, 'slow', undefined, 10), 20_000, 10_000],
  ] as const)('reads %s', (_, e, left, ms) => {
    expect(oidcRetryWait(e, left)).toBe(ms);
  });
});
