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

/** How signing a member in on this device ended: signed in, already signed in here (as
 * any person: their profile is on this device), or it didn't work (nothing changed here;
 * `reason`: why, when it is known: `addMemberHere`'s refusal, or `too_many` when the
 * server's limiter refused the session, 429). */
export type SignInHereResult =
  | { status: 'done' }
  | { status: 'already' }
  | { status: 'failed'; reason?: Exclude<AddMemberHereCode, 'already_here'> | 'too_many' };

/** What a failed sign-in here (the session, or `addMemberHere` after it) comes to. */
function signInHereFailure(e: unknown): SignInHereResult {
  if (e instanceof AddMemberHereError) {
    return e.code === 'already_here' ? { status: 'already' } : { status: 'failed', reason: e.code };
  }
  return apiErrorKind(e) === 'too_many'
    ? { status: 'failed', reason: 'too_many' }
    : { status: 'failed' };
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

/** What a sign-in here that didn't work says: already here, too many tries, why
 * `addMemberHere` refused, else that it can be tried again. */
export function hereFailure(here: SignInHereResult, name: string, t: TFunction): string {
  if (here.status === 'already') return t('household.here.already', { name });
  switch (here.status === 'failed' ? here.reason : undefined) {
    case 'too_many':
      return t('common.tooManyTries');
    case 'not_ready':
      return t('connect.memberNotReady');
    case 'choose_adult':
      return t('profiles.add.chooseAdult');
    default:
      return t('household.here.failedRetry', { name });
  }
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
