import { AppState, Platform } from 'react-native';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { resolveClient } from '@/api/connection-clients';
import {
  bookKeyParts,
  cachedCapability,
  cachedShowTitle,
  chaptersQuery,
  fetchFailFast,
  fetchServerProgress,
  itemQuery,
  qk,
} from '@/api/hooks';
import { markEpisodeOnServer } from '@/api/podcast-cache';
import { queryClient } from '@/api/provider';
import {
  saveServerSnapshot,
  seedServerSnapshot,
  type ServerSnapshot,
} from '@/api/server-snapshots';
import type { Book, BookMeta, ChaptersResponse } from '@/api/types';
import { withMatchFields } from '@/components/library/meta-gating';
import { identityMovePending } from '@/lib/connection-id';
import { contentKey, contentKeyOf, isKeyOf } from '@/lib/content-key';
import { mapLimit } from '@/lib/map-limit';
import { canAutoDownload } from '@/lib/network';
import { serialQueue } from '@/lib/serial-queue';
import { sharedStart } from '@/lib/shared-start';
import { getItem, getItemStrict, setItemStrict } from '@/lib/storage';
import { DOWNLOADS_KEY, isRecord } from '@/lib/storage-keys';
import { onStoredChange, tabChannel, type TabChannel } from '@/lib/tab-channel';
import { tabLock, webLocalStorage } from '@/lib/tab-lock';
import { bookFileSpecs } from '@/playback/book-queue';
import { fetchPercent, isAbsentEpisode } from '@/playback/episode-fetch-rules';
import { type BookRef, bookRefOf } from '@/playback/types';
import { webTranscodeFromCache } from '@/playback/transcode-capability';
import { cachedEbookUri } from '@/reader/ebook-file';
import { onConnectionRemoved } from '@/stores/session';
import { useSettings } from '@/stores/settings';

import { entryBytes } from './downloads-view';
import { engine } from './engine';
import { type EpisodeWaitEnd, isWaiting, stopWaiting, waitForEpisode } from './episode-ready';
import {
  setDownloadEndCheck,
  setDownloadLengthCheck,
  setKeptMetaRefresh,
  setKeptOfflineCheck,
} from './kept-offline';
import { estimateBytes, pendingBytes, roomLeft } from './keep-ahead';
import { classifyDownloadError } from './failure';
import {
  canMatch,
  captureOfflineMeta,
  readOfflineMeta,
  releaseOfflineBook,
  removeOfflineMeta,
  seedOfflineMeta,
  seedQuery,
  serverHasMetadata,
  whenSessionReady,
  writeOfflineMeta,
} from './offline-meta';
import {
  fetchReadalongFile,
  fitsDownload,
  type KeptReadalong,
  keptOf,
  readalongChange,
  readReadalongFile,
  removeReadalongFile,
  wantsReadalong,
} from './readalong-file';
import {
  downloadsRunningElsewhere,
  heldDownloads,
  holdDownload,
  releaseDownloadAfter,
  tabsShareDownloads,
  whenDownloadLeft,
} from './tab-owner';
import type {
  DownloadedFile,
  DownloadEntry,
  DownloadFailure,
  DownloadManifest,
  DownloadOrigin,
  DownloadOutcome,
  DownloadStatus,
  StorageEstimate,
} from './types';

export const downloadKey = contentKey;

type Registry = Record<string, DownloadEntry>;

// Module-level orchestration (mirrors src/playback/store.ts): one book downloads at a
// time; further requests wait in `queue` (the running one is taken off it first). The
// client is resolved per entry at run time (see runOne), so queued downloads from
// different servers each use their own server's client - the old single module-level
// apiRef raced two-server downloads.
let running = false;
const queue: string[] = [];
// The running download's controller, by book. Whoever stops a run (`stopRun`) also takes
// it out, so the run can tell it is no longer the book's live one: a cancel then Download
// again queues a new entry under the same key, which the old run must never touch.
const controllers = new Map<string, AbortController>();

/** Stop a book's waiting or running download: off the queue (or no longer waiting for its
 * server, an episode: `episode-ready.ts`), its transfer aborted, and its run no longer the
 * live one (see `controllers`). */
function stopRun(key: string) {
  stopWaiting(key);
  const idx = queue.indexOf(key);
  if (idx >= 0) queue.splice(idx, 1);
  controllers.get(key)?.abort();
  controllers.delete(key);
}

// Books whose download was cancelled or removed in this session (by the listener, or by
// "remove a download when you finish the book"). Automatic downloads skip them, so a
// book someone just removed is never fetched again behind their back; the listener
// downloading it again clears the mark. Session-only on purpose: memory, not storage.
const declined = new Set<string>();

// How often each book was cancelled or removed this session: a `download` that waited (for
// the launch's read and offline check, or for the book's item) gives up on a book the
// listener stopped meanwhile, instead of fetching it again.
const stopCounts = new Map<string, number>();
const stopCount = (key: string) => stopCounts.get(key) ?? 0;
const noteStopped = (key: string) => stopCounts.set(key, stopCount(key) + 1);

// The launch's read of the saved registry while it runs (`hydrate`, up to its merge). The
// registry is not known yet, so `download` and `remove` wait for it (a book already on
// disk would otherwise be fetched over its own files, or removed and then put back by the
// merge), and `persist` holds off (it would save only the live entries over the saved
// registry: an app closed mid-hydrate would lose every download).
let hydrating: Promise<void> | null = null;
// The launch's check that this browser can play a download offline (`engine.probe`, the
// web: a service worker must control the page) while it runs. `download` waits for it: a
// download started before the answer ran to 100% and was then refused, its bytes held
// (v2.5.1 PLAYER-03).
let probing: Promise<unknown> | null = null;

/** Whether this book's download was cancelled or removed earlier in this session. */
export function isDeclined(connectionId: string, libraryId: number, path: string): boolean {
  return declined.has(downloadKey(connectionId, libraryId, path));
}

type DownloadsState = {
  entries: Registry;
  /** Web: the downloads on their way that another tab of this browser is running (their
   * keys, `tab-owner.ts`). Shown as downloading there; that tab stops them (`cancel` and
   * `remove` ask it to), and this one never revives, runs or saves them. */
  elsewhere: Record<string, true>;
  /** Storage refused the latest save of the registry (its read or its write): the change is
   * kept here and tried again (`persist`) until it lands, and the Downloads page says so. */
  saveFailing: boolean;
  hydrated: boolean;
  supported: boolean;
  hydrate: () => Promise<void>;
  /** Queue a book. `origin` says who asked (default: the listener, which also lifts a
   * cancel/remove mark from earlier in the session). An errored entry is retried,
   * keeping the files it already finished. Resolves what it did (`DownloadOutcome`); a
   * listener's request is queued at once, an automatic one after reading the room. On
   * web, a list-shape `book` (no `direct_playable`) is first looked up in full, so a
   * book this browser plays transcoded is refused whoever asks; so is a podcast episode
   * given without its chapters (an episode row's list shape), for its file's own. A retry
   * of a failed download reads the book's item and chapters afresh first, for its current
   * files. An episode not on its server yet waits there first (`episode-ready.ts`), off the
   * queue. */
  download: (
    connectionId: string,
    libraryId: number,
    book: Book,
    chapterData?: ChaptersResponse,
    origin?: DownloadOrigin,
  ) => Promise<DownloadOutcome>;
  cancel: (connectionId: string, libraryId: number, path: string) => void;
  remove: (connectionId: string, libraryId: number, path: string) => Promise<void>;
};

export const useDownloads = create<DownloadsState>()((set, get) => ({
  entries: {},
  elsewhere: {},
  saveFailing: false,
  hydrated: false,
  supported: engine.supported,

  hydrate: async () => {
    let read!: () => void;
    const reading = new Promise<void>((r) => (read = r));
    hydrating = reading;
    // The launch reads the registry: no copy of an earlier read stands for it (`storedCopy`,
    // `heldAs`).
    storedCopy = null;
    heldAs.clear();
    listenForStops();
    let cleaned: Registry;
    // On web, having the Cache API isn't enough - offline files only play if the
    // service worker is actually controlling the page and serving them. Probe the
    // real path (no real download needed) and downgrade `supported` if it can't, so
    // the UI hides downloads instead of offering ones that won't play offline. Asked from
    // the start, and applied once the registry is read (which sets `supported` from the
    // engine): `download` waits for it until it has settled, however the read went (a read
    // that throws must not leave `download` waiting on a settled check forever).
    const probe = engine.probe;
    const checked: Promise<void> | null =
      engine.supported && probe
        ? Promise.all([probe().catch(() => false), reading])
            .then(([ok]) => {
              if (ok !== useDownloads.getState().supported) set({ supported: ok });
            })
            .finally(() => {
              if (probing === checked) probing = null;
            })
        : null;
    probing = checked;
    try {
      cleaned = await readRegistry();
    } finally {
      hydrating = null;
      read();
    }
    // An `/item` answer can reach the cache before this read the registry (the web's
    // refresh starts after paint, its own sweep then finding no downloads yet).
    if (itemRefreshOn) takeCachedItems(Object.values(cleaned));
    await persist();
    // Web: what other tabs changed while this one read (their `storage` events are not
    // followed then) shows now, not at their next save.
    if (Platform.OS === 'web') {
      followStored(await getItemStrict<unknown>(DOWNLOADS_KEY).catch(() => null));
    }
    // The episodes that were waiting for their server when the app closed wait again, once
    // the session knows the connections to ask and the browser's offline check has settled.
    void Promise.all([whenSessionReady(), checked])
      .then(resumeEpisodeWaits)
      .catch(() => {});
    // The community metadata kept with each downloaded book, seeded for offline reading
    // (and filled in for a download made before it was kept). In the background, once the
    // launch's first screens are up: the registry is usable without it.
    afterLaunch(() => void restoreOfflineMeta(Object.keys(cleaned)).catch(() => {}));
    if (checked) await checked;
  },

  download: (connectionId, libraryId, book, chapterData, origin = 'listener') => {
    if (!engine.supported) return Promise.resolve<DownloadOutcome>('unsupported');
    const key = downloadKey(connectionId, libraryId, book.rel_path);
    const stops = stopCount(key);
    // Until the launch has read the registry a book already on disk looks new, and its
    // download would write over (and, offline, lose) the files it has.
    const reading = hydrating ?? probing;
    if (reading)
      return reading.then(() =>
        stopCount(key) !== stops
          ? 'declined'
          : get().download(connectionId, libraryId, book, chapterData, origin),
      );
    // This browser can't play a download offline (the launch's probe): refused up front,
    // before a byte is fetched. The control says so ("Downloads unavailable").
    if (!get().supported) return Promise.resolve<DownloadOutcome>('unsupported');
    // On web, a list-shape book (`/books`, `/fs`, shelves, tiles, the queue) carries no
    // `direct_playable`, so the transcode refusal below would read it as playable and
    // download raw files this browser cannot play. Such a book is decided on its full
    // item and chapters (through the query cache, as keep-ahead's `startOne` does), which
    // also give the download its files. Native never transcodes, so it asks only for an
    // episode given without chapters: its item says whether its server has it now, and its
    // chapters (the file's own) go with the download. Not for an episode its caller says is
    // absent, on either platform: it waits on its server first, and both are read once the
    // file is there, where the transcode refusal is decided again (`episodeWaitEnded`).
    // A retry of a failed download reads both afresh on every platform: the caller's files
    // (the query cache's, kept up to 30 minutes, or the failed download's own saved copy)
    // can still list a file the server has since removed, and the retry would fetch it
    // again. Asked whatever the online flag says (`fetchFailFast`): held for the network, a
    // Retry tapped offline would wait unseen instead of going on the files it was given.
    const retrying = get().entries[key]?.status === 'error';
    const lookup =
      !isAbsentEpisode(book) &&
      (retrying || lacksPlayability(book, chapterData) || (!!book.episode && !chapterData));
    const client = lookup ? resolveClient(connectionId) : null;
    if (!client) return queueBook(connectionId, libraryId, book, chapterData, origin);
    const staleTime = retrying ? 0 : 30_000;
    const itemOptions = {
      ...itemQuery(connectionId, client, libraryId, book.rel_path),
      staleTime,
    };
    const chaptersOptions = {
      ...chaptersQuery(connectionId, client, libraryId, book.rel_path),
      staleTime,
    };
    return (async () => {
      const [item, chapters] = await Promise.allSettled([
        retrying ? fetchFailFast(itemOptions) : queryClient.fetchQuery(itemOptions),
        retrying ? fetchFailFast(chaptersOptions) : queryClient.fetchQuery(chaptersOptions),
      ]);
      if (stopCount(key) !== stops) return 'declined';
      // A lookup that failed decides on what the caller gave, as before.
      return queueBook(
        connectionId,
        libraryId,
        item.status === 'fulfilled' ? item.value : book,
        chapters.status === 'fulfilled' ? chapters.value : chapterData,
        origin,
      );
    })();
  },

  cancel: (connectionId, libraryId, path) => {
    const key = downloadKey(connectionId, libraryId, path);
    noteStopped(key);
    declined.add(key);
    // An entry the launch is still reading would come back from its merge, its files gone
    // (fe#153): the stop waits for the read, as `remove` does. Marked stopped at once, so a
    // download waiting for the read gives up on the book.
    void (async () => {
      if (hydrating) await hydrating;
      if (askOwnerToStop(key, { connectionId, libraryId, path, remove: false })) return;
      stopRun(key);
      void engine.removeBook(connectionId, libraryId, path);
      void removeEntry(key);
    })();
  },

  remove: async (connectionId, libraryId, path) => {
    const key = downloadKey(connectionId, libraryId, path);
    noteStopped(key);
    // An entry the launch is still reading would come back from its merge, its files gone.
    if (hydrating) await hydrating;
    declined.add(key);
    if (askOwnerToStop(key, { connectionId, libraryId, path, remove: true })) return;
    stopRun(key);
    await engine.removeBook(connectionId, libraryId, path);
    const saved = removeEntry(key);
    releaseOfflineBook(connectionId, libraryId, path);
    await saved;
  },
}));

// A book downloaded here, or on its way, keeps its server's place in the progress mirror
// as the book's progress is read (`fetchServerProgress`, which can't import this store).
setKeptOfflineCheck((connectionId, libraryId, path) => {
  const entry = useDownloads.getState().entries[downloadKey(connectionId, libraryId, path)];
  return !!entry && entry.status !== 'error';
});

// A span recovered past a download's early end never finishes its book (`mirrorSpanEnd`,
// which can't import this store): asked after the launch's read of the registry. A registry
// not read (before that read starts, or a read that threw) is not known, which is not "the
// download holds the book's end": the check rejects (fe#273).
setDownloadEndCheck(async (connectionId, libraryId, path) => {
  if (hydrating) await hydrating;
  if (!useDownloads.getState().hydrated) throw new Error('the downloads registry is not read');
  return downloadedEntryOf({ connectionId, libraryId, path })?.manifest.endsBefore;
});

// A listen the server refused as another length, played over a download that ends early,
// is sent again at the book's length (`resendMismatched`, which can't import this store).
setDownloadLengthCheck(async (connectionId, libraryId, path) => {
  if (hydrating) await hydrating;
  const manifest = downloadedEntryOf({ connectionId, libraryId, path })?.manifest;
  return manifest?.endsBefore ? (manifest.bookDuration ?? 0) : undefined;
});

// A finished Bridge job made the book's characters, recaps or description: its kept copy
// is read again now (`refreshAfterFinish`, which can't import this store), not at the
// launch a week on (fe#158). This launch's earlier attempt does not hold it back; a book not
// downloaded is nothing (`keepOfflineMeta`'s own check), which only the registry once read
// can say, and a copy already kept again for this job is left alone.
setKeptMetaRefresh(async (connectionId, libraryId, path, job) => {
  if (hydrating) await hydrating;
  await keepOfflineMeta(downloadKey(connectionId, libraryId, path), { force: true, job });
});

