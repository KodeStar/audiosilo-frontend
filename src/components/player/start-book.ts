import { resolveClient } from '@/api/connection-clients';
import { downloadedEntryOf } from '@/downloads/store';
import { type BookSource, bookSourceOf, fetchBookSource } from '@/playback/book-source';
import { usePlayer } from '@/playback/store';

import type { PlayTarget } from './play-route';

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
 * not downloaded and its connection is gone; rejects when the book could not be fetched.
 */
export async function startBookInPlace(
  target: PlayTarget,
  opts: StartOptions = {},
): Promise<boolean> {
  const source = await startSourceOf(target);
  if (!source) return false;
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
  return true;
}
