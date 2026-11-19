import { Platform } from 'react-native';

import { contentKeyOf } from './content-key';
import { randomUUID } from './random';
import { holdWebLock, queryWebLocks, whenWebLockFree } from './tab-lock';
import { withTimeout } from './with-timeout';

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
 * A hidden tab's timers are throttled (a minute apart or more), so the stamps can fall behind
 * a replay still sending, and another tab took its claims while its requests were out. So,
 * where the browser has Web Locks, a replay holds one named for its claim (`claimLockName`)
 * from before the claim is written to its settle, and a claim whose lock is held stands
 * whatever its time says (`claimLive`); the browser frees a closed tab's locks. Without them
 * (plain http, native) the time stands alone. Either way the replay's send checks its claim
 * right before each entry goes (`ClaimCheck`), stamping it again there when it is near its
 * end: an entry another replay took meanwhile is not sent twice.
 *
 * A sign-out's last send (`takeOver`) does not leave its connection's entries to another
 * tab's claim: the token is revoked after it, and the purge takes what is left. It waits for
 * a claim live by its lock (the other tab sends them, or lets them go), for a while, then
 * claims whatever is still there and sends it; and then, within the same while, for a claim
 * another tab's last send took from it meanwhile (two at once: one told of the other's).
 * Off the web the app is one process, so a claim no replay of this launch is still sending
 * (`sending`) was left by one that ended: a run killed mid-replay, or a replay whose settle
 * storage refused (or that threw). A last send there takes it as free.
 *
 * Storage that refuses a write (full): a claim that could not be written sends nothing (two
 * tabs would send the same entries), and the next replay tries again; but a sign-out's last
 * send has no next replay, so it sends them unclaimed, but for one whose claim's lock a tab
 * holds (that tab sends it). Entries sent whose removal could not
 * be written are remembered in this tab (`ReplayQueue.sent`), which never sends them again
 * and takes them out with the next replay that can write.
 */

/** A replay's mark on a queued entry: which replay, and until when it stands (ms, this
 * device's clock). */
export type QueueClaim = { id: string; until: number };

/** How often a replay still sending stamps its claims again. */
export const CLAIM_RENEW_MS = 30_000;

/** How long a claim stands from its last stamp: two renewals missed, its tab went away. */
export const CLAIM_MS = 2 * CLAIM_RENEW_MS;

/** Claim `id`, standing until `until`. */
export const newClaim = (id: string, until = Date.now() + CLAIM_MS): QueueClaim => ({ id, until });

/** The claims (ids) of this launch's replays still out, from before the claim is written to
 * the end of the settle. Off the web a last send takes any other claim as free
 * (`ReplayQueue.takeOver`): kept, its entries went with the purge unsent. */
const sending = new Set<string>();

/** A queued entry as stored: the entry, and the claim of the replay sending it, if any. */
export type Claimed<T> = T & { claim?: QueueClaim };

/** Whether a replay's claim on `entry` stands. One further ahead than any is written for
 * (the clock set back since) has run out too. */
export function claimStands(entry: { claim?: unknown }, now = Date.now()): boolean {
  const claim = entry.claim as Partial<QueueClaim> | undefined;
  const until = claim?.until;
  return typeof until === 'number' && until > now && until - now <= CLAIM_MS;
}

/** The Web Lock a tab holds while its claim `id` stands (`claimLive`): a replay's, from
 * before the claim is written to its settle; the reader's waits for their send turn. */
export const claimLockName = (id: string) => `audiosilo-claim:${id}`;