// --- helpers ---------------------------------------------------------------

/** `hydrate`'s read of the saved registry: each entry relocated, checked on disk and
 * revived (or dropped and deleted), merged into the live entries and set. Returns the
 * entries it read. */
async function readRegistry(): Promise<Registry> {
  // Web: with the downloads another tab is running now. Theirs as stored (a failed one shown
  // as the retry starting there, `runningElsewhere`): never checked on disk, revived as cut
  // short or emptied, under a transfer that is still writing.
  const { saved, away } = await readStoredWithOwners();
  // Each entry on its own (its own folder: relocated, renamed, checked on disk), several at
  // once: a launch with many downloads no longer waits for the sum (fe#153), and a large
  // library never fans out every file's probe together (the web's Cache API).
  // A read that fails ends the launch's read (`download`, `remove` and `cancel` no longer
  // wait): no further entry is started, and the ones under way have ended before the failure
  // is thrown on, since one still relocating, renaming or emptying a folder would do it under
  // a download started since.
  const failures: unknown[] = [];
  const outcomes = await mapLimit(Object.values(saved), REGISTRY_READS_AT_ONCE, async (raw) => {
    if (failures.length > 0) return null;
    try {
      return await readSavedEntry(raw, away);
    } catch (error) {
      failures.push(error);
      return null;
    }
  });
  if (failures.length > 0) throw failures[0];
  const cleaned: Registry = {};
  for (const outcome of outcomes) if (outcome?.[1]) cleaned[outcome[0]] = outcome[1];
  // Merge, don't overwrite: a live entry made during the read's async window (per-book
  // file moves and renames, fileExists probes; `download` itself waits for the read,
  // `hydrating`) would be clobbered by a blind set(cleaned) built from the stale
  // start-of-hydrate snapshot. Keep any live entry this hydrate didn't produce; the
  // hydrated/on-disk version wins on a key collision.
  const merged: Registry = { ...cleaned };
  for (const [key, entry] of Object.entries(useDownloads.getState().entries)) {
    if (!(key in merged)) merged[key] = entry;
  }
  // What the launch read is what this tab knows of the stored registry: the save after the
  // merge writes what the read changed (an entry relocated, revived or dropped) and the
  // live entries made meanwhile, and leaves the rest as stored. An entry the read kept as it
  // was stored is known as the live copy (`relocateEntry` always makes a new object): taken
  // as changed, every one was written back over what another tab changed or removed while
  // this one read.
  const read: Registry = {};
  for (const [key, raw] of Object.entries(saved)) {
    const kept = merged[key];
    const same = kept && (heldAs.get(key) === raw || JSON.stringify(kept) === JSON.stringify(raw));
    read[key] = same ? kept : raw;
  }
  known = read;
  const elsewhere: Record<string, true> = {};
  for (const key of away) {
    if (inProgress(merged[key]) && merged[key] === cleaned[key]) elsewhere[key] = true;
  }
  useDownloads.setState({
    entries: merged,
    elsewhere,
    hydrated: true,
    supported: engine.supported,
  });
  for (const key of Object.keys(elsewhere)) watchOwner(key);
  return cleaned;
}

/** How many saved entries the launch's read checks at once (`readRegistry`). */
const REGISTRY_READS_AT_ONCE = 8;

/** One saved entry as the launch reads it (`readRegistry`): its key, and what it is now
 * (null: dropped, its folder deleted). */
async function readSavedEntry(
  raw: DownloadEntry,
  away: ReadonlySet<string>,
): Promise<[string, DownloadEntry | null]> {
  const rawKey = downloadKey(raw.connectionId, raw.libraryId, raw.path);
  if (away.has(rawKey) && raw.status !== 'downloaded')
    return [rawKey, runningElsewhere(rawKey, raw)];
  // Re-resolve stored file uris against the live storage root first: the app's
  // document-container path can change between installs/launches (notably dev
  // rebuilds), which leaves the persisted absolute uris stale even though the
  // files are still on disk. Without this the existence check below fails and
  // the book is dropped *and deleted* - the download vanishes after a rebuild.
  const e = await relocateEntry(raw);
  // Key on the entry's own connection-scoped id (stale un-scoped entries from before
  // scoping were already wiped by resetStaleStorage, so every entry here has a real id).
  const key = downloadKey(e.connectionId, e.libraryId, e.path);
  // Which of the files the entry lists are still on disk (`reviveEntry` has the rules).
  const present = await Promise.all(e.manifest.files.map((f) => engine.fileExists(f.localUri)));
  const revived = reviveEntry(e, present);
  if (
    (!revived || revived.manifest.files.length !== e.manifest.files.length) &&
    identityMovePending()
  ) {
    // The identity migration gave up mid-move this launch: the files can be under the
    // new id while this entry names the old one (or the reverse). Kept as stored, never
    // trimmed, dropped or deleted; the launch that finishes the move finds them.
    return [key, raw];
  }
  if (!revived) {
    void engine.removeBook(e.connectionId, e.libraryId, e.path);
    return [key, null];
  }
  // A row kept with no finished file: what its folder holds is partial. Emptied by the
  // launch that made it so. On the web a row saved that way already (a failure listing no
  // file, an episode waiting for its server) holds nothing (a transfer that fails stores
  // nothing), and emptying it read every key of the media cache on every launch (fe#197).
  // The app looks again, which costs one check of the folder: a failure a 2.4.x-2.6.x app
  // saved kept its partial file until that app's next launch, and Android writes it at the
  // file's own name.
  const emptied =
    Platform.OS === 'web' &&
    raw.manifest.files.length === 0 &&
    (raw.status === 'error' || !!raw.serverFetch);
  if (revived.manifest.files.length === 0 && !emptied)
    void engine.removeBook(e.connectionId, e.libraryId, e.path);
  if (revived.status !== 'downloaded') return [key, revived];
  // A chapters answer can reach the cache before this read the registry.
  const manifest = withCachedChapters(e, revived.manifest);
  seedQueryCache(e.connectionId, e.libraryId, e.path, manifest);
  return [key, manifest === revived.manifest ? revived : { ...revived, manifest }];
}

/** The downloads another tab holds the lock of while the stored registry still shows them
 * failed (`runningElsewhere`), by key: the stored entry each one is shown in place of. */
const heldAs = new Map<string, DownloadEntry>();

/**
 * Another tab holds the lock of the download `key` (`tab-owner.ts`): it is running there,
 * whatever the stored registry says. Stored as failed, it is a retry starting there, its
 * new start not saved yet: shown as queued, that tab's (not a Retry here for a moment, which
 * would start it a second time). Its stored entry stays known (`heldAs`), never saved from
 * here; that tab's next save shows its progress (`followStored`), and the lock let go with
 * nothing saved shows the stored entry again (`ownerLeft`).
 */
function runningElsewhere(key: string, stored: DownloadEntry): DownloadEntry {
  if (stored.status !== 'error') return stored;
  const shown: DownloadEntry = { ...stored, status: 'queued', progress: 0 };
  delete shown.failure;
  heldAs.set(key, stored);
  return shown;
}

/** How often the launch reads the registry again for a download whose tab cannot be told
 * (`readStoredWithOwners`) before leaving it to that tab. */
const OWNER_READS = 3;

/**
 * The launch's read of the stored registry, with the downloads another tab of this browser
 * is running (`tab-owner.ts`; none where the tabs cannot tell, and then one read). A
 * download on its way that no tab holds was cut short, and the launch revives it; but a tab
 * saves a download's start after taking its lock and its end before letting go, so one read
 * and one look at the locks can straddle either (the entry read as on its way, its tab
 * found gone, the download in fact finished since: revived, its folder was emptied). So an
 * entry is nobody's only when it reads the same before and after the look that found no
 * holder. One that keeps moving is left to its tab, as running there.
 */
async function readStoredWithOwners(): Promise<{ saved: Registry; away: Set<string> }> {
  const read = async () => (await getItem<Registry>(DOWNLOADS_KEY)) ?? {};
  let saved = await read();
  if (!tabsShareDownloads()) return { saved, away: new Set() };
  for (let tries = 1; ; tries++) {
    const away = await downloadsRunningElsewhere();
    const before = saved;
    const unheld = ([key, e]: [string, DownloadEntry]) => inProgress(e) && !away.has(key);
    if (!Object.entries(before).some(unheld)) return { saved, away };
    saved = await read();
    const moved = Object.entries(saved)
      .filter(unheld)
      .filter(([key, e]) => JSON.stringify(e) !== JSON.stringify(before[key]));
    if (moved.length === 0) return { saved, away };
    if (tries >= OWNER_READS) {
      for (const [key] of moved) away.add(key);
      return { saved, away };
    }
  }
}

/** Put a book on the one-at-a-time queue (`download` decided it may go). An errored
 * entry is retried, keeping the files its failed attempt finished. */
/** Whether a book's playability in this browser is unknown: on web, neither the book nor
 * its chapters carry `direct_playable` (the list shape). */
function lacksPlayability(book: Book, chapterData?: ChaptersResponse): boolean {
  return (
    Platform.OS === 'web' &&
    book.direct_playable === undefined &&
    chapterData?.direct_playable === undefined
  );
}

/** `download()` once the book is known: the transcode refusal, then queue it by the
 * listener's or the automatic rules. */
function queueBook(
  connectionId: string,
  libraryId: number,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  origin: DownloadOrigin,
): Promise<DownloadOutcome> {
  const done = (outcome: DownloadOutcome) => Promise.resolve(outcome);
  // A connection removed here (or in another tab, which told this one): nothing of it is
  // fetched, and no entry is left behind for it (its server would refuse the token).
  if (removedConnection(connectionId)) return done('declined');
  // A book this browser plays through the server's transcoder would download as its
  // raw files, which it can't play offline: refuse (every path - the book page, auto
  // download, keep-ahead - lands here). The UI says why (useDownloadControls, and the
  // Downloads page's row for an earlier download of it that failed).
  if (webTranscodeFromCache(connectionId, book, chapterData)) return done('transcoded');
  const key = downloadKey(connectionId, libraryId, book.rel_path);
  const existing = useDownloads.getState().entries[key];
  if (existing && existing.status !== 'error') return done('exists'); // queued/downloading/done
  if (origin === 'listener') {
    declined.delete(key);
    begin(key, connectionId, libraryId, book, chapterData, origin);
    return done('queued');
  }
  // An automatic download (the book you start, keep-ahead) never takes back a book
  // the listener cancelled or removed this session, and never eats into the reserve
  // (`roomLeft`; an unknowable room lets it start, one at a time).
  if (declined.has(key)) return done('declined');
  return (async (): Promise<DownloadOutcome> => {
    let storage: StorageEstimate | null = null;
    try {
      storage = await engine.storageEstimate();
    } catch {
      // not knowable: start it, one at a time like keep-ahead
    }
    const need = estimateBytes(book);
    const entries = Object.entries(useDownloads.getState().entries);
    const room = roomLeft(storage, pendingBytes(entries.map(([, e]) => e)));
    // The book being listened to outranks keep-ahead's books still waiting their turn:
    // if only they stand in its way, they step aside (keep-ahead plans them again
    // around it, when they still fit). One already downloading finishes.
    let yielding: string[] = [];
    if (room !== null && need > room) {
      if (origin !== 'auto') return 'no-space';
      // Not another tab's: this one cannot take its download off its queue.
      const { elsewhere } = useDownloads.getState();
      yielding = entries
        .filter(([k, e]) => e.origin === 'keep-ahead' && e.status === 'queued' && !elsewhere[k])
        .map(([k]) => k);
      const others = entries.filter(([k]) => !yielding.includes(k)).map(([, e]) => e);
      const without = roomLeft(storage, pendingBytes(others));
      if (without !== null && need > without) return 'no-space';
    }
    // Things may have moved while the room was read.
    const now = useDownloads.getState().entries[key];
    if (declined.has(key) || removedConnection(connectionId)) return 'declined';
    if (now && now.status !== 'error') return 'exists';
    for (const k of yielding) stepAside(k);
    begin(key, connectionId, libraryId, book, chapterData, origin);
    return 'queued';
  })();
}

/** Start a download `queueBook` let through: a podcast episode its server must fetch first
 * waits there (`awaitEpisode`), anything else goes on the queue. An episode whose last try
 * failed on its server (the fetch, or a 503 from a file the server no longer had) asks it
 * again; one that failed its fetch POSTs when the listener asks (their Retry skips the
 * server's cool-down, which an automatic download's own retry respects), and so does one
 * whose Retry of a failed fetch ended before its POST was answered (`failure.refetch`: signed
 * out, no access, cut short by a launch), whoever starts it again: the POST is the listener's
 * ask, still owed when an automatic download gets to the entry before their next Retry. */
function begin(
  key: string,
  connectionId: string,
  libraryId: number,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  origin: DownloadOrigin,
) {
  const existing = useDownloads.getState().entries[key];
  const failure = existing?.status === 'error' ? existing.failure : undefined;
  const owed = !!failure?.refetch;
  const fetchFailed = failure?.kind === 'serverFetch' || owed;
  const wait =
    !!book.episode &&
    (isAbsentEpisode(book) ||
      fetchFailed ||
      (failure?.kind === 'server' && failure.status === 503));
  if (wait) {
    const retry = owed || (fetchFailed && origin === 'listener');
    awaitEpisode(key, connectionId, libraryId, book, chapterData, origin, retry);
  } else enqueue(key, connectionId, libraryId, book, chapterData, origin);
}

/** Put a book's entry in the registry as `queued` (saved at once): its manifest from `book`
 * and `chapterData`, keeping the files a failed attempt finished. */
function putEntry(
  key: string,
  connectionId: string,
  libraryId: number,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  origin: DownloadOrigin,
  extra: Pick<DownloadEntry, 'serverFetch'> = {},
) {
  const { entries } = useDownloads.getState();
  const existing = entries[key];
  const showTitle = book.episode
    ? (cachedShowTitle(connectionId, libraryId, book.episode.show_path) ??
      existing?.manifest.showTitle)
    : undefined;
  const manifest: DownloadManifest = {
    book,
    chapters: chapterData ?? existing?.manifest.chapters ?? null,
    // A retry keeps the files the failed attempt finished (runOne skips those still
    // on disk).
    files: existing?.manifest.files ?? [],
    coverUri: null,
    ...(showTitle ? { showTitle } : {}),
    savedAt: new Date().toISOString(),
  };
  const entry: DownloadEntry = {
    connectionId,
    libraryId,
    path: book.rel_path,
    title: book.title,
    status: 'queued',
    progress: 0,
    bytes: 0,
    totalBytes: 0,
    origin,
    ...extra,
    manifest,
  };
  useDownloads.setState({
    entries: { ...entries, [key]: entry },
    elsewhere: without(useDownloads.getState().elsewhere, [key]),
  });
  void persist();
}

function enqueue(
  key: string,
  connectionId: string,
  libraryId: number,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  origin: DownloadOrigin,
) {
  putEntry(key, connectionId, libraryId, book, chapterData, origin);
  if (!queue.includes(key)) {
    // The book you start goes next, ahead of keep-ahead's books still waiting (the
    // download running now is off the queue).
    if (origin === 'auto' && running) queue.unshift(key);
    else queue.push(key);
  }
  void runQueue();
}

/**
 * A podcast episode not on its server yet (fe#166, D2): its entry waits as `queued` with
 * `serverFetch`, off the one-at-a-time queue, while `episode-ready.ts` gets it onto its
 * server (`retry`: POST, the listener's Retry after a failed fetch); then it goes on the
 * queue like any book (`episodeWaitEnded`).
 */
function awaitEpisode(
  key: string,
  connectionId: string,
  libraryId: number,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  origin: DownloadOrigin,
  retry: boolean,
) {
  putEntry(key, connectionId, libraryId, book, chapterData, origin, {
    serverFetch: { percent: fetchPercent(book.episode?.fetch), ...(retry ? REFETCH : {}) },
  });
  watchEpisode(key, connectionId, libraryId, book.rel_path, retry);
}

