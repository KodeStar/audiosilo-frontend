import type { TFunction } from 'i18next';

import { chapterLabel } from '@/lib/chapter-label';
import { contentKey } from '@/lib/content-key';
import { fnv1a } from '@/lib/fnv1a';
import { wallClockSeconds } from '@/playback/rate';
import type { SleepTimerState } from '@/playback/sleep-timer';
import {
  selectBookKey,
  selectBookPosition,
  selectCurrentChapter,
  selectIsTransportLive,
  type usePlayer,
} from '@/playback/store';
import { formatTimeLeft, timeLeft } from '@/playback/time-left';

/**
 * The pure half of the iOS widgets (decision 9, contract 2.6): what the app writes into
 * the `ContinueListening` widget and the `SleepTimer` Live Activity, and WHEN. Framework
 * free and platform free, so all of it is unit tested; `widget-sync.ios.ts` only wires
 * these to the stores and to expo-widgets.
 *
 * Every prop is computed and localized by the APP: the widget extension runs a separate
 * JavaScript context with no i18n, no stores and no network (expo-widgets evaluates the
 * `'widget'` function there), so whatever it shows has to arrive in its props.
 */

type PlayerState = ReturnType<typeof usePlayer.getState>;

/** The app's custom URL scheme (`app.json` `scheme`). A widget's URL is delivered to its
 * containing app whatever the scheme resolves to elsewhere, so the side-by-side dev build
 * (`app.audiosilo.dev`, same scheme) still opens itself from its own widget. */
export const APP_SCHEME = 'audiosilo';

/** Props of the `ContinueListening` widget. Every field is optional: an empty object is
 * the never-written state (the widget gallery's preview before the app has run), and
 * `{ emptyText }` is the cleared state after sign-out. */
export type ContinueListeningProps = {
  title?: string;
  author?: string;
  chapterTitle?: string;
  /** `file://` URL of a ~320 px JPEG in `widgetsDirectory` (the extension cannot fetch). */
  coverFile?: string;
  /** "3h 12m left at 1.25×", already localized at the book's speed. */
  timeLeft?: string;
  /** 0..1 through the whole book. */
  progress?: number;
  isPlaying?: boolean;
  /** Opens this book's player (a cold launch starts it where it was left). */
  deepLink?: string;
  /** Beyond the contract: the book's connection, so a sign-out after a relaunch still
   * knows whether this widget shows that server's book (`onConnectionRemoved`). */
  connectionId?: string;
  /** Beyond the contract: the localized line the empty widget shows. */
  emptyText?: string;
};

/** Props of the `SleepTimer` Live Activity. */
export type SleepTimerActivityProps = {
  title: string;
  chapterTitle?: string;
  /** `file://` URL of a ~160 px JPEG, within the Live Activity's presentation size. */
  coverFile?: string;
  /** Epoch ms the countdown reaches zero. */
  endsAt: number;
  /** Epoch ms the countdown froze (playback paused); absent while it runs. */
  pausedAt?: number;
  deepLink: string;
  /** Beyond the contract: the localized "Sleep timer" caption and accessibility label. */
  label: string;
};

/** `audiosilo://player?connection=..&libraryId=..&path=..`: the player route with the
 * book's identity (`playerHref`'s params), so a cold launch from the widget opens THIS
 * book rather than an empty player. */
export function playerDeepLink(connectionId: string, libraryId: number, path: string): string {
  const q = [
    `connection=${encodeURIComponent(connectionId)}`,
    `libraryId=${libraryId}`,
    `path=${encodeURIComponent(path)}`,
  ].join('&');
  return `${APP_SCHEME}://player?${q}`;
}

/** The current chapter's display label, or undefined without chapters. */
function currentChapterTitle(player: PlayerState, t: TFunction): string | undefined {
  const chapter = selectCurrentChapter(player);
  return chapter ? chapterLabel(chapter, t) : undefined;
}

/** Drop `undefined` fields: the props cross the bridge into a native dictionary, and
 * an explicit undefined is not a value there. */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** The widget's props for the book that is loaded, or null when nothing is. */
export function continueListeningProps(
  player: PlayerState,
  t: TFunction,
  coverFile: string | undefined,
): ContinueListeningProps | null {
  const np = player.nowPlaying;
  if (!np) return null;
  const position = selectBookPosition(player);
  const total = np.queue.total;
  const left = formatTimeLeft(t, timeLeft(position, total, player.rate));
  return compact({
    title: np.title || undefined,
    author: np.author || undefined,
    chapterTitle: currentChapterTitle(player, t),
    coverFile,
    timeLeft: left || undefined,
    progress: total > 0 ? Math.min(1, Math.max(0, position / total)) : undefined,
    isPlaying: selectIsTransportLive(player),
    deepLink: playerDeepLink(np.connectionId, np.libraryId, np.path),
    connectionId: np.connectionId,
    emptyText: t('widgets.empty'),
  });
}

