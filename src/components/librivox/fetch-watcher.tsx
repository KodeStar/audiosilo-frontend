import { hashKey, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';

import { ApiError, isNotInLibraryError } from '@/api/client';
import { invalidateLibraryLists, qk, useLibrivoxJob, useServerInfo } from '@/api/hooks';
import type { BridgeJob } from '@/api/types';
import { isAway } from '@/lib/app-activity';
import { BRIDGE_IDLE_POLL_MS, isOpenJob } from '@/lib/bridge-jobs';
import { getItem, setItem } from '@/lib/storage';
import { isRecord, LIBRIVOX_WATCHES_KEY } from '@/lib/storage-keys';
import { useSession } from '@/stores/session';

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
 * refused (a 400 or 403). A connection signed out (gone, or needing its sign-in again after
 * a 401) holds the watch, unread, and reads it again once signed in: a fetch that ended
 * meanwhile is handled then. One whose connection never comes back is let go `WATCH_TTL_MS`
 * after it was first watched. The read keeps its `bridge` gate (true only while the Bridge
 * is online): a lapsed heartbeat pauses it, the watch kept, and the watcher asks `/server`
 * again every `BRIDGE_IDLE_POLL_MS` in the foreground until the Bridge is back.
 */
type Watch = { cid: string; id: number; /** When it was first watched (ms). */ at: number };

/** How long a watch whose connection is signed out is kept: a fetch ends in hours at most,
 * and a connection not back by then is taken as gone for good. */
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

/** The saved watches still worth following (well formed, not past `WATCH_TTL_MS`). */
function savedWatches(raw: unknown, now: number): Watch[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (w): w is Watch =>
      isRecord(w) &&
      typeof w.cid === 'string' &&
      typeof w.id === 'number' &&
      typeof w.at === 'number' &&
      now - w.at < WATCH_TTL_MS,
  );
}

let restoring: Promise<void> | null = null;
let stopSaving: (() => void) | null = null;

/** Read the saved watches once (the watcher's first mount), behind any watched since, then
 * save the list at every change. */
export function restoreLibrivoxWatches(): Promise<void> {
  restoring ??= (async () => {
    const saved = savedWatches(await getItem<unknown>(LIBRIVOX_WATCHES_KEY), Date.now());
    stopSaving = useLibrivoxWatches.subscribe((s, prev) => {
      if (s.watches !== prev.watches) void setItem(LIBRIVOX_WATCHES_KEY, s.watches);
    });
    // A new list, so the merge is saved too (the ones past their hold left out).
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
 * it: `gone` (a 404, deleted with its library: the last answer no longer stands), its
 * `job` (none once gone) and whether it `ended` (gone, or no longer open).
 */
export function followedRead(read: { data?: BridgeJob; error: unknown }) {
  const gone = read.error instanceof ApiError && read.error.status === 404;
  const job = gone ? undefined : read.data;
  return { gone, job, ended: gone || (!!job && !isOpenJob(job)) };
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
  return useSyncExternalStore(
    subscribe,
    () => (qc.getQueryCache().get(hash)?.getObserversCount() ?? 0) > 1,
  );
}

function WatchedFetch({ cid, id, at }: Watch) {
  const qc = useQueryClient();
  const conn = useSession((s) => s.connections.find((c) => c.id === cid));
  // Signed in, and not waiting for its sign-in again (a 401): only then asked. Never for a
  // connection that is gone (its client is too).
  const reading = !!conn && !conn.needsReconnect;
  useReadElsewhere(qc, qk.bridgeJob(cid, id));
  const read = useLibrivoxJob(reading ? id : undefined, true, cid);
  // Judged only once `/server` has answered: until then the hooks' gate lays that read's own
  // failure over the job's (`useCapabilityQuery`), so a proxy's 403 or 404 for `/server` at
  // launch would read as the job refused or gone.
  const own = useServerInfo(cid).data !== undefined ? read : { data: read.data, error: null };
  const { gone, job, ended } = followedRead(own);
  const doneIn = job?.state === 'done' ? job.library_id : null;
  // A refusal (a 400 or 403): asking again can't help, by the poll's own rule
  // (`useLibrivoxJob`), which stops too. A 404 is `gone`: an end, not a refusal. A 401 holds
  // the watch until the connection is signed in again (`reading`).
  const refused = !gone && isNotInLibraryError(own.error);
  const signedIn = !!conn;

  useEffect(() => {
    // Signed out for longer than any fetch takes: gone for good.
    const expired = !signedIn && Date.now() - at >= WATCH_TTL_MS;
    if (expired || refused) return dropWatch({ cid, id });
    if (!reading || !ended) return;
    librivoxFetchEnded(qc, cid, doneIn);
    dropWatch({ cid, id });
  }, [signedIn, at, refused, reading, ended, doneIn, qc, cid, id]);

  return null;
}

/** A watched connection whose Bridge is away (`/server`'s `bridge` flag not true): its reads
 * are paused by their gate, and nothing else may read `/server` again while no page is open,
 * so it is asked every `BRIDGE_IDLE_POLL_MS` with the app in the foreground until it is. */
function BridgeAwayWaker({ cid }: { cid: string }) {
  const info = useServerInfo(cid);
  useServerAskedWhileAway(info.data?.capabilities?.bridge !== true, info.refetch);
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
