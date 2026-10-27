import { ApiError } from '@/api/client';
import i18n from '@/i18n';

import { signInErrorText } from './sign-in-error';

const t = i18n.t.bind(i18n);

describe('signInErrorText', () => {
  it('tells a 401 apart by the request that failed', () => {
    const e = new ApiError(401, 'x');
    expect(signInErrorText(e, 'redeem', t)).toMatch(/That invite code didn't work/);
    expect(signInErrorText(e, 'exchange', t)).toMatch(/used up or has expired/);
    expect(signInErrorText(e, 'login', t)).toBe(
      'The username or password is wrong. Check them and try again.',
    );
  });

  it('names the wait in whole minutes, rounding up', () => {
    expect(signInErrorText(new ApiError(429, 'x', undefined, 61), 'login', t)).toBe(
      'Too many tries from this network. Try again in 2 minutes.',
    );
    expect(signInErrorText(new ApiError(429, 'x', undefined, 30), 'redeem', t)).toBe(
      'Too many tries from this network. Try again in 1 minute.',
    );
  });

  it('falls back to a few minutes when the server sent no wait', () => {
    expect(signInErrorText(new ApiError(429, 'x'), 'login', t)).toBe(
      'Too many tries. Wait a few minutes and try again.',
    );
  });

  it('says a turned-off account is turned off', () => {
    expect(signInErrorText(new ApiError(409, 'x', 'member_disabled'), 'exchange', t)).toMatch(
      /turned off/,
    );
  });

  it('is the generic failure for no answer or a server error', () => {
    expect(signInErrorText(new TypeError('Network request failed'), 'login', t)).toBe(
      'Sign in failed. Please try again.',
    );
    expect(signInErrorText(new ApiError(500, 'boom'), 'login', t)).toBe(
      'Sign in failed. Please try again.',
    );
  });
});
