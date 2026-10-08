import type { TFunction } from 'i18next';

import type { SourcedProgress } from '@/api/hooks';
import type { Book, Progress } from '@/api/types';
import { progressAt, splitProgress } from '@/components/home/home-model';
import { splitDownloads } from '@/downloads/downloads-view';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';
import { contentKeyOf } from '@/lib/content-key';
import { bookTitle } from '@/lib/paths';
import { progressFractionRemaining } from '@/lib/progress-view';
import { buildBookQueue, locate } from '@/playback/book-queue';
import { localFromManifest, resumeStart } from '@/playback/book-source';
import type { ResumeLookup } from '@/playback/progress-sync';
import { bookSpeed, formatTimeLeft, timeLeft } from '@/playback/time-left';
import { bookRefOf, type BookRef, toNativeTrack } from '@/playback/types';

import type {
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

/** Every string the car shows beyond the tab titles (each tab carries its own `title`).
 * Native has none of its own. */
export type CarLabels = {
  continue: string;
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
  /** `carItemId(book)`: Android's media id. */
  id: string;
  /** The book itself, so native compares its fields instead of decoding `id` (CarPlay). */
  book: BookRef;
  title: string;
  /** The author, then the time left at the book's own speed once started. */
  subtitle: string;
  /** 0..1, null when not started. */
  progress: number | null;
  finished: boolean;
  downloaded: boolean;
  /** A `file://` cover the app wrote: under the car artwork folder, or a downloaded book's own
   * cover file. Null when there is none (yet). */
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
  const { inProgress } = splitProgress(rows);
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
    push(loaded, rows.find((r) => contentKeyOf(progressAt(r)) === key) ?? null);
  }
  for (const row of inProgress) push(progressAt(row), row);
  return out;
}

/** The downloaded books, newest download first (the Downloads page's ready list),
 * `CAR_TAB_LIMITS.downloads` at most. */
export function downloadedEntries(entries: Record<string, DownloadEntry>): DownloadEntry[] {
  return splitDownloads(Object.values(entries)).ready.slice(0, CAR_TAB_LIMITS.downloads);
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
      : progressFractionRemaining(place.position, place.total).fraction;
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
    book: bookRefOf(b.ref),
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
    localFromManifest(manifest),
    virtualChapterInterval,
  );
  if (queue.tracks.length === 0 || queue.tracks.some((t) => !t.url)) return undefined;
  const saved = lookup.kind === 'progress' ? lookup.progress : null;
  const { index, positionInTrack } = locate(queue.offsets, saved ? resumeStart(saved) : 0);
  return {
    book: ref,
    tracks: queue.tracks.map(toNativeTrack),
    chapters: queue.chapterClips,
    startIndex: index,
    positionInTrack,
    rate: bookSpeed(saved?.playback_speed, defaultRate),
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

/** Each tab's title (namespace `car`). */
const TAB_TITLE = {
  continue: 'car.continue',
  upnext: 'car.upNext',
  downloads: 'car.downloads',
  library: 'car.library',
} as const satisfies Record<CarTabId, string>;

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
    tabs.push({ id, title: ctx.t(TAB_TITLE[id]), items });
  }
  return {
    version: 1,
    generatedAt: input.generatedAt,
    labels: input.labels,
    signedIn: input.signedIn,
    tabs,
  };
}
