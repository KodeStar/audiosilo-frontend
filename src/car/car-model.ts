import type { TFunction } from 'i18next';

import type { SourcedProgress } from '@/api/hooks';
import type { Book, Progress } from '@/api/types';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';
import { contentKeyOf } from '@/lib/content-key';
import { bookTitle } from '@/lib/paths';
import { isInProgress } from '@/lib/progress-view';
import { buildBookQueue, locate } from '@/playback/book-queue';
import type { ResumeLookup } from '@/playback/progress-sync';
import { clampRate } from '@/playback/rate';
import { bookSpeed, formatTimeLeft, timeLeft } from '@/playback/time-left';

import type {
  BookRef,
  NativeChapter,
  NativeTrack,
} from '../../modules/audiosilo-player/src/AudiosiloPlayer.types';

/**
 * The car snapshot (Phase 6 contract, section 3): what CarPlay and Android Auto list, built
 * by JS because native has no strings, no session and no server of its own. Pure and
 * framework-free; `car-controller.ts` gathers the inputs (the progress lists, the queue, the
 * downloads registry, the selected library, the artwork files, the resume lookups) and hands
 * the JSON to native.
 */

export type CarTabId = 'continue' | 'upnext' | 'downloads' | 'library';

/** Every string the car shows. Native has none of its own. */
export type CarLabels = {
  continue: string;
  upNext: string;
  downloads: string;
  library: string;
  chapters: string;
  bookmark: string;
  bookmarkSaved: string;
  /** An empty tab. */
  empty: string;
  /** No server signed in. */
  signedOut: string;
  /** A play request that failed or timed out. */
  unavailable: string;
};

/** How a downloaded book starts on Android with no JS running: file URLs only, no headers,
 * so no session token ever leaves expo-secure-store for the car. */
export type CarPlaySpec = {
  book: BookRef;
  tracks: NativeTrack[];
  /** `buildChapterClips` output (`[]`: one item per file). */
  chapters: NativeChapter[];
  startIndex: number;
  positionInTrack: number;
  rate: number;
};

export type CarItem = {
  id: string;
  title: string;
  /** The author, then the time left at the book's own speed once started. */
  subtitle: string;
  /** 0..1, null when not started. */
  progress: number | null;
  finished: boolean;
  downloaded: boolean;
  /** A `file://` JPEG the app wrote under the car artwork folder, else null. */
  artwork: string | null;
  /** Only for a downloaded book. */
  play?: CarPlaySpec;
};

export type CarTab = { id: CarTabId; title: string; items: CarItem[] };

export type CarSnapshot = {
  version: 1;
  generatedAt: string;
  labels: CarLabels;
  signedIn: boolean;
  tabs: CarTab[];
};

/** The most items each tab carries (Android Auto doesn't page; CarPlay trims further to its
 * own `maximumItemCount`). */
export const CAR_TAB_LIMITS: Record<CarTabId, number> = {
  continue: 20,
  upnext: 20,
  downloads: 50,
  library: 50,
};

const TAB_ORDER: readonly CarTabId[] = ['continue', 'upnext', 'downloads', 'library'];

// --- Item ids -------------------------------------------------------------------------

const ID_PREFIX = 'book:';

/** A car item's id: `book:` and the URI-encoded connection id, library id and path joined by
 * `:` (encoding turns every `:` inside them into `%3A`, so the split is unambiguous). Path is
 * the identity, scoped by connection: never a database id. */
export function carItemId(ref: BookRef): string {
  return (
    ID_PREFIX +
    [ref.connectionId, String(ref.libraryId), ref.path].map(encodeURIComponent).join(':')
  );
}

/** The book a car item id names, or null for anything that isn't one. */
export function parseCarItemId(id: string): BookRef | null {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return null;
  const parts = id.slice(ID_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null; // a malformed escape
  }
  const [connectionId, lib, path] = decoded;
  const libraryId = Number(lib);
  if (!connectionId || !path || !/^\d+$/.test(lib) || !Number.isSafeInteger(libraryId)) {
    return null;
  }
  return { connectionId, libraryId, path };
}

// --- Labels ---------------------------------------------------------------------------