const claimIdOf = (entry: { claim?: unknown }): string | undefined => {
  const id = (entry.claim as Partial<QueueClaim> | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
};

/** The Web Locks held now (`queryWebLocks`) when `claimLive` needs them for `entries` (a
 * claim on one has run out by its time), else null: no query where the times tell. Null too
 * where no tab can tell (no Web Locks: native, plain http). */
export async function claimLocksFor(
  entries: readonly { claim?: unknown }[],
  now = Date.now(),
): Promise<ReadonlySet<string> | null> {
  return entries.some((e) => e.claim != null && !claimStands(e, now)) ? queryWebLocks() : null;
}

/** Whether the claim on `entry` stands: by its time (`claimStands`), or while its tab holds
 * its lock (`held`, from `claimLocksFor`), however far behind its stamps fell. */
export function claimLive(
  entry: { claim?: unknown },
  held: ReadonlySet<string> | null,
  now = Date.now(),
): boolean {
  if (claimStands(entry, now)) return true;
  const id = claimIdOf(entry);
  return id !== undefined && held?.has(claimLockName(id)) === true;
}

/** How long a sign-out's last send waits for another tab's live claim on its connection's
 * entries (`takeOver`) before taking them over: two requests' timeouts, the save ahead of a
 * waiting one and then its own. */
export const TAKE_OVER_WAIT_MS = 30_000;

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
  /** `read` for the check before each send (`ClaimCheck`), where `read` gives an empty queue
   * for storage it could not read: this one rejects then, so the check can tell a queue it
   * could not read from one its entry left. By default `read`. */
  readStrict?: () => Promise<Claimed<T>[]>;
  /** Store the queue (`before`: its length as read). Rejects when storage refused it. */
  write: (next: Claimed<T>[], before: number) => Promise<void>;
  /** Asked once per connection per replay, under the lock (and before it by a sign-out's
   * wait, `takeOver`). */
  route: (connectionId: string) => Route<C> | Promise<Route<C>>;
  /** Send one connection's entries in order; resolves to those to keep queued. `mine` is
   * asked right before each entry goes (`ClaimCheck`): one it says no to is kept, unsent. */
  send: (connectionId: string, client: C, entries: T[], mine: ClaimCheck<T>) => Promise<T[]>;
  /** The entries (`queuedKey`) this tab sent, or sent a later save of, whose removal storage
   * refused (the queue's own set, kept for the life of the tab): never sent again from
   * here. */
  sent: Set<string>;
  /** A sign-out's last send of the connections `route` sends: another tab's claim on their
   * entries is waited for while it is live by its lock (`TAKE_OVER_WAIT_MS` at most), then
   * taken over. Only on the web, where tabs share the queue. Off the web the app is one
   * process: a claim no replay of this launch is still sending (`sending`) is free (its replay
   * ended: killed mid-replay, or its settle not stored); one still sending stands. On every
   * platform its entries have no later replay (the connection's purge follows), so they are
   * sent even when storage refuses their claim (unclaimed: not one a tab's live lock holds,
   * which that tab sends), or would not let the send check or stamp it (`claimCheck`). */
  takeOver?: boolean;
};

/** Asked by a replay's send right before an entry goes: its stored copy while that still
 * carries this replay's claim, else null. Null once it left the queue, or once another replay
 * claimed it (the claim ran out while this tab's timers were throttled, or a sign-out took it
 * over). A claim with less than `CLAIM_RENEW_MS` left is stamped again first, under the
 * lock. */
export type ClaimCheck<T> = (entry: T) => Promise<Claimed<T> | null>;

/**
 * Replay the queue (see above): claim the entries to send, send each connection's (the
 * connections at once), then settle. Entries another tab claims are left to it (a sign-out's
 * last send waits for them, then takes them over: `takeOver`); a connection `route` drops
 * leaves the queue unsent.
 */
export async function replayQueue<T extends QueuedSave, C>(q: ReplayQueue<T, C>): Promise<void> {
  const { takeOver, ended } = lastSendOf(q);
  // One wait for the whole of a sign-out's last send, before its claim and after it.
  const waitUntil = Date.now() + TAKE_OVER_WAIT_MS;
  if (takeOver) await othersLetGo(q, waitUntil);
  // Nothing to claim (an empty queue, as after most saves, or every entry another tab's and
  // no sign-out to take them over): no lock taken. The claim below reads the queue again
  // under it.
  const queue = await q.read();
  if (takeOver ? queue.length === 0 : queue.every((s) => claimStands(s) && !ended(s))) return;
  const id = randomUUID();
  // Asked before the claim is written, so a tab that waits on it (`othersLetGo`) waits
  // behind this one. Nothing is held without Web Locks.
  const release = holdWebLock(claimLockName(id));
  sending.add(id);
  try {
    await claimSendSettle(q, id);
  } finally {
    sending.delete(id);
    release();
  }
  // Another tab's last send (its own sign-out's, or one told of this one) can have taken
  // these over from this replay while it sent, its claim asked once this one's wait had
  // looked: what it is still sending goes before this tab's token is revoked, not after.
  if (takeOver) await othersLetGo(q, waitUntil);
}