/** The mark of a wait (or a failure) whose Retry still has to POST (`serverFetch.refetch`). */
const REFETCH = { refetch: true } as const;

/** The wait for a waiting entry's episode (`awaitEpisode`, `resumeEpisodeWaits`): its
 * progress onto the entry, its end through `episodeWaitEnded`. The first status on its way
 * (queued, fetching) after a Retry's POST (`retry`) says the server took it: the saved mark
 * goes (`serverFetch.refetch`), so a restart from then on asks the stream. Each status is the one the episode page
 * and an open row menu read too (`qk.podcastFetch`, as the player's fetch seeds it). */
function watchEpisode(
  key: string,
  connectionId: string,
  libraryId: number,
  path: string,
  retry: boolean,
) {
  waitForEpisode(
    { key, connectionId, libraryId, path },
    {
      onStatus: (status) => {
        queryClient.setQueryData(qk.podcastFetch(connectionId, libraryId, path), status);
        const cur = useDownloads.getState().entries[key];
        const percent = fetchPercent(status);
        if (!cur?.serverFetch) return;
        // On its way: the POST took. Until then the mark stays, whatever else the status says
        // (the fetch limit's refusal is asked again, still owed).
        const owed = !!cur.serverFetch.refetch;
        const posted = owed && (status.state === 'queued' || status.state === 'fetching');
        if (posted || cur.serverFetch.percent !== percent) {
          patchEntry(key, { serverFetch: { percent, ...(owed && !posted ? REFETCH : {}) } });
          if (posted) void persist();
        }
      },
      onEnd: (end) => void episodeWaitEnded(key, end).catch(() => {}),
    },
    { retry },
  );
}

/**
 * The launch's waits (fe#280): each entry still waiting for its server (`serverFetch`, kept by
 * `reviveEntry`) waits again, from the stream, under the per-server cap. One whose connection
 * has no client now (it is gone), or in a browser that can't play a download offline (the
 * launch's check, which `download` refuses on), is a download the app cut short, as before:
 * a row to retry, or gone with its folder where `reviveEntry` drops it (keep-ahead's).
 */
function resumeEpisodeWaits() {
  const { entries, elsewhere, supported } = useDownloads.getState();
  const cut = new Map<string, DownloadEntry | null>();
  for (const [key, e] of Object.entries(entries)) {
    // Another tab's wait is that tab's (`elsewhere`).
    if (e.status !== 'queued' || !e.serverFetch || isWaiting(key) || elsewhere[key]) continue;
    if (supported && resolveClient(e.connectionId)) {
      // A Retry whose POST was not answered before the app closed asks it again.
      watchEpisode(key, e.connectionId, e.libraryId, e.path, !!e.serverFetch.refetch);
    } else {
      // `reviveEntry` kept it only with every file it lists on disk. Dropped, or a row with no
      // finished file, its folder goes (as `readRegistry` does).
      const revived = reviveEntry(
        withoutServerFetch(e),
        e.manifest.files.map(() => true),
      );
      if (!revived || revived.manifest.files.length === 0)
        void engine.removeBook(e.connectionId, e.libraryId, e.path);
      // Its Retry still owes the POST (`failure.refetch`).
      const failure = revived?.failure;
      cut.set(
        key,
        revived && failure && e.serverFetch.refetch
          ? { ...revived, failure: { ...failure, ...REFETCH } }
          : revived,
      );
    }
  }
  if (cut.size === 0) return;
  const next: Registry = { ...useDownloads.getState().entries };
  for (const [key, revived] of cut) {
    if (revived) next[key] = revived;
    else delete next[key];
  }
  useDownloads.setState({ entries: next });
  void persist();
}

/** A waiting entry without its `serverFetch` (the key gone, not kept as undefined). */
function withoutServerFetch(entry: DownloadEntry): DownloadEntry {
  const { serverFetch: _waiting, ...rest } = entry;
  return rest;
}

/**
 * An episode's wait on its server ended. On its server: its item and chapters are read again
 * (the file's own size and chapters, `downloaded` now true; `fetchFailFast`, so the entry
 * never sits here on a read the network holds), it is marked on its server in the show's
 * cached episode lists (`markEpisodeOnServer`: a show page on screen says so, with no list
 * read again), and it goes on the queue. The wait can be long (it
 * stops in the background), so what `queueBook` decided before it is decided again: an
 * automatic download the network rule no longer lets start is dropped (no decline mark:
 * the next start asks again), and so is one this browser turns out to play transcoded.
 * Otherwise the entry fails (`serverFetch`, with the server's code; Retry POSTs), or, for a
 * removed connection, as `removed`. A cancel or remove meanwhile wins.
 */
async function episodeWaitEnded(key: string, end: EpisodeWaitEnd): Promise<void> {
  const entry = useDownloads.getState().entries[key];
  if (!entry?.serverFetch) return;
  const { connectionId, libraryId, path } = entry;
  if (end.kind !== 'ready') {
    useDownloads.setState({
      entries: {
        ...useDownloads.getState().entries,
        [key]: {
          ...withoutServerFetch(entry),
          status: 'error',
          error:
            end.kind === 'removed' ? 'Server connection removed' : 'The episode was not fetched',
          failure:
            end.kind === 'failed'
              ? { kind: 'serverFetch', kept: 0, ...(end.code ? { code: end.code } : {}) }
              : end.kind === 'removed'
                ? { kind: 'removed' }
                : // Signed out or no access: a Retry of a failed fetch whose POST never got
                  // through still owes it, after the sign-in (`begin`).
                  { kind: end.kind, kept: 0, ...(entry.serverFetch.refetch ? REFETCH : {}) },
        },
      },
    });
    void persist();
    // The feed gave the episode another identity: what the cache holds of it is stale (as
    // the player's fetch does, `episode-fetch.ts`).
    if (end.kind === 'failed' && end.code === 'identity_changed') {
      void queryClient.invalidateQueries({ queryKey: qk.item(connectionId, libraryId, path) });
      void queryClient.invalidateQueries({
        queryKey: qk.podcastEpisodesOfLibrary(connectionId, libraryId),
      });
    }
    return;
  }
  const stops = stopCount(key);
  // Still the wait that ended (no cancel, remove or new download since).
  const standing = () =>
    stopCount(key) === stops && !!useDownloads.getState().entries[key]?.serverFetch;
  const drop = () => {
    void engine.removeBook(connectionId, libraryId, path);
    void removeEntry(key);
  };
  const client = resolveClient(connectionId);
  let book = entry.manifest.book;
  let chapters = entry.manifest.chapters ?? undefined;
  if (client) {
    const [item, read] = await Promise.allSettled([
      fetchFailFast({ ...itemQuery(connectionId, client, libraryId, path), staleTime: 0 }),
      fetchFailFast({ ...chaptersQuery(connectionId, client, libraryId, path), staleTime: 0 }),
    ]);
    if (item.status === 'fulfilled') book = item.value;
    if (read.status === 'fulfilled') chapters = read.value;
  }
  if (!standing()) return;
  // The network may not be the one the rule let it start on (the wait stops in the
  // background and carries on wherever the app comes back).
  if (entry.origin === 'auto') {
    const allowed = await canAutoDownload(useSettings.getState().autoDownloadNext);
    if (!standing()) return;
    if (!allowed) return drop();
  }
  // Its file's own format is known only now: one this browser plays through the server's
  // transcoder is refused, as `queueBook` refuses it (the control says why).
  if (webTranscodeFromCache(connectionId, book, chapters)) return drop();
  // The show's cached lists, by the item as it was read (one whose read failed marks
  // nothing: the lists are read again).
  const show = book.episode?.show_path;
  if (show !== undefined) {
    markEpisodeOnServer(queryClient, connectionId, libraryId, show, path, book);
  }
  // Its server has the file now, whatever an older answer said (the re-read failed): the
  // manifest a later Retry starts from must not send it back to wait.
  if (book.episode && !book.episode.downloaded) {
    book = { ...book, episode: { ...book.episode, downloaded: true } };
  }
  enqueue(key, connectionId, libraryId, book, chapters, entry.origin ?? 'listener');
}

/** Take a waiting automatic download off the queue for the book you start, without the
 * session's decline mark (the listener didn't cancel it): keep-ahead plans it again. A
 * waiting keep-ahead download has no files yet (keep-ahead never retries a failure). */
function stepAside(key: string) {
  const idx = queue.indexOf(key);
  if (idx >= 0) queue.splice(idx, 1);
  void removeEntry(key);
}

/**
 * What a saved entry becomes on launch (`present`: whether each file it lists, in order, is
 * still on disk):
 * - a downloaded book stays downloaded while every file is there;
 * - a downloaded book with some of its files gone (the system or the listener deleted
 *   them) stays as a failure keeping the files still there (`missing`), so Retry fetches
 *   only the rest instead of the whole book being dropped (fe#158). A keep-ahead one is
 *   dropped with its folder instead, as before: keep-ahead never retries a failure, and
 *   plans a dropped book again;
 * - an episode waiting for its server stays waiting (`resumeEpisodeWaits` asks again), unless
 *   files a failed attempt finished are gone;
 * - a failed download, or one the app closed mid-way (still `queued` / `downloading`:
 *   the engines can't resume a transfer, but the files it FINISHED are listed as they
 *   land), stays as a failure keeping those of its files still there, so Retry fetches
 *   only the rest. One cut short by the app closing says so (`interrupted`), or, on web
 *   with every file saved and no EPUB to fetch, that only the check that it plays offline
 *   was left (`unservable`: the service worker that serves it may not control the page,
 *   v2.5.1 PLAYER-03);
 * - a failed or cut-short download with no file left (most books are ONE file) stays too,
 *   as a row to retry from the start (v2.5.1 PLAYER-04), its folder emptied by the caller;
 *   a keep-ahead one is dropped instead (keep-ahead plans it again, and never retries a
 *   failure);
 * - a downloaded entry with no file there at all is dropped (and its folder deleted by the
 *   caller).
 * The kept share is recomputed from the files, so it is what is really on the device.
 */
export function reviveEntry(
  saved: DownloadEntry,
  present: readonly boolean[],
): DownloadEntry | null {
  const listed = saved.manifest.files;
  const files = listed.filter((_, i) => present[i] === true);
  const allPresent = listed.length > 0 && files.length === listed.length;
  // An episode that was waiting for its server waits again (`resumeEpisodeWaits`), with what
  // a failed attempt finished still there; one whose files went is a download cut short.
  if (saved.serverFetch && (listed.length === 0 || allPresent)) return saved;
  const e = saved.serverFetch ? withoutServerFetch(saved) : saved;
  // A wait that was the listener's Retry of a failed fetch, its POST not answered yet: the
  // failure it becomes still owes it (`failure.refetch`, `begin`).
  const owed = saved.serverFetch?.refetch ? REFETCH : {};
  if (e.status === 'downloaded') {
    if (allPresent) return e;
    if (files.length === 0 || e.origin === 'keep-ahead') return null;
  }
  if (files.length === 0) {
    if (e.origin === 'keep-ahead') return null;
    return {
      ...e,
      status: 'error',
      progress: 0,
      bytes: 0,
      error: e.status === 'error' ? e.error : 'Interrupted',
      failure:
        e.status === 'error' && e.failure
          ? { ...e.failure, kept: 0 }
          : { kind: 'interrupted', kept: 0, ...owed },
      // Its folder goes (a cut-short transfer's partial bytes, the cover): the retry
      // fetches them again.
      manifest: { ...e.manifest, files: [], coverUri: null, ebookUri: undefined },
    };
  }
  const of = bookFileSpecs(e.manifest.book, e.manifest.chapters ?? undefined).length;
  const kept = Math.min(1, files.length / Math.max(of, listed.length));
  // Only the check was left when every file is saved and no EPUB was still to come (it is
  // fetched after the audio, and listed only once the download ends).
  const onlyCheckLeft = allPresent && kept === 1 && !!engine.verify && !e.manifest.book.ebook;
  const failure: DownloadFailure =
    e.status === 'downloaded'
      ? { kind: 'missing', kept }
      : e.status === 'error' && e.failure
        ? { ...e.failure, kept }
        : { kind: onlyCheckLeft ? 'unservable' : 'interrupted', kept, ...owed };
  return {
    ...e,
    status: 'error',
    progress: kept,
    bytes: files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
    error:
      e.status === 'error' ? e.error : e.status === 'downloaded' ? 'Files missing' : 'Interrupted',
    failure,
    manifest: allPresent ? e.manifest : { ...e.manifest, files },
  };
}

/**
 * A downloaded book's manifest with the server's `fresh` chapters in place of the saved
 * ones, or null to leave it as it is. A book's chapters can change on the server after
 * it was downloaded (a rescan, a community chapter list fitted onto its audio, the admin
 * switching it back), and offline it plays and lists what the manifest holds. Only the
 * chapters move: when the fresh answer's audio files are not the ones on the device (the
 * same paths in the order the manifest plays them now, `bookFileSpecs`, and the same
 * sizes where both answers know them: a file replaced in place keeps its path), the local
 * audio no longer matches and that is a new download, so nothing changes. The same files
 * in another order are taken only by a start that plays them that way
 * (`adoptStartedChapters`), never from a background answer. Null too when nothing differs.
 */
export function refreshedChapters(
  manifest: DownloadManifest,
  fresh: ChaptersResponse,
): DownloadManifest | null {
  const refresh = chaptersRefresh(manifest, fresh);
  return refresh && !refresh.reordered ? refresh.manifest : null;
}

/** The manifest with `fresh` chapters when they name the device's own files (the same set
 * of paths, the same sizes where both answers know them), and whether they play those
 * files in another order than the manifest's chapters do (`reordered`); else null. */
function chaptersRefresh(
  manifest: DownloadManifest,
  fresh: ChaptersResponse,
): { manifest: DownloadManifest; reordered: boolean } | null {
  // An unchanged refetch hands back the same object (structural sharing): skip the compare.
  if (fresh === manifest.chapters) return null;
  const want = bookFileSpecs(manifest.book, fresh);
  if (want.length !== manifest.files.length) return null;
  // The files in the order the manifest plays them now, with the sizes the download read
  // (0 when only the chapters named the files).
  const read = bookFileSpecs(manifest.book, manifest.chapters ?? undefined);
  const readSize = new Map(read.map((s) => [s.path, s.size]));
  // The device's files, each one named exactly once, in any order.
  const onDisk = manifest.files.map((f) => f.relPath);
  const onDiskSet = new Set(onDisk);
  const onDevice = new Set(onDiskSet);
  for (const s of want) {
    if (!onDevice.delete(s.path)) return null;
    const was = readSize.get(s.path) ?? 0;
    if (was > 0 && s.size > 0 && was !== s.size) return null;
  }
  // The order the manifest plays them in now: its chapters', else (saved chapters that name
  // no file list of their own) the order the download wrote them.
  const playing =
    read.length === onDisk.length && read.every((s) => onDiskSet.has(s.path))
      ? read.map((s) => s.path)
      : onDisk;
  const reordered = want.some((s, i) => s.path !== playing[i]);
  if (!reordered && JSON.stringify(fresh) === JSON.stringify(manifest.chapters)) return null;
  return { manifest: { ...manifest, chapters: fresh }, reordered };
}

