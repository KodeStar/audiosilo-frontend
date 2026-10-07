import { useTranslation } from 'react-i18next';

import { bookSpeed, formatTimeLeft, timeLeft } from '@/playback/time-left';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

/**
 * The React side of `src/playback/time-left.ts`: time left in a book at THAT book's
 * speed, as one phrase ("22h 27m left at 1.25×"). Each hook's selector returns the text
 * itself, so a caller re-renders when the words change (about once a minute), not on
 * every engine tick.
 */

/** A book, by identity (what `useOpen`, Home and the library rows carry). */
export type BookRef = { connectionId: string; libraryId: number; path: string };

/** What a book's saved progress knows: its place, length and speed. */
export type SavedPlace = { position: number; duration: number; playback_speed?: number };

type PlayerSlice = Parameters<Parameters<typeof usePlayer>[0]>[0];

/** Is `book` the one loaded in the player? */
function isLoaded(s: PlayerSlice, book: BookRef): boolean {
  const np = s.nowPlaying;
  return (
    !!np &&
    np.connectionId === book.connectionId &&
    np.libraryId === book.libraryId &&
    np.path === book.path
  );
}

/** The playing book's time left ("" when nothing is loaded or its length is unknown). */
export function usePlayingTimeLeft(): string {
  const { t } = useTranslation();
  return usePlayer((s) =>
    s.nowPlaying
      ? formatTimeLeft(t, timeLeft(selectBookPosition(s), s.nowPlaying.queue.total, s.rate))
      : '',
  );
}

/**
 * The speed `book` plays at: the player's rate while it is loaded, else its saved speed,
 * else the default speed setting.
 */
export function useBookSpeed(book: BookRef | null, savedSpeed?: number): number {
  const defaultRate = useSettings((s) => s.defaultRate);
  const live = usePlayer((s) => (book && isLoaded(s, book) ? s.rate : 0));
  return live > 0 ? live : bookSpeed(savedSpeed, defaultRate);
}

/**
 * Time left in ANY book: the live place and speed while it is the loaded one (a saved
 * place lags the player by up to 15 s, and its speed by a whole session), else its saved
 * place and speed. `total` overrides the saved duration when the caller knows better
 * (the book's own length). "" when unknown or finished.
 */
export function useBookTimeLeft(book: BookRef | null, saved?: SavedPlace, total?: number): string {
  const { t } = useTranslation();
  const defaultRate = useSettings((s) => s.defaultRate);
  return usePlayer((s) => {
    if (!book) return '';
    const loaded = isLoaded(s, book);
    const live = loaded ? selectBookPosition(s) : 0;
    // While the book is still loading the player reads 0: keep the saved place until
    // the player has really moved.
    const position = live > 0 ? live : (saved?.position ?? 0);
    const length = (loaded ? s.nowPlaying!.queue.total : 0) || total || saved?.duration || 0;
    const speed = loaded ? s.rate : bookSpeed(saved?.playback_speed, defaultRate);
    return formatTimeLeft(t, timeLeft(position, length, speed));
  });
}
