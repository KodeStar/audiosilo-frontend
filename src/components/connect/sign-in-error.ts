import type { TFunction } from 'i18next';

import { ApiError, apiErrorKind } from '@/api/client';

/** Which request of the sign-in failed: the invite code's redeem, the pairing token's
 * exchange that follows it, or a username and password login. */
export type SignInStage = 'redeem' | 'exchange' | 'login';

/**
 * The words for a refusal that reads the same wherever it lands (a sign-in, a pairing
 * link), or `undefined` for one the caller words itself: a 429 names the wait from the
 * server's `Retry-After` when it sent one (in seconds under a minute, else in whole
 * minutes: 30 s never reads as "1 minute"), and the server's `member_disabled`,
 * `invite_used` and `invite_expired` codes their own sentences.
 */
export function sharedRefusalText(e: ApiError, t: TFunction): string | undefined {
  if (e.status === 429) {
    const secs = namedWaitSeconds(e);
    if (secs === undefined) return t('common.tooManyTries');
    return secs < 60
      ? t('connect.signIn.errors.waitSeconds', { count: secs })
      : t('connect.signIn.errors.wait', { count: Math.ceil(secs / 60) });
  }
  switch (apiErrorKind(e)) {
    case 'member_disabled':
      return t('connect.signIn.errors.disabled');
    // The server names a real invite that can't be used any more (redeem, server v2.5.0).
    case 'invite_used':
      return t('connect.signIn.errors.inviteUsed');
    case 'invite_expired':
      return t('connect.signIn.errors.inviteExpired');
  }
  return undefined;
}

/** What a refusal that names a wait says once that wait is over: `text` from `at` (epoch ms). */
export type WaitOver = { at: number; text: string };

/** The wait a 429's words name, in whole seconds (so 59.5 s reads as "1 minute", never "60
 * seconds"), or `undefined` for any error that names none: ONE rule for the words and for
 * when they give way (`refusalWaitOver`). */
function namedWaitSeconds(e: unknown): number | undefined {
  if (!(e instanceof ApiError) || e.status !== 429) return undefined;
  const s = e.retryAfterSeconds;
  return s === undefined || s <= 0 ? undefined : Math.ceil(s);
}

/**
 * When the wait `sharedRefusalText` names (a 429 with a `Retry-After`) is over, and the words
 * then: the same refusal with no time in it, so "Try again in 30 seconds" never stays on
 * screen once trying again works (`useRefusalError` swaps it then). `undefined` for any error
 * whose words name no wait.
 */
export function refusalWaitOver(e: unknown, t: TFunction): WaitOver | undefined {
  const secs = namedWaitSeconds(e);
  if (secs === undefined) return undefined;
  return { at: Date.now() + secs * 1000, text: t('connect.signIn.errors.waitOver') };
}

/**
 * A failed sign-in as a sentence that says what to do next (CONNECT-08), never the
 * server's raw string ("invalid credentials"). Told apart by status and the request that
 * failed: a 401 at redeem is a code that didn't work, at exchange an invite used up or
 * expired, at login a wrong name or password (a redeem's `invite_used` and
 * `invite_expired` codes say which of those it is); a 429 names the wait from the server's
 * `Retry-After` when it sent one (`sharedRefusalText`). Anything that is no answer from the
 * server is the generic "Sign in failed".
 */
export function signInErrorText(e: unknown, stage: SignInStage, t: TFunction): string {
  if (!(e instanceof ApiError)) return t('connect.signIn.failed');
  const shared = sharedRefusalText(e, t);
  if (shared !== undefined) return shared;
  if (e.status === 401 || e.status === 400) {
    if (stage === 'redeem') return t('connect.signIn.errors.badCode');
    if (stage === 'exchange') return t('connect.signIn.errors.usedInvite');
    return t('connect.signIn.errors.badPassword');
  }
  return t('connect.signIn.failed');
}