/**
 * A start of a downloaded book loaded the engine from `chapters` (`playBook`, once its
 * load landed; `adoptLoaded`, when Android's service plays exactly their order after a JS
 * restart lost that start): the manifest takes them, so a later start, offline or from
 * Android's service, plays the order the engine was given. This is the only way the same
 * files take a new order (server v2.4.0 plays them in natural order, "2-" before "10-"):
 * the chapters carry the order every queue over the download plays them in
 * (`bookFileSpecs`, each file found by its path: `localFromManifest`), and `files` itself
 * never moves, since a file's name on disk is the index it was saved under (`fileName`;
 * `relocateEntry` keeps a saved file's own name, `storedIndex`, and so does a retry,
 * `retryPlan`). A
 * background answer never does it (`refreshedChapters`): JS cannot see a book the Android
 * service or a Cast receiver holds before it is adopted. Chapters naming other files
 * change nothing.
 */
export function adoptStartedChapters(ref: BookRef, chapters: ChaptersResponse): void {
  const entry = downloadedEntryOf(ref);
  const refresh = entry && chaptersRefresh(entry.manifest, chapters);
  // The same order is the background refresh's to take (`startChapterRefresh`): a start's
  // answer can be older (cached) than one the manifest took while it loaded.
  if (!refresh?.reordered) return;
  patchEntry(contentKeyOf(ref), { manifest: refresh.manifest });
  void persist();
}

/**
 * `manifest` with `endsBefore` set from `order`, the book's files in its server's order:
 * the last one when the download lacks it (it ends before the book does, D3, fe#185), else
 * none; and with it `bookDuration`, the book's length on the server when `duration` gives
 * it (an order with no length keeps the one known for the same end). The same manifest when
 * nothing changes, and when `order` is empty.
 */
export function withBookEnd(
  manifest: DownloadManifest,
  order: readonly string[],
  duration?: number,
): DownloadManifest {
  const last = order[order.length - 1];
  if (last === undefined) return manifest;
  const endsBefore = manifest.files.some((f) => f.relPath === last) ? undefined : last;
  const { endsBefore: _was, bookDuration: _length, ...rest } = manifest;
  if (endsBefore === undefined) return manifest.endsBefore === undefined ? manifest : rest;
  const bookDuration =
    duration !== undefined && duration > 0
      ? duration
      : endsBefore === manifest.endsBefore
        ? manifest.bookDuration
        : undefined;
  if (endsBefore === manifest.endsBefore && bookDuration === manifest.bookDuration) {
    return manifest;
  }
  return { ...rest, endsBefore, ...(bookDuration !== undefined && { bookDuration }) };
}

/** An adoption with no server answer saw the engine play the book's files in `order`
 * (`adoptLoadedBook`): the download keeps whether it ends before the book does, so a later
 * start of it offline (a cold Resume) pauses at that end as the adopted queue did. Only an
 * order naming a file the download lacks says where the book ends: one inside the download
 * (an engine loaded from the download's own copy, offline) says nothing, and leaves the
 * fact a server answer kept. */
export function noteDownloadEnd(ref: BookRef, order: readonly string[]): void {
  const entry = downloadedEntryOf(ref);
  if (!entry) return;
  const held = new Set(entry.manifest.files.map((f) => f.relPath));
  if (order.every((p) => held.has(p))) return;
  const manifest = withBookEnd(entry.manifest, order);
  if (manifest === entry.manifest) return;
  patchEntry(contentKeyOf(ref), { manifest });
  void persist();
}

/**
 * `manifest` with the chapters answer the cache already holds for its book
 * (`withServedChapters`: where the book ends, its length, and the chapters when
 * `refreshedChapters` takes them). `startChapterRefresh` only sees answers that land while the
 * book is downloaded; this takes one that landed before, while it was downloading or before
 * the launch's `hydrate` read the registry. That answer is the one the download was given
 * or a newer one (the callers read it from the same cache entry). Not the manifest's own
 * chapters (the store's seed, `seedQueryCache`): they name only the files on the device, so
 * read as an answer they would say the download holds the book's end, and drop the
 * `endsBefore` a server answer set (D3).
 */
function withCachedChapters(ref: BookRef, manifest: DownloadManifest): DownloadManifest {
  const cached = queryClient.getQueryData<ChaptersResponse>(
    qk.chapters(ref.connectionId, ref.libraryId, ref.path),
  );
  return cached && cached !== manifest.chapters ? withServedChapters(manifest, cached) : manifest;
}

/** `manifest` after a server chapters answer for its book: where the book ends and its
 * length (`withBookEnd`, by every answer, also one naming files the download lacks), then
 * the chapters when `refreshedChapters` takes them. The same manifest when nothing changes. */
function withServedChapters(manifest: DownloadManifest, fresh: ChaptersResponse): DownloadManifest {
  const ended = withBookEnd(
    manifest,
    bookFileSpecs(manifest.book, fresh).map((f) => f.path),
    fresh.duration,
  );
  return refreshedChapters(ended, fresh) ?? ended;
}

/**
 * Keep downloaded books' chapters in step with the server: every chapters answer the
 * server gives (any screen's fetch, the play and download paths) for a downloaded book
 * replaces its saved copy when `refreshedChapters` allows. The cache already holds that
 * answer, so there is nothing to seed. A queue already playing keeps its chapters until
 * the book is next started. Returns the unsubscribe; shared (`sharedStart`) by the root
 * layout and the car's stack (fe#158).
 *
 * The answers the cache already holds when it starts are taken too: the web starts it
 * after the first paint (`root-services.web.tsx`), when a screen's answer can have landed
 * already. Native starts it before any fetch, where the cache holds at most the store's
 * own seeds, which are the manifests' chapters and so change nothing.
 */
export const startChapterRefresh = sharedStart(runChapterRefresh);

function runChapterRefresh(): () => void {
  for (const entry of Object.values(useDownloads.getState().entries)) {
    if (entry.status !== 'downloaded') continue;
    const manifest = withCachedChapters(entry, entry.manifest);
    if (manifest === entry.manifest) continue;
    patchEntry(contentKeyOf(entry), { manifest });
    persistSoon();
  }
  return queryClient.getQueryCache().subscribe((event) => {
    // A server answer only: the store's own seeds (`setQueryData`) are manual.
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const book = bookKeyParts(event.query.queryKey, 'chapters');
    const fresh = event.action.data as ChaptersResponse | undefined;
    if (!book || !fresh) return;
    const ref = { connectionId: book.cid, libraryId: book.libraryId, path: book.path };
    const entry = downloadedEntryOf(ref);
    if (!entry) return;
    const manifest = withServedChapters(entry.manifest, fresh);
    if (manifest === entry.manifest) return;
    patchEntry(contentKeyOf(ref), { manifest });
    // A burst of answers (a reconnect's refetches, a search fan-out, the start's own
    // sweep above) saves the registry once, not once per book.
    persistSoon();
  });
}

/** The map refetches this session already tried, by download and map (`startItemRefresh`):
 * one attempt each per launch, so a map that keeps failing its check is not fetched again on
 * every answer for the book. */
const readalongTried = new Set<string>();

/**
 * Keep downloaded books in step with the server's `/item` answers. Read-along maps (Bridge
 * Phase 3c): every answer for a downloaded book with its EPUB on the device fetches the map
 * again when its `readalong.generated_at` is not the one the download keeps, and drops the
 * kept one when the server has no ready map any more, unless a stale one still fits the
 * download's EPUB (`readalongChange`; only from a server that serves maps, so an older one
 * never drops anything). Returns the unsubscribe; shared (`sharedStart`) by the root layout
 * and the car's stack (fe#158).
 *
 * The answers the cache already holds when it starts, and when the launch's `hydrate` has
 * read the registry, are taken too (as `startChapterRefresh` and `withCachedChapters` do):
 * the web starts it after the first paint, when a screen's `/item` can have landed already.
 * The store's own seeds name the map the download keeps (`namingReadalong`), so they change
 * nothing but a map the download could not fetch, which is tried again (`readalongTried`).
 *
 * What the book's community metadata is found by: an answer naming an id or a work the
 * download's book lacks gives it that (`adoptMatch`, fe#290).
 */
export const startItemRefresh = sharedStart(runItemRefresh);

function runItemRefresh(): () => void {
  itemRefreshOn = true;
  takeCachedItems(Object.values(useDownloads.getState().entries));
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const ref = bookKeyParts(event.query.queryKey, 'item');
    const book = event.action.data as Book | undefined;
    if (!ref || !book) return;
    takeItemAnswer({ connectionId: ref.cid, libraryId: ref.libraryId, path: ref.path }, book);
  });
  return () => {
    itemRefreshOn = false;
    unsubscribe();
  };
}

/** Whether `startItemRefresh` runs (the launch's registry read then takes the cached
 * answers too). */
let itemRefreshOn = false;

/** The `/item` answers the cache holds for these downloaded books, each taken as an answer
 * that just landed (`takeItemAnswer`). */
function takeCachedItems(entries: Iterable<DownloadEntry>): void {
  for (const entry of entries) {
    if (entry.status !== 'downloaded') continue;
    const cached = queryClient.getQueryData<Book>(
      qk.item(entry.connectionId, entry.libraryId, entry.path),
    );
    if (cached) takeItemAnswer(bookRefOf(entry), cached);
  }
}

/** One `/item` answer's work for `startItemRefresh`. */
function takeItemAnswer(ref: BookRef, book: Book): void {
  adoptMatch(ref, book);
  void refreshReadalong(ref, book).catch(() => {});
}

/**
 * A download's book takes what an `/item` answer says its community metadata is found by
 * (`withMatchFields`: an ASIN, an ISBN, generated content, the community work), each when
 * the book names none or another (fe#290). The download's own book can be a list row, and
 * one made before its server sent the work's id (server#484, a console match without ids)
 * names none: on a launch with no network that book is all `canMatch` reads, which would
 * leave the download out of the fill-in and the weekly refresh, unmatched offline. A work
 * the book did not name has its copy kept for it (`keepForWork`), and the copy it has is
 * marked as from before the work (`meta.rematched`) in the same save as the id: the id alone,
 * saved with the keep cut short (the app closed, a request that failed), would leave that
 * copy a week, no later answer naming a new work. Never an episode; no request of its own.
 */
function adoptMatch(ref: BookRef, book: Book): void {
  const entry = downloadedEntryOf(ref);
  if (!entry || book.episode || entry.manifest.book.episode) return;
  const { manifest } = entry;
  const taken = withMatchFields(manifest.book, book);
  if (taken === manifest.book) return;
  const key = contentKeyOf(ref);
  const newWork = taken.work_id !== manifest.book.work_id ? taken.work_id : undefined;
  const meta = newWork && manifest.meta ? { ...manifest.meta, rematched: true as const } : null;
  patchEntry(key, { manifest: { ...manifest, book: taken, ...(meta && { meta }) } });
  persistSoon();
  if (newWork) keepForWork(key, newWork);
}

/** A download's book with what the `/item` answer the cache holds says it is found by
 * (`withMatchFields`), for a download that just finished: the answers that landed while
 * its files did found no downloaded book to give them to (`adoptMatch`). */
function withCachedMatch(ref: BookRef, book: Book): Book {
  const cached = queryClient.getQueryData<Book>(qk.item(ref.connectionId, ref.libraryId, ref.path));
  return cached && !cached.episode && !book.episode ? withMatchFields(book, cached) : book;
}

/** The keeps `keepForWork` was asked for: one book at a time. */
const oneWorkKeep = serialQueue();

/**
 * Keep a download's copy for the work its book now names, past this launch's try: a
 * download that kept none, one kept as unmatched before its console match, one tied to
 * another work. A copy that names the work already stays as it is (a book matched by its
 * ASIN or ISBN all along; read from its file, no request). One book at a time across the
 * downloads, so many answers at once (the cached ones, as the refresh starts) are never a
 * burst of requests. The keep reads `/meta` again, not an answer from before the work
 * (`keepOfflineMetaNow`).
 */
function keepForWork(key: string, workId: string): void {
  void oneWorkKeep(async () => {
    // A keep under way for the book (its download's own) writes the copy read here.
    await metaKeeps.get(key);
    const entry = useDownloads.getState().entries[key];
    if (entry?.status !== 'downloaded' || entry.manifest.book.work_id !== workId) return;
    const kept = entry.manifest.meta ? (await readOfflineMeta(entry))?.meta : undefined;
    if (namesWork(kept, workId)) return;
    await keepOfflineMeta(key, { force: true });
  }).catch(() => {});
}

/** Whether a `/meta` answer is a match to the work `workId`. */
const namesWork = (meta: BookMeta | undefined, workId: string | undefined): boolean =>
  !!meta?.matched && meta.work.id === workId;

/** Mark stale the `/meta` answers the cache holds for a book that do not name `workId`,
 * with no request: one read before the book named the work stays fresh for an hour, and a
 * keep would save it as it is (an unmatched one, or another work's), not read again. */
function staleMetaNotNaming(ref: BookRef, workId: string): void {
  void queryClient.invalidateQueries({
    queryKey: qk.bookMeta(ref.connectionId, ref.libraryId, ref.path),
    predicate: (q) => !namesWork(q.state.data as BookMeta | undefined, workId),
    refetchType: 'none',
  });
}

/** One answer's read-along work for `startItemRefresh`. */
async function refreshReadalong(ref: BookRef, book: Book): Promise<void> {
  const entry = downloadedEntryOf(ref);
  if (!entry || cachedCapability(ref.connectionId, 'readalong') !== true) return;
  const change = readalongChange(book, entry.manifest);
  if (change === 'keep') return;
  const key = contentKeyOf(ref);
  let kept: KeptReadalong | undefined;
  if (change === 'drop') {
    await removeReadalongFile(ref);
  } else {
    const attempt = `${key}@${entry.manifest.savedAt}@${book.readalong?.generated_at}`;
    const api = resolveClient(ref.connectionId);
    if (readalongTried.has(attempt) || !api) return;
    readalongTried.add(attempt);
    // Only a map of the ebook the download holds (fe#193). Without its sha (no map was kept
    // yet), an ebook of another size on the server is another ebook: none is fetched.
    const { manifest } = entry;
    const own = { sha256: manifest.ebookSha256, size: manifest.book.ebook?.size };
    if (!fitsDownload(own, { size: book.ebook?.size })) return;
    const fetched = await fetchReadalongFile(api, ref, { ebookSha256: manifest.ebookSha256 });
    // Not fetched: the map kept (if any) stays, and so does what the download says of it.
    if (!fetched) return;
    if ('refused' in fetched) {
      // Refused: that too, and the download remembers the refusal, so the same map is not
      // fetched again on the next launch (`readalongRefused`).
      if (!stillDownloaded(key, entry)) return;
      const cur = useDownloads.getState().entries[key];
      patchEntry(key, { manifest: { ...cur.manifest, readalongRefused: fetched.refused } });
      persistSoon();
      return;
    }
    kept = fetched;
  }
  if (!stillDownloaded(key, entry)) {
    // Removed while it was fetched: don't leave the file behind.
    if (!useDownloads.getState().entries[key]) await removeReadalongFile(ref);
    return;
  }
  const cur = useDownloads.getState().entries[key];
  const { manifest } = cur;
  // The entry's size follows the map's: the old one's bytes out, the new one's in.
  const delta = (kept?.bytes ?? 0) - (manifest.readalongBytes ?? 0);
  patchEntry(key, {
    bytes: Math.max(0, cur.bytes + delta),
    totalBytes: cur.totalBytes > 0 ? Math.max(0, cur.totalBytes + delta) : cur.totalBytes,
    manifest: {
      ...manifest,
      readalongGeneratedAt: kept?.generatedAt,
      readalongBytes: kept?.bytes,
      readalongRefused: undefined,
      ebookSha256: manifest.ebookSha256 ?? kept?.ebookSha256,
      book: namingReadalong(manifest.book, kept?.generatedAt, book.readalong),
    },
  });
  persistSoon();
}

/**
 * A download's book naming the read-along map it keeps (`kept`, its `generated_at`), or,
 * with none kept, what `readalong` says (a server's answer: stale, or none). Offline that
 * book is what the cache is seeded with (`seedQueryCache`), and the kept copy is read only
 * while the book names it or no map at all (`readalongSource`).
 */
