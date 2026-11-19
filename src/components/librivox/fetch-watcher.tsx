import { hashKey, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';

import { ApiError, isNotInLibraryError } from '@/api/client';
import { invalidateLibraryLists, qk, useLibrivoxJob, useServerInfo } from '@/api/hooks';
import type { BridgeJob, ServerInfo } from '@/api/types';
import { isAway } from '@/lib/app-activity';
import { BRIDGE_IDLE_POLL_MS, isOpenJob } from '@/lib/bridge-jobs';
import { getItem, setItem } from '@/lib/storage';
import { isRecord, LIBRIVOX_WATCHES_KEY } from '@/lib/storage-keys';
import { sessionHydrateFailed, useSession } from '@/stores/session';

import { DONE_RECHECK_MS } from './librivox-model';

/**
 * The `librivox.fetch` jobs Find on LibriVox follows, watched past the page (fe#293): a
 * fetch added (or seen open) and then left, the page closed or the work folded, still ends
 * with the Library read again, as if the page were open. Saved on the device
 * (`LIBRIVOX_WATCHES_KEY`), so a fetch still on its way when the app closed is followed again
 * at the next launch (fe#299).
 *
 * `LibrivoxFetchWatcher` (a root listener) is the ONE poller of each followed job
 * (`useLibrivoxJob`, active: its rules, polled while the app is in the foreground, slower
 * with no page showing it and while its reads fail); a recording row reads the same query
 * without polling (`useFollowedFetch`). A job that ends asks the connection's works again,
 * and a done one reads the library's lists again and asks the works once more a moment
 * later (`librivoxFetchEnded`); then it is watched no more, as it is once gone (a 404) or
 * refused by the server (its own 400 or 403; a 401 or 403 from a proxy in front of it,
 * `ApiError.fromProxy`, is a read that failed: the watch is kept and the poll asks again,
 * backing off). A connection signed out (gone, or needing its sign-in again after
 * a 401) holds the watch, unread, and reads it again once signed in: a fetch that ended
 * meanwhile is handled then. One whose connection never comes back is let go `WATCH_TTL_MS`
 * after it was first watched; a signed-in connection's watch is kept however old (a fetch
 * parked for longer than that is still followed, also by the next launch). The read keeps
 * its `bridge` gate (true only while the Bridge is online): a lapsed heartbeat pauses it,
 * the watch kept, and the watcher asks `/server` again every `BRIDGE_IDLE_POLL_MS` in the
 * foreground until the Bridge is back. A Bridge `/server` still finds away `WATCH_TTL_MS`
 * after it was first found away (`awaySince`, saved with the watch) is taken as gone for
 * good too: the watch is dropped, and with the connection's last one the asking stops. Find
 * on LibriVox follows the fetch again if its row reads it open once the Bridge is back.
 */
type Watch = {
  cid: string;
  id: number;
  /** When it was first watched (ms). */
  at: number;
  /** When `/server` first answered with the Bridge away (ms, its `dataUpdatedAt`), since it
   * was last online. */
  awaySince?: number;
};

/** How long a watch is kept with its connection signed out, or its Bridge away: a fetch
 * ends in hours at most, and a connection or a Bridge not back by then is taken as gone for
 * good. */
export const WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const useLibrivoxWatches = create<{ watches: Watch[] }>(() => ({ watches: [] }));

const same = (a: Pick<Watch, 'cid' | 'id'>, b: Pick<Watch, 'cid' | 'id'>) =>
  a.cid === b.cid && a.id === b.id;

/** Follow `id` on `cid` until it ends (once: watching it again changes nothing). */
export function watchLibrivoxFetch(cid: string, id: number) {
  const w = { cid, id };
  useLibrivoxWatches.setState((s) =>
    s.watches.some((x) => same(x, w)) ? s : { watches: [...s.watches, { ...w, at: Date.now() }] },
  );
}

function dropWatch(w: Pick<Watch, 'cid' | 'id'>) {
  useLibrivoxWatches.setState((s) => ({ watches: s.watches.filter((x) => !same(x, w)) }));
}

/** Record when `w`'s Bridge was first found away (undefined: online again). */
function setAwaySince(w: Pick<Watch, 'cid' | 'id'>, awaySince: number | undefined) {
  useLibrivoxWatches.setState((s) => ({
    watches: s.watches.map((x) => (same(x, w) ? { ...x, awaySince } : x)),
  }));
}

/** The saved watches (the well formed ones; an `awaySince` that is not a number left out).
 * None is judged by its age here: only a signed-out connection's watch, or one whose Bridge
 * is away, runs out (`WATCH_TTL_MS`), and both are known only once the session has read its
 * connections and `/server` has answered (`WatchedFetch`). */
function savedWatches(raw: unknown): Watch[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w: unknown): Watch[] => {
    if (!isRecord(w)) return [];
    const { cid, id, at, awaySince } = w;
    if (typeof cid !== 'string' || typeof id !== 'number' || typeof at !== 'number') return [];
    return [typeof awaySince === 'number' ? { cid, id, at, awaySince } : { cid, id, at }];
  });
}

