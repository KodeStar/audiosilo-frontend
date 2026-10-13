import type { TFunction } from 'i18next';

import { ApiError, type ApiErrorKind, apiErrorKind } from '@/api/client';
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
 * Kids switch no longer moves it. `newBooks`: "Create <Name>'s books" was chosen (the
 * collection is created when the form is submitted, `useMemberBooks`). */
export type AddForm = {
  name: string;
  kid: boolean;
  access: MemberAccess;
  accessPicked: boolean;
  collectionIds: number[];
  newBooks: boolean;
};

/** A new form: a kid (the common case the page leads with), on its default access. */
export function newAddForm(kid = true): AddForm {
  return {
    name: '',
    kid,
    access: defaultAccess(kid),
    accessPicked: false,
    collectionIds: [],
    newBooks: false,
  };
}

/** Whether saving creates "<Name>'s books" first: chosen, and only for "Only
 * collections I share" (switching to everything takes the promise back). */
export function createsBooks(access: MemberAccess, newBooks: boolean): boolean {
  return access === 'collections' && newBooks;
}

/** The caller's own collection already named `booksName` (trimmed, case aside): "Create
 * <Name>'s books" offers that one instead of a second collection of the same name
 * (8b-1, D10). */
export function namedCollection<T extends { name: string }>(
  own: readonly T[],
  booksName: string,
): T | undefined {
  const want = booksName.trim().toLocaleLowerCase();
  return want ? own.find((c) => c.name.trim().toLocaleLowerCase() === want) : undefined;
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

/** What a refused add or change says (a key under `household.errors`, `writeErrorText`).
 * The server's `code` decides (Phase 8b-1's coded refusals, `apiErrorKind`); the status
 * stands in for a route or an older server without one: 409 the cap, 400 a name or
 * collection it would not take, 403 adding turned off for this account, 404 the member is
 * gone, 429 too many tries, anything else (or no answer) nothing changed. */
export type WriteError =
  | 'limit'
  | 'usernameTaken'
  | 'invalidName'
  | 'invalidCollections'
  | 'invalid'
  | 'featureOff'
  | 'notAllowed'
  | 'member'
  | 'kid'
  | 'demo'
  | 'forbidden'
  | 'gone'
  | 'tooMany'
  | 'failed';

const BY_KIND: Readonly<Record<ApiErrorKind, WriteError>> = {
  member_limit: 'limit',
  username_taken: 'usernameTaken',
  invalid_name: 'invalidName',
  invalid_collections: 'invalidCollections',
  feature_off: 'featureOff',
  not_allowed: 'notAllowed',
  member_cannot_manage: 'member',
  kid_account: 'kid',
  demo_account: 'demo',
  too_many: 'tooMany',
  conflict: 'limit',
  invalid: 'invalid',
  forbidden: 'forbidden',
  not_found: 'gone',
  failed: 'failed',
};

export function writeError(e: unknown): WriteError {
  const kind = apiErrorKind(e);
  // A coded 409 that is not the cap (a collection's share cap): the change was refused.
  if (kind === 'conflict' && e instanceof ApiError && e.code) return 'invalid';
  return BY_KIND[kind];
}

/** Whether a refusal means the members list on screen is out of date (the cap or the
 * admin's switch changed under the page, or the member is gone): read it again. */
export function listIsStale(why: WriteError): boolean {
  return (
    why === 'limit' ||
    why === 'featureOff' ||
    why === 'notAllowed' ||
    why === 'forbidden' ||
    why === 'gone'
  );
}

/** What a refused write `e` says, in words (`writeError`). */
export function writeErrorText(e: unknown, server: string, t: TFunction): string {
  const why = writeError(e);
  return why === 'tooMany' ? t('common.tooManyTries') : t(`household.errors.${why}`, { server });
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
