import { focusedRoute, type NavState, topRootRoute } from '@/lib/root-stack';

/** A book to start: on which connection, library and path. */
export type PlayTarget = { connectionId: string; libraryId: number; path: string };

/** Where a press on a book's play (or a jump into it) goes (`playRoute`). */
export type PlayRoute =
  /** Pause or play the loaded book in place. */
  | { kind: 'toggle' }
  /** Open the full player on the book (at the place), first pushing the book's page under
   * it when `bookPage`. */
  | { kind: 'player'; bookPage: boolean }
  /** The loaded book, in place: to the place (a jump), then playing on. */
  | { kind: 'play-on' }
  /** Start the book in place under the docked bar (`startBookInPlace`), at the place. */
  | { kind: 'start' };

/**
 * THE rule for starting a book, or jumping into one, from anywhere outside the player:
 * - a toggle (Home's Now card, the book page's primary) on the loaded book pauses or
 *   plays it in place, on every layout;
 * - a phone opens the full player (which resumes from the saved place, or applies the
 *   jump once, also to the loaded book), over the book's page when asked and that page
 *   is not already the one on screen;
 * - with the full player already on top (Up next's sheet over it, the player's own
 *   rows), or on a tablet or desktop, the loaded book plays on (from the jump, when there
 *   is one) and any other one starts in place, so the open player shows it.
 */
export function playRoute(input: {
  phone: boolean;
  /** The root stack's top route is the full player: pushing another would stack two. */
  playerOnTop: boolean;
  /** The page on screen is this book's own. */
  bookOnTop: boolean;
  /** This book is the one in the player. */
  loaded: boolean;
  toggle: boolean;
  viaBookPage: boolean;
}): PlayRoute {
  const { phone, playerOnTop, bookOnTop, loaded, toggle, viaBookPage } = input;
  if (loaded && toggle) return { kind: 'toggle' };
  if (phone && !playerOnTop) return { kind: 'player', bookPage: viaBookPage && !bookOnTop };
  return { kind: loaded ? 'play-on' : 'start' };
}

/** The book page's route name in the shell's stacks (`src/app/(app)/.../book/[libraryId]`). */
const BOOK_ROUTE = 'book/[libraryId]';

/** Where the navigator is for a press on `target`: whether the full player is on top and
 * whether the page on screen is the book's own (its route params are `bookHref`'s). */
export function navFor(
  state: NavState | undefined,
  target: PlayTarget,
): { playerOnTop: boolean; bookOnTop: boolean } {
  const route = focusedRoute(state);
  const params = (route?.params ?? {}) as Record<string, unknown>;
  return {
    playerOnTop: topRootRoute(state) === 'player',
    bookOnTop:
      route?.name === BOOK_ROUTE &&
      params.connection === target.connectionId &&
      params.libraryId === String(target.libraryId) &&
      params.path === target.path,
  };
}
