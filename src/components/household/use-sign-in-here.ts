import type { TFunction } from 'i18next';
import { useState } from 'react';

import { apiErrorKind } from '@/api/client';
import { useMemberSession } from '@/api/hooks';
import type { AuthSession, HouseholdMember } from '@/api/types';
import {
  type AddMemberHereCode,
  AddMemberHereError,
  addMemberHere,
  memberSignedInHere,
} from '@/components/connect/add-member-here';
import { serverIdOf } from '@/lib/connection-id';

/** Why the server refused a member's session, as `signInMemberHere` tells them apart: its
 * limiter (429), a member the admin disabled (409 `member_disabled`), or one no longer in
 * the caller's household (404: deleted, or moved, elsewhere). */
export type SessionRefusal = 'too_many' | 'member_disabled' | 'not_found';

const SESSION_REFUSALS: ReadonlySet<string> = new Set<SessionRefusal>([
  'too_many',
  'member_disabled',
  'not_found',
]);

/** The refusal of a member's session `e` is, when it is one `hereFailure` says in words. */
function sessionRefusal(e: unknown): SessionRefusal | undefined {
  const kind = apiErrorKind(e);
  return SESSION_REFUSALS.has(kind) ? (kind as SessionRefusal) : undefined;
}

/** How signing a member in on this device ended: signed in, already signed in here (as
 * any person: their profile is on this device), or it didn't work (nothing changed here;
 * `reason`: why, when it is known: `addMemberHere`'s refusal, or the server's
 * (`SessionRefusal`)). */
export type SignInHereResult =
  | { status: 'done' }
  | { status: 'already' }
  | { status: 'failed'; reason?: Exclude<AddMemberHereCode, 'already_here'> | SessionRefusal };

/** What a failed sign-in here (the session, or `addMemberHere` after it) comes to. */
function signInHereFailure(e: unknown): SignInHereResult {
  if (e instanceof AddMemberHereError) {
    return e.code === 'already_here' ? { status: 'already' } : { status: 'failed', reason: e.code };
  }
  const reason = sessionRefusal(e);
  return reason ? { status: 'failed', reason } : { status: 'failed' };
}

/**
 * Sign one of the caller's household members in on this device as a person of their own
 * (Phase 8b-1: a kid just added, "They'll also use this phone", a member card's "Sign in on
 * this device"). First `memberSignedInHere`: a member this device already holds is
 * "already" without asking the server for a session (one `addMemberHere` then refused
 * would stay signed in with nothing using it). Then `mint` (their session: the add's
 * answer, or `useMemberSession`) and `addMemberHere`, which places it in a new profile,
 * keeps the person listening and the default connection where they are, and turns kids
 * mode on for a kid's account. `serverId`: the owner's server. Never throws.
 */
export async function signInMemberHere(
  mint: () => Promise<AuthSession>,
  member: Pick<HouseholdMember, 'id' | 'name'>,
  serverId: string,
): Promise<SignInHereResult> {
  if (memberSignedInHere(serverId, member.id)) return { status: 'already' };
  try {
    await addMemberHere(await mint(), { name: member.name });
    return { status: 'done' };
  } catch (e) {
    return signInHereFailure(e);
  }
}

/** What a sign-in here that didn't work says: already here, too many tries, a member the
 * admin disabled or no longer in the household, why `addMemberHere` refused, else that it
 * can be tried again. */
export function hereFailure(here: SignInHereResult, name: string, t: TFunction): string {
  if (here.status === 'already') return t('household.here.already', { name });
  switch (here.status === 'failed' ? here.reason : undefined) {
    case 'too_many':
      return t('common.tooManyTries');
    case 'member_disabled':
      return t('household.here.disabled', { name });
    case 'not_found':
      return t('household.here.gone', { name });
    case 'not_ready':
      return t('connect.memberNotReady');
    case 'choose_adult':
      return t('profiles.add.chooseAdult');
    default:
      return t('household.here.failedRetry', { name });
  }
}

/** What a member's session the server refused says (`hereFailure`'s words for too many
 * tries, a disabled member or one no longer in the household), for `name`; null for any
 * other failure, which the caller says in its own words. */
export function sessionRefusalText(e: unknown, name: string, t: TFunction): string | null {
  const reason = sessionRefusal(e);
  return reason ? hereFailure({ status: 'failed', reason }, name, t) : null;
}

/** `signInMemberHere` with a session `owner` mints (`useMemberSession`), and whether one
 * is on its way. */
export function useSignInHere(owner: { id: string; serverId?: string }) {
  const session = useMemberSession(owner.id);
  const [busy, setBusy] = useState(false);
  const run = async (member: Pick<HouseholdMember, 'id' | 'name'>): Promise<SignInHereResult> => {
    setBusy(true);
    try {
      return await signInMemberHere(
        () => session.mutateAsync(member.id),
        member,
        serverIdOf(owner),
      );
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}
