import { create } from 'zustand';

import type { ApiClient } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import {
  allProgressQuery,
  chaptersQuery,
  isQueueKey,
  itemQuery,
  nextBookQuery,
  queueQuery,
  serverInfoQuery,
} from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Capabilities, Progress } from '@/api/types';
import { canAutoDownload, onNetworkChange } from '@/lib/network';
import { bookTitle } from '@/lib/paths';
import { resolveNextBook } from '@/playback/next-book';
import { usePlayer } from '@/playback/store';
import { toKeepAhead, useSettings } from '@/stores/settings';

import {
  aheadKey,
  aheadWindow,
  pendingBytes,
  planKeepAhead,
  type AheadBook,
  type KeepAheadSlot,
  type KeepAheadStatus,
  type NetworkGate,
} from './keep-ahead';
import { engine } from './engine';
import { isDeclined, useDownloads } from './store';
import type { DownloadStatus } from './types';

/**
 * "Keep the next books ready", acting on the pure plan (`keep-ahead.ts`).
 *
 * ## How it sits beside the existing automatic download
 * The playback store already downloads the book you START (`maybeAutoDownloadCurrent`
 * in `src/playback/store.ts`, under `autoDownloadNext`), and the player switches to the
 * local copy once it lands. That stays exactly as it is (decision 7: the store is not
 * changed). This controller adds the books AFTER it: with the setting at N, the next N
 * from Up next and then the series. Both obey the same network rule, both go through the
 * downloads store's one-at-a-time queue, and the current book always wins the queue:
 * the store enqueues it the moment playback starts, while this waits `SETTLE_MS` after
 * the book changes before planning. With the setting off (the default) nothing here
 * downloads anything, so the app behaves as before.
 *
 * Framework-free, started once from `src/app/_layout.tsx` like `startAutoSleep`.
 */

/** What the Downloads page shows about keeping books ready. */
type KeepAheadView = {
  status: KeepAheadStatus;
  slots: KeepAheadSlot[];
};

export const useKeepAhead = create<KeepAheadView>()(() => ({ status: 'off', slots: [] }));

/** Wait this long after anything changes before planning: skimming through books or
 * tapping the setting several times plans once, and the book just started is queued
 * first. */
export const SETTLE_MS = 4000;

type Current = { connectionId: string; libraryId: number; path: string };

async function capabilities(client: ApiClient, cid: string): Promise<Capabilities> {
  return (await queryClient.fetchQuery(serverInfoQuery(cid, client))).capabilities;
}

/** The queue as `AheadBook`s (entries the server didn't index, with no `book`, can't be
 * downloaded and are skipped). */
async function queueAhead(client: ApiClient, cid: string): Promise<AheadBook[]> {
  const queue = await queryClient.fetchQuery({ ...queueQuery(cid, client), staleTime: 30_000 });
  return queue.flatMap((e) =>
    e.book
      ? [
          {
            connectionId: cid,
            libraryId: e.library_id,
            path: e.path,
            title: e.book.title,
            size: e.book.size,
            duration: e.book.duration,
            source: 'queue' as const,
          },
        ]
      : [],
  );
}

/** Up to `max` books after `from` in its series: the server's `next_book` answer when it
 * has one (community order, then series, then folder), else the folder's next sibling
 * (`resolveNextBook`, what the end-of-book flow uses). Each step starts from the last. */
async function seriesAhead(
  client: ApiClient,
  cid: string,
  from: Current,
  max: number,
  nextBook: boolean,
): Promise<AheadBook[]> {
  const out: AheadBook[] = [];
  const seen = new Set([aheadKey(from)]);
  let at = { libraryId: from.libraryId, path: from.path };
  while (out.length < max) {
    let next: AheadBook | null = null;
    if (nextBook) {
      const { libraryId, path } = at;
      const r = await queryClient.fetchQuery(nextBookQuery(cid, client, libraryId, path));
      if (r.next)
        next = {
          connectionId: cid,
          libraryId: r.next.library_id,
          path: r.next.path,
          title: bookTitle(r.book?.title, r.next.path),
          size: r.book?.size ?? 0,
          duration: r.book?.duration ?? 0,
          source: 'series',
        };
    } else {
      const e = await resolveNextBook(client, at.libraryId, at.path);
      if (e?.is_book)
        next = {
          connectionId: cid,
          libraryId: at.libraryId,
          path: e.path,
          title: e.title || e.name,
          size: e.is_dir ? 0 : e.size,
          duration: e.duration ?? 0,
          source: 'series',
        };
    }
    if (!next || seen.has(aheadKey(next))) break;
    seen.add(aheadKey(next));
    out.push(next);
    at = { libraryId: next.libraryId, path: next.path };
  }
  return out;
}

async function finishedKeys(client: ApiClient, cid: string): Promise<Set<string>> {
  const rows = await queryClient.fetchQuery({
    ...allProgressQuery(cid, client),
    staleTime: 60_000,
  });
  return new Set(
    rows.filter((p) => p.finished).map((p) => aheadKey({ connectionId: cid, ...pathOf(p) })),
  );
}
const pathOf = (p: Progress) => ({ libraryId: p.library_id, path: p.path });

