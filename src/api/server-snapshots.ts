import { getItem, setItem } from '@/lib/storage';
import { isRecord, OFFLINE_SERVERS_KEY } from '@/lib/storage-keys';
import { onConnectionRemoved, useSession } from '@/stores/session';

import { qk } from './hooks';
import { queryClient } from './provider';
import type { ServerInfo } from './types';

/**
 * Each connection's last `/server` answer, kept on the device (`OFFLINE_SERVERS_KEY`, one
 * small document by connection id) and put back in the query cache at launch: the ONE copy
 * of a server's facts for a launch that can't reach it (fe#211).
 *
 * Every capability gate reads `qk.server(cid)` (`useCapability`, `cachedCapability`,
 * `fetchCapabilities`). On a cold start with no network that query is never answered, so
 * without a kept copy every gate waits on a flag that never comes: community metadata, the
 * reader, read-along, the queue, and which path listening is recorded on
 * (`usesListeningSync`). There used to be two partial copies: one saved only for a
 * connection with a download that kept its metadata, and the listening outbox's own kept
 * `listening_sync` flag. Now:
 * - **kept** on every answer a request to `/server` gets (`watchServerAnswers`; a copy
 *   seeded into the cache is not an answer and is never written back), and on an answer
 *   read outside the cache (`keepServerAnswer`: the outbox's rollback check);
 * - **seeded** per connection at launch (`restoreServerSnapshots`, awaited by
 *   `bootstrapPlayback` before any screen): dated when it was read, so the first observer
 *   still asks the server again, and the first answer replaces it. The app then holds the
 *   flags it held when it was last online, which is what a session that goes offline
 *   holds anyway;
 * - **forgotten** with its connection (`onConnectionRemoved`), and wiped by either storage
 *   reset (`SCOPED_STORAGE_KEYS`); the identity migration re-keys it.
 *
 * A flag nobody has ever read stays unknown, and each reader decides what unknown means
 * (listening sync counts it as on, `usesListeningSync`).
 */

/** A server's `/server` answer and when it was read (epoch ms). */
export type ServerSnapshot = { info: ServerInfo; savedAt: number };

/** A stored `/server` snapshot, or undefined when it is not one. */
export function parseServerSnapshot(raw: unknown): ServerSnapshot | undefined {
  return isRecord(raw) &&
    isRecord(raw.info) &&
    isRecord(raw.info.capabilities) &&
    typeof raw.savedAt === 'number'
    ? (raw as ServerSnapshot)
    : undefined;
}

/** The kept `/server` answers, by connection id (none when unreadable). */
export async function readServerSnapshots(): Promise<Record<string, ServerSnapshot>> {
  const raw = await getItem<unknown>(OFFLINE_SERVERS_KEY);
  if (!isRecord(raw)) return {};
  const out: Record<string, ServerSnapshot> = {};
  for (const [cid, v] of Object.entries(raw)) {
    const snapshot = parseServerSnapshot(v);
    if (snapshot) out[cid] = snapshot;
  }
  return out;
}

/** Writes of the kept answers, one after another (each reads what the last wrote). */
let snapshotWrites: Promise<void> = Promise.resolve();

/** Change the kept document (`change` says whether it did); resolves whether it was
 * written. A failed write resolves false: it must not fail the ones after it, nor reject
 * into a `void` caller. */
function updateSnapshots(
  change: (all: Record<string, ServerSnapshot>) => boolean,
): Promise<boolean> {
  const run = snapshotWrites
    .then(async () => {
      const all = await readServerSnapshots();
      if (!change(all)) return false;
      await setItem(OFFLINE_SERVERS_KEY, all);
      return true;
    })
    .catch(() => false);
  snapshotWrites = run.then(() => undefined);
  return run;
}

/** Each connection's answer as last written or read here, as JSON: an answer that says
 * what the kept one says is not written again (a server's facts rarely change, and it is
 * asked every few minutes). */
const lastKept = new Map<string, string>();

/** Keep `snapshot` as the connection's answer, unless one read later is kept already. */
export async function saveServerSnapshot(
  connectionId: string,
  snapshot: ServerSnapshot,
): Promise<void> {
  const json = JSON.stringify(snapshot.info);
  if (lastKept.get(connectionId) === json) return;
  const wrote = await updateSnapshots((all) => {
    if ((all[connectionId]?.savedAt ?? -Infinity) > snapshot.savedAt) return false;
    all[connectionId] = snapshot;
    return true;
  });
  if (wrote) lastKept.set(connectionId, json);
}

