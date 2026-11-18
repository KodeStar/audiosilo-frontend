import { contentKeyOf } from './content-key';
import { randomUUID } from './random';

/**
 * A stored offline queue replayed by every tab of the web player (the legacy progress
 * queue, the reader's queue), without holding the queue's cross-tab lock (`tabLock`) over
 * the network: on plain http that lock is a lease that runs out after a few seconds, and a
 * replay can take longer than that (one request after another, each with its timeout).
 *
 * So a replay claims what it sends, under the lock and touching only storage: each entry it
 * takes is marked with its claim (`QueueClaim`) and stays in the queue; another tab's replay
 * leaves a live claim alone. The requests go out with no lock held, the claims stamped again
 * every `CLAIM_RENEW_MS` while they do. Then, under the lock again, the entries the replay
 * settled leave the queue and the rest lose the claim, ready for the next replay. An entry
 * replaced meanwhile (the latest save per book wins) is no longer there to settle; a claim
 * whose tab went away (closed, crashed) is not renewed and runs out (`CLAIM_MS`), and its
 * entries are replayed again: a save sent twice is the same save.
 *
 * Storage that refuses a write (full): a claim that could not be written sends nothing (two
 * tabs would send the same entries), and the next replay tries again; entries sent whose
 * removal could not be written are remembered in this tab (`ReplayQueue.sent`), which never
 * sends them again and takes them out with the next replay that can write.
 */

/** A replay's mark on a queued entry: which replay, and until when it stands (ms, this
 * device's clock). */
export type QueueClaim = { id: string; until: number };

/** A queued entry as stored: the entry, and the claim of the replay sending it, if any. */
export type Claimed<T> = T & { claim?: QueueClaim };

/** How often a replay still sending stamps its claims again. */
export const CLAIM_RENEW_MS = 30_000;

/** How long a claim stands from its last stamp: two renewals missed, its tab went away. */
export const CLAIM_MS = 2 * CLAIM_RENEW_MS;

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

/** A queued save: its book, and when it was made. */
export type QueuedSave = {
  connectionId: string;
  libraryId: number;
  path: string;
  updated_at: string;
};

/** One entry per book in the queue: its book's key, and when it was made. */
export const queuedKey = (s: QueuedSave) => `${contentKeyOf(s)}|${s.updated_at}`;
const keyOf = queuedKey;

export type ReplayQueue<T extends QueuedSave, C> = {
  /** The queue's cross-tab lock (`tabLock`): storage reads and writes only. */
  lock: <R>(job: () => Promise<R>) => Promise<R>;
  read: () => Promise<Claimed<T>[]>;
  /** Store the queue (`before`: its length as read). Rejects when storage refused it. */
  write: (next: Claimed<T>[], before: number) => Promise<void>;
  route: (connectionId: string) => Route<C>;
  /** Send one connection's entries in order; resolves to those to keep queued. */
  send: (connectionId: string, client: C, entries: T[]) => Promise<T[]>;
  /** The entries (`queuedKey`) this tab sent, or sent a later save of, whose removal storage
   * refused (the queue's own set, kept for the life of the tab): never sent again from
   * here. */
  sent: Set<string>;
};

/**
 * Replay the queue (see above): claim the entries to send, send each connection's (the
 * connections at once), then settle. Entries another tab claims are left to it; a
 * connection `route` drops leaves the queue unsent.
 */
export async function replayQueue<T extends QueuedSave, C>(q: ReplayQueue<T, C>): Promise<void> {
  // Nothing to claim (an empty queue, as after most saves, or every entry another tab's):
  // no lock taken. The claim below reads the queue again under it.
  if (!(await q.read()).some((stored) => !claimStands(stored))) return;
  const id = randomUUID();
  const groups = await q.lock(async () => {
    const queue = await q.read();
    const now = Date.now();
    const routes = new Map<string, Route<C>>();
    const taken = new Map<string, { client: C; entries: T[] }>();
    const next: Claimed<T>[] = [];
    const removed: string[] = [];
    for (const stored of queue) {
      if (claimStands(stored, now)) {
        next.push(stored);
        continue;
      }
      const entry = unclaimed(stored);
      // Sent from here already, its removal refused: taken out now, never sent again.
      if (q.sent.has(keyOf(entry))) {
        removed.push(keyOf(entry));
        continue;
      }
      const cid = entry.connectionId;
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
    if (taken.size > 0 || next.length !== queue.length) {
      try {
        await q.write(next, queue.length);
      } catch {
        // The claim is not stored, so another tab would send these too: nothing is sent.
        return new Map<string, { client: C; entries: T[] }>();
      }
    }
    for (const key of removed) q.sent.delete(key);
    return taken;
  });
  if (groups.size === 0) return;
  // Still sending: the claims are stamped again, so they stand only while this tab lives.
  const renewing = setInterval(
    () => void renewClaims(q, id).catch(() => undefined),
    CLAIM_RENEW_MS,
  );
  const settled = new Set<string>();
  try {
    await Promise.all(
      [...groups].map(async ([cid, { client, entries }]) => {
        const kept = new Set(await q.send(cid, client, entries).catch(() => entries));
        for (const entry of entries) if (!kept.has(entry)) settled.add(keyOf(entry));
      }),
    );
  } finally {
    clearInterval(renewing);
  }
  try {
    await q.lock(async () => {
      const queue = await q.read();
      const next: Claimed<T>[] = [];
      for (const stored of queue) {
        if (stored.claim?.id !== id) next.push(stored);
        else if (!settled.has(keyOf(stored))) next.push(unclaimed(stored));
      }
      await q.write(next, queue.length);
    });
  } catch {
    // The sent entries are still queued (their claim runs out): not sent again from here.
    for (const key of settled) q.sent.add(key);
  }
}

/** Stamp the claims of replay `id` again (`CLAIM_RENEW_MS`), under the queue's lock. */
function renewClaims<T extends QueuedSave, C>(q: ReplayQueue<T, C>, id: string): Promise<void> {
  return q.lock(async () => {
    const queue = await q.read();
    if (!queue.some((stored) => stored.claim?.id === id)) return;
    const until = Date.now() + CLAIM_MS;
    await q.write(
      queue.map((stored) =>
        stored.claim?.id === id ? { ...stored, claim: { id, until } } : stored,
      ),
      queue.length,
    );
  });
}
