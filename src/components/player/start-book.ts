import { resolveClient } from '@/api/connection-clients';
import { fetchCapabilities } from '@/api/hooks';
import { isReachable } from '@/api/reachability';
import type { Book } from '@/api/types';
import { downloadedEntryOf } from '@/downloads/store';
import { contentKeyOf } from '@/lib/content-key';
import { isDeviceOnline } from '@/lib/device-online';
import { type BookSource, bookSourceOf, fetchBookSource } from '@/playback/book-source';
import { readPlaceEarly } from '@/playback/progress-sync';
import {
  cancelEpisodeFetchOf,
  cancelEpisodeFetchUnless,
  isEpisodeFetchStarting,
  isLatestStart,
  needsEpisodeFetch,
  requestEpisodeFetch,
} from '@/playback/episode-fetch';
import { isAbsentEpisode } from '@/playback/episode-fetch-rules';
import { selectBookKey, selectIsTransportLive, usePlayer } from '@/playback/store';
import { mayActFor } from '@/stores/profiles';
import { withTimeout } from '@/lib/with-timeout';

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
 * from its download's copy (under a car's 10 s wait for a start). Its place is read in the
 * same wait (`readPlaceEarly`), so a frozen server holds the start this long, once. */
export const FRESH_SOURCE_WAIT_MS = 3_000;

/** The client a downloaded book's start asks, when there is one to ask: its connection's,
 * with the device online and the server not marked unreachable. Null for a streamed book. */
function downloadedClient(target: PlayTarget) {
  const client = downloadedEntryOf(target) ? resolveClient(target.connectionId) : null;
  return client && isDeviceOnline() && isReachable(target.connectionId) ? client : null;
}

/**
 * Where a book starts from. A downloaded one still asks its server first, as a streamed one
 * does: a download saved from a list row can hold no chapters (and the list shape of its
 * item), and a server's chapters can change after a download (a rescan, community chapters
 * fitted on), which only an answer from the server picks up. It never waits long: offline,
 * refused, or slower than `FRESH_SOURCE_WAIT_MS`, it starts from its download's copy, so a
 * downloaded book still starts offline. With nothing to ask (the device has no network, or
 * its server is marked unreachable) it starts from that copy at once: Play offline showed a
 * spinner for the whole wait. Else `bookSourceOf` (a streamed book through the query cache,
 * or null when its connection is gone). `client` is `downloadedClient`'s.
 */
async function startSourceOf(
  target: PlayTarget,
  client: ReturnType<typeof downloadedClient>,
): Promise<BookSource | null> {
  if (client) {
    try {
      return await withTimeout(
        fetchBookSource(target, client),
        FRESH_SOURCE_WAIT_MS,
        'slow server',
      );
    } catch {
      // The download's own copy (below).
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
 * A path that is not the book's own (a stale Up next entry: a part path the server now
 * resolves to the folder book holding it) whose book is the one already loaded starts
 * nothing: the book plays on from where it is, as the loaded book does everywhere else, and
 * the entry leaves Up next (fe#147, `playsOnLoaded`).
 *
 * A start asked for again while the same one is on its way (the same book from the same
 * place: a second tap while its item, chapters and place are looked up, before the player
 * shows it; 8b-1, D2) joins it, never a second start. Only while it is the latest start: a
 * start of another book after it (a tap on story B between two on A) takes over the
 * player, so asking for A again starts A again, as the last tap must win.
 *
 * An episode its server has not fetched yet (Bridge Phase 2d-1) goes to the episode fetch
 * (`requestEpisodeFetch`), which starts it here again once it is ready, unless a start of
 * something else (or a Cancel) came first; any other start ends a fetch on its way. One
 * downloaded to this device plays from it with no fetch.
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
    // A start that may be called off (the car's) is never joined by one that may not.
    !!how.wanted,
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
  /** Whether the start is still wanted, asked before the book loads and again before it
   * plays (the store's `playBook`): the car's, which its native side can give up on while a
   * slow server holds the start. Called off before the load, nothing starts (an episode
   * handed to its fetch included, which ends); after it, the book stays loaded, paused. */
  wanted?: () => boolean;
  /** Called off for a play that took its place (the car's tap on the loaded book, which its
   * native side played on, fe#350): asked with `wanted`, and once it says yes the start loads
   * nothing, as for a start of another book made since (the last tap wins). */
  superseded?: () => boolean;
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

/**
 * The start was asked by a path that is not the book's own (the server resolved a part
 * path to the folder book holding it) and that book is the one loaded: it plays on from
 * where it is, never loaded a second time, and both paths leave Up next. Only a start from
 * the saved place (one that names a place or a speed starts as asked), and never an ended
 * or failed book, which starts again through the resume lookup like any other.
 */
async function playsOnLoaded(target: PlayTarget, book: Book, opts: StartOptions): Promise<boolean> {
  if (book.rel_path === target.path) return false;
  if (opts.position !== undefined || opts.track !== undefined || opts.speed !== undefined) {
    return false;
  }
  const player = usePlayer.getState();
  if (selectBookKey(player) !== contentKeyOf({ ...target, path: book.rel_path })) return false;
  const state = player.snapshot.state;
  if (state === 'ended' || state === 'error') return false;
  if (!selectIsTransportLive(player)) await player.toggle();
  dropStartedBook(target.connectionId, target.libraryId, book.rel_path, target.path);
  return true;
}

async function startNow(target: PlayTarget, opts: StartOptions, how: StartHow): Promise<boolean> {
  if (!mayActFor(target.connectionId)) return false;
  // A downloaded book from its saved place: its place is read beside its item and chapters
  // (`readPlaceEarly`), so a frozen server holds the start for one wait, not two.
  const asked = downloadedClient(target);
  const saved = asked ? downloadedEntryOf(target)?.manifest.book : undefined;
  if (asked && saved && opts.position === undefined && opts.track === undefined) {
    readPlaceEarly(asked, target.connectionId, target.libraryId, saved.rel_path);
  }
  const source = await startSourceOf(target, asked);
  if (!source) return false;
  if (how.wanted && !how.wanted()) return false;
  if (!how.fetched && (await playsOnLoaded(target, source.book, opts))) return true;
  const key = contentKeyOf(target);
  if (how.fetched) {
    // The fetch's own start, only while it stands: a Cancel, or a start of something else,
    // since the episode was ready wins.
    if (!isEpisodeFetchStarting(key)) return false;
  } else if (
    !source.local &&
    !downloadedEntryOf(target) &&
    (await needsFetch(target, source.book))
  ) {
    // An episode not on its server yet: the fetch waits for it, then starts it here again
    // (`fetched`). The start is handled (the listener sees it on its way). Not when a tap
    // on another book took over while this one was looked up: that one stands. Never one on
    // this device (fe#166): it plays from its download, whatever its server holds (a
    // downloaded book's source is its server's own when it answers, with no `local`).
    if (!isLatestStart(key)) return false;
    // With its check, when it has one: the fetch ends, and nothing starts, once it says no.
    if (how.wanted) requestEpisodeFetch(target, source.book, opts, { wanted: how.wanted });
    else requestEpisodeFetch(target, source.book, opts);
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
      how.wanted,
      how.superseded,
    );
  // The book you're on is not up next any more (Up next's own Play now does the same):
  // a queued book started from its page, a browse row or the car leaves the queue, once it
  // is the book loaded (a start another one took over keeps its place). Quiet
  // housekeeping, and nothing is sent for a book that isn't queued.
  dropStartedBook(target.connectionId, target.libraryId, source.book.rel_path, target.path);
  return true;
}
