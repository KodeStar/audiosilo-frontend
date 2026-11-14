import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';

import { ApiError, isNotInLibraryError, isSignedOutError } from '@/api/client';
import { invalidateLibraryLists, qk, useLibrivoxJob } from '@/api/hooks';
import { isOpenJob } from '@/lib/bridge-jobs';
import { useSession } from '@/stores/session';

import { DONE_RECHECK_MS } from './librivox-model';

/**
 * The `librivox.fetch` jobs Find on LibriVox follows, watched past the page (fe#293): a
 * fetch added (or seen open) and then left, the page closed or the work folded, still ends
 * with the Library read again, as if the page were open. In memory only: after a restart
 * the Library's own stale time covers it.
 *
 * `LibrivoxFetchWatcher` (a root listener) is the ONE poller of each followed job
 * (`useLibrivoxJob`, active: its rules, polled while the app is in the foreground); a
 * recording row reads the same query without polling (`useFollowedFetch`). A job that ends
 * asks the connection's works again, and a done one reads the library's lists again and asks
 * the works once more a moment later (`librivoxFetchEnded`); then it is watched no more, as
 * it is once gone (a 404), refused (a 400, 401 or 403), or its connection signed out. The
 * read keeps its `bridge` gate (true only while the Bridge is online): a lapsed heartbeat
 * pauses it, the watch kept, until the Bridge is back.
 */
type Watch = { cid: string; id: number };

export const useLibrivoxWatches = create<{ watches: Watch[] }>(() => ({ watches: [] }));

const same = (a: Watch, b: Watch) => a.cid === b.cid && a.id === b.id;

/** Follow `id` on `cid` until it ends (once: watching it again changes nothing). */
export function watchLibrivoxFetch(cid: string, id: number) {
  const w = { cid, id };
  useLibrivoxWatches.setState((s) =>
    s.watches.some((x) => same(x, w)) ? s : { watches: [...s.watches, w] },
  );
}

function dropWatch(w: Watch) {
  useLibrivoxWatches.setState((s) => ({ watches: s.watches.filter((x) => !same(x, w)) }));
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

/** Every followed fetch, each read by its own `WatchedFetch`. Renders nothing. */
export function LibrivoxFetchWatcher() {
  const watches = useLibrivoxWatches((s) => s.watches);
  return (
    <>
      {watches.map((w) => (
        <WatchedFetch key={`${w.cid}:${w.id}`} cid={w.cid} id={w.id} />
      ))}
    </>
  );
}

function WatchedFetch({ cid, id }: Watch) {
  const qc = useQueryClient();
  const signedIn = useSession((s) => s.connections.some((c) => c.id === cid));
  // Never asked for a connection that is gone (its client is too).
  const read = useLibrivoxJob(signedIn ? id : undefined, true, cid);
  const gone = read.error instanceof ApiError && read.error.status === 404;
  const job = gone ? undefined : read.data;
  const ended = gone || (!!job && !isOpenJob(job));
  const doneIn = job?.state === 'done' ? job.library_id : null;
  // A refusal (a 400, 401 or 403): asking again can't help, by the poll's own rule
  // (`useLibrivoxJob`), which stops too. A 404 is `gone`: an end, not a refusal.
  const refused = !gone && (isSignedOutError(read.error) || isNotInLibraryError(read.error));
  const stop = !signedIn || refused;

  useEffect(() => {
    if (!stop && !ended) return;
    if (!stop) librivoxFetchEnded(qc, cid, doneIn);
    dropWatch({ cid, id });
  }, [stop, ended, doneIn, qc, cid, id]);

  return null;
}