/** How a replay of `q` treats other replays' claims: `lastChance`, a sign-out's last send;
 * `takeOver`, one on the web, which waits for them and takes them over; `ended`, the claims
 * it takes as free (off the web, any no replay of this launch is still sending, `sending`:
 * `ReplayQueue.takeOver`). */
function lastSendOf<T extends QueuedSave, C>(q: ReplayQueue<T, C>) {
  const lastChance = q.takeOver === true;
  const takeOver = lastChance && Platform.OS === 'web';
  const freeOthers = lastChance && !takeOver;
  return {
    lastChance,
    takeOver,
    ended: (stored: { claim?: unknown }) => {
      if (!freeOthers) return false;
      const claim = claimIdOf(stored);
      return claim === undefined || !sending.has(claim);
    },
  };
}

async function claimSendSettle<T extends QueuedSave, C>(
  q: ReplayQueue<T, C>,
  id: string,
): Promise<void> {
  const { lastChance, takeOver, ended } = lastSendOf(q);
  // Whether the claims were stored: a last send whose claim storage refused sends unclaimed.
  let stamped = true;
  // Each taken entry as stored when it was taken (`queuedKey`), its claim then included.
  const takenFrom = new Map<string, Claimed<T>>();
  const groups = await q.lock(async () => {
    const queue = await q.read();
    const now = Date.now();
    const held = await claimLocksFor(queue, now);
    const routeOf = cachedRoute(q);
    const taken = new Map<string, { client: C; entries: T[] }>();
    const next: Claimed<T>[] = [];
    const removed: string[] = [];
    for (const stored of queue) {
      const stands = !ended(stored) && claimLive(stored, held, now);
      if (stands && !takeOver) {
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
      const route = await routeOf(cid);
      if (route === 'drop' && !stands) continue;
      // Kept, and another tab's claim taken over only for a connection this replay sends.
      if (route === 'drop' || route === 'keep') {
        next.push(stored);
        continue;
      }
      const group = taken.get(cid) ?? { client: route.send, entries: [] };
      group.entries.push(entry);
      taken.set(cid, group);
      takenFrom.set(keyOf(entry), stored);
      next.push({ ...entry, claim: newClaim(id, now + CLAIM_MS) });
    }
    if (taken.size > 0 || next.length !== queue.length) {
      try {
        await q.write(next, queue.length);
      } catch {
        // The claim is not stored, so another tab would send these too: nothing is sent, the
        // next replay tries again. A sign-out's last send has none (the purge follows): sent
        // unclaimed. Not one whose claim's lock a tab holds (a replay sending it, a save
        // waiting for its turn): with no claim stored to tell it, that tab sends it too, and a
        // bookmark has no idempotency key. One standing by its time alone (no Web Locks) goes:
        // its tab may be gone.
        if (!lastChance) return new Map<string, { client: C; entries: T[] }>();
        stamped = false;
        const locks = await queryWebLocks();
        if (!locks) return taken;
        for (const [cid, group] of taken) {
          group.entries = group.entries.filter((e) => {
            const other = claimIdOf(takenFrom.get(keyOf(e)) ?? {});
            return other === undefined || !locks.has(claimLockName(other));
          });
          if (group.entries.length === 0) taken.delete(cid);
        }
        return taken;
      }
    }
    for (const key of removed) q.sent.delete(key);
    return taken;
  });
  if (groups.size === 0) return;
  // Still sending: the claims are stamped again, so they stand only while this tab lives.
  const renewing = stamped
    ? setInterval(() => void renewClaims(q, id).catch(() => undefined), CLAIM_RENEW_MS)
    : undefined;
  // Unclaimed (storage refused the claim): no claim to check, every entry goes, as stored
  // when it was taken (a send that checks its stored copy's claim, the bookmarks', finds the
  // one it carries still: not a claim of this replay's that never was stored).
  const mine: ClaimCheck<T> = stamped
    ? claimCheck(q, id, lastChance)
    : async (entry) => takenFrom.get(keyOf(entry)) ?? entry;
  const settled = new Set<string>();
  try {
    await Promise.all(
      [...groups].map(async ([cid, { client, entries }]) => {
        const kept = new Set(await q.send(cid, client, entries, mine).catch(() => entries));
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
        const ours = stored.claim?.id === id;
        // Sent unclaimed: settled by its key, whatever claim it carries.
        if ((ours || !stamped) && settled.has(keyOf(stored))) continue;
        next.push(ours ? unclaimed(stored) : stored);
      }
      await q.write(next, queue.length);
    });
  } catch {
    // The sent entries are still queued (their claim runs out): not sent again from here.
    // The rest keep the claim for its time, unsent (a last send off the web takes it).
    for (const key of settled) q.sent.add(key);
  }
}

/** Replay `id`'s check before each send (`ClaimCheck`). The stored copy is read with no lock
 * while its claim has `CLAIM_RENEW_MS` left: no other replay takes it before then, and that
 * is longer than a request's timeout. A queue that could not be read sends nothing: the entry
 * is kept for the next replay, and loses nothing. Not in a sign-out's last send
 * (`lastChance`, `ReplayQueue.takeOver` on any platform): kept there, the entry went with
 * the connection's purge unsent, so it is sent as this replay claimed it, and so is one
 * whose claim ran out while storage refused its stamp. */
function claimCheck<T extends QueuedSave, C>(
  q: ReplayQueue<T, C>,
  id: string,
  lastChance: boolean,
): ClaimCheck<T> {
  return async (entry) => {
    const key = keyOf(entry);
    let queue: Claimed<T>[];
    try {
      queue = await (q.readStrict ?? q.read)();
    } catch {
      return lastChance ? { ...entry, claim: newClaim(id) } : null;
    }
    const seen = queue.find((s) => s.claim?.id === id && keyOf(s) === key);
    if (!seen) return null;
    if (claimStands(seen) && seen.claim!.until - Date.now() >= CLAIM_RENEW_MS) return seen;
    try {
      return (await renewClaims(q, id, key)) ? seen : null;
    } catch {
      // Storage refused the stamp: still this replay's while the claim it has stands.
      return lastChance || claimStands(seen) ? seen : null;
    }
  };
}

/** Stamp the claims of replay `id` again (`CLAIM_RENEW_MS`), under the queue's lock. Whether
 * the entry `key` (when given) still carries the claim. */
function renewClaims<T extends QueuedSave, C>(
  q: ReplayQueue<T, C>,
  id: string,
  key?: string,
): Promise<boolean> {
  return q.lock(async () => {
    const queue = await q.read();
    const mine = (stored: Claimed<T>) => stored.claim?.id === id;
    if (!queue.some(mine)) return false;
    const until = Date.now() + CLAIM_MS;
    await q.write(
      queue.map((stored) => (mine(stored) ? { ...stored, claim: newClaim(id, until) } : stored)),
      queue.length,
    );
    return key === undefined || queue.some((stored) => mine(stored) && keyOf(stored) === key);
  });
}

/**
 * Before a sign-out's last send takes its connection's entries over (`takeOver`): the claims
 * other replays hold on them while they are live by their lock (a tab sending them, or a
 * save waiting for its send turn there) are waited for, until `waitUntil` at most. What
 * they send leaves the queue; what is still claimed then is taken over. A claim standing by
 * its time alone (no Web Locks, or its tab gone) is not waited for.
 */
async function othersLetGo<T extends QueuedSave, C>(
  q: ReplayQueue<T, C>,
  waitUntil: number,
): Promise<void> {
  const left = waitUntil - Date.now();
  if (left <= 0) return;
  const held = await queryWebLocks();
  if (!held || held.size === 0) return;
  const routeOf = cachedRoute(q);
  const names = new Set<string>();
  for (const stored of await q.read()) {
    const id = claimIdOf(stored);
    if (id === undefined || !held.has(claimLockName(id))) continue;
    if (typeof (await routeOf(stored.connectionId)) === 'object') names.add(claimLockName(id));
  }
  if (names.size === 0) return;
  await withTimeout(Promise.all([...names].map(whenWebLockFree)), left, 'claims still live').catch(
    () => undefined,
  );
}

/** `q.route`, asked once per connection over the returned function's life (one replay's
 * claim, a sign-out's wait). */
function cachedRoute<C>(
  q: Pick<ReplayQueue<QueuedSave, C>, 'route'>,
): (cid: string) => Promise<Route<C>> {
  const routes = new Map<string, Promise<Route<C>>>();
  return (cid) => {
    let route = routes.get(cid);
    if (!route) routes.set(cid, (route = Promise.resolve(q.route(cid))));
    return route;
  };
}
