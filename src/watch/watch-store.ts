import { create } from 'zustand';

import { connectionIdOf } from '@/lib/connection-id';
import { onForeground } from '@/lib/when-active';

import { watchLink } from './link';
import { applyWatchStatus, followConnectionRemovals, hydrateLedger } from './watch-ledger';
import { NO_WATCH, type WatchStatus } from './watch-model';

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
  const { state } = status;
  const here =
    state?.signed_in && state.server_id ? connectionIdOf(state.server_id, state.user_id) : null;
  useWatchStore.setState((s) => ({
    status,
    pairUntil: here !== null && Object.hasOwn(s.pairUntil, here) ? {} : s.pairUntil,
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
  watchLink.subscribe(setStatus);
  // Paired or installed can change while the app is away, with no event reaching it.
  onForeground(() => void refreshWatch());
  // The ledger first: nothing can be sent before the first answer, so no row is laid over one not
  // read yet. An event that came meanwhile found no rows to settle.
  void hydrateLedger()
    .catch(() => {})
    .then(refreshWatch);
}

/** A pair went out. The native link has cancelled any older one still undelivered, this
 * connection's or another's, so only this one counts. */
export function notePairSent(connectionId: string, until: number): void {
  useWatchStore.setState({ pairUntil: { [connectionId]: until } });
}
