import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { selectBookPosition, usePlayer } from '@/playback/store';
import { bookSpeed, displaySeconds, formatTimeLeft, timeLeft } from '@/playback/time-left';
import { useSettings } from '@/stores/settings';

import { selectIsLoaded } from './playing-target';
import type { PlayTarget } from './use-play-book';

/**
 * The React side of `src/playback/time-left.ts`: time left in a book at THAT book's
 * speed, as one phrase ("22h 27m left at 1.25×"). The player is read as numbers
 * (`displaySeconds`, the speed), so a caller re-renders when the words change (about
 * once a minute), not on every engine tick, and the words are made in render.
 */

/** What a book's saved progress knows: its place, length and speed. */
export type SavedPlace = { position: number; duration: number; playback_speed?: number };

type PlayerSlice = Parameters<Parameters<typeof usePlayer>[0]>[0];

/** Nothing live to say. */
const NONE = [-1, 0] as const;

/** `[displaySeconds, speed]` of the time left from `position` to `length` at `speed`, or
 * `NONE` without a timeline. */
function liveLeft(position: number, length: number, speed: number): readonly [number, number] {
  const left = timeLeft(position, length, speed);
  return left ? [displaySeconds(left.seconds), left.speed] : NONE;
}

/** The playing book's time left ("" when nothing is loaded or its length is unknown). */
export function usePlayingTimeLeft(): string {
  const { t } = useTranslation();
  const [seconds, speed] = usePlayer(
    useShallow((s: PlayerSlice) =>
      s.nowPlaying ? liveLeft(selectBookPosition(s), s.nowPlaying.queue.total, s.rate) : NONE,
    ),
  );
  return seconds < 0 ? '' : formatTimeLeft(t, { seconds, speed });
}

/**
 * The speed `book` plays at: the player's rate while it is loaded, else its saved speed,
 * else the default speed setting.
 */
export function useBookSpeed(book: PlayTarget | null, savedSpeed?: number): number {
  const defaultRate = useSettings((s) => s.defaultRate);
  const live = usePlayer((s) => (selectIsLoaded(book)(s) ? s.rate : 0));
  return live > 0 ? live : bookSpeed(savedSpeed, defaultRate);
}

/**
 * Time left in ANY book: the live place and speed while it is the loaded one (a saved
 * place lags the player by up to 15 s, and its speed by a whole session), else its saved
 * place and speed. `total` overrides the saved duration when the caller knows better
 * (the book's own length). "" when unknown or finished. A row that is not the loaded
 * book reads one boolean from the player and its saved words once.
 */
export function useBookTimeLeft(
  book: PlayTarget | null,
  saved?: SavedPlace,
  total?: number,
): string {
  const { t } = useTranslation();
  const defaultRate = useSettings((s) => s.defaultRate);
  const loaded = usePlayer(selectIsLoaded(book));
  const position = saved?.position ?? 0;
  const length = total || saved?.duration || 0;
  const savedSpeed = saved?.playback_speed;
  const hasBook = !!book;
  const savedWords = useMemo(
    () =>
      hasBook
        ? formatTimeLeft(t, timeLeft(position, length, bookSpeed(savedSpeed, defaultRate)))
        : '',
    [t, hasBook, position, length, savedSpeed, defaultRate],
  );
  const [seconds, speed] = usePlayer(
    useShallow((s: PlayerSlice) => {
      if (!loaded || !s.nowPlaying) return NONE;
      const live = selectBookPosition(s);
      // While the book is still loading the player reads 0: keep the saved place until
      // the player has really moved.
      return liveLeft(live > 0 ? live : position, s.nowPlaying.queue.total || length, s.rate);
    }),
  );
  if (!loaded) return savedWords;
  return seconds < 0 ? '' : formatTimeLeft(t, { seconds, speed });
}
