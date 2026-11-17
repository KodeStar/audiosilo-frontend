import { create } from 'zustand';

import { onForeground } from '@/lib/when-active';
import { onConnectionRemoved, useSession } from '@/stores/session';

import { watchLink } from './link';
import { applyWatchStatus, followConnectionRemovals, hydrateLedger } from './watch-ledger';
import { accountOnWatch, NO_WATCH, pairAfterSignIn, type WatchStatus } from './watch-model';

type WatchStore = {
  status: WatchStatus;
  /** When the `pair` on its way runs out, epoch ms, by connection id. At most one entry: a new
   * pair takes the place of an undelivered one whichever account it is for, and one the watch
   * says it signed in with is no longer on its way. Kept for this run only: the watch's own
   * `watch-state` is what says it arrived. */
  pairUntil: Record<string, number>;
};

/** The watch as this phone knows it, one per app (every book row reads it). */
export const useWatchStore = create<WatchStore>(() => ({ status: NO_WATCH, pairUntil: {} }));

/** Take what the watch says. A pair for the account it says it is signed in to has landed and its
 * token is used: kept, it would read as still on its way once the watch leaves that account (a
 * book would follow it and only be held), then as having run out when it never did. */
function setStatus(status: WatchStatus): void {
  const here = accountOnWatch(status.state);
  const { connections } = useSession.getState();
  useWatchStore.setState((s) => ({
    status,
    pairUntil: pairAfterSignIn(s.pairUntil, here, connections),
  }));
  applyWatchStatus(status);
}

/** Read the watch's status afresh. It is what the session kept after a cold start, waiting for
 * activation if need be. Best effort: the last answer stands. */
export async function refreshWatch(): Promise<void> {
  try {
    setStatus(await watchLink.read());
  } catch {
    // The session did not answer: no change to what is shown.
  }
}

let started = false;

/** Follow the watch (one call does it, the first screen that asks). */
export function startWatchLink(): void {
  if (started) return;
  started = true;
  followConnectionRemovals();
  // A removed connection's pair is no one's to wait for.
  onConnectionRemoved(forgetPair);
  watchLink.subscribe(setStatus);
  // Paired or installed can change while the app is away, with no event reaching it.
  onForeground(() => void refreshWatch());
  // The ledger first: nothing can be sent before the first answer, so no row is laid over one not
  // read yet. An event that came meanwhile found no rows to settle.
  void hydrateLedger()
    .catch(() => {})
    .then(refreshWatch);
}

/** How many times each connection's pair was forgotten (`forgetPair`), for this run. */
const forgotten = new Map<string, number>();

/** The connection's pair epoch: a pair minted at one epoch and sent at another was forgotten on
 * its way. */
export function pairEpoch(connectionId: string): number {
  return forgotten.get(connectionId) ?? 0;
}

/** A pair went out. The native link has cancelled any older one still undelivered, this
 * connection's or another's, so only this one counts. `epoch`: `pairEpoch` when it was minted; a
 * pair forgotten since (its token ended meanwhile) is not on its way, and has still cancelled the
 * older one: then none is. */
export function notePairSent(connectionId: string, until: number, epoch: number): void {
  const live = epoch === pairEpoch(connectionId);
  useWatchStore.setState({ pairUntil: live ? { [connectionId]: until } : {} });
}

/** The connection's pair on its way can no longer sign the watch in: its token was ended (a
 * password change ends the account's open pairing tokens on the server), or the connection went.
 * The next book brings a new one, and the card offers set up again. One still being minted or sent
 * is forgotten too, when it lands (`pairEpoch`). */
export function forgetPair(connectionId: string): void {
  forgotten.set(connectionId, pairEpoch(connectionId) + 1);
  useWatchStore.setState((s) => {
    if (!Object.hasOwn(s.pairUntil, connectionId)) return s;
    const { [connectionId]: _gone, ...rest } = s.pairUntil;
    return { pairUntil: rest };
  });
}