let restoring: Promise<void> | null = null;
let stopSaving: (() => void) | null = null;

/** Read the saved watches once (the watcher's first mount), behind any watched since, then
 * save the list at every change. */
export function restoreLibrivoxWatches(): Promise<void> {
  restoring ??= (async () => {
    const saved = savedWatches(await getItem<unknown>(LIBRIVOX_WATCHES_KEY));
    stopSaving = useLibrivoxWatches.subscribe((s, prev) => {
      if (s.watches !== prev.watches) void setItem(LIBRIVOX_WATCHES_KEY, s.watches);
    });
    // A new list, so the merge is saved too (anything not a watch left out).
    useLibrivoxWatches.setState((s) => ({
      watches: [...saved.filter((w) => !s.watches.some((x) => same(x, w))), ...s.watches],
    }));
  })();
  return restoring;
}

/** Tests: forget that the saved watches were read, and stop saving them (a new launch). */
export function resetLibrivoxWatchesForTests() {
  stopSaving?.();
  stopSaving = null;
  restoring = null;
}

/**
 * A followed fetch's read (`useLibrivoxJob`), as the watcher and a recording row both take
 * it: `gone` (a 404, deleted with its library: the last answer no longer stands), `refused`
 * (the server's own 400 or 403, `isNotInLibraryError`: asking again can't help, so nothing
 * follows it any more, and its last answer no longer stands either; a proxy's 401 or 403 is
 * a read that failed, not this), its `job` (none once gone or refused) and whether it `ended`
 * (gone, or no longer open).
 */
export function followedRead(read: { data?: BridgeJob; error: unknown }) {
  const gone = read.error instanceof ApiError && read.error.status === 404;
  const refused = !gone && isNotInLibraryError(read.error);
  const job = gone || refused ? undefined : read.data;
  return { gone, refused, job, ended: gone || (!!job && !isOpenJob(job)) };
}

/**
 * After a followed fetch ended: the connection's works are asked again (a done one moves the
 * recording into the library, a failed one offers Add again); a done one (`doneIn`, its
 * library) also has the library's lists and the recently added read again, and the works
 * asked once more after `DONE_RECHECK_MS` (the server records the book just after the job
 * ends). The timer is the module's, so it fires whatever is mounted by then.
 */
function librivoxFetchEnded(qc: QueryClient, cid: string, doneIn: number | null) {
  const ask = () => void qc.invalidateQueries({ queryKey: qk.librivoxWorks(cid) });
  ask();
  if (doneIn === null) return;
  invalidateLibraryLists(qc, cid, doneIn);
  setTimeout(ask, DONE_RECHECK_MS);
}

/** Every followed fetch, each read by its own `WatchedFetch`, and each of their signed-in
 * connections' `/server` asked again while its Bridge is away (`BridgeAwayWaker`). Renders
 * nothing. */
export function LibrivoxFetchWatcher() {
  const watches = useLibrivoxWatches((s) => s.watches);
  const signedIn = useSession((s) => s.connections);
  useEffect(() => void restoreLibrivoxWatches().catch(() => {}), []);
  const cids = [...new Set(watches.map((w) => w.cid))].filter((cid) =>
    signedIn.some((c) => c.id === cid && !c.needsReconnect),
  );
  return (
    <>
      {watches.map((w) => (
        <WatchedFetch key={`${w.cid}:${w.id}`} {...w} />
      ))}
      {cids.map((cid) => (
        <BridgeAwayWaker key={cid} cid={cid} />
      ))}
    </>
  );
}

/** Whether anyone but the watcher reads the job (a recording row on screen), followed as
 * readers come and go: the watcher renders again then, so its poll takes the pace for it
 * (`librivoxJobPollInterval`'s `seen`) at once, not at its next answer. */
function useReadElsewhere(qc: QueryClient, queryKey: readonly unknown[]): boolean {
  const hash = hashKey(queryKey);
  const subscribe = useCallback(
    (onChange: () => void) =>
      qc.getQueryCache().subscribe((e) => {
        if (e.query.queryHash !== hash) return;
        if (e.type === 'observerAdded' || e.type === 'observerRemoved') onChange();
      }),
    [qc, hash],
  );
  const read = () => (qc.getQueryCache().get(hash)?.getObserversCount() ?? 0) > 1;
  return useSyncExternalStore(subscribe, read, read);
}