async function networkGate(): Promise<NetworkGate> {
  const mode = useSettings.getState().autoDownloadNext;
  if (mode === 'never') return 'never';
  return (await canAutoDownload(mode)) ? 'allowed' : 'metered';
}

/** Download one planned book with its full item and chapters (the queue and `/next`
 * give the list shape, which has no files), unless something changed while it waited. */
async function startOne(client: ApiClient, book: AheadBook): Promise<void> {
  const { connectionId: cid, libraryId, path } = book;
  const [item, chapters] = await Promise.all([
    queryClient.fetchQuery(itemQuery(cid, client, libraryId, path)),
    queryClient.fetchQuery(chaptersQuery(cid, client, libraryId, path)),
  ]);
  if (isDeclined(cid, libraryId, path)) return;
  if (useDownloads.getState().entries[aheadKey(book)]) return;
  useDownloads.getState().download(cid, libraryId, item, chapters, 'keep-ahead');
}

/** Plan once and act on it. Never throws: a server that can't be reached simply plans
 * nothing this time (no reachability report: this is a background nicety). */
export async function runKeepAhead(): Promise<void> {
  const count = toKeepAhead(useSettings.getState().keepAhead);
  const downloads = useDownloads.getState();
  const np = usePlayer.getState().nowPlaying;
  const publish = (status: KeepAheadStatus, slots: KeepAheadSlot[] = []) =>
    useKeepAhead.setState({ status, slots });

  if (count === 0) return publish('off');
  // Until the registry has loaded, everything looks missing: wait for it.
  if (!downloads.supported || !downloads.hydrated) return publish('idle');
  const network = await networkGate();
  if (network === 'never') return publish('never');
  if (!np) return publish('idle');

  const current: Current = {
    connectionId: np.connectionId,
    libraryId: np.libraryId,
    path: np.path,
  };
  const client = resolveClient(current.connectionId);
  if (!client) return publish('idle');
  try {
    const caps = await capabilities(client, current.connectionId);
    const [queue, finished] = await Promise.all([
      caps.queue ? queueAhead(client, current.connectionId) : [],
      finishedKeys(client, current.connectionId),
    ]);
    // The series only fills what the queue leaves.
    const fromQueue = aheadWindow({ count, current, queue, series: [], finished });
    const series =
      fromQueue.length < count
        ? await seriesAhead(client, current.connectionId, current, count, !!caps.next_book)
        : [];
    const window = aheadWindow({ count, current, queue, series, finished });
    const entries = useDownloads.getState().entries;
    const plan = planKeepAhead({
      count,
      network,
      window,
      entries: new Map(
        Object.entries(entries).map(([k, e]): [string, DownloadStatus] => [k, e.status]),
      ),
      declined: new Set(
        window.filter((b) => isDeclined(b.connectionId, b.libraryId, b.path)).map(aheadKey),
      ),
      storage: engine.storageEstimate ? await engine.storageEstimate() : null,
      pending: pendingBytes(Object.values(entries)),
    });
    publish(plan.status, plan.slots);
    for (const book of plan.start) {
      try {
        await startOne(client, book);
      } catch {
        // This book's item didn't load: the next plan tries again.
      }
    }
  } catch {
    publish('idle');
  }
}

/** The registry's shape that matters to the plan: which books, in which state (not the
 * byte counts, which move on every progress tick). */
function registrySignature(): string {
  const { entries, hydrated } = useDownloads.getState();
  return `${hydrated}|${Object.entries(entries)
    .map(([k, e]) => `${k}=${e.status}`)
    .sort()
    .join('|')}`;
}

function currentSignature(): string {
  const np = usePlayer.getState().nowPlaying;
  return np ? aheadKey(np) : '';
}

function settingsSignature(): string {
  const s = useSettings.getState();
  return `${s.keepAhead}|${s.autoDownloadNext}`;
}

/**
 * Plan whenever an input changes: the loaded book, the two settings, the downloads
 * registry (a book finished downloading or was removed), the Up next queue (any read or
 * write of it), or the network (native: Wi-Fi coming back). Each change re-arms one
 * `SETTLE_MS` timer; a change during a run plans again once it ends. Returns a teardown.
 */
export function startKeepAhead(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;

  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await runKeepAhead();
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, SETTLE_MS);
  }

  const watch = (signature: () => string, subscribe: (fn: () => void) => () => void) => {
    let last = signature();
    return subscribe(() => {
      const next = signature();
      if (next === last) return;
      last = next;
      schedule();
    });
  };

  const unsubs = [
    watch(currentSignature, (fn) => usePlayer.subscribe(fn)),
    watch(settingsSignature, (fn) => useSettings.subscribe(fn)),
    watch(registrySignature, (fn) => useDownloads.subscribe(fn)),
    queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.action.type === 'success' &&
        isQueueKey(event.query.queryKey)
      )
        schedule();
    }),
    onNetworkChange(schedule),
  ];
  schedule();

  return () => {
    if (timer) clearTimeout(timer);
    for (const off of unsubs) off();
  };
}
