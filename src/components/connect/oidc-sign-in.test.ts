import { ApiError, NetworkError } from '@/api/client';
import type { ServerInfo } from '@/api/types';
import i18n from '@/i18n';

import { offersOidc, oidcFinishText, oidcName, ownServerPage } from './oidc-sign-in';

const t = i18n.t.bind(i18n);
const ORIGIN = 'https://books.example.com';

const info = (oidc?: boolean, name?: string): ServerInfo =>
  ({
    name: 'Hearthside',
    server_id: 'srv-1',
    version: '2.7.0',
    api: 'v1',
    capabilities: oidc === undefined ? {} : { oidc },
    auth: name === undefined ? { methods: [] } : { methods: ['oidc'], oidc: { name } },
  }) as ServerInfo;

describe('offersOidc', () => {
  it('is offered by the served web player at its own server with the capability on', () => {
    expect(offersOidc(info(true, 'Keycloak'), ORIGIN, ORIGIN, 'web')).toBe(true);
    expect(offersOidc(info(true, 'Keycloak'), `${ORIGIN}/`, ORIGIN, 'web')).toBe(true);
  });

  it('is not offered with the capability off or absent (an older server)', () => {
    expect(offersOidc(info(false), ORIGIN, ORIGIN, 'web')).toBe(false);
    expect(offersOidc(info(), ORIGIN, ORIGIN, 'web')).toBe(false);
    expect(offersOidc(null, ORIGIN, ORIGIN, 'web')).toBe(false);
  });

  it('is not offered in the app, nor on a page that is not the server (Metro, another origin)', () => {
    expect(offersOidc(info(true), ORIGIN, ORIGIN, 'ios')).toBe(false);
    expect(offersOidc(info(true), ORIGIN, ORIGIN, 'android')).toBe(false);
    expect(offersOidc(info(true), ORIGIN, null, 'web')).toBe(false);
    expect(offersOidc(info(true), 'http://192.168.1.20:8080', ORIGIN, 'web')).toBe(false);
    expect(ownServerPage('https://books.example.com:8443', ORIGIN, 'web')).toBe(false);
  });
});

it("names the provider from the server's auth block, '' when it sent none", () => {
  expect(oidcName(info(true, ' Keycloak '))).toBe('Keycloak');
  expect(oidcName(info(true))).toBe('');
  expect(oidcName(null)).toBe('');
});

describe('oidcFinishText', () => {
  it.each([
    [new ApiError(401, 'no', 'oidc_no_sign_in'), 'connect.oidc.errors.noSignIn'],
    [new ApiError(401, 'gone', 'oidc_sign_in_expired'), 'connect.oidc.errors.expired'],
    [new ApiError(400, 'invalid request'), 'connect.oidc.errors.failed'],
    [new ApiError(500, 'boom'), 'connect.oidc.errors.failed'],
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
