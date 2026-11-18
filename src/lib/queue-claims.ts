import { randomUUID } from './random';

/**
 * A stored offline queue replayed by every tab of the web player (the legacy progress
 * queue, the reader's queue), without holding the queue's cross-tab lock (`tabLock`) over
 * the network: on plain http that lock is a lease that runs out after a few seconds, and a
 * replay can take longer than that (one request after another, each with its timeout).
 *
 * So a replay claims what it sends, under the lock and touching only storage: each entry it
 * takes is marked with its claim (`QueueClaim`) and stays in the queue; another tab's replay
 * leaves a live claim alone. The requests go out with no lock held. Then, under the lock
 * again, the entries the replay settled leave the queue and the rest lose the claim, ready
 * for the next replay. An entry replaced meanwhile (the latest save per book wins) is no
 * longer there to settle; a claim whose tab went away (closed, crashed) runs out
 * (`CLAIM_MS`), and its entries are replayed again: a save sent twice is the same save.
 */

/** A replay's mark on a queued entry: which replay, and until when it stands (ms, this
 * device's clock). */
export type QueueClaim = { id: string; until: number };

/** A queued entry as stored: the entry, and the claim of the replay sending it, if any. */
export type Claimed<T> = T & { claim?: QueueClaim };

/** How long a claim stands: past a replay of many entries, each with its own timeout. */
export const CLAIM_MS = 120_000;

/** Whether a replay's claim on `entry` stands. One further ahead than any is written for
 * (the clock set back since) has run out too. */
export function claimStands(entry: { claim?: unknown }, now = Date.now()): boolean {
  const claim = entry.claim as Partial<QueueClaim> | undefined;
  const until = claim?.until;
  return typeof until === 'number' && until > now && until - now <= CLAIM_MS;
}

/** `entry` with no claim. */
export function unclaimed<T extends object>(entry: Claimed<T>): T {
  if (!('claim' in entry)) return entry;
  const { claim: _claim, ...rest } = entry;
  return rest as T;
}

/** What a replay does with a connection's entries: send them through its client, keep them
 * queued, or drop them (the connection is gone). */
export type Route<C> = { send: C } | 'keep' | 'drop';

export type ReplayQueue<T extends object, C> = {
  /** The queue's cross-tab lock (`tabLock`): storage reads and writes only. */
  lock: <R>(job: () => Promise<R>) => Promise<R>;
  read: () => Promise<Claimed<T>[]>;
  /** Store the queue (`before`: its length as read). */
  write: (next: Claimed<T>[], before: number) => Promise<void>;
  connectionOf: (entry: T) => string;
  /** One entry per book in the queue: its book's key, and when it was made. */
  keyOf: (entry: T) => string;
  route: (connectionId: string) => Route<C>;
  /** Send one connection's entries in order; resolves to those to keep queued. */
  send: (connectionId: string, client: C, entries: T[]) => Promise<T[]>;
};

/**
 * Replay the queue (see above): claim the entries to send, send each connection's (the
 * connections at once), then settle. Entries another tab claims are left to it; a
 * connection `route` drops leaves the queue unsent.
 */
export async function replayQueue<T extends object, C>(q: ReplayQueue<T, C>): Promise<void> {
  const id = randomUUID();
  const groups = await q.lock(async () => {
    const queue = await q.read();
    const now = Date.now();
    const routes = new Map<string, Route<C>>();
    const taken = new Map<string, { client: C; entries: T[] }>();
    const next: Claimed<T>[] = [];
    for (const stored of queue) {
      if (claimStands(stored, now)) {
        next.push(stored);
        continue;
      }
      const entry = unclaimed(stored);
      const cid = q.connectionOf(entry);
      let route = routes.get(cid);
      if (!route) routes.set(cid, (route = q.route(cid)));
      if (route === 'drop') continue;
      if (route === 'keep') {
        next.push(stored);
        continue;
      }
      const group = taken.get(cid) ?? { client: route.send, entries: [] };
      group.entries.push(entry);
      taken.set(cid, group);
      next.push({ ...entry, claim: { id, until: now + CLAIM_MS } });
    }
    if (taken.size > 0 || next.length !== queue.length) await q.write(next, queue.length);
    return taken;
  });
  if (groups.size === 0) return;
  const settled = new Set<string>();
  await Promise.all(
    [...groups].map(async ([cid, { client, entries }]) => {
      const kept = new Set(await q.send(cid, client, entries).catch(() => entries));
      for (const entry of entries) if (!kept.has(entry)) settled.add(q.keyOf(entry));
    }),
  );
  await q.lock(async () => {
    const queue = await q.read();
    const next: Claimed<T>[] = [];
    for (const stored of queue) {
      if ((stored.claim as Partial<QueueClaim> | undefined)?.id !== id) next.push(stored);
      else if (!settled.has(q.keyOf(stored))) next.push(unclaimed(stored));
    }
    await q.write(next, queue.length);
  });
}
