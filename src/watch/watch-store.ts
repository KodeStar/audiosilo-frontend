import { create } from 'zustand';

import { onForeground } from '@/lib/when-active';

import { watchLink } from './link';
import { NO_WATCH, type WatchStatus } from './watch-model';

type WatchStore = {
  status: WatchStatus;
  /** When the `pair` last sent for a connection runs out, epoch ms, by connection id. Kept for
   * this run only: the watch's own `watch-state` is what says it arrived. */
  pairUntil: Record<string, number>;
};

/** The watch as this phone knows it, one per app (every book row reads it). */
export const useWatchStore = create<WatchStore>(() => ({ status: NO_WATCH, pairUntil: {} }));

/** Read the watch's status afresh. It is what the session kept after a cold start, waiting for
 * activation if need be. Best effort: the last answer stands. */
export async function refreshWatch(): Promise<void> {
  try {
    const status = await watchLink.read();
    useWatchStore.setState({ status });
  } catch {
    // The session did not answer: no change to what is shown.
  }
}

let started = false;

/** Follow the watch (one call does it, the first screen that asks). */
export function startWatchLink(): void {
  if (started) return;
  started = true;
  watchLink.subscribe((status) => useWatchStore.setState({ status }));
  // Paired or installed can change while the app is away, with no event reaching it.
  onForeground(() => void refreshWatch());
  void refreshWatch();
}

export function notePairSent(connectionId: string, until: number): void {
  useWatchStore.setState((s) => ({ pairUntil: { ...s.pairUntil, [connectionId]: until } }));
}