/** The cleared widget: no book, just the empty line. */
export function emptyContinueListeningProps(t: TFunction): ContinueListeningProps {
  return { emptyText: t('widgets.empty') };
}

// --- When to write the widget -------------------------------------------------------

/** A move this far (book seconds) from where steady playback would be is a jump worth a
 * write (contract 2.6: "a jump over 30 s"). */
export const JUMP_SECONDS = 30;
/** While playing, refresh the time left and the progress bar at most this often. Reloads
 * are free while the app is the Now Playing app, but there is no point redrawing a
 * "3h 12m left" faster than its minutes change. */
export const REFRESH_MS = 60_000;
/** Coalesce bursts (a book load emits several writes in a row) into one write. */
export const MIN_WRITE_MS = 2_000;

/** What a write decision compares: the last written (or the current) state. */
export type WidgetMark = {
  bookKey: string | null;
  chapterIndex: number | null;
  playing: boolean;
  rate: number;
  /** Whole-book position, seconds. */
  position: number;
  /** Epoch ms of the reading. */
  at: number;
};

export function widgetMark(player: PlayerState, now: number): WidgetMark {
  return {
    bookKey: selectBookKey(player),
    chapterIndex: selectCurrentChapter(player)?.index ?? null,
    playing: selectIsTransportLive(player),
    rate: player.rate,
    position: selectBookPosition(player),
    at: now,
  };
}

/**
 * Should the widget be rewritten for `next`, given the `last` write?
 *
 * - `now`: something the widget SHOWS changed in kind - the book, the chapter, play or
 *   pause, the speed (the time left is at the book's speed), or the position jumped more
 *   than `JUMP_SECONDS` from where steady playback since the last write would put it (a
 *   scrub, a chapter tap, a lock-screen skip back).
 * - `refresh`: nothing changed in kind but a playing book's time left has moved on; due
 *   once `REFRESH_MS` has passed.
 * - `skip`: otherwise. Progress ticks arrive several times a second; nearly all are this.
 *
 * Throttling `now` to `MIN_WRITE_MS` is the caller's job (it owns the timer).
 */
export function writeDecision(
  last: WidgetMark | null,
  next: WidgetMark,
): 'now' | 'refresh' | 'skip' {
  if (!last) return next.bookKey ? 'now' : 'skip';
  if (last.bookKey !== next.bookKey) return 'now';
  if (!next.bookKey) return 'skip';
  if (last.chapterIndex !== next.chapterIndex) return 'now';
  if (last.playing !== next.playing) return 'now';
  if (Math.abs(last.rate - next.rate) > 0.001) return 'now';
  const elapsed = Math.max(0, next.at - last.at) / 1000;
  const expected = last.position + (last.playing ? elapsed * last.rate : 0);
  if (Math.abs(next.position - expected) > JUMP_SECONDS) return 'now';
  if (next.playing && next.at - last.at >= REFRESH_MS) return 'refresh';
  return 'skip';
}

// --- The sleep timer Live Activity ----------------------------------------------------

/** When the Live Activity's countdown ends, and whether it is frozen. */
export type SleepTiming = { endsAt: number; pausedAt?: number };

/**
 * The countdown for the Live Activity, or null when no timer is counting down towards a
 * pause (idle, or the post-pause grace: the activity ends the moment the timer fires).
 *
 * - A DURATION timer is a wall-clock deadline already (`endsAt`), frozen at `frozenAt`
 *   while the book is paused; the activity shows exactly that.
 * - An END-OF-CHAPTER timer is a book position (`pauseAtPosition`). Its wall-clock end is
 *   `now + (target - position) / rate`, which moves with every seek and speed change (so
 *   the caller re-sends it; `sameTiming` keeps the jitter of progress ticks from becoming
 *   updates). While the book is paused it does not count down at all, so it is shown
 *   frozen at `now`: `Text(timerInterval:pauseTime:)` then reads `endsAt - pausedAt`.
 * - A timer armed for another book than the loaded one is over (the store cancels it on
 *   its next tick): null.
 */
export function sleepTiming(
  timer: Pick<SleepTimerState, 'phase' | 'endsAt' | 'frozenAt' | 'pauseAtPosition' | 'bookKey'>,
  player: PlayerState,
  now: number,
): SleepTiming | null {
  if (timer.phase !== 'running' && timer.phase !== 'ending') return null;
  if (!player.nowPlaying || timer.bookKey !== selectBookKey(player)) return null;
  if (timer.endsAt !== null) {
    return timer.frozenAt !== null
      ? { endsAt: timer.endsAt, pausedAt: timer.frozenAt }
      : { endsAt: timer.endsAt };
  }
  if (timer.pauseAtPosition === null) return null;
  const left = wallClockSeconds(timer.pauseAtPosition - selectBookPosition(player), player.rate);
  const endsAt = Math.round(now + left * 1000);
  return selectIsTransportLive(player) ? { endsAt } : { endsAt, pausedAt: now };
}

