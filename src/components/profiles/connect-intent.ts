import { activeProfile, useProfiles } from '@/stores/profiles';

/**
 * Whether the connect flow on screen signs in a NEW person ("Add someone" on "Who's
 * listening?", `/connect?add=1&profile=new`). `/connect` sets it from its own param while
 * it is mounted (the sign-in step is pushed over it, so it stays mounted through the flow)
 * and clears it when it unmounts (the flow finished or was left); `finishConnect` reads it
 * to place the new connection in a profile of its own (`placeConnection`). Module state,
 * not a route param, because every way in (a pairing link, a code, a password, the demo)
 * ends in `finishConnect` from a different screen.
 */
let newPerson = false;

export function setConnectForNewProfile(on: boolean): void {
  newPerson = on;
}

export function connectForNewProfile(): boolean {
  return newPerson;
}

/** The connect flow's href for "Add someone". */
export const ADD_SOMEONE_HREF = '/connect?add=1&profile=new';

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
