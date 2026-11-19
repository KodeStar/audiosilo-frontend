import { ApiError } from '@/api/client';
import i18n, { ensureLanguage, SUPPORTED_CODES } from '@/i18n';

import { refusalWaitOver, signInErrorText } from './sign-in-error';

const t = i18n.t.bind(i18n);

// Only English is in from the start: the fixed-language checks below need theirs.
beforeAll(() => Promise.all(SUPPORTED_CODES.map(ensureLanguage)));

describe('signInErrorText', () => {
  it('tells a 401 apart by the request that failed', () => {
    const e = new ApiError(401, 'x');
    expect(signInErrorText(e, 'redeem', t)).toMatch(/That invite code didn't work/);
    expect(signInErrorText(e, 'exchange', t)).toMatch(/used up or has expired/);
    expect(signInErrorText(e, 'login', t)).toBe(
      'The username or password is wrong. Check them and try again.',
    );
  });

  // fe#295: a sign-in proxy's own 401 is never a wrong code or password.
  it("names the proxy headers for an auth proxy's 401, at every step", () => {
    const e = new ApiError(401, 'Unauthorized', undefined, undefined, true);
    for (const stage of ['redeem', 'exchange', 'login'] as const) {
      expect(signInErrorText(e, stage, t)).toMatch(/sign-in proxy turned this device away/);
    }
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

  it('names a wait of a minute or more in whole minutes, rounding up', () => {
    expect(signInErrorText(new ApiError(429, 'x', undefined, 61), 'login', t)).toBe(
      'Too many tries from this network. Try again in 2 minutes.',
    );
    expect(signInErrorText(new ApiError(429, 'x', undefined, 60), 'redeem', t)).toBe(
      'Too many tries from this network. Try again in 1 minute.',
    );
    // Rounded to whole seconds first: never "60 seconds".
    expect(signInErrorText(new ApiError(429, 'x', undefined, 59.5), 'login', t)).toBe(
      'Too many tries from this network. Try again in 1 minute.',
    );
  });

  // A single sign-on's finish offers Try again after a 429 shorter than its minute: 30 s
  // once read "Try again in 1 minute" (SSO-DONE verify).
  it('names a wait under a minute in seconds', () => {
    expect(signInErrorText(new ApiError(429, 'x', undefined, 30), 'redeem', t)).toBe(
      'Too many tries from this network. Try again in 30 seconds.',
    );
    expect(signInErrorText(new ApiError(429, 'x', undefined, 0.5), 'login', t)).toBe(
      'Too many tries from this network. Try again in 1 second.',
    );
  });

  it.each(SUPPORTED_CODES.filter((c) => c !== 'en'))('names a wait in seconds in %s', (lng) => {
    const wait = new ApiError(429, 'x', undefined, 30);
    const said = signInErrorText(wait, 'login', i18n.getFixedT(lng));
    expect(said).toMatch(/30/);
    // A missing key falls back to the English sentence.
    expect(said).not.toBe(signInErrorText(wait, 'login', t));
    expect(said).not.toBe(
      signInErrorText(new ApiError(429, 'x', undefined, 60), 'login', i18n.getFixedT(lng)),
    );
  });

  it.each(SUPPORTED_CODES.filter((c) => c !== 'en'))('words a wait that is over in %s', (lng) => {
    const wait = new ApiError(429, 'x', undefined, 30);
    const said = refusalWaitOver(wait, i18n.getFixedT(lng))?.text;
    expect(said).toBeTruthy();
    // A missing key falls back to the English sentence.
    expect(said).not.toBe(refusalWaitOver(wait, t)?.text);
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

describe('refusalWaitOver', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1_000_000));
  afterEach(() => jest.restoreAllMocks());

  it('says a named wait is over at the Retry-After, with no time in the words', () => {
    expect(refusalWaitOver(new ApiError(429, 'x', undefined, 30), t)).toEqual({
      at: 1_030_000,
      text: 'Too many tries from this network. You can try again now.',
    });
    expect(refusalWaitOver(new ApiError(429, 'x', undefined, 900), t)?.at).toBe(1_900_000);
  });

  it('swaps at the whole second the words name, never before it', () => {
    const wait = new ApiError(429, 'x', undefined, 0.3);
    expect(signInErrorText(wait, 'login', t)).toBe(
      'Too many tries from this network. Try again in 1 second.',
    );
    expect(refusalWaitOver(wait, t)?.at).toBe(1_001_000);
  });

  it('has nothing to swap for words that name no wait', () => {
    expect(refusalWaitOver(new ApiError(429, 'x'), t)).toBeUndefined();
    expect(refusalWaitOver(new ApiError(429, 'x', undefined, 0), t)).toBeUndefined();
    expect(refusalWaitOver(new ApiError(401, 'x', undefined, 30), t)).toBeUndefined();
    expect(refusalWaitOver(new TypeError('Failed to fetch'), t)).toBeUndefined();
  });
});
