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