/** The car's strings in the app's language (namespace `car`). */
export function carLabels(t: TFunction): CarLabels {
  return {
    continue: t('car.continue'),
    upNext: t('car.upNext'),
    downloads: t('car.downloads'),
    library: t('car.library'),
    chapters: t('car.chapters'),
    bookmark: t('car.bookmark'),
    bookmarkSaved: t('car.bookmarkSaved'),
    empty: t('car.empty'),
    signedOut: t('car.signedOut'),
    unavailable: t('car.unavailable'),
  };
}

// --- The lists ------------------------------------------------------------------------

/** A book as a tab lists it: where it lives, and what the app knows of it (its item, else
 * null: the title then comes from its path; its saved progress row, else null). */
export type CarBook = { ref: BookRef; book: Book | null; progress: Progress | null };

/** A progress row's book. */
const rowRef = (p: SourcedProgress): BookRef => ({
  connectionId: p.connectionId,
  libraryId: p.library_id,
  path: p.path,
});

/**
 * Continue listening, Home's rule (`isInProgress`, newest first, every signed-in server):
 * the loaded book first (Home's Now card, also before its first save reaches the list),
 * then the other books in progress, `CAR_TAB_LIMITS.continue` at most. Refs only; the
 * controller finds each book's item.
 */
export function continueRefs(
  rows: readonly SourcedProgress[],
  loaded: BookRef | null,
): { ref: BookRef; progress: Progress | null }[] {
  const inProgress = [...rows]
    .filter(isInProgress)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const out: { ref: BookRef; progress: Progress | null }[] = [];
  const seen = new Set<string>();
  const push = (ref: BookRef, progress: Progress | null) => {
    const key = contentKeyOf(ref);
    if (seen.has(key) || out.length >= CAR_TAB_LIMITS.continue) return;
    seen.add(key);
    out.push({ ref, progress });
  };
  if (loaded) {
    const key = contentKeyOf(loaded);
    push(loaded, rows.find((r) => contentKeyOf(rowRef(r)) === key) ?? null);
  }
  for (const row of inProgress) push(rowRef(row), row);
  return out;
}

/** The downloaded books, newest download first, `CAR_TAB_LIMITS.downloads` at most. */
export function downloadedEntries(entries: Record<string, DownloadEntry>): DownloadEntry[] {
  return Object.values(entries)
    .filter((e) => e.status === 'downloaded')
    .sort((a, b) => b.manifest.savedAt.localeCompare(a.manifest.savedAt))
    .slice(0, CAR_TAB_LIMITS.downloads);
}

// --- Items ----------------------------------------------------------------------------

/** The loaded book's live place (the player's position, timeline and speed). */
export type LivePlace = { ref: BookRef; position: number; total: number; rate: number };

/** What every item is built with. */
export type CarItemContext = {
  t: TFunction;
  /** The listener's default speed (a book with no saved speed plays at it). */
  defaultRate: number;
  /** The loaded book's live place, else null. */
  live: LivePlace | null;
  isDownloaded: (ref: BookRef) => boolean;
  artworkFor: (ref: BookRef) => string | null;
  /** The play spec of a downloaded book (undefined for any other). */
  playFor: (ref: BookRef) => CarPlaySpec | undefined;
};

type Place = { position: number; total: number; finished: boolean; speed: number };

/** Where the listener is in a book: the live place for the loaded one, else its saved row. */
function placeOf(b: CarBook, ctx: CarItemContext): Place | null {
  const total = (t: number) => (t > 0 ? t : (b.book?.duration ?? 0));
  if (ctx.live && contentKeyOf(ctx.live.ref) === contentKeyOf(b.ref)) {
    return {
      position: ctx.live.position,
      total: total(ctx.live.total),
      finished: false,
      speed: ctx.live.rate,
    };
  }
  const p = b.progress;
  if (!p) return null;
  return {
    position: p.position,
    total: total(p.duration),
    finished: p.finished,
    speed: bookSpeed(p.playback_speed, ctx.defaultRate),
  };
}

