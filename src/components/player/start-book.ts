import { bookSourceOf } from '@/playback/book-source';
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

/**
 * Start a book WITHOUT opening any screen: its item and chapters from its download when it
 * is downloaded (so it starts offline, as from the car), else through the query cache (the
 * player never starts before its chapters; a book whose page is open starts without asking
 * again; `bookSourceOf`), then the store's `playBook`, which resumes from the saved place
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
  const source = await bookSourceOf(target);
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
