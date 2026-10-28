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

  it("says which way a redeemed invite can't be used when the server names it", () => {
    expect(signInErrorText(new ApiError(401, 'x', 'invite_used'), 'redeem', t)).toBe(
      'This invite has been used on all the devices it allows. Ask your admin for a new invite.',
    );
    expect(signInErrorText(new ApiError(401, 'x', 'invite_expired'), 'redeem', t)).toBe(
      'This invite has expired. Ask your admin for a new invite.',
    );
    // An older server sends no code: a code that didn't work, as before.
    expect(signInErrorText(new ApiError(401, 'x'), 'redeem', t)).toMatch(/didn't work/);
  });

  it.each(['de', 'es', 'fr', 'it', 'pt'])('has both invite messages in %s', (lng) => {
    const tl = i18n.getFixedT(lng);
    for (const code of ['invite_used', 'invite_expired']) {
      const said = signInErrorText(new ApiError(401, 'x', code), 'redeem', tl);
      expect(said).not.toBe(signInErrorText(new ApiError(401, 'x', code), 'redeem', t));
      expect(said).not.toMatch(/connect\.signIn/);
    }
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
