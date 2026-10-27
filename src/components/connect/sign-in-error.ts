import type { TFunction } from 'i18next';

import { ApiError } from '@/api/client';

/** Which request of the sign-in failed: the invite code's redeem, the pairing token's
 * exchange that follows it, or a username and password login. */
export type SignInStage = 'redeem' | 'exchange' | 'login';

/**
 * A failed sign-in as a sentence that says what to do next (CONNECT-08), never the
 * server's raw string ("invalid credentials"). Told apart by status and the request that
 * failed: a 401 at redeem is a code that didn't work, at exchange an invite used up or
 * expired, at login a wrong name or password (a redeem's `invite_used` and
 * `invite_expired` codes say which of those it is); a 429 names the wait from the server's
 * `Retry-After` (in whole minutes) when it sent one. Anything that is no answer from the
 * server is the generic "Sign in failed".
 */
export function signInErrorText(e: unknown, stage: SignInStage, t: TFunction): string {
  if (!(e instanceof ApiError)) return t('connect.signIn.failed');
  if (e.status === 429) {
    const s = e.retryAfterSeconds;
    return s !== undefined && s > 0
      ? t('connect.signIn.errors.wait', { count: Math.ceil(s / 60) })
      : t('common.tooManyTries');
  }
  if (e.code === 'member_disabled') return t('connect.signIn.errors.disabled');
  // The server names a real invite that can't be used any more (redeem, server v2.5.0).
  if (e.code === 'invite_used') return t('connect.signIn.errors.inviteUsed');
  if (e.code === 'invite_expired') return t('connect.signIn.errors.inviteExpired');
  if (e.status === 401 || e.status === 400) {
    if (stage === 'redeem') return t('connect.signIn.errors.badCode');
    if (stage === 'exchange') return t('connect.signIn.errors.usedInvite');
    return t('connect.signIn.errors.badPassword');
  }
  return t('connect.signIn.failed');
}