function namingReadalong(
  book: Book,
  kept: string | undefined,
  readalong: Book['readalong'] = book.readalong,
): Book {
  return {
    ...book,
    readalong: kept ? { ...readalong, state: 'ready', generated_at: kept } : readalong,
  };
}

/** While a download runs, its finished files reach storage at most this often
 * (`persistSoon`); everything else saves at once. */
const PERSIST_EVERY_MS = 2000;
/** A running download's progress reaches the store (and every screen that shows it) at
 * most this often; status changes and completion are never held back. */
const PROGRESS_EVERY_MS = 250;
/** A save `persistSoon` is holding, and the app-state watch that flushes it early. */
let pendingSave: { timer: ReturnType<typeof setTimeout>; watch: { remove: () => void } } | null =
  null;

/** The registry's entries as this tab last wrote or read them (the same objects): `persist`
 * writes only the entries this tab changed since, so the tabs of the web player, which
 * share the one stored registry, never write over each other's downloads. */
let known: Registry = {};

/** The stored registry's read-modify-writes one at a time, in this tab and across tabs
 * (`tabLock`): each tab holds its own entries in memory, and a tab that wrote all of them
 * over the stored registry lost every download another tab made meanwhile. */
const withRegistryLock = tabLock(DOWNLOADS_KEY);

/** Save the registry now (and drop any save `persistSoon` was holding): into the stored
 * registry, only what this tab changed (`known`), under `withRegistryLock`. `drop` also
 * takes out stored entries it names (a removed connection's, another tab's included), and
 * the files of those this tab did not hold. A read or a write that fails changes nothing
 * stored: the changes (and the drops) wait, `saveFailing` says so, and the save is tried
 * again (`saveFailed`) until one lands; any save meanwhile writes them too. */
function persist(drop?: (entry: DownloadEntry) => boolean): Promise<void> {
  if (drop) dropsWaiting.push(drop);
  // The launch's read saves once it has merged (`hydrating`): before that the live entries
  // are not the registry, and saving them would write over every saved download.
  if (hydrating) return Promise.resolve();
  if (pendingSave) {
    clearTimeout(pendingSave.timer);
    pendingSave.watch.remove();
    pendingSave = null;
  }
  // Nothing changed here and nothing to drop: no lock taken, the registry not read.
  if (nothingToSave()) return Promise.resolve();
  return withRegistryLock(saveChanges).then(removeEntryFiles);
}

/** Whether this tab has nothing to save (no change since `known`, no drop waiting): then
 * any save that failed has nothing left to land (`saveLanded`). */
function nothingToSave(): boolean {
  if (dropsWaiting.length > 0 || changedSinceKnown(useDownloads.getState().entries)) return false;
  saveLanded();
  return true;
}

/** `persist`'s read, merge and write, holding the registry's lock; resolves to the stored
 * entries a drop took that this tab did not hold. */
async function saveChanges(): Promise<DownloadEntry[]> {
  // A save that waited behind another: that one wrote these changes too.
  if (nothingToSave()) return [];
  const raw = await readStoredRegistry();
  if (raw === undefined) {
    saveFailed();
    return [];
  }
  // The entries as they are now, after the read: one taken before it could be older than
  // what the page's last moments wrote meanwhile (`saveRegistryOnPageHide`).
  const live = useDownloads.getState().entries;
  const drops = [...dropsWaiting];
  const saved: Registry = isRecord(raw) ? { ...(raw as Registry) } : {};
  let changed = applyChanges(saved, live);
  const dropped: DownloadEntry[] = [];
  for (const [key, entry] of Object.entries(saved)) {
    if (!drops.some((d) => d(entry))) continue;
    if (!live[key]) dropped.push(entry);
    delete saved[key];
    changed = true;
  }
  if (changed) {
    try {
      await setItemStrict(DOWNLOADS_KEY, saved);
    } catch {
      storedCopy = null;
      saveFailed();
      return [];
    }
  }
  if (Platform.OS !== 'web') storedCopy = saved;
  known = live;
  dropsWaiting.splice(0, drops.length);
  saveLanded();
  return dropped;
}

/** Into `saved` (the stored registry, a copy), what this tab changed since `known`: its
 * added and updated entries, and the ones it took out. Whether there was any. */
function applyChanges(saved: Registry, live: Registry): boolean {
  let changed = false;
  for (const key of new Set([...Object.keys(live), ...Object.keys(known)])) {
    if (live[key] === known[key]) continue;
    if (live[key]) saved[key] = live[key];
    else delete saved[key];
    changed = true;
  }
  return changed;
}

/** The stored registry as `persist` merges into it (undefined: storage refused the read).
 * Native has one runtime, nothing else writes the registry after the launch's read, so the
 * copy `persist` last wrote or read stands for it (`storedCopy`): not read before each save.
 * The web's tabs share it: read every time. */
async function readStoredRegistry(): Promise<unknown> {
  if (Platform.OS !== 'web' && storedCopy) return storedCopy;
  return getItemStrict<unknown>(DOWNLOADS_KEY).catch(() => undefined);
}

/** The files of `gone`, removed concurrently (on web each removal re-lists the cache): a
 * removed connection's downloads, and the stored entries a drop took that this tab did not
 * hold (another tab's), whose files nothing else would ever reach. */
async function removeEntryFiles(gone: DownloadEntry[]): Promise<void> {
  await Promise.all(gone.map((e) => engine.removeBook(e.connectionId, e.libraryId, e.path)));
}

/** A failed save is tried again after this long, doubling each time up to
 * `SAVE_RETRY_MAX_MS`, until one lands. */
const SAVE_RETRY_MS = 1_000;
const SAVE_RETRY_MAX_MS = 30_000;
/** The retry `saveFailed` set, and how long the next one waits. */
let saveRetry: ReturnType<typeof setTimeout> | null = null;
let saveRetryMs = SAVE_RETRY_MS;
/** What `persist` was asked to take out that storage has not taken yet (`drop`). */
const dropsWaiting: ((entry: DownloadEntry) => boolean)[] = [];
/** Native: the stored registry as `persist` last wrote or read it (`readStoredRegistry`). */
let storedCopy: Registry | null = null;

/** Storage refused a save's read or write: the store says so (`saveFailing`, shown on the
 * Downloads page) and the save is tried again, with backoff, never left to a later change
 * that may not come (the end of the last download, a removal). */
function saveFailed(): void {
  if (!useDownloads.getState().saveFailing) useDownloads.setState({ saveFailing: true });
  if (saveRetry) return;
  const wait = saveRetryMs;
  saveRetryMs = Math.min(saveRetryMs * 2, SAVE_RETRY_MAX_MS);
  saveRetry = setTimeout(() => {
    saveRetry = null;
    void persist().catch(() => {});
  }, wait);
}

/** A save landed: no retry waits, and the next failure starts the backoff again. After a
 * failing spell, whichever save landed (the retry, or one with no change of the entries to
 * follow: the page going), a download's end saved at last lets its lock go
 * (`syncHeldLocks`). */
function saveLanded(): void {
  if (saveRetry) clearTimeout(saveRetry);
  saveRetry = null;
  saveRetryMs = SAVE_RETRY_MS;
  if (!useDownloads.getState().saveFailing) return;
  useDownloads.setState({ saveFailing: false });
  syncHeldLocks(useDownloads.getState());
}

/** Whether `live` differs from what this tab last wrote or read (`known`). */
function changedSinceKnown(live: Registry): boolean {
  const keys = Object.keys(live);
  return keys.length !== Object.keys(known).length || keys.some((key) => live[key] !== known[key]);
}

/**
 * Another tab changed the stored registry (the web's `storage` event, `raw` its new
 * value): a book it downloaded, or a download of its own it removed or updated, shows here
 * too. Only books this tab is not running and has not changed since (`known`). A download on
 * its way shows here as the other tab's while that tab holds its lock (`elsewhere`,
 * `tab-owner.ts`: Web Locks), and is that tab's to stop; without Web Locks only finished
 * downloads are followed. Nothing before this tab read the registry (its read takes what is
 * there).
 */
export function followStoredRegistry(raw: string | null): void {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return;
  }
  followStored(parsed);
}

/** Whether a download is on its way (waiting its turn or its server, or transferring). */
const inProgress = (e: DownloadEntry | undefined): e is DownloadEntry =>
  e?.status === 'queued' || e?.status === 'downloading';

/** `record` without `keys` (the same object when it holds none of them). */
function without<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  if (!keys.some((key) => key in record)) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

/** Each entry as JSON, kept with the entry (an entry is never changed in place). */
const entryText = new WeakMap<DownloadEntry, string>();
function textOf(entry: DownloadEntry): string {
  let text = entryText.get(entry);
  if (text === undefined) entryText.set(entry, (text = JSON.stringify(entry)));
  return text;
}

/** Whether this tab's entry is the stored one, field for field. Not by `savedAt` alone: the
 * other tab changes a finished download without a new one (its chapters taken from the
 * server, its read-along map, its kept metadata, a file found gone). */
const sameStored = (mine: DownloadEntry, theirs: DownloadEntry) => textOf(mine) === textOf(theirs);

/** `followStoredRegistry` over the stored registry as read (anything but a record: nothing). */
function followStored(parsed: unknown): void {
  if (hydrating || !useDownloads.getState().hydrated || !isRecord(parsed)) return;
  const stored = parsed as Registry;
  const { entries: live, elsewhere } = useDownloads.getState();
  const next: Registry = { ...live };
  const nextKnown: Registry = { ...known };
  const nextElsewhere = { ...elsewhere };
  // On their way in the stored registry, not shown so here: another tab's, when it holds
  // their lock (`followStarted`).
  const started: string[] = [];
  let changed = false;
  for (const key of new Set([...Object.keys(live), ...Object.keys(stored)])) {
    if (controllers.has(key) || queue.includes(key) || isWaiting(key)) continue;
    // Changed here, not saved yet: added, updated, or taken out (a remove whose save waits
    // for the lock would be undone by the other tab's copy, its files already gone).
    if (live[key] !== known[key]) continue;
    const mine = live[key];
    const theirs = stored[key];
    // A removed connection's (`removals`, `purging`): the other tab's save or removal of it
    // changes nothing here.
    if (theirs && ofRemovedConnection(key, theirs)) continue;
    if (theirs?.status === 'downloaded') {
      if (mine?.status === 'downloaded' && sameStored(mine, theirs)) continue;
      next[key] = nextKnown[key] = theirs;
      delete nextElsewhere[key];
      seedQueryCache(theirs.connectionId, theirs.libraryId, theirs.path, theirs.manifest);
      changed = true;
    } else if (!theirs) {
      // A finished download removed there, or a download of that tab's it cancelled.
      if (!mine || (mine.status !== 'downloaded' && !elsewhere[key])) continue;
      delete next[key];
      delete nextKnown[key];
      delete nextElsewhere[key];
      // As this tab's own `remove`: its seeded item and chapters are no longer kept for good.
      if (mine.status === 'downloaded') {
        releaseOfflineBook(mine.connectionId, mine.libraryId, mine.path);
      }
      changed = true;
    } else if (mine && elsewhere[key]) {
      // The other tab's download shown here: how far it is now, or how it failed there.
      if (sameStored(mine, theirs)) continue;
      // Still the failed entry its retry there is shown in place of (`runningElsewhere`).
      const was = heldAs.get(key);
      if (was && sameStored(was, theirs)) continue;
      next[key] = nextKnown[key] = theirs;
      if (!inProgress(theirs)) delete nextElsewhere[key];
      changed = true;
    } else if (inProgress(theirs)) {
      started.push(key);
    }
  }
  if (changed) {
    known = nextKnown;
    for (const key of heldAs.keys()) if (next[key] !== live[key]) heldAs.delete(key);
    useDownloads.setState({ entries: next, elsewhere: nextElsewhere });
  }
  if (started.length > 0 && tabsShareDownloads()) void followStarted(started).catch(() => {});
}

/**
 * `followStored` for the downloads the stored registry shows on their way (`keys`): those
 * another tab is running (it holds their lock, `tab-owner.ts`) show here as that tab's
 * (`elsewhere`), with its progress as it saves it. One whose tab is gone is nobody's: left
 * as this tab has it, for a launch to revive.
 */
async function followStarted(keys: readonly string[]): Promise<void> {
  const away = await downloadsRunningElsewhere();
  if (!keys.some((key) => away.has(key))) return;
  // Read again: the registry may have moved on while the locks were asked.
  const raw = await getItemStrict<unknown>(DOWNLOADS_KEY).catch(() => null);
  if (hydrating || !isRecord(raw)) return;
  const stored = raw as Registry;
  const { entries: live, elsewhere } = useDownloads.getState();
  const next: Registry = { ...live };
  const nextKnown: Registry = { ...known };
  const nextElsewhere = { ...elsewhere };
  const taken: string[] = [];
  for (const key of keys) {
    const theirs = stored[key];
    if (!away.has(key) || !inProgress(theirs) || elsewhere[key]) continue;
    if (ofRemovedConnection(key, theirs)) continue;
    if (controllers.has(key) || queue.includes(key) || isWaiting(key)) continue;
    if (live[key] !== known[key]) continue;
    next[key] = nextKnown[key] = theirs;
    nextElsewhere[key] = true;
    taken.push(key);
  }
  if (taken.length === 0) return;
  known = nextKnown;
  useDownloads.setState({ entries: next, elsewhere: nextElsewhere });
  for (const key of taken) watchOwner(key);
}

/** The other tabs' downloads this one waits on (`watchOwner`). */
const watching = new Set<string>();

/** Wait for the tab running the download `key` to let it go, then settle it here
 * (`ownerLeft`). */
function watchOwner(key: string): void {
  if (watching.has(key)) return;
  watching.add(key);
  void whenDownloadLeft(key)
    .then(() => {
      watching.delete(key);
      return ownerLeft(key);
    })
    .catch(() => {});
}

/**
 * The tab that ran the download `key` let it go. It ended there (downloaded, failed,
 * cancelled): that end is in the stored registry, saved before the lock was released, and
 * is followed like any change. Or the tab closed with the download on its way: it is cut
 * short now, and this tab revives it as a launch does (`reviveEntry`: the files that
 * finished kept, a row to retry), which it may at last, nobody writing its folder.
 */
async function ownerLeft(key: string): Promise<void> {
  if (!useDownloads.getState().elsewhere[key]) return;
  const raw = await getItemStrict<unknown>(DOWNLOADS_KEY).catch(() => undefined);
  if (raw === undefined) return;
  const stored: Registry = isRecord(raw) ? (raw as Registry) : {};
  // A retry shown as running there (`runningElsewhere`) let go with nothing saved: the
  // stored failure shows again.
  heldAs.delete(key);
  followStored(stored);
  const theirs = stored[key];
  if (!useDownloads.getState().elsewhere[key] || !inProgress(theirs)) return;
  // Taken up by a tab again meanwhile (a retry there): still that tab's.
  if ((await downloadsRunningElsewhere()).has(key)) return watchOwner(key);
  const present = await Promise.all(
    theirs.manifest.files.map((f) => engine.fileExists(f.localUri)),
  );
  const state = useDownloads.getState();
  if (!state.elsewhere[key] || state.entries[key] !== known[key]) return;
  const revived = reviveEntry(theirs, present);
  if (!revived || revived.manifest.files.length === 0) {
    void engine.removeBook(theirs.connectionId, theirs.libraryId, theirs.path);
  }
  const next = { ...state.entries };
  if (revived) next[key] = revived;
  else delete next[key];
  useDownloads.setState({ entries: next, elsewhere: without(state.elsewhere, [key]) });
  void persist();
  // An episode that was waiting for its server waits again, here.
  if (revived?.serverFetch) resumeEpisodeWaits();
}

/** What a tab asks the tab running a download to do with it (`askOwnerToStop`). */
type StopRequest = { connectionId: string; libraryId: number; path: string; remove: boolean };

