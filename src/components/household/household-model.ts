import { ApiError } from '@/api/client';
import type {
  HouseholdMember,
  HouseholdMembers,
  HouseholdMembersReason,
  MemberAccess,
} from '@/api/types';
import { serverIdOf } from '@/lib/connection-id';

/**
 * The Household page's rules (Phase 8b-1): who may add, what the add form starts with and
 * how it follows the Kids switch, what a refused write says, and which of the session's
 * connections is a member signed in on this device. Pure, so they're tested apart from the
 * screens.
 */

/** A member's name: 1-40 characters (runes) once trimmed, no control characters (the
 * server's own rule, so a 400 `invalid_name` is never the first anyone hears of it). */
export const MEMBER_NAME_MAX = 40;

// Control characters (C0, DEL and C1): the server refuses a name holding one.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function validMemberName(name: string): boolean {
  const n = [...name.trim()].length;
  return n > 0 && n <= MEMBER_NAME_MAX && !CONTROL.test(name);
}

/** Why the members section offers no "Add someone to your household": the server's
 * `reason`, or `at_cap` when the caller has as many members as the server allows. Null
 * when they may add. */
export type AddBlock = HouseholdMembersReason | 'at_cap';

export function addBlock(list: HouseholdMembers): AddBlock | null {
  if (!list.allowed) return list.reason ?? 'not_allowed';
  return list.members.length >= list.max ? 'at_cap' : null;
}

/** What a new member can listen to before the owner picks (decision J): a kid starts on
 * "Only collections I share", a grown-up on "Everything I can listen to". */
export function defaultAccess(kid: boolean): MemberAccess {
  return kid ? 'collections' : 'all';
}

/** The add form's choices. `accessPicked`: the owner chose an access themselves, so the
 * Kids switch no longer moves it. */
export type AddForm = {
  name: string;
  kid: boolean;
  access: MemberAccess;
  accessPicked: boolean;
  collectionIds: number[];
};

/** A new form: a kid (the common case the page leads with), on its default access. */
export function newAddForm(kid = true): AddForm {
  return { name: '', kid, access: defaultAccess(kid), accessPicked: false, collectionIds: [] };
}

/** The Kids switch flipped: the access follows it until the owner picked one. */
export function withKid(form: AddForm, kid: boolean): AddForm {
  return { ...form, kid, access: form.accessPicked ? form.access : defaultAccess(kid) };
}

/** The owner picked an access: from now on it stays whatever the Kids switch does. */
export function withAccess(form: AddForm, access: MemberAccess): AddForm {
  return { ...form, access, accessPicked: true };
}

/** The collections a body sends: the chosen ones for "Only collections I share", none
 * otherwise (the server treats `collection_ids` as the full set to share). */
export function collectionIdsFor(
  access: MemberAccess,
  ids: readonly number[],
): number[] | undefined {
  return access === 'collections' ? [...ids] : undefined;
}

/** What a refused add or change says (a key under `household.errors`): the server's
 * cap (409), a name or collection it would not take (400), adding turned off for this
 * account (403), anything else (the server didn't answer: nothing changed). */
export type WriteError = 'limit' | 'invalid' | 'forbidden' | 'failed';

export function writeError(e: unknown): WriteError {
  if (!(e instanceof ApiError)) return 'failed';
  if (e.status === 409) return 'limit';
  if (e.status === 400) return 'invalid';
  if (e.status === 403) return 'forbidden';
  return 'failed';
}

/** The connection on this device that is `memberId` on the owner's server (signed in
 * here, as any person), if there is one. Matched by server (`serverIdOf`, never the id's
 * text) and user id. */
export function memberConnection<
  C extends { id: string; serverId?: string; user: { id?: number } },
>(
  connections: readonly C[],
  owner: { id: string; serverId?: string },
  memberId: number,
): C | undefined {
  const server = serverIdOf(owner);
  return connections.find((c) => serverIdOf(c) === server && c.user?.id === memberId);
}

/** Whether `name` (typed into the second delete confirmation) names `member`: the same
 * letters, ignoring case and the spaces around it. */
export function confirmsName(typed: string, member: Pick<HouseholdMember, 'name'>): boolean {
  const a = typed.trim().toLocaleLowerCase();
  return a.length > 0 && a === member.name.trim().toLocaleLowerCase();
}

/** The members of the caller's household who can listen only to collections they share
 * (the share sheet's line about them), by id. */
export function collectionsMembers(
  list: HouseholdMembers | undefined,
): Map<number, HouseholdMember> {
  return new Map(
    (list?.members ?? []).filter((m) => m.access === 'collections').map((m) => [m.id, m]),
  );
}