function WatchedFetch({ cid, id, at, awaySince }: Watch) {
  const qc = useQueryClient();
  const conn = useSession((s) => s.connections.find((c) => c.id === cid));
  // Signed in, and not waiting for its sign-in again (a 401): only then asked. Never for a
  // connection that is gone (its client is too).
  const reading = !!conn && !conn.needsReconnect;
  useReadElsewhere(qc, qk.bridgeJob(cid, id));
  const read = useLibrivoxJob(reading ? id : undefined, true, cid);
  // Judged only once `/server` has answered: until then the hooks' gate lays that read's own
  // failure over the job's (`useCapabilityQuery`), so a 403 or 404 for `/server` at launch
  // would read as the job refused or gone.
  const info = useServerInfo(cid);
  const own = info.data !== undefined ? read : { data: read.data, error: null };
  // When `/server` last answered, and whether that answer found the Bridge away (0: no
  // answer yet, nothing judged).
  const answeredAt = reading && info.data !== undefined ? info.dataUpdatedAt : 0;
  const bridgeAway = isBridgeAway(info.data);
  // `refused`: the server's own 400 or 403, asking again can't help, by the poll's own rule
  // (`useLibrivoxJob`), which stops too. A proxy's 401 or 403 is a read that failed: the poll
  // asks again. A 404 is `gone`: an end, not a refusal. The server's 401 holds the watch
  // until the connection is signed in again (`reading`).
  const { refused, job, ended } = followedRead(own);
  const doneIn = job?.state === 'done' ? job.library_id : null;
  const signedIn = !!conn;
  // Who is signed in is known only once the session has read its connections.
  const sessionRead = useSession((s) => s.status !== 'loading');

  useEffect(() => {
    // Signed out for longer than any fetch takes: gone for good. Never judged from a list
    // that is not the real one (still loading, or a read that failed and is tried again).
    const expired =
      sessionRead && !sessionHydrateFailed() && !signedIn && Date.now() - at >= WATCH_TTL_MS;
    if (expired || refused) return dropWatch({ cid, id });
    if (!reading || !ended) return;
    librivoxFetchEnded(qc, cid, doneIn);
    dropWatch({ cid, id });
  }, [sessionRead, signedIn, at, refused, reading, ended, doneIn, qc, cid, id]);

  useEffect(() => {
    if (!answeredAt) return;
    if (!bridgeAway) {
      if (awaySince !== undefined) setAwaySince({ cid, id }, undefined);
      return;
    }
    // Never from before the watch: an answer kept from then says nothing of how long since.
    if (awaySince === undefined) return setAwaySince({ cid, id }, Math.max(answeredAt, at));
    // Away for longer than any fetch takes, by `/server`'s own answers: gone for good.
    if (answeredAt - awaySince >= WATCH_TTL_MS) dropWatch({ cid, id });
  }, [answeredAt, bridgeAway, awaySince, at, cid, id]);

  return null;
}

/** Whether a `/server` answer finds the Bridge away (its `bridge` flag not true): the ONE
 * reading for the waker's asking and a watch's `awaySince`. */
function isBridgeAway(info: ServerInfo | undefined): boolean {
  return info?.capabilities?.bridge !== true;
}

/** A watched connection whose Bridge is away (`/server`'s `bridge` flag not true): its reads
 * are paused by their gate, and nothing else may read `/server` again while no page is open,
 * so it is asked every `BRIDGE_IDLE_POLL_MS` with the app in the foreground until it is back,
 * or until its watches are dropped for a Bridge away too long (`WATCH_TTL_MS`). */
function BridgeAwayWaker({ cid }: { cid: string }) {
  const info = useServerInfo(cid);
  useServerAskedWhileAway(isBridgeAway(info.data), info.refetch);
  return null;
}

/** While the Bridge is `away`, `/server` is read again (`refetch`) every
 * `BRIDGE_IDLE_POLL_MS` with the app in the foreground: its answer is fresh for minutes and
 * nothing else reads it again meanwhile. The watcher's and Find on LibriVox's one rule. */
export function useServerAskedWhileAway(away: boolean, refetch: () => unknown) {
  useEffect(() => {
    if (!away) return;
    const timer = setInterval(() => {
      if (!isAway()) void refetch();
    }, BRIDGE_IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [away, refetch]);
}