/** The channel a tab asks another to stop its download on. */
const STOP_CHANNEL = 'audiosilo-download-stop';
let stopTabs: TabChannel<StopRequest> | null | undefined;
let stopListening: (() => void) | null = null;
/** The channel, opened on first use (null off the web). */
const stopChannel = () =>
  stopTabs === undefined ? (stopTabs = tabChannel<StopRequest>(STOP_CHANNEL)) : stopTabs;

/** Test-only: the channel `askOwnerToStop` and `listenForStops` use. */
export function setDownloadStopChannelForTests(
  channel: TabChannel<StopRequest> | null | undefined,
): void {
  stopListening?.();
  stopListening = null;
  stopTabs = channel;
}

/** Hear the other tabs' requests to stop a download this one runs (once, from the launch). */
function listenForStops(): void {
  if (!stopListening) stopListening = stopChannel()?.subscribe(stopAsked) ?? null;
}

/** A cancel or remove of a download another tab is running (`elsewhere`): that tab is asked
 * to do it, since only it can stop its transfer, and its removal shows here as it is saved
 * (`followStored`). Whether `key` was one. */
function askOwnerToStop(key: string, ask: StopRequest): boolean {
  if (!useDownloads.getState().elsewhere[key]) return false;
  stopChannel()?.post(ask);
  return true;
}

/** Another tab asked for a download to be stopped: done when this tab is running it. */
function stopAsked(ask: StopRequest): void {
  if (
    typeof ask?.connectionId !== 'string' ||
    typeof ask.path !== 'string' ||
    typeof ask.libraryId !== 'number'
  )
    return;
  const state = useDownloads.getState();
  const key = downloadKey(ask.connectionId, ask.libraryId, ask.path);
  if (!inProgress(state.entries[key]) || state.elsewhere[key]) return;
  if (ask.remove) void state.remove(ask.connectionId, ask.libraryId, ask.path).catch(() => {});
  else state.cancel(ask.connectionId, ask.libraryId, ask.path);
}

// Web: this tab holds the lock of each download it runs, from queued to its end, and lets
// it go once that end is saved (`tab-owner.ts`).
useDownloads.subscribe((state, prev) => {
  if (state.entries === prev.entries && state.elsewhere === prev.elsewhere) return;
  syncHeldLocks(state);
});

/** The locks of the downloads this tab runs: held while each is on its way here, let go
 * once its end is saved. Not tried while saves fail (each try is a save, at every change
 * of the entries, past `saveFailed`'s backoff): the save that lands lets them go
 * (`saveLanded`). */
function syncHeldLocks(state: DownloadsState): void {
  if (!tabsShareDownloads()) return;
  for (const [key, entry] of Object.entries(state.entries)) {
    if (inProgress(entry) && !state.elsewhere[key]) holdDownload(key);
  }
  if (state.saveFailing) return;
  for (const key of heldDownloads()) {
    if (!inProgress(state.entries[key]) || state.elsewhere[key]) {
      releaseDownloadAfter(key, endSaved(key));
    }
  }
}

/** Resolves once the end of this tab's download `key` is in the stored registry; rejects
 * when storage refused it. The lock is kept then: let go, the other tabs would read the
 * entry still stored as on its way as cut short, and empty a finished download's folder. */
async function endSaved(key: string): Promise<void> {
  await persist();
  if (inProgress(known[key])) throw new Error('not saved');
}

if (Platform.OS === 'web') onStoredChange(DOWNLOADS_KEY, followStoredRegistry);

/** The web's storage as the page's last moments can use it: `localStorage`, which is what
 * `AsyncStorage` keeps the registry in there (the same key). */
type SyncStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Web: the page is going (`pagehide`, or hidden: a phone's browser may close a hidden tab
 * with no `pagehide`). A save on its way waits for the registry's lock and its read, and a
 * closed tab never finishes it: the last file of a download, its end, a removal were lost.
 * So what this tab changed is written now, synchronously, over the stored registry read in
 * the same moment (`applyChanges`, as `persist` does), and the usual save runs too. Not under
 * the lock (nothing can wait here); another tab's save in flight can still write over it,
 * which this tab's own save then writes again (a closed tab: the next launch's read settles
 * it, as it always did). Drops wait for `persist`: their
 * files could not be removed now. A storage that refuses it changes nothing.
 */
function saveRegistryOnPageHide(storage: SyncStorage | null = webLocalStorage()): void {
  if (hydrating || !storage || !useDownloads.getState().hydrated) return;
  const live = useDownloads.getState().entries;
  if (!changedSinceKnown(live)) return;
  try {
    const raw = storage.getItem(DOWNLOADS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const saved: Registry = isRecord(parsed) ? (parsed as Registry) : {};
    applyChanges(saved, live);
    storage.setItem(DOWNLOADS_KEY, JSON.stringify(saved));
    // Not taken as saved (`known` stays): a tab only hidden lives on, and another tab's save
    // that read before this write lands over it. Its own save below writes the same changes
    // again under the lock, and a download's end lets its lock go only once that save has
    // (`endSaved`): let go on this write, the others would revive it as cut short.
  } catch {
    // Refused (full) or not readable: the save below, and its retries, still try.
  }
  void persist();
}

/** Listens for the page going on `win`/`doc` (`saveRegistryOnPageHide`); returns the stop. */
export function watchRegistryOnPageHide(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>,
  storage?: SyncStorage | null,
): () => void {
  const onPageHide = () => saveRegistryOnPageHide(storage);
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') saveRegistryOnPageHide(storage);
  };
  win.addEventListener('pagehide', onPageHide);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('pagehide', onPageHide);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined') {
  watchRegistryOnPageHide(window, document);
}

/** Save the registry within `PERSIST_EVERY_MS`: a book of many files lands one file at
 * a time, and each save writes the whole registry. A failure, completion, cancel or the
 * app leaving the foreground saves at once (`persist`), so the kept-files record of a
 * download the app is closed in the middle of still reaches storage. */
function persistSoon() {
  if (pendingSave) return;
  pendingSave = {
    timer: setTimeout(() => void persist(), PERSIST_EVERY_MS),
    watch: AppState.addEventListener('change', (state) => {
      if (state !== 'active') void persist();
    }),
  };
}

function patchEntry(key: string, patch: Partial<DownloadEntry>) {
  const cur = useDownloads.getState().entries[key];
  if (!cur) return;
  useDownloads.setState({
    entries: { ...useDownloads.getState().entries, [key]: { ...cur, ...patch } },
  });
}

/** Take a book's entry out, and save the registry (resolves once saved). */
function removeEntry(key: string): Promise<unknown> {
  const state = useDownloads.getState();
  const next = { ...state.entries };
  delete next[key];
  useDownloads.setState({ entries: next, elsewhere: without(state.elsewhere, [key]) });
  return persist();
}

/** Seed a downloaded book's item and chapters for offline reading (`seedQuery`: never
 * over an answer the cache holds, which is the server's own and at least as full - the
 * manifest's book can be the list shape; dated when the download was saved, so an online
 * screen refetches it once stale; kept past `gcTime`, so the book page still opens offline
 * long after launch). */
function seedQueryCache(
  connectionId: string,
  libraryId: number,
  path: string,
  manifest: DownloadManifest,
) {
  const savedAt = Date.parse(manifest.savedAt) || Date.now();
  seedQuery(qk.item(connectionId, libraryId, path), manifest.book, savedAt);
  if (manifest.chapters)
    seedQuery(qk.chapters(connectionId, libraryId, path), manifest.chapters, savedAt);
}

// --- the offline companion (see offline-meta.ts) ----------------------------

/** The downloads whose community metadata this session already tried to keep, by
 * download (its key and completion time, so a book removed and downloaded again tries
 * afresh): one attempt each per launch, so an unreachable server or a down metadata
 * service never turns into a retry storm. The next launch tries again. */
const metaTried = new Set<string>();

/** Whether `entry` is still the downloaded book in the registry (not removed, nor
 * replaced by a new download of it). */
function stillDownloaded(key: string, entry: DownloadEntry): boolean {
  const now = useDownloads.getState().entries[key];
  return now?.status === 'downloaded' && now.manifest.savedAt === entry.manifest.savedAt;
}

/** The keep under way for each download (`keepOfflineMeta`). */
const metaKeeps = new Map<string, Promise<void>>();

/** `force`: past this launch's earlier attempt. `job`: the finished Bridge job the keep is
 * for, recorded on the manifest's marker; a copy already kept for it is not kept again (the
 * job is read done at every launch, `refreshAfterFinish`). */
type KeepOptions = { force?: boolean; job?: number };

/** Keep a downloaded book's community metadata beside its files (best effort, once per
 * launch unless `force`): read it, save it, mark the manifest and seed the cache. One at a
 * time per download: a keep asked for while another is under way (a forced one after a
 * Bridge job, beside the launch's fill-in or the download's own) starts once that one has
 * ended, so the answer read last is the one written last. */
function keepOfflineMeta(key: string, opts: KeepOptions = {}): Promise<void> {
  const before = metaKeeps.get(key);
  const run = before
    ? before.then(() => keepOfflineMetaNow(key, opts))
    : keepOfflineMetaNow(key, opts);
  const ended = run.catch(() => {});
  metaKeeps.set(key, ended);
  void ended.then(() => {
    if (metaKeeps.get(key) === ended) metaKeeps.delete(key);
  });
  return run;
}

async function keepOfflineMetaNow(key: string, { force = false, job }: KeepOptions) {
  const entry = useDownloads.getState().entries[key];
  if (!entry || entry.status !== 'downloaded' || !engine.writeText) return;
  if (job !== undefined && entry.manifest.meta?.job === job) return;
  const attempt = `${key}@${entry.manifest.savedAt}`;
  if (metaTried.has(attempt) && !force) return;
  metaTried.add(attempt);
  // Never a cached answer from before the book named its work (a console match made since,
  // a book removed and downloaded again within the hour): that one is read again.
  const workId = entry.manifest.book.work_id;
  if (workId) staleMetaNotNaming(entry, workId);
  const payload = await captureOfflineMeta(entry);
  if (!payload || !stillDownloaded(key, entry)) return;
  if (!(await writeOfflineMeta(entry, payload))) return;
  if (!stillDownloaded(key, entry)) {
    // Removed while it was written: don't leave the file behind (a new download of the
    // book writes its own over it).
    if (!useDownloads.getState().entries[key]) void removeOfflineMeta(entry);
    return;
  }
  const { manifest } = useDownloads.getState().entries[key];
  // A keep for no job (the weekly one) leaves the job the copy was last kept for.
  const keptFor = job ?? manifest.meta?.job;
  patchEntry(key, {
    manifest: {
      ...manifest,
      meta: {
        savedAt: new Date(payload.savedAt).toISOString(),
        ...(keptFor === undefined ? {} : { job: keptFor }),
      },
    },
  });
  // Many books in a row (the launch's fill-in) save the registry once, not once each.
  persistSoon();
  seedOfflineMeta(entry.connectionId, entry.libraryId, entry.path, payload);
}

/** A kept copy older than this is read again on a launch that can reach its server, so
 * what a book carries offline follows the community's edits (new recaps, characters). */
const KEPT_META_REFRESH_MS = 7 * 24 * 60 * 60_000;

/** How many kept payloads the launch reads at once. */
const RESTORE_READS_AT_ONCE = 3;

/** On launch: seed the metadata every downloaded book kept (each connection's `/server`
 * answer, whose flag opens the readers' gate, was seeded before any screen:
 * `restoreServerSnapshots`; a file from before that answer had its own key carries it
 * over, unless one read later is kept), then fill in, one book at a time, the downloads
 * that kept none (made before this existed, or whose file is gone or unreadable), then
 * refresh the copies older than a week, and those from before the work their book names
 * whose keep did not land (`meta.rematched`). That asks only a server with `metadata`, each
 * server's flags once; a failure keeps what the book had. */
async function restoreOfflineMeta(keys: string[]): Promise<void> {
  const downloaded = keys
    .map((key) => [key, useDownloads.getState().entries[key]] as const)
    .filter((pair): pair is readonly [string, DownloadEntry] => pair[1]?.status === 'downloaded');
  const read = await mapLimit(downloaded, RESTORE_READS_AT_ONCE, async ([key, e]) => ({
    key,
    entry: e,
    payload: e.manifest.meta ? await readOfflineMeta(e) : null,
  }));
  // The `/server` answer a file from before it had its own key carries (the first such
  // file's, per connection).
  const carried = new Map<string, ServerSnapshot>();
  const missing: string[] = [];
  const old: string[] = [];
  for (const { key, entry, payload } of read) {
    if (!payload) {
      missing.push(key);
      continue;
    }
    seedOfflineMeta(entry.connectionId, entry.libraryId, entry.path, payload);
    if (payload.server && !carried.has(entry.connectionId)) {
      carried.set(entry.connectionId, payload.server);
    }
    // A copy from before the work its book names now (`adoptMatch`, as late as this
    // launch's own cached answers) is seeded stale, so a keep under way for that work reads
    // `/meta`, not this copy; and one whose keep never landed is read again below.
    const now = useDownloads.getState().entries[key]?.manifest;
    const workId = now?.book.work_id;
    const before = !!workId && !namesWork(payload.meta, workId);
    if (before) staleMetaNotNaming(entry, workId);
    if ((before && now?.meta?.rematched) || Date.now() - payload.savedAt > KEPT_META_REFRESH_MS) {
      old.push(key);
    }
  }
  // Neither replaces an answer read later (the launch's seed, the server's own).
  for (const [cid, snapshot] of carried) {
    seedServerSnapshot(cid, snapshot);
    void saveServerSnapshot(cid, snapshot);
  }
  if (missing.length === 0 && old.length === 0) return;

  await whenSessionReady();
  const hasMetadata = new Map<string, Promise<boolean>>();
  for (const key of [...missing, ...old]) {
    const e = useDownloads.getState().entries[key];
    if (!e || e.status !== 'downloaded' || !canMatch(e)) continue;
    let check = hasMetadata.get(e.connectionId);
    if (!check) {
      check = serverHasMetadata(e.connectionId);
      hasMetadata.set(e.connectionId, check);
    }
    if (await check) await keepOfflineMeta(key);
  }
}

/** Run `task` once the launch's first screens are up: when the JS thread is next idle
 * (`requestIdleCallback`, on native and most browsers), else a moment later. */
function afterLaunch(task: () => void) {
  const idle = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown;
    }
  ).requestIdleCallback;
  if (typeof idle === 'function') idle(task, { timeout: 2000 });
  else setTimeout(task, 250);
}

/**
 * Rebuild a saved entry's local file uris from the *current* storage root. The
 * on-disk filename scheme is owned here (`storedName`, else `fileName`, for audio;
 * `cover.jpg` for the cover, `book.epub` for the ebook), so the
 * (connectionId, libraryId, path, fileName) → live-uri
 * mapping lives here too; `engine.localUri` supplies the container-current absolute uri
 * (native) or the virtual cache url (web). Recomputing from the entry's own connection id
 * is also what carries a download across the identity migration, which rewrites
 * `connectionId` but not the stored uris (and moves the files on native; the web engine
 * finds them under the legacy id, `legacyIdOf`). On iOS an old `<i>.mka` is renamed to
 * `<i>.mp3` on the way (`playableName`). A no-op only for an engine without `localUri`
 * (no offline storage).
 */