/** Forget a removed connection's kept answer. */
export async function forgetServerSnapshot(connectionId: string): Promise<void> {
  lastKept.delete(connectionId);
  await updateSnapshots((all) => {
    if (!(connectionId in all)) return false;
    delete all[connectionId];
    return true;
  });
}

/**
 * Put a kept answer in the cache as the connection's `/server`, unless the cache holds one
 * read no earlier (an answer from the server always wins; on the web the startup cache may
 * have restored an older visit's first). Dated `savedAt`, so it is stale on the usual
 * schedule and the first observer asks the server again; kept for the session
 * (`gcTime: Infinity`, as `serverInfoQuery` keeps a fetched one: unwatched, a seeded
 * entry would otherwise be dropped after five minutes).
 */
export function seedServerSnapshot(connectionId: string, snapshot: ServerSnapshot): void {
  const key = qk.server(connectionId);
  queryClient.setQueryDefaults(key, { gcTime: Infinity });
  const state = queryClient.getQueryState<ServerInfo>(key);
  if (state?.data !== undefined && state.dataUpdatedAt >= snapshot.savedAt) return;
  queryClient.setQueryData(key, snapshot.info, { updatedAt: snapshot.savedAt });
}

/** Whether a query key is a signed-in connection's `/server` (`qk.server(cid)`); its
 * connection id, else null. The key is also built for a connection that is not one yet. */
function connectionOfServerKey(key: readonly unknown[]): string | null {
  const [kind, cid] = key;
  if (kind !== qk.server('')[0] || typeof cid !== 'string' || key.length !== 2) return null;
  return useSession.getState().connections.some((c) => c.id === cid) ? cid : null;
}

let watching = false;

/**
 * Keep every `/server` answer the query cache gets from a request (a seeded copy, a
 * `setQueryData`, is `manual` and is no answer). Started at launch
 * (`restoreServerSnapshots`), not at import: the query client may not exist yet then (an
 * import cycle through the provider).
 */
export function watchServerAnswers(): void {
  if (watching) return;
  const cache = (queryClient as Partial<typeof queryClient> | undefined)?.getQueryCache?.();
  if (!cache) return; // a test's stand-in client: nothing to follow
  watching = true;
  cache.subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success' || e.action.manual) return;
    const cid = connectionOfServerKey(e.query.queryKey);
    const { data, dataUpdatedAt } = e.query.state;
    if (!cid || !parseServerSnapshot({ info: data, savedAt: dataUpdatedAt })) return;
    void saveServerSnapshot(cid, { info: data as ServerInfo, savedAt: dataUpdatedAt });
  });
}

/**
 * An answer to `/server` read outside the query cache (the listening outbox asking the
 * server itself whether it still takes events): it is the connection's answer like any
 * other, so the cache holds it from now on and it is kept.
 */
export function keepServerAnswer(connectionId: string, info: ServerInfo): void {
  const snapshot = parseServerSnapshot({ info, savedAt: Date.now() });
  if (!snapshot) {
    // Not an answer every reader can take (no flags at all): have the cache ask instead.
    void queryClient.invalidateQueries({ queryKey: qk.server(connectionId) });
    return;
  }
  queryClient.setQueryData(qk.server(connectionId), info, { updatedAt: snapshot.savedAt });
  void saveServerSnapshot(connectionId, snapshot);
}

let restored: Promise<void> | null = null;

/**
 * The launch step (`bootstrapPlayback`, once the storage migrations have run): seed every
 * kept answer into the cache and start keeping the answers that follow. One run per
 * launch; it never rejects (an unreadable document seeds nothing).
 */
export function restoreServerSnapshots(): Promise<void> {
  restored ??= (async () => {
    watchServerAnswers();
    const all = await readServerSnapshots().catch(() => ({}) as Record<string, ServerSnapshot>);
    for (const [cid, snapshot] of Object.entries(all)) {
      // What is kept need not be written again by the first answer that says the same.
      if (!lastKept.has(cid)) lastKept.set(cid, JSON.stringify(snapshot.info));
      seedServerSnapshot(cid, snapshot);
    }
  })();
  return restored;
}

// A removed connection's answer would only ever seed a cache entry nobody reads.
onConnectionRemoved((id) => void forgetServerSnapshot(id));

/** Test-only: forget what this module holds in memory (not the watcher: a cache is
 * subscribed to once). */
export function resetServerSnapshotsForTests(): void {
  lastKept.clear();
  restored = null;
  snapshotWrites = Promise.resolve();
}