/** Countdowns closer than this (ms) are the same countdown: a re-send would only move
 * the display by a progress tick's jitter and spend an ActivityKit update on it. */
export const TIMING_TOLERANCE_MS = 2_000;

/** Whether two timings show the same countdown. A frozen one is compared by what it
 * shows (the time left at the freeze), since its `endsAt` is re-anchored on `now` for an
 * end-of-chapter timer every time it is computed. */
export function sameTiming(a: SleepTiming, b: SleepTiming): boolean {
  const aFrozen = a.pausedAt !== undefined;
  if (aFrozen !== (b.pausedAt !== undefined)) return false;
  if (aFrozen) {
    const aLeft = a.endsAt - (a.pausedAt as number);
    const bLeft = b.endsAt - (b.pausedAt as number);
    return Math.abs(aLeft - bLeft) <= TIMING_TOLERANCE_MS;
  }
  return Math.abs(a.endsAt - b.endsAt) <= TIMING_TOLERANCE_MS;
}

/** The Live Activity's props, or null when there should be none. */
export function sleepActivityProps(
  timer: Pick<SleepTimerState, 'phase' | 'endsAt' | 'frozenAt' | 'pauseAtPosition' | 'bookKey'>,
  player: PlayerState,
  now: number,
  t: TFunction,
  coverFile: string | undefined,
): SleepTimerActivityProps | null {
  const timing = sleepTiming(timer, player, now);
  const np = player.nowPlaying;
  if (!timing || !np) return null;
  return compact({
    title: np.title,
    chapterTitle: currentChapterTitle(player, t),
    coverFile,
    endsAt: timing.endsAt,
    pausedAt: timing.pausedAt,
    deepLink: playerDeepLink(np.connectionId, np.libraryId, np.path),
    label: t('widgets.sleepTimer'),
  });
}

/** Whether the Live Activity already shows `next` (so no update is sent). */
export function sameActivity(a: SleepTimerActivityProps, b: SleepTimerActivityProps): boolean {
  return (
    a.title === b.title &&
    a.chapterTitle === b.chapterTitle &&
    a.coverFile === b.coverFile &&
    a.deepLink === b.deepLink &&
    a.label === b.label &&
    sameTiming(a, b)
  );
}

// --- Covers -----------------------------------------------------------------------------

/** FNV-1a, 32 bit, as 8 hex digits: a stable, filename-safe name for a book's cover. */
export const hashKey = fnv1a;

/** File name stem shared by a book's two cover files (`-w` widget, `-a` activity). */
export function coverStem(connectionId: string, libraryId: number, path: string): string {
  return `cover-${hashKey(contentKey(connectionId, libraryId, path))}`;
}

/** Largest edge (px) the widget accepts: a systemMedium cover is ~130 pt, so 3x is ~400 px,
 * and WidgetKit refuses to archive an image far above the widget's own pixel area. */
export const WIDGET_COVER_MAX = 640;
/** Largest edge (px) for the Live Activity: its images must fit the presentation. */
export const ACTIVITY_COVER_MAX = 200;
/** The server thumbnail sizes asked for (`CoverSize`). */
export const WIDGET_COVER_SIZE = 320;
export const ACTIVITY_COVER_SIZE = 160;

/**
 * Pixel size of a JPEG or PNG from its header, or null for anything else (or a truncated
 * file). A cover is only written when it is small enough, and the app has no image
 * resizer: a server without `cover_sizes` ignores `size` and sends the full art, which
 * can be thousands of pixels and would either fail to archive (WidgetKit) or fail to
 * start (ActivityKit). Reading the header is how that is caught.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG: signature, then the IHDR chunk's width and height (big endian) at 16 and 20.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    const u32 = (o: number) =>
      ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    return { width: u32(16), height: u32(20) };
  }
  // JPEG: walk the marker segments to the first start-of-frame (SOF0..SOF15 except the
  // DHT/JPG/DAC markers C4, C8, CC), whose payload holds height then width.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < bytes.length) {
    if (bytes[o] !== 0xff) return null;
    const marker = bytes[o + 1];
    if (marker === 0xff) {
      o += 1; // fill byte
      continue;
    }
    const len = (bytes[o + 2] << 8) | bytes[o + 3];
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: (bytes[o + 5] << 8) | bytes[o + 6],
        width: (bytes[o + 7] << 8) | bytes[o + 8],
      };
    }
    if (len < 2) return null;
    o += 2 + len;
  }
  return null;
}

/** Whether an image's bytes are a JPEG/PNG no larger than `maxEdge` on either side. */
export function fitsCover(bytes: Uint8Array, maxEdge: number): boolean {
  const size = imageSize(bytes);
  return (
    !!size && size.width > 0 && size.height > 0 && Math.max(size.width, size.height) <= maxEdge
  );
}