/** One list row. */
export function carItem(b: CarBook, ctx: CarItemContext): CarItem {
  const place = placeOf(b, ctx);
  const started = !!place && (place.finished || place.position > 0);
  const finished = !!place?.finished;
  const progress = !started
    ? null
    : finished
      ? 1
      : place.total > 0
        ? Math.min(1, Math.max(0, place.position / place.total))
        : 0;
  const author = b.book?.author || b.book?.narrator || '';
  const left =
    started && !finished
      ? formatTimeLeft(ctx.t, timeLeft(place.position, place.total, place.speed))
      : '';
  const subtitle = author && left ? ctx.t('car.subtitle', { author, left }) : author || left || '';
  const downloaded = ctx.isDownloaded(b.ref);
  const play = downloaded ? ctx.playFor(b.ref) : undefined;
  return {
    id: carItemId(b.ref),
    title: bookTitle(b.book?.title, b.ref.path),
    subtitle,
    progress,
    finished,
    downloaded,
    artwork: ctx.artworkFor(b.ref),
    ...(play ? { play } : {}),
  };
}

// --- Play specs -----------------------------------------------------------------------

/** The local files a downloaded book plays from (the same map the player store builds for
 * it, `localFromManifest`). */
function localFiles(manifest: DownloadManifest) {
  return {
    files: new Map(manifest.files.map((f) => [f.relPath, f.localUri] as const)),
    artwork: manifest.coverUri ?? undefined,
  };
}

/**
 * How Android starts a downloaded book with no JS: its queue exactly as `playBook` builds it
 * for a downloaded book (`buildBookQueue` over the local files, the chapter clips), at the
 * place `playBook` would resume it from. `lookup` is `loadInitialProgress`'s answer (the
 * newest of the server row, the local mirror and the offline queue), read the way `playBook`
 * reads it: an unfinished book resumes at its saved place, a finished one starts again at 0,
 * and its saved speed wins over the default. Undefined when a file has no local copy.
 */
export function playSpec(
  ref: BookRef,
  manifest: DownloadManifest,
  lookup: ResumeLookup,
  defaultRate: number,
  virtualChapterInterval: number,
): CarPlaySpec | undefined {
  const queue = buildBookQueue(
    null,
    ref.libraryId,
    manifest.book,
    manifest.chapters ?? undefined,
    localFiles(manifest),
    virtualChapterInterval,
  );
  if (queue.tracks.length === 0 || queue.tracks.some((t) => !t.url)) return undefined;
  let startAt = 0;
  let speed = clampRate(defaultRate > 0 ? defaultRate : 1);
  if (lookup.kind === 'progress') {
    const p = lookup.progress;
    if (!p.finished && p.position > 0) startAt = p.position;
    if (p.playback_speed > 0) speed = clampRate(p.playback_speed);
  }
  const { index, positionInTrack } = locate(queue.offsets, startAt);
  return {
    book: { connectionId: ref.connectionId, libraryId: ref.libraryId, path: ref.path },
    tracks: queue.tracks.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      album: t.album,
      artist: t.artist,
      artwork: t.artwork,
      duration: t.duration,
    })),
    chapters: queue.chapterClips,
    startIndex: index,
    positionInTrack,
    rate: speed,
  };
}

// --- The snapshot ---------------------------------------------------------------------

export type CarSnapshotInput = {
  generatedAt: string;
  labels: CarLabels;
  signedIn: boolean;
  /** Each tab's books in order. `upnext` null: the default server keeps no queue, so the
   * tab is left out. */
  books: Record<Exclude<CarTabId, 'upnext'>, CarBook[]> & { upnext: CarBook[] | null };
};

const TAB_TITLE: Record<CarTabId, keyof CarLabels> = {
  continue: 'continue',
  upnext: 'upNext',
  downloads: 'downloads',
  library: 'library',
};

/** The snapshot: the four tabs in order (Up next only where the queue exists), each
 * deduplicated by book and trimmed to its limit. Signed out, every tab is empty (native
 * shows `labels.signedOut`). */
export function buildCarSnapshot(input: CarSnapshotInput, ctx: CarItemContext): CarSnapshot {
  const tabs: CarTab[] = [];
  for (const id of TAB_ORDER) {
    const books = input.books[id];
    if (books === null) continue;
    const seen = new Set<string>();
    const items: CarItem[] = [];
    if (input.signedIn) {
      for (const b of books) {
        const key = contentKeyOf(b.ref);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(carItem(b, ctx));
        if (items.length >= CAR_TAB_LIMITS[id]) break;
      }
    }
    tabs.push({ id, title: input.labels[TAB_TITLE[id]], items });
  }
  return {
    version: 1,
    generatedAt: input.generatedAt,
    labels: input.labels,
    signedIn: input.signedIn,
    tabs,
  };
}
