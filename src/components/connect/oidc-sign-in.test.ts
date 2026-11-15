import { ApiError, NetworkError } from '@/api/client';
import type { ServerInfo } from '@/api/types';
import i18n from '@/i18n';

import { oidcButtonName, oidcFinishText } from './oidc-sign-in';

const t = i18n.t.bind(i18n);

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
