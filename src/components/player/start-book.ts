import { resolveClient } from '@/api/connection-clients';
import { fetchCapabilities } from '@/api/hooks';
import type { Book } from '@/api/types';
import { downloadedEntryOf } from '@/downloads/store';
import { contentKeyOf } from '@/lib/content-key';
import { type BookSource, bookSourceOf, fetchBookSource } from '@/playback/book-source';
import {
  cancelEpisodeFetchOf,
  cancelEpisodeFetchUnless,
  isAbsentEpisode,
  isEpisodeFetchStarting,
  isLatestStart,
  needsEpisodeFetch,
  requestEpisodeFetch,
} from '@/playback/episode-fetch';
import { usePlayer } from '@/playback/store';
import { mayActFor } from '@/stores/profiles';

import type { PlayTarget } from './play-route';
import { dropStartedBook } from './drop-started';

/** Where `startBookInPlace` starts a book, when not from its saved place. */
export type StartOptions = {
  /** Whole-book seconds to start at (lowers the resume floor there, so the start's own
   * saves are not refused as a slip). */
  position?: number;
  /** A file to start at, by index, when no `position` says where (a file of a book
   * whose durations are unknown). */
  track?: number;
  /** The speed to play at, from the start (else the book's saved speed, which the store
   * restores at an explicit `position` too, from what this device knows). */
  speed?: number;
};

/** How long a downloaded book waits for its server's item and chapters before it starts
 * from its download's copy (under a car's 10 s wait for a start, with room for the resume
 * lookup). */
export const FRESH_SOURCE_WAIT_MS = 3_000;

/**
 * Where a book starts from. A downloaded one still asks its server first, as a streamed one
 * does: a download saved from a list row can hold no chapters (and the list shape of its
 * item), and a server's chapters can change after a download (a rescan, community chapters
 * fitted on), which only an answer from the server picks up. It never waits long: offline,
 * refused, or slower than `FRESH_SOURCE_WAIT_MS`, it starts from its download's copy, so a
 * downloaded book still starts offline. Else `bookSourceOf` (a streamed book through the
 * query cache, or null when its connection is gone).
 */
async function startSourceOf(target: PlayTarget): Promise<BookSource | null> {
  const client = downloadedEntryOf(target) ? resolveClient(target.connectionId) : null;
  if (client) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetchBookSource(target, client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('slow server')), FRESH_SOURCE_WAIT_MS);
        }),
      ]);
    } catch {
      // The download's own copy (below).
    } finally {
      clearTimeout(timer);
    }
  }
  return bookSourceOf(target);
}

/**
 * Start a book WITHOUT opening any screen: its item and chapters through the query cache
 * (the player never starts before its chapters; a book whose page is open starts without
 * asking again), a downloaded book from its download when its server doesn't answer quickly
 * (so it starts offline, as from the car; `startSourceOf`), then the store's `playBook`,
 * which resumes from the saved place
 * unless `opts.position` says where. The one way a book starts outside the player route:
 * a browse surface's play button (`usePlayBook`), Previously on's resume, the car, and the
 * end of a book (`advanceTo`), which can run while the app is in the background, where
 * presenting the player modal is not possible (iOS cannot present a view controller from
 * the background; the app came back to a black screen). Resolves `false` when the book is
 * not downloaded and its connection is gone, or it is not the listening person's
 * (`mayActFor`: refused before anything is fetched); rejects when the book could not be
 * fetched. A book that starts leaves Up next (`dropStartedBook`).
 *
 * A start asked for again while the same one is on its way (the same book from the same
 * place: a second tap while its item, chapters and place are looked up, before the player
 * shows it; 8b-1, D2) joins it, never a second start. Only while it is the latest start: a
 * start of another book after it (a tap on story B between two on A) takes over the
 * player, so asking for A again starts A again, as the last tap must win.
 *
 * An episode its server has not fetched yet (Bridge Phase 2d-1) goes to the episode fetch
 * (`requestEpisodeFetch`), which starts it here again once it is ready, unless a start of
 * something else (or a Cancel) came first; any other start ends a fetch on its way.
 */
export function startBookInPlace(
  target: PlayTarget,
  opts: StartOptions = {},
  how: StartHow = {},
): Promise<boolean> {
  // A start of anything else ends an episode's fetch on its way (the last tap wins).
  cancelEpisodeFetchUnless(contentKeyOf(target));
  const key = JSON.stringify([
    contentKeyOf(target),
    opts.position,
    opts.track,
    opts.speed,
    !!how.fetched,
  ]);
  const running = starting.get(key);
  if (running && latestStart === key) return running;
  latestStart = key;
  const start: Promise<boolean> = startNow(target, opts, how).finally(() => {
    // Only its own entry: a later start of the same book may have replaced it.
    if (starting.get(key) === start) starting.delete(key);
  });
  starting.set(key, start);
  return start;
}

/** How a start is made (`startBookInPlace`), beside where it starts. */
export type StartHow = {
  /** The episode's fetch has just finished (`episode-fetch.ts`): start it, never hand it
   * back to the fetch. */
  fetched?: boolean;
};

/** Whether `book` is an episode its server must fetch before it plays (`podcast_fetch`
 * from the cached flags, read once when the cache holds none). */
async function needsFetch(target: PlayTarget, book: Book): Promise<boolean> {
  if (!isAbsentEpisode(book)) return false;
  const client = resolveClient(target.connectionId);
  if (!client) return false;
  const caps = await fetchCapabilities(target.connectionId, client).catch(() => null);
  return needsEpisodeFetch(book, caps?.podcast_fetch);
}

/** The starts on their way, by book and options (`startBookInPlace`). */
const starting = new Map<string, Promise<boolean>>();
/** The key of the start asked for last (`startBookInPlace`). */
let latestStart: string | null = null;

async function startNow(target: PlayTarget, opts: StartOptions, how: StartHow): Promise<boolean> {
  if (!mayActFor(target.connectionId)) return false;
  const source = await startSourceOf(target);
  if (!source) return false;
  const key = contentKeyOf(target);
  if (how.fetched) {
    // The fetch's own start, only while it stands: a Cancel, or a start of something else,
    // since the episode was ready wins.
    if (!isEpisodeFetchStarting(key)) return false;
  } else if (!source.local && (await needsFetch(target, source.book))) {
    // An episode not on its server yet: the fetch waits for it, then starts it here again
    // (`fetched`). The start is handled (the listener sees it on its way). Not when a tap
    // on another book took over while this one was looked up: that one stands.
    if (!isLatestStart(key)) return false;
    requestEpisodeFetch(target, source.book, opts);
    return true;
  } else {
    // Played here (on its server now, or a server that does not fetch): a fetch of it still
    // on its way ends, or it would start it a second time once ready.
    cancelEpisodeFetchOf(key);
  }
  // The speed goes in with the start: set after it, the book audibly began at another.
  await usePlayer
    .getState()
    .playBook(
      target.connectionId,
      target.libraryId,
      source.book,
      source.chapters,
      opts.position,
      opts.track,
      opts.speed,
    );
  // The book you're on is not up next any more (Up next's own Play now does the same):
  // a queued book started from its page, a browse row or the car leaves the queue, once it
  // is the book loaded (a start another one took over keeps its place). Quiet
  // housekeeping, and nothing is sent for a book that isn't queued.
  dropStartedBook(target.connectionId, target.libraryId, source.book.rel_path);
  return true;
}
