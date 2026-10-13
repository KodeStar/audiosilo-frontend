import { router } from 'expo-router';

import { activeProfile, useProfiles } from '@/stores/profiles';

/**
 * What the connect flow on screen is for. Module state, not route params, because every
 * way in (a pairing link, a code, a password, the demo) ends in `finishConnect` from a
 * different screen, and a link must never be able to carry either. Both end when the flow
 * is left (`endConnectFlow`, as `connect/_layout.tsx` unmounts), so the next flow starts as
 * a sign-in of the person listening again.
 *
 * - `newPerson`: the flow signs in a NEW person ("Add someone" on "Who's listening?",
 *   `/connect?add=1&profile=new`). A `/connect` with `profile=new` sets it, an explicit
 *   "Add a server" (`add=1` without it) clears it, and a `/connect` with neither param keeps
 *   it, since the flow's own steps produce one (the QR scan replaces its screen with a
 *   `/connect` that carries only the link, "Use another server" returns with no params).
 *   `finishConnect` reads it to place the new connection in a profile of its own
 *   (`placeConnection`).
 * - `grownUpFromKids`: kids mode lets this flow through (8b-1, D1). Kids mode never opens
 *   the connect flow (a link, a banner, a typed URL all go back to `/kids`), with ONE
 *   exception, a grown-up's "Add someone" on "Who's listening?" (reached through the
 *   Grown-ups hold) on a device with no grown-up (`mayAddPerson`): how a kid-only device is
 *   signed in again. Set only by that button (`openAddSomeone`).
 */
type ConnectIntent = { newPerson: boolean; grownUpFromKids: boolean };

const NO_INTENT: ConnectIntent = { newPerson: false, grownUpFromKids: false };
let intent: ConnectIntent = NO_INTENT;

export function setConnectForNewProfile(on: boolean): void {
  intent = { ...intent, newPerson: on };
}

export function connectForNewProfile(): boolean {
  return intent.newPerson;
}

/** The connect flow's href for "Add someone". */
export const ADD_SOMEONE_HREF = '/connect?add=1&profile=new';

/** "Add someone": the connect flow for a new person. From kids mode (only enabled there
 * on a device with no grown-up) it also lets kids mode through the flow
 * (`kidsConnectAllowed`). */
export function openAddSomeone(): void {
  const state = useProfiles.getState();
  if (activeProfile(state)?.kids && mayAddPerson(state)) {
    intent = { ...intent, grownUpFromKids: true };
  }
  router.push(ADD_SOMEONE_HREF);
}

/** Whether the connect flow on screen was opened by a grown-up from kids mode
 * (`openAddSomeone`). */
export function kidsConnectAllowed(): boolean {
  return intent.grownUpFromKids;
}

/** The connect flow was left: the next one starts with no intent. */
export function endConnectFlow(): void {
  intent = NO_INTENT;
}

type ProfilesState = ReturnType<typeof useProfiles.getState>;

/**
 * Whether someone new may sign in on this device now ("Add someone", a new server, the
 * demo). Not while a kids profile is listening and a grown-up is on the device: they
 * choose the grown-up first ("Who's listening?", PIN and all), or a child could leave kids
 * mode through a new profile. With no grown-up left, kids mode would otherwise have no way
 * out at all, so then it may. Not while the profiles could not be read (nobody is known).
 */
export function mayAddPerson(state: ProfilesState = useProfiles.getState()): boolean {
  if (state.hydrationFailed) return false;
  return !activeProfile(state)?.kids || !state.profiles.some((p) => !p.kids);
}