async function relocateEntry(e: DownloadEntry): Promise<DownloadEntry> {
  const resolve = engine.localUri;
  if (!resolve) return e;
  const { connectionId, libraryId, path } = e;
  const at = (name: string) => resolve(connectionId, libraryId, path, name);
  const names = e.manifest.files.map((f, i) => {
    const index = savedIndex(f, i);
    return { index, name: storedName(index, f.localUri) ?? fileName(index, f.relPath) };
  });
  // A copy under a name the entry lists is never dropped (`playableName`).
  const listed = new Set(names.map((n) => n.name));
  const removeFile = engine.removeFile;
  const drop =
    removeFile &&
    (async (name: string) => {
      if (!listed.has(name)) await removeFile(connectionId, libraryId, path, name);
    });
  const files = await Promise.all(
    e.manifest.files.map(async (f, i) => {
      const { index, name } = names[i];
      return { ...f, localUri: at(await playableName(index, name, at, drop)) };
    }),
  );
  const coverUri = e.manifest.coverUri ? at(COVER_FILE) : e.manifest.coverUri;
  const ebookUri = e.manifest.ebookUri ? at(EBOOK_FILE) : undefined;
  return { ...e, manifest: { ...e.manifest, files, coverUri, ebookUri } };
}

/**
 * The name a saved file should go by now: on iOS, a `<i>.mka` an older app saved (MP3
 * bytes from a server that remuxes, or raw Matroska iOS can't play under any name) is
 * renamed on disk to the `<i>.mp3` `fileName` gives it today, so it plays after the
 * update. One a launch already renamed before the registry was saved is found under the
 * new name. With both names on disk (fe#153), the file the entry lists is the one it
 * vouches for (finished files are listed as they land), and under its old name it never
 * plays here: the other copy goes so the rename lands (`drop`, which keeps a name the entry
 * lists too). Anything that fails keeps the old name: the file is never lost.
 * Elsewhere (and for every other name) the name is kept as it is. The renamed entry is
 * saved, so each file is renamed once.
 */
async function playableName(
  index: number,
  name: string,
  at: (name: string) => string,
  drop: ((name: string) => Promise<void>) | undefined,
): Promise<string> {
  const want = fileName(index, name);
  if (want === name || !engine.renameFile) return name;
  const from = at(name);
  try {
    if (await engine.fileExists(from)) {
      if (drop && (await engine.fileExists(at(want)))) await drop(want);
      await engine.renameFile(from, want);
    }
  } catch {
    // the probe below finds the file under whichever name it has now
  }
  // Whatever the rename reported, the file goes by the name it is under now: a move that
  // landed but answered false (or threw) must not leave the entry naming a gone file,
  // which hydrate would drop and delete.
  return !(await engine.fileExists(from)) && (await engine.fileExists(at(want))) ? want : name;
}

/** A downloaded book's cover and ebook, beside its audio (never an audio file's name:
 * those are `<index>[.ext]`). */
const COVER_FILE = 'cover.jpg';
const EBOOK_FILE = 'book.epub';

/**
 * Sanitized destination filename for a file index, keeping its extension, except that on
 * iOS a `.mka` is saved as `.mp3`: a server with ffmpeg serves an MP3-in-Matroska file as
 * a lossless MP3 stream copy at the same url, and AVFoundation picks a local file's type
 * by its extension, so the bytes must not land under `.mka` there (raw Matroska from an
 * older server plays on iOS under no name). Android's Media3 sniffs the bytes and the web
 * plays by Content-Type, so they keep `.mka` and raw Matroska is never mislabelled.
 */
function fileName(index: number, relPath: string): string {
  const ext = extensionOf(relPath);
  return `${index}${Platform.OS === 'ios' && ext.toLowerCase() === '.mka' ? '.mp3' : ext}`;
}

/** A path's extension with its dot (`.mka`), or '' when its last segment has none. */
function extensionOf(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  return dot > relPath.lastIndexOf('/') ? relPath.slice(dot) : '';
}

/** The name an older app saved a file under (`<index>` plus its source's own extension)
 * when `fileName` gives it another now (iOS: a `.mka` saved as `.mp3`), else undefined. */
function olderName(name: string, relPath: string): string | undefined {
  const index = storedIndex(name);
  const older = index === undefined ? undefined : `${index}${extensionOf(relPath)}`;
  return older === name ? undefined : older;
}

/** The last segment of a stored uri: the file's name, as `storedName` reads it. */
function nameOf(localUri: string): string {
  return localUri.slice(localUri.lastIndexOf('/') + 1);
}

/**
 * The name a saved file already has on disk, read from its stored uri, when it is one
 * `fileName` could have given this index (`<index>` plus an optional extension). Relocation
 * keeps it, so a download saved under an older naming rule (an Android 2.4.x `0.mka`)
 * still resolves; anything else (no stored uri, another shape, a percent-escaped name a
 * `file://` uri carries, which is not the name on disk) falls back to `fileName`.
 */
function storedName(index: number, localUri: string): string | undefined {
  return storedIndex(localUri) === index ? nameOf(localUri) : undefined;
}

/** The index a saved file's stored name says, when it is one `fileName` could have given
 * (`<index>` plus an optional extension, as `storedName` reads it), else undefined. */
function storedIndex(localUri: string): number | undefined {
  const m = /^(\d+)(\.[^./:?#%]+)?$/.exec(nameOf(localUri));
  return m ? Number(m[1]) : undefined;
}

/** The index the file listed `k`th was saved under: the one its stored name says, else its
 * place in the list. A launch that found a file gone lists only the ones still there
 * (`reviveEntry`), so a file listed after a gone one is saved under a later index than its
 * place (fe#158). */
function savedIndex(f: DownloadedFile, k: number): number {
  return storedIndex(f.localUri) ?? k;
}

/**
 * How a retry reuses the files an earlier attempt saved (`earlier`), by path (fe#158): a file
 * the book still lists is taken wherever it now is in the list, under the name it was saved
 * by, so a server list that gained, lost or reordered a file fetches only the files that are
 * new. Each file the retry still has to fetch gets a name no kept file holds: its index when
 * that is free, else the next free number past the list (`storedIndex` reads either). `kept`
 * is the earlier file for a path, `nameFor` the name to fetch a path into, `notReached`
 * the kept files of the paths not handled yet (listed while the retry runs, and kept by a
 * failure), and `unlisted` the earlier files of paths the book no longer lists, which the
 * retry deletes (fe#354): no manifest names them again, so nothing else would.
 */
function retryPlan(
  earlier: readonly DownloadedFile[],
  paths: readonly string[],
): {
  kept: (path: string) => DownloadedFile | undefined;
  nameFor: (index: number, path: string) => string;
  notReached: (handled: ReadonlySet<string>) => DownloadedFile[];
  unlisted: DownloadedFile[];
} {
  const listed = new Set(paths);
  const byPath = new Map<string, DownloadedFile>();
  // The names a kept file holds, by the index its name says: never fetched over.
  const held = new Map<number, string>();
  earlier.forEach((f, k) => {
    if (!listed.has(f.relPath) || byPath.has(f.relPath)) return;
    byPath.set(f.relPath, f);
    held.set(savedIndex(f, k), f.relPath);
  });
  let spare = Math.max(paths.length, ...[...held.keys()].map((i) => i + 1));
  return {
    kept: (path) => byPath.get(path),
    nameFor: (index, path) => {
      // Its own name is free to write over (the file is gone, or the fetch replaces it).
      const owner = held.get(index);
      if (owner === undefined || owner === path) return fileName(index, path);
      while (held.has(spare)) spare++;
      const name = fileName(spare, path);
      held.set(spare++, path);
      return name;
    },
    notReached: (handled) => [...byPath.values()].filter((f) => !handled.has(f.relPath)),
    // Never a name a kept file is under.
    unlisted: earlier.filter(
      (f) =>
        !listed.has(f.relPath) &&
        ![...byPath.values()].some((k) => nameOf(k.localUri) === nameOf(f.localUri)),
    ),
  };
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    // Taken off before it runs: the same book queued again while it runs (a cancel, then
    // Download) waits its own turn instead of being taken off with it.
    let key: string | undefined;
    while ((key = queue.shift()) !== undefined) {
      const entry = useDownloads.getState().entries[key];
      if (entry && entry.status !== 'downloaded') await runOne(key);
    }
  } finally {
    running = false;
  }
}

async function runOne(key: string) {
  const entry = useDownloads.getState().entries[key];
  if (!entry) return;
  // Resolve the download's OWN server client, so two servers' queued downloads never
  // race a shared client. A removed connection errors the entry rather than downloading.
  const api = resolveClient(entry.connectionId);
  if (!api) {
    patchEntry(key, {
      status: 'error',
      error: 'Server connection removed',
      failure: { kind: 'removed' },
    });
    void persist();
    return;
  }
  const { connectionId, libraryId, path } = entry;
  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  // Still the book's live run (see `controllers`).
  const live = () => controllers.get(key) === ctrl;
  const patch = (p: Partial<DownloadEntry>) => {
    if (live()) patchEntry(key, p);
  };
  // A stopped run's files go: whoever stopped it deleted the book, but a write can land after
  // that delete (a transfer finishing, the EPUB's copy, which no signal stops). Awaited, so
  // a new download of the book (it runs after this one) starts clean.
  const dropFiles = () => engine.removeBook(connectionId, libraryId, path).catch(() => {});
  patch({ status: 'downloading', progress: 0, bytes: 0 });
  void persist();
  // Beside the transfer, the place the download opens at offline (v2.5.1 PLAYER-01): the
  // book has a downloads entry now, so the server's answer goes into the progress mirror, and
  // the book's first offline save starts there instead of at 0 over the server's place. A
  // server with no record, or one that can't be reached, leaves the mirror as it is; the
  // book's next progress read keeps the place.
  void fetchServerProgress(api, connectionId, libraryId, path, ctrl.signal).catch(() => {});

  // The files that finished, so a failure can keep them, and how many there are.
  const files: DownloadedFile[] = [];
  let fileCount = 0;
  // Files a failed attempt already finished, reused by path (`retryPlan`), and the paths this
  // attempt has handled (kept, fetched, or being fetched).
  const earlier = entry.manifest.files;
  let plan: ReturnType<typeof retryPlan> | null = null;
  const handled = new Set<string>();
  try {
    const specs = bookFileSpecs(entry.manifest.book, entry.manifest.chapters ?? undefined);
    fileCount = specs.length;
    plan = retryPlan(
      earlier,
      specs.map((s) => s.path),
    );
    for (const gone of plan.unlisted) {
      await engine
        .removeFile?.(connectionId, libraryId, path, nameOf(gone.localUri))
        .catch(() => {});
    }
    // The ebook (Bridge Phase 3b-2) is one more step after the audio, and its size counts in
    // the total: 100% is the whole download, and the bytes kept include it. So is the
    // read-along map the book will likely take (its size counts once it is in, fe#193).
    const ebook = entry.manifest.book.ebook;
    const serves = cachedCapability(connectionId, 'readalong');
    const mapLikely = !!ebook && wantsReadalong(serves, entry.manifest.book, EBOOK_FILE);
    const steps = specs.length + (ebook ? 1 : 0) + (mapLikely ? 1 : 0);
    // The sizes the book lists, each file's replaced by what it came to once it is here (an
    // MP3-in-Matroska file's remuxed stream is smaller than the file it lists, fe#153); 0
    // while one is unknown.
    let knownTotal = specs.every((s) => s.size > 0)
      ? specs.reduce((sum, s) => sum + s.size, 0) + (ebook?.size ?? 0)
      : 0;
    let priorBytes = 0;
    /** A file here: `got` bytes of the `listed` the book gave it, in both running counts. */
    const land = (listed: number, got: number) => {
      priorBytes += got;
      if (knownTotal > 0) knownTotal += got - listed;
    };

    // The book's extras beside its audio: optional (a failure never fails the audio
    // download, the book carries on without it), but a cancel during one cancels the book.
    const extra = async (
      name: string,
      url: string,
      headers?: Record<string, string>,
      onProgress?: (bytesWritten: number, totalBytes: number) => void,
    ) => {
      try {
        return await engine.downloadFile(
          connectionId,
          libraryId,
          path,
          name,
          url,
          onProgress,
          ctrl.signal,
          headers,
        );
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        return undefined;
      }
    };
    // The cover and the audio carry the token in the URL; a server behind an auth proxy
    // also takes the connection's proxy headers (fe#167, never stored with the download).
    const coverUrl = api.coverUrl(libraryId, path);
    const coverUri = (await extra(COVER_FILE, coverUrl, api.proxyHeadersFor(coverUrl))) ?? null;

    let lastTick = 0;
    /** A progress tick, at most every PROGRESS_EVERY_MS: `step` steps done (fractional). */
    const tick = (step: number, bytes: number) => {
      const now = Date.now();
      if (now - lastTick < PROGRESS_EVERY_MS) return;
      lastTick = now;
      patch({ bytes, totalBytes: knownTotal, progress: step / steps });
    };
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      handled.add(s.path);
      const done = plan.kept(s.path);
      if (done && (await engine.fileExists(done.localUri))) {
        files.push(done);
        // An older app listed a file whose engine reported nothing as 0 bytes: the size the
        // book lists stands in, or the finished total (now these bytes) comes out short.
        land(s.size, done.bytes || s.size);
        patch({ bytes: priorBytes, totalBytes: knownTotal, progress: (i + 1) / steps });
        continue;
      }
      let curBytes = 0;
      const fileUrl = api.streamUrl(libraryId, s.path, true);
      const name = plan.nameFor(i, s.path);
      const localUri = await engine.downloadFile(
        connectionId,
        libraryId,
        path,
        name,
        fileUrl,
        (bytesWritten, totalBytes) => {
          curBytes = bytesWritten;
          tick(i + (totalBytes > 0 ? bytesWritten / totalBytes : 0), priorBytes + bytesWritten);
        },
        ctrl.signal,
        api.proxyHeadersFor(fileUrl),
      );
      // What the server sent, which an MP3-in-Matroska file's remuxed stream makes smaller
      // than the size the book lists (fe#153); that size only for an engine that said none.
      const got = curBytes > 0 ? curBytes : s.size;
      land(s.size, got);
      files.push({ relPath: s.path, localUri, bytes: got });
      // A partial copy an older app left under the name this file had then (an iOS 2.4.x
      // download cut short in a `<i>.mka`, fe#153) goes, unless a kept file is under it.
      const older = olderName(name, s.path);
      if (older && !earlier.some((f) => nameOf(f.localUri) === older))
        await engine.removeFile?.(connectionId, libraryId, path, older);
      // List each finished file as it lands, so a download the app is closed in the
      // middle of keeps them across the restart (`reviveEntry`). Kept files of the paths
      // not reached yet stay listed (`retryPlan` never fetches over them).
      const cur = useDownloads.getState().entries[key];
      if (cur && live()) {
        patchEntry(key, {
          bytes: priorBytes,
          totalBytes: knownTotal,
          progress: (i + 1) / steps,
          manifest: { ...cur.manifest, files: [...files, ...plan.notReached(handled)] },
        });
        persistSoon();
      }
    }

    // The book's ebook, so the reader opens it offline. After the audio: an attempt that
    // fails on the audio never fetches it, so a retry fetches it once. The app reader's
    // cached copy for this size is taken as it is (the reader already fetched the book);
    // else it is fetched, its route taking the Authorization header only, never `?token=`.
    let ebookUri: string | undefined;
    let ebookBytes = 0;
    if (ebook) {
      const cached = await cachedEbookUri({
        connectionId,
        libraryId,
        path,
        size: ebook.size,
      }).catch(() => null);
      if (cached && engine.copyFile) {
        ebookUri = await engine
          .copyFile(connectionId, libraryId, path, EBOOK_FILE, cached)
          .catch(() => undefined);
      }
      if (!ebookUri) {
        const { url, headers } = api.ebookRequest(libraryId, path);
        ebookUri = await extra(EBOOK_FILE, url, headers, (bytesWritten, totalBytes) => {
          ebookBytes = bytesWritten;
          tick(
            specs.length + (totalBytes > 0 ? bytesWritten / totalBytes : 0),
            priorBytes + bytesWritten,
          );
        });
      }
      // A copied EPUB, or an engine that reported no progress: the server's size stands in.
      ebookBytes = ebookUri ? ebookBytes || ebook.size : 0;
    }
    // The book's read-along map (Bridge Phase 3c), beside the EPUB it follows: optional too.
    // The capability as it is now, not as it was before the audio (a download resumed at
    // launch can start before the server's answer is cached).
    // No ebook to check against yet (the map names it), so none is refused here.
    let readalong: KeptReadalong | undefined;
    const servesNow = cachedCapability(connectionId, 'readalong');
    if (wantsReadalong(servesNow, entry.manifest.book, ebookUri)) {
      readalong = keptOf(
        await fetchReadalongFile(api, { connectionId, libraryId, path }, { signal: ctrl.signal }),
      );
    }
    const mapBytes = readalong?.bytes ?? 0;
    // Once it is all here, its total is what it holds: the bytes each file came to (not the
    // sizes the book lists, fe#153), without an ebook whose fetch failed, with the map.
    const bytes = priorBytes + ebookBytes + mapBytes;

    // With what an `/item` answer that landed while the files did says the book is found by.
    const book = withCachedMatch(entry, entry.manifest.book);
    // With the server's chapters answer when one landed while the files did.
    const manifest = withCachedChapters(entry, {
      ...entry.manifest,
      files,
      coverUri,
      ebookUri,
      readalongGeneratedAt: readalong?.generatedAt,
      readalongBytes: readalong?.bytes,
      ebookSha256: readalong?.ebookSha256,
      book: namingReadalong(book, readalong?.generatedAt),
      savedAt: new Date().toISOString(),
    });

    // Stopped while its last file (or the EPUB's copy) landed.
    if (!live()) return void (await dropFiles());

    // Don't claim "downloaded" unless the file can really be played back offline.
    // On web the bytes are cached but only playable once the service worker controls
    // the page; mark an error (keeping the bytes for a retry) so the badge can't lie.
    if (engine.verify && files.length > 0 && !(await engine.verify(files[0].localUri))) {
      patch({
        status: 'error',
        error: 'Saved, but offline playback isn’t ready yet - reload the app, then retry.',
        failure: { kind: 'unservable' },
        progress: 1,
        bytes,
        totalBytes: bytes,
        manifest,
      });
      void persist();
      return;
    }
    if (!live()) return void (await dropFiles());

    patchEntry(key, { status: 'downloaded', progress: 1, bytes, totalBytes: bytes, manifest });
    void persist();
    seedQueryCache(connectionId, libraryId, path, manifest);
    // Keep its community metadata for offline use, after the download and apart from it:
    // a failure there never fails (or holds up) the book.
    keepOfflineMeta(key).catch(() => {});
  } catch (e) {
    // Cancelled only when this download's own signal aborted (`cancel`, `remove`, a removed
    // connection), whatever the error says: Android reports a dropped connection as
    // "Software caused connection abort", which is a failure like any other.
    if (ctrl.signal.aborted) {
      // Whoever stopped it dropped the entry, and the book may be queued again already: only
      // the files go.
      await dropFiles();
    } else if (live()) {
      // Keep the files that finished: a retry skips them, so a failure 41% through a
      // multi-file book doesn't throw that 41% away. (The one being written is partial,
      // and is written over by the retry.) So are the files an earlier attempt saved for
      // the paths this one never reached (a download with a file gone, fe#158: a retry that
      // fails on the gone file must not unlist the rest).
      const held = [...files, ...(plan ? plan.notReached(handled) : earlier)];
      // Nothing finished: what the folder holds is partial, emptied now rather than by a
      // launch (the web's leaves a row saved with no file alone, fe#197). Before the row
      // shows the failure, so a Retry starts after it.
      if (held.length === 0) {
        await dropFiles();
        if (!live()) return;
      }
      const kept = fileCount > 0 ? Math.min(1, held.length / fileCount) : 0;
      const failure: DownloadFailure = { ...classifyDownloadError(e), kept };
      const cur = useDownloads.getState().entries[key];
      patchEntry(key, {
        status: 'error',
        error: e instanceof Error ? e.message : 'Download failed',
        failure,
        ...(cur ? { manifest: { ...cur.manifest, files: held } } : {}),
      });
      void persist();
    }
  } finally {
    if (live()) controllers.delete(key);
  }
}

