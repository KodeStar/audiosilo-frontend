import type { TFunction } from 'i18next';
import { useState } from 'react';

import { apiErrorKind } from '@/api/client';
import { useMemberSession } from '@/api/hooks';
import type { HouseholdMember } from '@/api/types';
import {
  AddMemberHereError,
  addMemberHere,
  memberSignedInHere,
} from '@/components/connect/add-member-here';
import { serverIdOf } from '@/lib/connection-id';

/** How signing a member in on this device ended: signed in, already signed in here (as
 * any person: their profile is on this device), or it didn't work (nothing changed here;
 * `message`: `addMemberHere`'s own, already translated, when it said why; `tooMany`: the
 * server's limiter refused the session, 429). */
export type SignInHereResult =
  | { status: 'done' }
  | { status: 'already' }
  | { status: 'failed'; message?: string; tooMany?: boolean };

/** What a failed `addMemberHere` (or the session before it) says. A refusal of
 * `addMemberHere` carries a translated message; a server error does not (its text is the
 * server's English), so the caller's own words stand in. */
export function signInHereFailure(e: unknown, fromAddHere: boolean): SignInHereResult {
  if (e instanceof AddMemberHereError) return { status: 'already' };
  if (apiErrorKind(e) === 'too_many') return { status: 'failed', tooMany: true };
  return fromAddHere && e instanceof Error && e.message
    ? { status: 'failed', message: e.message }
    : { status: 'failed' };
}

/** What a sign-in here that didn't work says: already here, too many tries,
 * `addMemberHere`'s own (translated) reason, else that it can be tried again. */
export function hereFailure(here: SignInHereResult, name: string, t: TFunction): string {
  if (here.status === 'already') return t('household.here.already', { name });
  if (here.status === 'failed' && here.tooMany) return t('common.tooManyTries');
  if (here.status === 'failed' && here.message) return here.message;
  return t('household.here.failedRetry', { name });
}

/**
 * Sign one of the caller's household members in on this device as a person of their own
 * (Phase 8b-1: "They'll also use this phone", a member card's "Sign in on this device").
 * First `memberSignedInHere`: a member this device already holds is "already" without
 * asking the server for a session (one `addMemberHere` then refused would stay signed in
 * with nothing using it). Then the member's session (`useMemberSession`) and
 * `addMemberHere`, which places it in a new profile, keeps the person listening and the
 * default connection where they are, and turns kids mode on for a kid.
 */
export function useSignInHere(owner: { id: string; serverId?: string }) {
  const session = useMemberSession(owner.id);
  const [busy, setBusy] = useState(false);
  const run = async (
    member: Pick<HouseholdMember, 'id' | 'name' | 'kind'>,
  ): Promise<SignInHereResult> => {
    if (memberSignedInHere(serverIdOf(owner), member.id)) return { status: 'already' };
    setBusy(true);
    try {
      let s;
      try {
        s = await session.mutateAsync(member.id);
      } catch (e) {
        return signInHereFailure(e, false);
      }
      try {
        await addMemberHere(s, { name: member.name, kids: member.kind === 'kid' });
        return { status: 'done' };
      } catch (e) {
        return signInHereFailure(e, true);
      }
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}