/** When each removed connection was last removed here: its downloads saved before then are
 * never shown here again from another tab's save of them (that tab may not know of the
 * removal). A later removal covers an earlier one. */
const removals = new Map<string, string>();

/** A removed connection's downloads another tab was running, by key, with when it was
 * removed (`purgeWhenLeft`): never shown here, by key, not by `savedAt` (the end of one saved
 * there is stamped after the removal). One saved there on its way since the removal is a
 * download started again (signed in again, a retry): no longer this purge's. */
const purging = new Map<string, string>();

/** Whether `connectionId` was removed here (`removals`) and is not signed in again since. */
const removedConnection = (connectionId: string) =>
  removals.has(connectionId) && !resolveClient(connectionId);

/** Whether another tab's save of `e` (the stored entry of `key`) is a removed connection's,
 * not shown here. */
function ofRemovedConnection(key: string, e: DownloadEntry): boolean {
  const purgeAt = purging.get(key);
  if (purgeAt !== undefined) {
    if (!(inProgress(e) && e.manifest.savedAt > purgeAt)) return true;
    purging.delete(key);
    return false;
  }
  const removedAt = removals.get(e.connectionId);
  return removedAt !== undefined && !(e.manifest.savedAt > removedAt);
}

// Removing a connection purges its downloads: abort any in-flight transfer, delete the
// files, and drop the entries (signing out of an account takes its downloads with it;
// nothing else would ever reach them).
onConnectionRemoved(async (id) => {
  // Before the launch's read the live entries are not the registry: the read would merge the
  // connection's stored downloads back in after this purge, live and unsaved.
  if (hydrating) await hydrating;
  // The drop can wait across saves storage refused (`dropsWaiting`): a download of the same
  // connection made since (signed in again: the same `<server>.<user>` id) is not this purge's.
  const removedAt = new Date().toISOString();
  const removed = (e: DownloadEntry) => e.connectionId === id && !(e.manifest.savedAt > removedAt);
  removals.set(id, removedAt);
  // Web: the connection's downloads another tab is running (it holds their lock,
  // `tab-owner.ts`) are that tab's to stop: their folders are being written there. That tab
  // runs this purge too (the session tells every tab of the removal), and each goes from the
  // registry here once it let it go (`purgeWhenLeft`), should that tab not get to it.
  const away = new Set([...(await downloadsRunningElsewhere())].filter((key) => isKeyOf(key, id)));
  const state = useDownloads.getState();
  const doomed = Object.entries(state.entries).filter(([, e]) => e.connectionId === id);
  const mine = doomed.filter(([key]) => !away.has(key));
  if (doomed.length > 0) {
    const next = { ...state.entries };
    for (const [key] of doomed) delete next[key];
    for (const [key] of mine) stopRun(key);
    // The other tab's are not this tab's to save either way: its save of their end, or of
    // their removal, stands.
    known = without(known, [...away]);
    useDownloads.setState({
      entries: next,
      elsewhere: without(
        state.elsewhere,
        doomed.map(([key]) => key),
      ),
    });
  }
  for (const key of away) {
    purging.set(key, removedAt);
    void purgeWhenLeft(key, removedAt).catch(() => {});
  }
  await removeEntryFiles(mine.map(([, e]) => e));
  // The stored registry is every tab's: the connection's downloads this tab did not hold
  // (another tab's, finished) go from it too, and then their files (`persist`).
  await persist((e) => removed(e) && !away.has(contentKeyOf(e)));
});

/**
 * A removed connection's download another tab was running (`key`): once that tab let it go
 * (it removed it, running this purge itself; it ended first; or it closed), what the
 * registry still holds of it goes, and its files with it (`persist`'s drop of an entry this
 * tab does not hold). By key, not by `savedAt`: a download that ended there was saved again
 * as it ended, after the removal (`purging`, which keeps that save from showing here
 * meanwhile). Unless the book's download was started again since, here or there (signed in
 * again, a retry).
 */
async function purgeWhenLeft(key: string, removedAt: string): Promise<void> {
  await whenDownloadLeft(key);
  // Started again since (`purging`): not this purge's.
  if (purging.get(key) !== removedAt) return;
  // Taken up again there meanwhile, its start not saved yet: wait for its end.
  if ((await downloadsRunningElsewhere()).has(key)) return purgeWhenLeft(key, removedAt);
  await persist(
    (e) =>
      purging.get(key) === removedAt &&
      contentKeyOf(e) === key &&
      !useDownloads.getState().entries[key] &&
      // One saved on its way since the removal: started again, before its lock was held.
      !(inProgress(e) && e.manifest.savedAt > removedAt),
  );
  if (purging.get(key) === removedAt) purging.delete(key);
}

// --- selectors -------------------------------------------------------------

/** Web: whether the book's download is on its way in another tab of this browser. */
export function useDownloadElsewhere(
  connectionId: string,
  libraryId: number,
  path: string,
): boolean {
  return useDownloads((s) => !!s.elsewhere[downloadKey(connectionId, libraryId, path)]);
}

export function useDownloadEntry(
  connectionId: string,
  libraryId: number,
  path: string,
): DownloadEntry | undefined {
  return useDownloads((s) => s.entries[downloadKey(connectionId, libraryId, path)]);
}

/** The bytes a book's download holds on the device (`entryBytes`; 0 with no entry): the one
 * figure the Downloaded menu and the remove confirmation give (fe#197). */
export function useDownloadBytes(connectionId: string, libraryId: number, path: string): number {
  return useDownloads((s) => {
    const e = s.entries[downloadKey(connectionId, libraryId, path)];
    return e ? entryBytes(e) : 0;
  });
}

/** A book's entry in `entries` when it is fully downloaded, else undefined: the one
 * "counts as downloaded" rule the selectors below and `downloadedEntryOf` share. */
function downloadedIn(
  entries: Registry,
  connectionId: string,
  libraryId: number,
  path: string,
): DownloadEntry | undefined {
  const e = entries[downloadKey(connectionId, libraryId, path)];
  return e?.status === 'downloaded' ? e : undefined;
}

// The narrow selectors below return one primitive (or, the last two, a shallow-compared
// handful), so the entry patches a running download makes every PROGRESS_EVERY_MS
// re-render nothing until the value changes.
// Prefer them to `useDownloadEntry` wherever the caller needs no progress: a whole book
// page or every cover of the book on screen re-rendering 4 times a second is the cost.

/** Whether the book is fully downloaded. */
export function useIsDownloaded(connectionId: string, libraryId: number, path: string): boolean {
  return useDownloads((s) => downloadedIn(s.entries, connectionId, libraryId, path) !== undefined);
}

/** The cover a finished download of the book holds (its `manifest.coverUri`), else null. */
export function useDownloadedCoverUri(
  connectionId: string,
  libraryId: number,
  path: string,
): string | null {
  return useDownloads(
    (s) => downloadedIn(s.entries, connectionId, libraryId, path)?.manifest.coverUri ?? null,
  );
}

/** The EPUB a finished download of the book holds (its `manifest.ebookUri`), else
 * undefined. A string, so a download's progress ticks re-render nothing (the reader). */
export function useDownloadedEbook(
  connectionId: string,
  libraryId: number,
  path: string,
): string | undefined {
  return useDownloads(
    (s) => downloadedIn(s.entries, connectionId, libraryId, path)?.manifest.ebookUri || undefined,
  );
}

/** The `generated_at` of the read-along map a finished download of the book keeps beside
 * its EPUB (`manifest.readalongGeneratedAt`), else undefined. A string, so a download's
 * progress ticks re-render nothing. */
export function useDownloadedReadalong(
  connectionId: string,
  libraryId: number,
  path: string,
): string | undefined {
  return useDownloads((s) => {
    const m = downloadedIn(s.entries, connectionId, libraryId, path)?.manifest;
    return (m?.ebookUri && m.readalongGeneratedAt) || undefined;
  });
}

/** The sha256 of the ebook a finished download of the book holds (`manifest.ebookSha256`),
 * else undefined (no EPUB downloaded, or no map ever kept to say): a map made from another
 * ebook never reaches the reader of this copy (fe#193). */
export function useDownloadedEbookSha(
  connectionId: string,
  libraryId: number,
  path: string,
): string | undefined {
  return useDownloads((s) => {
    const m = downloadedIn(s.entries, connectionId, libraryId, path)?.manifest;
    return (m?.ebookUri && m.ebookSha256) || undefined;
  });
}

/** The server's size of the EPUB a finished download of the book holds, as its book said
 * when it was saved (`manifest.book.ebook.size`), else undefined (no EPUB downloaded). With
 * no `ebookSha256` known, a server ebook of another size is another ebook (fe#193), as
 * `refreshReadalong` takes it. */
export function useDownloadedEbookSize(
  connectionId: string,
  libraryId: number,
  path: string,
): number | undefined {
  return useDownloads((s) => {
    const m = downloadedIn(s.entries, connectionId, libraryId, path)?.manifest;
    return m?.ebookUri ? m.book.ebook?.size : undefined;
  });
}

/** The read-along map a finished download of the book keeps, read and checked, else null
 * (none kept, gone, or no map). */
export function readDownloadedReadalong(ref: BookRef) {
  const m = downloadedEntryOf(ref)?.manifest;
  return m?.ebookUri && m.readalongGeneratedAt ? readReadalongFile(ref) : Promise.resolve(null);
}

/** A book's download status (undefined: none) and a failed one's cause: what a control
 * needs to pick its state and say what went wrong (`failureText`). Shallow-compared, so
 * progress ticks re-render nothing (a book's actions menu, `useDownloadControls`);
 * `useDownloadProgress` carries the numbers. */
export function useDownloadState(
  connectionId: string,
  libraryId: number,
  path: string,
): { status: DownloadStatus | undefined; failure: DownloadFailure | undefined } {
  return useDownloads(
    useShallow((s) => {
      const e = s.entries[downloadKey(connectionId, libraryId, path)];
      return { status: e?.status, failure: e?.failure };
    }),
  );
}

/** A podcast episode's download while it waits for its server to fetch it (`serverFetch`):
 * how far that fetch is (a whole percent, null while the size is unknown); undefined when
 * the download is not waiting there (none, on the queue, running, done or failed). */
export function useDownloadServerFetch(
  connectionId: string,
  libraryId: number,
  path: string,
): number | null | undefined {
  return useDownloads((s) => {
    const e = s.entries[downloadKey(connectionId, libraryId, path)];
    return e?.status === 'queued' && e.serverFetch ? e.serverFetch.percent : undefined;
  });
}

/** A book's download progress (0..1) and bytes so far over the total, all 0 without a
 * download. Changes on every tick: only for what draws the progress itself. */
export function useDownloadProgress(
  connectionId: string,
  libraryId: number,
  path: string,
): { progress: number; bytes: number; totalBytes: number } {
  return useDownloads(
    useShallow((s) => {
      const e = s.entries[downloadKey(connectionId, libraryId, path)];
      return { progress: e?.progress ?? 0, bytes: e?.bytes ?? 0, totalBytes: e?.totalBytes ?? 0 };
    }),
  );
}

/** A book's registry entry when it is fully downloaded, else undefined: the non-hook
 * read for the framework-free callers (the player store, the car). */
export function downloadedEntryOf(ref: {
  connectionId: string;
  libraryId: number;
  path: string;
}): DownloadEntry | undefined {
  return downloadedIn(useDownloads.getState().entries, ref.connectionId, ref.libraryId, ref.path);
}

/** How many fully-downloaded books belong to a connection - the count the removal
 * warnings quote (removing a connection purges its downloads). One definition so the
 * "counts as a download worth warning about" rule can't drift between screens. */
export function downloadedCountFor(entries: Registry, connectionId: string): number {
  return Object.values(entries).filter(
    (e) => e.connectionId === connectionId && e.status === 'downloaded',
  ).length;
}
