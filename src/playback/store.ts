import { Platform } from 'react-native';
import { create } from 'zustand';

import type { ApiClient } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { isReachable, noteFailure } from '@/api/reachability';
import type {
  Book,
  Chapter,
  ChaptersResponse,
  ListeningEvent,
  ListeningStart,
  Progress,
} from '@/api/types';
import {
  adoptStartedChapters,
  downloadedEntryOf,
  downloadKey,
  useDownloads,
} from '@/downloads/store';
import { resolveConnectionId } from '@/lib/connection-id';
import { contentKey, contentKeyOf } from '@/lib/content-key';
import { canAutoDownload } from '@/lib/network';
import { flushReadingConnection } from '@/reader/reading-progress';
import { mayActFor } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';

import type { LoadedBook } from '../../modules/audiosilo-player/src/AudiosiloPlayer.types';

import {
  bookFileSpecs,
  buildBookQueue,
  chapterAt,
  FINISHED_TOLERANCE,
  locate,
  toBookPosition,
  trackIdOf,
  trackIndexById,
  type BookQueue,
} from './book-queue';
import {
  bookSourceOf,
  fetchChapters,
  localFromManifest,
  resumeStart,
  type LocalFiles,
} from './book-source';
import { engineTick, engineTicker } from './engine-ticks';
import {
  appendEvents,
  closeSpan,
  finishEvent,
  flushOutbox,
  type OpenSpan,
  type OutboxEntry,
  sendOnPageHide,
  type SpanEnd,
  spanToEvent,
  storeOpenSpan,
  usesListeningSync,
} from './listening-outbox';
import {
  ackVersion,
  cachedDeviceId,
  flushConnection,
  flushQueue,
  getDeviceId,
  loadInitialProgress,
  readMirror,
  saveProgress,
  writeMirror,
} from './progress-sync';
import { listenerSettings } from './listener-settings';
import { clampRate } from './rate';
import { createPlaybackService } from './service';
import { bookSpeed } from './time-left';
import { flushTimeSaved, noteSilenceSaved } from './time-saved';
import { mayNeedWebTranscode } from './transcode';
import { resolveWebTranscode } from './transcode-capability';
import {
  AutoplayBlockedError,
  bookRefOf,
  type BookRef,
  clampVolume,
  INITIAL_SNAPSHOT,
  type PlaybackService,
  type PlaybackSnapshot,
  PlaybackStartError,
  type PlaybackState,
} from './types';

/**
 * Is the engine actually producing audio? The strict reading of "the user is
 * listening": a buffering book is NOT playing, because no time is being spent on the
 * book yet. Used for the listening-history spans (a span must cover audio the listener
 * actually heard) and by `selectIsPlaying` for the play/pause UI.
 *
 * The deliberately looser reading is `isTransportLiveState` below - see it for when to
 * pick which.
 */
function isPlayingState(state: PlaybackState): boolean {
  return state === 'playing';
}

/**
 * Is the transport running right now, INCLUDING a book that is buffering with playback
 * intended? The loose reading of "the user is listening": `loading` counts because the
 * book is on its way to playing, so time is about to be spent listening. (A stall that
 * outlasts the watchdog becomes `error`, which does not count - so a dead stream reads
 * as not-listening rather than listening forever.)
 *
 * Which to use: pick this one for anything that must not treat a two-second buffer as
 * the listener having stopped - the sleep timer's freeze (a countdown that froze and
 * thawed on every buffer would be jitter, and a buffering book is still a book being
 * listened to). Pick `isPlayingState` when the answer must be "audio came out of the
 * speaker": the history spans, and the play/pause button.
 *
 * The difference IS deliberate. The two live side by side here, rather than one being
 * re-derived in the feature that needs it, so the choice is visible at both call sites.
 */
function isTransportLiveState(state: PlaybackState): boolean {
  return state === 'playing' || state === 'loading';
}

let service: PlaybackService | null = null;
let apiRef: ApiClient | null = null;
/** The connection `apiRef` belongs to (set by `switchBook`, with it). */
let apiRefFor: string | null = null;
let deviceId = '';
/** Where the playing listening began (`POST /history` when it ends); `sync`: begun on a
 * server taking listening events, whose spans carry it instead. */
let historyStart: { position: number; at: number; sync: boolean } | null = null;
/** Do we intend to be playing right now? Gates the stall watchdog so an idle/paused
 * buffer never surfaces as an error. Set by the play/pause actions and kept in sync
 * with the engine's own play state (a lock-screen play/pause flows through subscribe,
 * not the store actions). */
let wantsPlayback = false;
/** True from a play/retry request until the engine actually reaches `playing` (or the
 * attempt fails/aborts). While starting, the native bridge emits transient `ready`/
 * `paused` states as it rebuilds the queue; we must read those as "still connecting"
 * (spinner + watchdog), NOT as a real pause that would clear intent and strand the UI.
 * A genuine user/lock-screen pause arrives with this already false (we reached
 * `playing` first), so it's still distinguishable. */
let startingPlayback = false;
/** Counts the play requests (`beginPlaybackAttempt`): a paused adoption's reload tells the
 * listener's play made while its load was out from the engine playing by itself. */
let playAttempts = 0;
/** Pending stall→error timer (see armStallWatchdog). */
let stallTimer: ReturnType<typeof setTimeout> | null = null;
/** The whole-book position the current book resumed from, kept as a running high-water
 * mark. `persist` refuses to save a position far below this unless the user deliberately
 * seeked back (which lowers it) - so a slipped-through restart-at-0 can never overwrite
 * real saved progress. Reset per book in `playBook`. */
let resumeFloor = 0;
/** Set when `playBook` bailed at the resume-lookup stage (a streaming book whose resume
 * position couldn't be confirmed). `retry()` then re-runs the lookup instead of reloading
 * at a stale 0. */
let resumeLookupFailed = false;
/** The output gain currently applied to the engine, held here like `rate` (the other
 * engine parameter the store owns) so `setOutputVolume` can skip a bridge round-trip
 * when nothing changed. That matters because the sleep timer's fade calls it four times
 * a second, and its idle state calls it with 1 far more often than that.
 *
 * Not store state: nothing renders it, so a `set()` would re-render every player
 * subscriber at 4Hz. Kept in sync by EVERY route to the engine's volume, including
 * `playBook`'s direct `svc.setVolume(1)` backstop - a stale "already 1" would turn a
 * real restore into a no-op and leave the listener with a quiet book. */
let outputVolume = 1;

/**
 * Saves are held while `place-reconcile.ts` asks the server whether another device moved
 * this book's place on (a loaded book picked up again): `persist` writes nothing until
 * the hold is released, so the engine's stale place can't be saved over the other
 * device's newer one (the server is last-write-wins). A hold always ends: released by
 * its owner, or by itself after `SAVE_HOLD_MAX_MS` (a slow check never loses listening).
 */
let saveHold: { timer: ReturnType<typeof setTimeout>; expiresAt: number } | null = null;
const SAVE_HOLD_MAX_MS = 5_000;
/**
 * The download hot-swap moving the playing file to another track index (a download that
 * holds other files than the stream, `switchCurrentBookToLocal`): the book and the file's
 * index in the stream's queue. The engine reports the download's index before its swap or
 * load returns, and until the store commits the download's queue that index read through
 * the stream's queue is another file's place: `persist` and `onRemoteMove` refuse a place at
 * any other index of that book meanwhile. Released at the commit, or when the swap is
 * refused or fails.
 */
let swapHold: { nowPlaying: NowPlaying; trackIndex: number } | null = null;
/**
 * The book (its `contentKey`) `adoptLoaded` had to reload in its own file order (fe#134): its
 * engine's place is not new and was never checked against the server, so nothing saves it
 * until it plays (whose pick-up check holds the saves first) or the listener moves it. A
 * paused load reports `ready` and `paused`, and a playing one can stall into an `error`:
 * transitions that would otherwise save that place dated now, over another device's newer
 * one. By its key, so the download hot-swap's new `NowPlaying` keeps it. Cleared by the next
 * `playing` (one reported while the reload's load holds the store only once the reload's own
 * play stands) and by `userMoved` (every book switch is one).
 */
let quietAdopted: string | null = null;
const heldBySwap = (np: NowPlaying, trackIndex: number) =>
  swapHold !== null && swapHold.nowPlaying === np && trackIndex !== swapHold.trackIndex;
/** When the transport last settled out of `playing` (a pause, from any source), else
 * null. A play after `LONG_PAUSE_MS` of it is a book picked up again, which is when
 * another device may have moved its place on (`onPickedUpAgain`). */
let pausedAt: number | null = null;
export const LONG_PAUSE_MS = 60_000;
let pickedUpAgainListener: (() => void) | null = null;
/** A pick-up check due while a load held the store (`loadingBook`, by its content key): the
 * place reconcile skips while that hold is set, so the check waits for its release (the
 * subscription beside the download hot-swap's) instead of being used up by a `playing`
 * reported during the load. */
let pickUpDue: string | null = null;

/** Tell the pick-up listener now, or once the load holding the store lands (`pickUpDue`). */
function pickUp() {
  const { loadingBook } = usePlayer.getState();
  if (loadingBook) pickUpDue = loadingBook;
  else pickedUpAgainListener?.();
}
/** Counts the listener's own moves in the loaded book (seeks, track jumps, a book
 * started): a reconcile that sees it change while its check was out stands back. */
let localMoves = 0;

/** `playBook`s running now. An adoption that read while one ran stands back: the start
 * switches the book only after its own awaits, so an adoption landing between would take
 * the connection, the retry request and the save loop out from under it. */
let startsInFlight = 0;

/** Captured so `retry()` can re-run the resume path after a lookup failure. */
let lastPlayRequest: {
  connectionId: string;
  libraryId: number;
  book: Book;
  chapterData?: ChaptersResponse;
} | null = null;

const MIN_HISTORY_MS = 20_000; // ignore listening spans shorter than this
const STALL_GRACE_MS = 3_000; // a 'loading' that outlasts this is treated as a dead stream

// The server derives listening sessions from these saves (audiosilo-server
// internal/catalog/sessions.go: a session reads as playing for 60 s after a save
// and as ended after 10 min without one, though a later save whose position advanced
// by about the elapsed time still continues it). Changing the cadence means revisiting
// those windows (CROSS-REPO.md section 20).
const SAVE_INTERVAL_MS = 15_000;
/** Treat within 5 s of the end as finished (defined beside the timeline maths). */
export { FINISHED_TOLERANCE };
const SLIP_TOLERANCE = 60; // a save more than this far below the resume floor is suspect

/** Lower the resume floor after a deliberate user seek/jump, so a legitimate backward
 * move (or a restart) is allowed to save instead of being blocked by the guard. */
function lowerFloorTo(bookPosition: number) {
  if (Number.isFinite(bookPosition)) resumeFloor = Math.min(resumeFloor, Math.max(0, bookPosition));
}

/** A move of the listener's own in the loaded book (a seek, a track jump, a book
 * started): counted for the place reconcile (`localMoves`), and, given where it lands,
 * the resume floor lowered to it (`lowerFloorTo`). */
function userMoved(bookPosition?: number) {
  localMoves++;
  quietAdopted = null;
  if (bookPosition !== undefined) lowerFloorTo(bookPosition);
}

/** Engine tunables derived from the settings store. */
function currentConfig() {
  const s = useSettings.getState();
  return {
    autoRewindMax: s.autoRewindMax,
    jumpForward: s.skipForward,
    jumpBackward: s.skipBackward,
    smartSpeed: s.smartSpeed,
    voiceBoost: s.voiceBoost,
  };
}

export type NowPlaying = {
  /** The connection this book is playing through (scopes saves + download lookups). */
  connectionId: string;
  libraryId: number;
  path: string;
  title: string;
  author: string;
  cover: string;
  queue: BookQueue;
  /** A podcast episode (Bridge Phase 2d-1; set only then): no end credits, no cast, no
   * downloads. A view field only. */
  episode?: true;
};

/** The loaded book as the player shows it, built the same way by every path that loads one
 * (`playBook`, `adoptLoaded`). A downloaded book uses its local cover; with no client and
 * no local cover there's simply no cover (offline, connection gone) and the player falls
 * back to a placeholder. */
function nowPlayingOf(
  ref: BookRef,
  book: Book,
  queue: BookQueue,
  api: ApiClient | null,
  local?: LocalFiles,
): NowPlaying {
  return {
    ...bookRefOf(ref),
    title: book.title,
    author: book.author || book.narrator || '',
    cover: local?.artwork ?? api?.coverUrl(ref.libraryId, ref.path) ?? '',
    queue,
    ...(book.episode ? { episode: true as const } : {}),
  };
}

/** The identity of the book that just finished - enough for a UI-layer end-of-book
 * flow (end credits) to show it and resolve the next book, captured by `finishBook`
 * before playback state is torn down. */
export type FinishedBook = {
  connectionId: string;
  libraryId: number;
  path: string;
  title: string;
  author: string;
  cover: string;
  /** A podcast episode (`NowPlaying.episode`): it never opens the end credits. */
  episode?: true;
};

type PlayerState = {
  nowPlaying: NowPlaying | null;
  snapshot: PlaybackSnapshot;
  rate: number;
  /**
   * The book (its `contentKey`) `playBook` just swapped in whose engine load has not landed
   * yet, else null. Until it lands the snapshot still holds the PREVIOUS book's place (the
   * native engine reports the new queue only once its load resolves, and the old book's
   * ticks can still arrive meanwhile), so mapping it through this book's queue puts the
   * listener somewhere they have never been. The spoiler gates wait it out
   * (`selectPlacedBookKey`, `use-listening-position.ts`). Only set when the book changes, and
   * by `adoptLoaded` while it reloads the engine in the adopted queue's order (a tick until
   * then still counts in the engine's old order: `reloadAdopted`).
   */
  loadingBook: string | null;
  /** Whether the engine can show an OS audio-route / casting picker on this platform
   * (set when the engine is created). Drives whether the player shows the cast button. */
  canRoutePick: boolean;

  /** Start a book. Omit startBookPosition to resume from saved progress; pass
   * startTrack to begin at a specific file (used when file durations are
   * unknown, so a whole-book position can't address a track). `connectionId` is the
   * server this book is loaded through - it scopes saves, downloads and invalidations.
   * `startSpeed` plays it at that speed; without it the book plays at its saved speed
   * (else the default), also when it starts at an explicit place. */
  playBook: (
    connectionId: string,
    libraryId: number,
    book: Book,
    chapterData?: ChaptersResponse,
    startBookPosition?: number,
    startTrack?: number,
    startSpeed?: number,
  ) => Promise<void>;
  toggle: () => Promise<void>;
  pause: () => Promise<void>;
  /** Re-load the current track at the current position and resume - recovery after
   * the engine reports an `error` (e.g. the stream became unreachable). */
  retry: () => Promise<void>;
  seekBook: (bookPosition: number) => Promise<void>;
  /** Seek within the current track (used when the whole-book timeline is unknown). */
  seekInTrack: (positionInTrack: number) => Promise<void>;
  /** Jump to a track by index (multi-file books without a reliable timeline). */
  goToTrack: (index: number) => Promise<void>;
  skipSeconds: (delta: number) => Promise<void>;
  setRate: (rate: number) => Promise<void>;
  /** Apply an output gain to the engine - the sleep timer's fade-out. This is the ONLY
   * way out of the store to the engine's volume, so it is where the [0,1] clamp lives
   * (engines trust it), and where the gain the engine is already at is remembered: a
   * call that would not change it costs nothing, so a 4Hz fade (and the restore-to-full
   * that every timer path makes defensively) is free rather than a bridge round-trip
   * each. A no-op before an engine exists. */
  setOutputVolume: (volume: number) => Promise<void>;
  stop: () => Promise<void>;
  /** Mark the current book finished (from its natural end, or a manual "mark as
   * finished"): persist `finished: true`, tear down playback, optionally delete its
   * downloaded copy, and return the book's identity for a follow-on UI flow. Null when
   * nothing is playing. */
  finishBook: () => FinishedBook | null;
  /** Present the OS audio-route picker (AirPlay on iOS and in Safari, the Android output
   * switcher; Cast has its own button). No-op if the engine doesn't support it. */
  showRoutePicker: () => Promise<void>;
  /** Android: take over the book the playback SERVICE has loaded (the car started
   * it, or it kept playing while the app's JS restarted), without reloading the engine unless
   * it plays another file order than the queue's: the queue is built as `playBook` builds it,
   * the place and speed are the engine's, and the resume floor is that place, so the save loop
   * saves under that book from where it is. `reread` reads the service's book again once the
   * book's source is read, so a pause, a move or a speed change made meanwhile stands.
   * Resolves whether it adopted (false: the book's connection and download are gone, its
   * item could not be read, the service plays another book or order now, or another book
   * started meanwhile). See `adoptLoadedBook`. */
  adoptLoaded: (book: LoadedBook, reread?: () => Promise<LoadedBook | null>) => Promise<boolean>;
};

/** Persist the current whole-book position (offline-safe). Pass `forceFinished` to
 * record the book as finished regardless of position - used by `finishBook` for the
 * natural end AND for a manual "mark as finished" mid-book. A forced finish bypasses the
 * position/slip guards (they exist to protect an in-progress place, not a deliberate
 * completion) and records the whole-book duration so the book reads as 100% done. */
async function persist(opts?: { forceFinished?: boolean }) {
  const { nowPlaying, snapshot, rate, loadingBook } = usePlayer.getState();
  if (!nowPlaying) return;
  // A book whose load has not landed has no place here yet: the snapshot is still the
  // PREVIOUS book's (`loadingBook`), and mapped through this book's queue it is a place
  // this book never had (a switch of person, a sleep timer or a stall mid-start would save
  // it; a forced finish is the listener's own).
  if (loadingBook && !opts?.forceFinished) return;
  // Nor while the hot-swap moves the playing file to another index (`swapHold`).
  if (heldBySwap(nowPlaying, snapshot.trackIndex) && !opts?.forceFinished) return;
  // Nor an adoption's reloaded place, until it plays (`quietAdopted`).
  if (quietAdopted === contentKeyOf(nowPlaying) && !opts?.forceFinished) return;
  // A downloaded book started while its connection wasn't there (a session that could not
  // be read yet: a CarPlay launch with the phone locked) saves from when it is back.
  // A switch takes the next book's client before that book is `nowPlaying` (`switchBook`;
  // its resume lookup and load are awaits away): a save meanwhile (a lock-screen pause, the
  // sleep timer) is still the previous book's, and goes to its own server.
  const api =
    apiRefFor !== null && apiRefFor !== nowPlaying.connectionId
      ? resolveClient(nowPlaying.connectionId)
      : (apiRef ??= resolveClient(nowPlaying.connectionId));
  if (!api) return;
  const forceFinished = opts?.forceFinished ?? false;
  // Held while a reconcile check is out (a finish is the listener's own and still saves).
  // Past its deadline the hold is over even when its timer has not fired (Android pauses
  // JS timers in the background): end it here, and this save is the flush it owed.
  if (saveHold && Date.now() >= saveHold.expiresAt) {
    clearTimeout(saveHold.timer);
    saveHold = null;
  }
  if (saveHold && !forceFinished) return;
  const total = nowPlaying.queue.total;
  let position = toBookPosition(nowPlaying.queue.offsets, snapshot.trackIndex, snapshot.position);
  if (forceFinished) {
    if (total > 0) position = Math.max(position, total); // a completed book reads as 100%
  } else {
    if (position <= 0) return;
    // Guard against a slipped-through restart corrupting real progress: a position far
    // below the resume floor (without a deliberate backward seek, which lowers the floor)
    // is treated as a spurious reset and not saved. The server is last-write-wins, so a
    // small-position save with a newer timestamp would otherwise permanently overwrite the
    // user's place.
    if (position < resumeFloor - SLIP_TOLERANCE) return;
    if (position > resumeFloor) resumeFloor = position; // advance the high-water mark
  }
  const end = endAt(nowPlaying, snapshot.trackIndex, snapshot.position);
  const save = {
    connectionId: nowPlaying.connectionId,
    libraryId: nowPlaying.libraryId,
    path: nowPlaying.path,
    position,
    duration: total,
    finished: forceFinished || (total > 0 && position >= total - FINISHED_TOLERANCE),
    playback_speed: rate,
    device_id: deviceId || cachedDeviceId(),
    updated_at: new Date().toISOString(),
    // The file place (fe#188), the mirror's only (a PUT never sends it), on both paths: an
    // older capture's file place never outlives the place it was taken at.
    ...(forceFinished || !end.file ? {} : { file: end.file, file_pos: end.filePos }),
  };
  // Sync v2 (`listening_sync`): the place reaches the server as listening events (the
  // spans below); the capture only keeps this device's mirror.
  if (usesListeningSync(nowPlaying.connectionId)) {
    await writeMirror(save);
    if (span && sameBook(span, nowPlaying) && !forceFinished && finiteEnd(end)) span.to = end;
    return;
  }
  await saveProgress(api, save);
}

/** Nudge the Home/Browse "continue listening" + "finished" lists to re-read from
 * the server after playback halts. The live in-card position covers the actively-
 * playing book while it plays; this refreshes the other cards (finished state,
 * other-device progress) once it stops, without invalidating on every 15s save. */
function invalidateProgressLists() {
  // The playing book's connection scopes the invalidation (stop() invalidates
  // before it nulls nowPlaying, so the id is still in hand at every call site).
  const np = usePlayer.getState().nowPlaying;
  if (!np) return;
  void queryClient.invalidateQueries({ queryKey: qk.allProgress(np.connectionId) });
  // ...and this book's own progress entry: a book screen mounted alongside the player
  // (tablet/desktop, where the docked player bar plays under the page) reads
  // `useBookProgress` for its position/finished gating, which would otherwise stay stale
  // for as long as the screen stays mounted.
  void queryClient.invalidateQueries({
    queryKey: qk.progress(np.connectionId, np.libraryId, np.path),
  });
}

/** Download the book the user just started listening to, if they've opted in. Because the
 * player hot-swaps to the local copy the moment a download finishes
 * (`switchCurrentBookToLocal`), downloading on start covers a whole series - the next book
 * downloads as soon as "Play next" starts it. Honours the `autoDownloadNext` preference
 * and the network policy (`canAutoDownload`), and skips a book already downloaded or
 * queued/downloading (only an errored entry may be retried, matching the downloads store's
 * own guard). It asks as `auto`, so the downloads store applies the automatic rules (a
 * book the listener cancelled or removed this session, or one that would eat into the
 * reserve, is skipped); the default `listener` origin would lift that declined mark, as
 * if the listener had asked. Best-effort and fully guarded: any failure is swallowed and
 * it never touches playback. */
async function maybeAutoDownloadCurrent(
  connectionId: string,
  libraryId: number,
  book: Book,
  chapterData?: ChaptersResponse,
): Promise<void> {
  try {
    // Episodes are never downloaded (Bridge Phase 2d-1, decision 6.1).
    if (book.episode) return;
    const mode = useSettings.getState().autoDownloadNext;
    if (mode === 'never') return;
    // Already downloaded/queued/downloading? Nothing to do (only re-attempt an errored one).
    const existing =
      useDownloads.getState().entries[downloadKey(connectionId, libraryId, book.rel_path)];
    if (existing && existing.status !== 'error') return;
    if (!(await canAutoDownload(mode))) return;
    // download() no-ops when the engine can't store offline (web without a controlling
    // service worker, etc.), so no extra support guard is needed here.
    useDownloads.getState().download(connectionId, libraryId, book, chapterData, 'auto');
  } catch (err) {
    console.warn('[auto-download] failed to download the current book', err);
  }
}

/** What this device knows of `path`'s progress without the network (an explicit start
 * must not wait on it): the server's progress the app has cached (the book page reads it),
 * and the newer of that and the local mirror of the last save. */
async function knownProgress(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<{
  cached: Progress | null;
  newest: Pick<Progress, 'playback_speed' | 'finished'> | null;
}> {
  const cached =
    queryClient.getQueryData<Progress | null>(qk.progress(connectionId, libraryId, path)) ?? null;
  const mirror = await readMirror(connectionId, libraryId, path).catch(() => null);
  const newest =
    cached && mirror
      ? Date.parse(mirror.updated_at) >= Date.parse(cached.updated_at)
        ? mirror
        : cached
      : (cached ?? mirror);
  return { cached, newest };
}

/** The 15 s periodic save. An `engineTicker`, so the engine's events keep it going where
 * Android has paused the interval (screen off, app in the background). `playBook` stops
 * it before a book switch, so a late event of the old book never saves under the new one. */
const saveLoop = engineTicker(() => {
  void persist();
  tickListeningSpan();
}, SAVE_INTERVAL_MS);
/** Re-based on every start: the first save comes 15 s after playing starts. */
function startSaveLoop() {
  saveLoop.stop();
  saveLoop.start();
}
function stopSaveLoop() {
  saveLoop.stop();
}

/** Capture the current position then stop the periodic save loop - shared by the
 * engine's terminal states (pause/end/error) and the stall watchdog. Refreshes the
 * progress lists on both outcomes so a queued-offline save still re-reads server state. */
function haltAndPersist() {
  void persist().then(invalidateProgressLists, invalidateProgressLists);
  stopSaveLoop();
  void flushTimeSaved(); // Smart Speed's counts are saved when playback halts, too
}

// --- Listening spans (Sync v2, `listening_sync`; see `listening-outbox.ts`) ---------------
//
// On a server with `listening_sync` the place reaches it as listening events: a span of
// playing, from where it began to where it ended (whole-book seconds AND each end's file and
// seconds into it, fe#188), with why it began (`start`) and the version this device had
// acknowledged (`base_version`). A span OPENS when the engine starts playing; it is CUT
// (closed into an event, a new one opening at once with `continue`) on each 15 s tick while
// the server is reachable, a speed change, the server coming back, the app going to the
// background and the web page hiding; it is CLOSED on a pause (any settling out of
// `playing`), a move (the new place opens the next span with the move's reason), a stop, a
// book switch and the end. Offline, a tick only rewrites the open span (kept in storage, so
// a day offline is a handful of events and a kill loses nothing). The persist guards above
// (the load, the hot-swap, an adoption's reload, the resume floor) keep a suspicious place
// out of a span too: a span then ends where it was last seen.

/** The span being played, else null. */
let span: OpenSpan | null = null;
/** Why the next span begins: a book started or resumed (`resume`), a move (`jump`,
 * `moved_back`), starting again (`restart`). Back to `resume` once a span takes it. */
let nextStart: ListeningStart = 'resume';
/** A finished book started again owes an `unfinish` before its first span. */
let unfinishDue = false;
/** The book (`contentKey`) whose `finish` was sent: the natural end and the end credits'
 * "mark finished" send one between them. Cleared when the book plays again. */
let finishSent: string | null = null;

type ContentRef = { connectionId: string; libraryId: number; path: string };
const sameBook = (a: ContentRef, b: ContentRef) => contentKeyOf(a) === contentKeyOf(b);

/** The audio file (its rel path) of the track at `index`, from its id (`trackIdOf`). */
function fileOf(np: NowPlaying, index: number): string | undefined {
  const id = np.queue.tracks[index]?.id;
  const prefix = `${np.libraryId}:`;
  return id?.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

/** A place in the loaded book as a span end (its `pos` may not be finite: `finiteEnd`). */
function endAt(np: NowPlaying, trackIndex: number, positionInTrack: number): SpanEnd {
  const file = fileOf(np, trackIndex);
  return {
    pos: Math.max(0, toBookPosition(np.queue.offsets, trackIndex, positionInTrack)),
    ...(file && Number.isFinite(positionInTrack)
      ? { file, filePos: Math.max(0, positionInTrack) }
      : {}),
  };
}

/** Whether a span end is a real place: an engine that reports NaN (a stream with no length
 * yet) never puts one in a span or an event. */
const finiteEnd = (e: SpanEnd | null | undefined): e is SpanEnd => !!e && Number.isFinite(e.pos);

/** Where the engine is in the loaded book, or null while that place can't be trusted (the
 * persist guards: a load, the hot-swap, an adoption's reload, a slip below the floor). */
function engineEnd(): SpanEnd | null {
  const { nowPlaying: np, snapshot, loadingBook } = usePlayer.getState();
  if (!np || loadingBook || heldBySwap(np, snapshot.trackIndex)) return null;
  if (quietAdopted === contentKeyOf(np)) return null;
  const end = endAt(np, snapshot.trackIndex, snapshot.position);
  if (!finiteEnd(end) || end.pos < resumeFloor - SLIP_TOLERANCE) return null;
  return end;
}

/** The acknowledged version for a book (0 when none: the server then keeps the further
 * place of the two rather than moving a place this device never saw). */
async function baseVersionOf(ref: ContentRef) {
  const mirror = await readMirror(ref.connectionId, ref.libraryId, ref.path).catch(() => null);
  return mirror?.ack_version ?? 0;
}

/** A span of the loaded book from `at`, begun `now` (ISO) for `start`. */
function spanAt(
  np: NowPlaying,
  at: SpanEnd,
  start: ListeningStart,
  now: string,
  baseVersion = 0,
): OpenSpan {
  return {
    connectionId: np.connectionId,
    libraryId: np.libraryId,
    path: np.path,
    from: at,
    to: at,
    // The audio's length, not the timeline's: the server checks it against the indexed book.
    duration: np.queue.audio ?? 0,
    speed: usePlayer.getState().rate,
    startedAt: now,
    endedAt: now,
    start,
    baseVersion,
  };
}

/** Put events in a connection's outbox, then send. */
function emit(connectionId: string, events: ListeningEvent[]): void {
  void appendEvents(connectionId, events).then(() => flushOutbox(connectionId));
}

/** Open a span at `at` (else where the engine is) when the loaded book's server takes
 * listening events and none is open. */
function openListeningSpan(at?: SpanEnd) {
  const np = usePlayer.getState().nowPlaying;
  if (!np || !usesListeningSync(np.connectionId)) return;
  if (span) {
    if (sameBook(span, np)) return;
    closeListeningSpan();
  }
  const here = at ?? engineEnd();
  if (!finiteEnd(here)) return;
  const now = new Date().toISOString();
  const start = nextStart;
  nextStart = 'resume';
  const opened = spanAt(np, here, start, now);
  span = opened;
  if (finishSent === contentKeyOf(np)) finishSent = null;
  void baseVersionOf(np).then((base) => {
    opened.baseVersion = base;
    // A finished book started again: unfinished first, then the span from 0.
    if (unfinishDue) {
      unfinishDue = false;
      emit(np.connectionId, [finishEvent('unfinish', np, now, base)]);
    }
  });
}

/**
 * Close the open span at `at` (else where the engine is, else where it was last seen) into
 * the outbox, then send. Returns the closed span (null when none was open).
 */
function closeListeningSpan(opts: { at?: SpanEnd } = {}): OpenSpan | null {
  const closing = takeSpan(opts.at);
  if (!closing) return null;
  const cid = closing.connectionId;
  void closeSpan(closing).then(() => flushOutbox(cid));
  return closing;
}

/** Take the open span (none open from here), ended now at `at`, else where the engine is,
 * else where it was last seen. */
function takeSpan(at?: SpanEnd): OpenSpan | null {
  const closing = span;
  span = null;
  if (!closing) return null;
  const np = usePlayer.getState().nowPlaying;
  const here = finiteEnd(at) ? at : np && sameBook(closing, np) ? engineEnd() : null;
  if (here) closing.to = here;
  closing.endedAt = new Date().toISOString();
  return closing;
}

/** Cut the span (close it, a span opening where it ended, for `start`) while playing. */
function cutListeningSpan(start: ListeningStart = 'continue') {
  const closed = closeListeningSpan();
  if (!closed || !isPlayingState(usePlayer.getState().snapshot.state)) return;
  nextStart = start;
  openListeningSpan(closed.to);
}

/** The 15 s tick: cut while the server is reachable (live sessions), else keep the span.
 * Playing with none open, one opens here: the play's own could not (its place was held by a
 * load, the hot-swap or an adoption's reload), or the server took listening events only
 * since (its `/server` read while the book played; the history the PUT path began goes by
 * `POST /history` up to here). */
function tickListeningSpan() {
  if (!span) {
    const np = usePlayer.getState().nowPlaying;
    if (!np || !usesListeningSync(np.connectionId)) return;
    if (!isPlayingState(usePlayer.getState().snapshot.state)) return;
    if (historyStart && !historyStart.sync) {
      endHistory();
      beginHistory();
    }
    openListeningSpan();
    return;
  }
  if (isReachable(span.connectionId)) {
    cutListeningSpan();
    return;
  }
  const here = engineEnd();
  if (here) span.to = here;
  span.endedAt = new Date().toISOString();
  void storeOpenSpan({ ...span });
}

/**
 * A move of the place (a seek, a chapter, a bookmark, Undo, a lock-screen scrub) to
 * `target`: the span ends where it was (`from`, else the engine's place now, else where it
 * was last seen) and the next one begins at the target with the move's reason. Paused, the
 * move is sent at once as a span of its own that moved nowhere (the place syncs as a PUT
 * did), and the next play begins with the same reason.
 */
function moveListeningSpan(
  target: SpanEnd,
  opts: { from?: SpanEnd; reason?: ListeningStart } = {},
) {
  const np = usePlayer.getState().nowPlaying;
  if (!np || !usesListeningSync(np.connectionId)) return;
  const from = finiteEnd(opts.from) ? opts.from : undefined;
  const before = from ?? (span ? (engineEnd() ?? span.to) : engineEnd());
  // A place that is not one (NaN) moves nothing: the span just ends where it was.
  if (!finiteEnd(target)) {
    closeListeningSpan(before ? { at: before } : {});
    return;
  }
  const reason: ListeningStart =
    opts.reason ?? (before && target.pos < before.pos - 1 ? 'moved_back' : 'jump');
  const closed = closeListeningSpan(before ? { at: before } : {});
  if (closed && isPlayingState(usePlayer.getState().snapshot.state)) {
    nextStart = reason;
    openListeningSpan(target);
    return;
  }
  const now = new Date().toISOString();
  void baseVersionOf(np).then((base) =>
    emit(np.connectionId, [spanToEvent(spanAt(np, target, reason, now, base))]),
  );
  nextStart = reason;
}

/** The book's last span closed, then its `finish` (the natural end, "Mark finished"):
 * once between them. */
function sendFinish(np: NowPlaying) {
  closeListeningSpan();
  if (!usesListeningSync(np.connectionId)) return;
  const key = contentKeyOf(np);
  if (finishSent === key) return;
  finishSent = key;
  const now = new Date().toISOString();
  void baseVersionOf(np).then((base) =>
    emit(np.connectionId, [finishEvent('finish', np, now, base)]),
  );
}

/**
 * After the listener answered an offer of another device's place with Stay: this device's
 * place stands, so its next span begins as a deliberate move (`jump`), which the server
 * applies over the other place. Playing, the span is cut so that begins now.
 */
export function standByPlace(): void {
  nextStart = 'jump';
  if (span && isPlayingState(usePlayer.getState().snapshot.state)) cutListeningSpan('jump');
}

/** Cut the playing span now (the server came back, the app went to the background); a
 * no-op with no span open, or for another connection than `connectionId` when given. */
export function cutListeningSpanNow(connectionId?: string): void {
  if (!span || (connectionId !== undefined && span.connectionId !== connectionId)) return;
  cutListeningSpan();
}

/** Web `pagehide`: close the span and send what waits in a keepalive request. */
function closeSpanOnPageHide() {
  const closing = takeSpan();
  const extra: OutboxEntry[] = [];
  if (closing) {
    const event = spanToEvent(closing);
    void closeSpan(closing, event);
    extra.push({ connectionId: closing.connectionId, event });
  }
  sendOnPageHide(extra, deviceId || cachedDeviceId());
}

/** Surface an `error` if we wanted to play but haven't reached `playing` within the
 * grace - a dead/stalled stream then offers a retry instead of an endless spinner. The
 * watchdog is armed by the play/retry actions (and by a mid-playback stall's `loading`),
 * NOT by trying to interpret the native bridge's noisy resume/retry event stream - so no
 * event ordering can prevent it from firing. Idempotent: one fixed window per attempt;
 * only reaching `playing` (or a user pause/stop) cancels it. The fire test is simply
 * "not playing", so it doesn't matter what transient state the bridge left us in. Lives
 * in shared JS so iOS, Android and web behave identically. */
function armStallWatchdog() {
  if (stallTimer) return;
  stallTimer = setTimeout(() => {
    stallTimer = null;
    if (!wantsPlayback) return; // attempt abandoned (user paused/stopped)
    const { snapshot } = usePlayer.getState();
    if (snapshot.state === 'playing') return; // we made it
    clearPlaybackIntent();
    usePlayer.setState({ snapshot: { ...snapshot, state: 'error' } });
    haltAndPersist();
  }, STALL_GRACE_MS);
}

/** Begin a playback attempt: we intend to play, we're "connecting" until the engine
 * reaches `playing`, and the stall watchdog is ticking from now (a dead/slow-to-start
 * stream surfaces an error after the grace, matching the old native behavior). */
function beginPlaybackAttempt() {
  playAttempts++;
  wantsPlayback = true;
  startingPlayback = true;
  armStallWatchdog();
}

function cancelStallWatchdog() {
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}

/** Abandon the playback attempt/intent - the inverse of `beginPlaybackAttempt`. Shared
 * by every path that settles into not-playing (user pause/stop, the engine's terminal
 * states, the watchdog firing, a failed resume lookup) so no site can forget a piece
 * of the intent state. */
function clearPlaybackIntent() {
  wantsPlayback = false;
  startingPlayback = false;
  cancelStallWatchdog();
}

/** Start the engine. The browser's autoplay refusal (web, no user gesture yet: a cold
 * `/player` deep link) is a plain pause, not a failure: drop the intent (so the stall
 * watchdog never turns it into `error`) and settle on `paused`, so the play button comes
 * back and a press (the gesture it wanted) plays. Every other failure rejects as a
 * `PlaybackStartError` saying why (`startFailure`). */
async function startEngine(svc: PlaybackService): Promise<void> {
  try {
    await svc.play();
  } catch (err) {
    if (!(err instanceof AutoplayBlockedError)) throw startFailure(err);
    clearPlaybackIntent();
    const { snapshot } = usePlayer.getState();
    usePlayer.setState({ snapshot: { ...snapshot, state: 'paused' } });
  }
}

/** A failed start as the listener is told it: the loaded book streams from a server known
 * to be unreachable (`offline`, whatever the engine said; a downloaded book needs no
 * server), else the engine's own reason (the web engine's `audio`), else `unknown`. */
function startFailure(err: unknown): PlaybackStartError {
  const np = usePlayer.getState().nowPlaying;
  const connectionId = np?.connectionId;
  const reason =
    np && !isReachable(np.connectionId) && !downloadedEntryOf(np)
      ? 'offline'
      : err instanceof PlaybackStartError
        ? err.reason
        : 'unknown';
  return new PlaybackStartError(reason, { cause: err, connectionId });
}

/** `startEngine` for a press on a book already loaded (play/pause, Retry): a failure shows
 * where the book is (the engine's error state: the Retry button and its error line, or
 * the stall watchdog's), so it is logged, not thrown at a caller with nothing to add. */
async function startLoadedEngine(svc: PlaybackService): Promise<void> {
  try {
    await startEngine(svc);
  } catch (err) {
    console.warn('[player] could not start playback', err);
  }
}

/** Mark the start of a listening span when playback begins. */
function beginHistory() {
  if (historyStart) return;
  const player = usePlayer.getState();
  if (!player.nowPlaying) return;
  historyStart = {
    position: selectBookPosition(player),
    at: Date.now(),
    sync: usesListeningSync(player.nowPlaying.connectionId),
  };
}

/** Record the listening span (from→to over the elapsed time) when playback
 * stops, ignoring brief spans. `leaving`: the page is going or hiding (web), so nothing
 * on screen shows the span. On web every span goes as a keepalive request: a hard
 * navigation pauses the audio before `pagehide`, so the span that pause ends is posted
 * from a page that is going, and a plain request was aborted with it ("failed to save
 * listening span", v2.5.1 PLAYER-14). A span is far below keepalive's 64 KB. */
function endHistory({ leaving = false }: { leaving?: boolean } = {}) {
  const start = historyStart;
  historyStart = null;
  if (!start || !apiRef || Date.now() - start.at < MIN_HISTORY_MS) return;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np) return;
  // Listening spans are best-effort; don't fire at a server we know is unreachable
  // (reachability is per-connection, so key it on the playing book's own server).
  if (!isReachable(np.connectionId)) return;
  // A server taking listening events has them already (the spans above), when it took
  // them from the listening's start (`tickListeningSpan` ends a PUT path's history where a
  // span opens) and still does (not rolled back since).
  if (start.sync && usesListeningSync(np.connectionId)) return;
  void apiRef
    .addHistory(
      np.libraryId,
      np.path,
      {
        from_pos: start.position,
        to_pos: selectBookPosition(player),
        started_at: new Date(start.at).toISOString(),
        ended_at: new Date().toISOString(),
      },
      { keepalive: leaving || Platform.OS === 'web' },
    )
    .then(() => {
      // Not for a span posted as the page hides or goes: nothing on screen shows it, and
      // coming back reads every query again (`refreshAfterResume`), so a hidden tab that
      // splits its span at each switch doesn't refetch the history each time.
      if (!leaving)
        void queryClient.invalidateQueries({ queryKey: qk.historyAll(np.connectionId) });
    })
    .catch((err) => {
      noteFailure(np.connectionId, err); // a check, not a down mark, for one lost span
      console.warn('[history] failed to save listening span', err);
    });
}

/**
 * Web: the listening span when the page goes or hides, sent with a keepalive request that
 * outlives the page (PLAYER-03: closing a playing tab lost the span, which was only written
 * on pause or stop). `pagehide` (closed, reloaded, navigated off) ends it; `hidden` (a
 * phone's browser may close a tab with no `pagehide`) splits it, once it is long enough to
 * keep, playing on into a new span, so a background tab is still recorded. One post per
 * span: ending it clears it first.
 */
export function flushHistoryOnHide(final: boolean): void {
  // Sync v2: the page going closes the span and sends what waits with keepalive; hiding
  // cuts it (a phone's browser may close a hidden tab with no `pagehide`).
  if (final) closeSpanOnPageHide();
  else cutListeningSpanNow();
  if (!historyStart) return;
  if (!final && Date.now() - historyStart.at < MIN_HISTORY_MS) return;
  endHistory({ leaving: true });
  if (!final && isPlayingState(usePlayer.getState().snapshot.state)) beginHistory();
}

/** Listens for the page going (`flushHistoryOnHide`) on `win`/`doc`; returns the stop. */
export function watchPageHide(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>,
): () => void {
  const onPageHide = () => flushHistoryOnHide(true);
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') flushHistoryOnHide(false);
  };
  win.addEventListener('pagehide', onPageHide);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('pagehide', onPageHide);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined') {
  watchPageHide(window, document);
}

/**
 * The switch to another book, as `playBook` and `adoptLoaded` both make it, BEFORE
 * `nowPlaying` changes: the previous book's listening span flushed, its stall timer dropped
 * and its periodic save loop stopped (otherwise a 15 s tick, or the engine's continued ticks
 * after an early return, would map the OLD engine position through the NEW book's queue and
 * persist it under the new book's path, corrupting its progress; the loop restarts on the
 * engine's next `playing` transition for the new book), counted as the listener's own move,
 * and the new book's server (null for a downloaded book whose connection is gone: history
 * is then a no-op, and persist saves nothing until the connection is back) and retry
 * request taken.
 */
function switchBook(api: ApiClient | null, request: NonNullable<typeof lastPlayRequest>) {
  endHistory();
  closeListeningSpan();
  // The next book's first span begins as its start says (`playBook`), an adopted one's as a
  // resume.
  nextStart = 'resume';
  unfinishDue = false;
  cancelStallWatchdog();
  stopSaveLoop();
  userMoved();
  apiRef = api;
  apiRefFor = request.connectionId;
  lastPlayRequest = request; // so retry() can re-run resume
  resumeLookupFailed = false;
}

/**
 * A new book must never inherit a stale sleep-timer fade gain. The timer restores the
 * volume on every path it owns; this is the backstop for the one it doesn't - something
 * going wrong mid-fade, or a JS restart mid-fade (the engine's volume is sticky, while a
 * fresh `outputVolume` reads 1, so a later restore to 1 would be skipped) - because
 * near-silent audio with no visible cause is the worst failure this feature can produce.
 * Not awaited: it is a no-op in the common case, and every play would otherwise wait on a
 * bridge round-trip.
 *
 * Written unconditionally (not through `setOutputVolume`) because this is the backstop for
 * a gain the store may have lost track of; `outputVolume` is updated with it so the no-op
 * check can never think the engine is quieter than it is.
 *
 * Called AFTER `nowPlaying` is swapped, at every site that swaps it, and that ordering is
 * the whole point: the fade ticker cancels itself by comparing the playing book against
 * the timer's own, so while `nowPlaying` still holds the OLD book it keeps writing the fade
 * gain - a resume lookup is a network round trip, far more than the fade's 250ms period.
 * Restoring before the swap simply handed the ticker a window to undo it in, and the new
 * book could start attenuated. A fade running for the swapped-in book itself (only
 * possible for a timer that outlived the store's own book) writes its gain again on its
 * next tick.
 */
function restoreOutputGain(svc: PlaybackService) {
  outputVolume = 1;
  void svc.setVolume(1);
}

/** The service being created, while it is: ONE creation however many callers race to the
 * first (adopting the service's book at a JS boot while a car request starts another): two
 * bridges would each re-emit every native event with their own file index. */
let servicePending: Promise<PlaybackService> | null = null;

/** Initialize the shared router for a restored session without starting any media. */
export async function initializePlayback(): Promise<void> {
  await ensureService();
}

function ensureService(): Promise<PlaybackService> {
  if (service) return Promise.resolve(service);
  servicePending ??= createService().finally(() => {
    servicePending = null;
  });
  return servicePending;
}

async function createService(): Promise<PlaybackService> {
  const svc = createPlaybackService();
  await svc.setup();
  await svc.configure(currentConfig());
  // Keep auto-rewind + lock-screen skip intervals in sync with the settings store.
  useSettings.subscribe(() => void svc.configure(currentConfig()));
  svc.subscribe((raw) => {
    // Collapse the native bridge's noisy resume/retry event stream to a spinner. While
    // starting (after a play/retry, before we reach `playing`), the only real outcomes
    // are `playing` (success) and `error` (the watchdog gave up); every transient the
    // bridge emits while rebuilding the queue - `ready`, `paused`, `idle`, `ended`,
    // `loading` - is "still connecting" → `loading`. This is what makes the spinner and
    // watchdog robust regardless of event ordering (the spurious `paused` used to clear
    // intent and strand the spinner). A genuine user/lock-screen pause arrives AFTER
    // `playing` (startingPlayback already false), so it stays `paused`. Outside a fresh
    // start, a `ready` while intending to play is also a spinner.
    let state = raw.state;
    if (startingPlayback && state !== 'playing' && state !== 'error') state = 'loading';
    else if (state === 'ready' && wantsPlayback) state = 'loading';
    // When we're NOT intending to play (no attempt in flight), an engine `loading`
    // is not "connecting" - it's a stalled/failed item we have no watchdog for
    // (the watchdog only arms while wantsPlayback). iOS reports a failed item as
    // `loading` even while the user has the book paused; left as `loading` it would
    // strand an endless spinner with no retry. Read it as `paused` so the play
    // button comes back (tapping it starts a fresh attempt, which the watchdog covers).
    else if (state === 'loading' && !wantsPlayback && !startingPlayback) state = 'paused';
    const snapshot: PlaybackSnapshot = state === raw.state ? raw : { ...raw, state };
    const prev = usePlayer.getState().snapshot;
    // After the stall watchdog (or an engine error) surfaces an `error`, the engine
    // keeps re-reporting around the dead stream - iOS: frozen `onProgress` ticks
    // carrying `loading`; Android: `onPlayerError` then `STATE_IDLE` → `idle`, plus its
    // own progress ticks. Any of those would overwrite the `error` and drop the UI back
    // to a spinner/play button (the flash→spinner loop seen on Android). So once we're
    // in `error` and NOT retrying, hold it against EVERY re-report except a genuine
    // recovery (`playing`). It's released by the user retrying (wantsPlayback flips true
    // → this guard is skipped) or the stream actually resuming. Enumerating the "noisy"
    // states bit us repeatedly (loading, ready, idle, paused…); suppress-all-but-playing
    // is the robust rule.
    if (prev.state === 'error' && !wantsPlayback && snapshot.state !== 'playing') {
      return;
    }
    usePlayer.setState({ snapshot });
    // Listening spans use the STRICT reading (see `isPlayingState`): a span must cover
    // audio the listener actually heard, so a buffer is not the start of one.
    if (isPlayingState(snapshot.state) && !isPlayingState(prev.state)) {
      beginHistory();
      openListeningSpan();
    } else if (isPlayingState(prev.state) && !isPlayingState(snapshot.state)) {
      endHistory();
      // The natural end sends the finish after the last span (`sendFinish`, below).
      if (snapshot.state !== 'ended') closeListeningSpan();
    }
    // Close + reopen a span when the track advances mid-playback (e.g. a
    // multi-file book auto-advancing), so each file is logged as it finishes.
    else if (isPlayingState(snapshot.state) && snapshot.trackIndex !== prev.trackIndex) {
      endHistory();
      beginHistory();
    }
    // Drive the periodic progress save off the real play state: it runs only while
    // actually playing, so we don't keep re-saving the same position every 15s
    // after pause/stop/end - including a lock-screen pause or a book that simply
    // finishes, neither of which calls stop().
    if (snapshot.state !== prev.state) {
      // A lock-screen play/pause arrives here (the engine state), not through the store
      // actions - so keep intent + the start window in sync with it.
      if (snapshot.state === 'playing') {
        // Reached playback - the stream is alive and we're no longer "connecting".
        wantsPlayback = true;
        startingPlayback = false;
        cancelStallWatchdog();
        // Picked up again after a long pause, from anywhere (a press, the lock screen,
        // earbuds): the listener is told synchronously, so its save hold is in place
        // before this play's first save.
        const pickedUp = pausedAt !== null && Date.now() - pausedAt >= LONG_PAUSE_MS;
        pausedAt = null;
        // Playing again: its place is new from here. Not a play the engine reports while an
        // adoption's reload holds the store (still the old order's, and a paused one is paused
        // again once loaded): `reloadAdopted` clears it once its own play stands.
        if (quietAdopted !== usePlayer.getState().loadingBook) quietAdopted = null;
        // The span the transition above could not open while that held the place opens
        // now (a no-op with one open).
        openListeningSpan();
        if (pickedUp) pickUp();
        startSaveLoop();
      } else if (snapshot.state === 'loading') {
        // A mid-playback stall (or the ongoing start attempt): arm the watchdog so a
        // buffer that outlasts the grace surfaces an error. Idempotent - already armed
        // when an attempt began. Only when we intend to play.
        if (wantsPlayback) armStallWatchdog();
      } else if (snapshot.state === 'ended') {
        // The book reached its natural end. Behave like a pause: clear intent and run a
        // final persist (which records finished:true via the FINISHED_TOLERANCE), halting
        // the save loop. But deliberately KEEP nowPlaying populated and the `ended`
        // snapshot visible so a UI-layer listener can drive the end-of-book flow (end
        // credits, auto-play next). Do NOT navigate or clear state here.
        clearPlaybackIntent();
        haltAndPersist();
        const np = usePlayer.getState().nowPlaying;
        if (np) sendFinish(np);
      } else {
        // Any other settled state (a start-window transient was normalized to `loading`
        // above): a real pause, a finished book, a dead stream the web/Android engines
        // report directly, Android's STATE_IDLE after a stop-like failure, or a stray
        // `ready`. All clear intent and halt the loop. Deliberately NOT an enumerated
        // state list - that list kept coming up short (an unhandled `idle` left the 15s
        // save loop re-persisting the same position forever); like the error hold above,
        // anything that isn't `playing`/`loading` settles playback.
        pausedAt ??= Date.now();
        clearPlaybackIntent();
        haltAndPersist();
      }
    }
    // The engine's events drive the periodic work (the save, the sleep timer) where
    // Android has paused the JS timers: see `engineTicker`.
    engineTick();
  });
  // The OS media controls' seeks (web Media Session) go through the store's own seek,
  // so a lock-screen scrub back lowers the resume floor and saves like any other seek.
  svc.onRemoteSeek?.((positionInTrack) => void usePlayer.getState().seekInTrack(positionInTrack));
  // Native: the engine already moved for the lock screen, a headset or the car (its
  // snapshot already holds the landed place). That is the listener's own move: it lowers
  // the floor (a scrub back past the slip tolerance would otherwise never save) and counts
  // for the place reconcile, which then stands back.
  svc.onRemoteMove?.((trackIndex, positionInTrack) => {
    const { nowPlaying: np, loadingBook } = usePlayer.getState();
    // A move reported while a book loads is the PREVIOUS queue's (a native move reported a
    // moment late): mapped through the new book's queue it would lower its floor to, and
    // save, a place that book never had. So is one at the download's index while the
    // hot-swap moves the playing file (`swapHold`).
    if (loadingBook || (np && heldBySwap(np, trackIndex))) return;
    userMoved(np ? toBookPosition(np.queue.offsets, trackIndex, positionInTrack) : undefined);
    // The engine has moved already: the span ends where it was last seen.
    if (np) moveListeningSpan(endAt(np, trackIndex, positionInTrack), { from: span?.to });
    void persist();
  });
  // Native: the OS changed the speed and the engine already runs at it. Only a speed
  // outside the app's range goes back to the engine, clamped.
  svc.onRateChange?.((raw) => {
    const rate = clampRate(raw);
    usePlayer.setState({ rate });
    if (rate !== raw) void svc.setRate(rate);
    cutListeningSpan();
    void persist();
  });
  // Smart Speed's running total, counted on the playing book (`time-saved.ts`).
  svc.onSilenceSaved?.((total) => noteSilenceSaved(total, selectBookKey(usePlayer.getState())));
  service = svc;
  // Expose whether this platform/engine can show an audio-route picker so the player
  // can decide whether to render the cast button (web: only where the APIs exist).
  usePlayer.setState({ canRoutePick: svc.canShowRoutePicker?.() ?? false });
  return svc;
}

export const usePlayer = create<PlayerState>()((set, get) => ({
  nowPlaying: null,
  snapshot: { ...INITIAL_SNAPSHOT },
  rate: 1,
  loadingBook: null,
  canRoutePick: false,

  playBook: async (
    connectionId,
    libraryId,
    book,
    chapterData,
    startBookPosition,
    startTrack,
    startSpeed,
  ) => {
    // Only the person listening's books (Phase 8, `mayActFor`): every way a book starts
    // comes through here, so none can save to another person's account.
    if (!mayActFor(connectionId)) return;
    // Asked again after each await that could outlast a switch of person (`switchProfile`
    // stops only a book that is already `nowPlaying`): a start still looking up its place
    // must not load, play or save someone else's book once they have gone.
    const current = () => mayActFor(connectionId);
    // In flight until it ends: an adoption reading meanwhile stands back (`startsInFlight`).
    startsInFlight++;
    try {
      // Resolve the client from the connection id (single source of truth), mirroring the
      // downloads store - so a caller can't pass an `api` that disagrees with `connectionId`.
      const api = resolveClient(connectionId);

      // Play from local files when the book is downloaded (works fully offline).
      const ref = { connectionId, libraryId, path: book.rel_path };
      const dl = downloadedEntryOf(ref);
      const local = dl ? localFromManifest(dl.manifest) : undefined;

      // A fully-downloaded book plays entirely from `local` files, so it can start even when
      // the connection is gone (e.g. its secure-store token failed to hydrate this launch,
      // dropping it from the session while its download entry survives). Only a book that
      // still needs the server (not downloaded) requires a live client.
      if (!api && !local) return; // connection gone and nothing local; nothing to play

      // The previous book's place, saved now through its own server: the switch stops its
      // save loop (up to 15 s unsaved), and once this book is `nowPlaying` nothing saves it
      // again. Here, not in `switchBook`: the engine still holds the previous book (an
      // adoption's engine already plays another, so its snapshot is not that book's).
      void persist();
      switchBook(api, { connectionId, libraryId, book, chapterData });
      pausedAt = null; // a book (re)started here just had its place looked up
      pickUpDue = null;
      deviceId = await getDeviceId();

      // Web only: a book the browser can't decode streams through the server's transcoder
      // when it has one (playback/transcode.ts). Decided once here, so every later reload
      // (retry, seeks) reuses the queue's transcoded tracks; a downloaded book is local
      // files and never transcodes. Every other book skips the lookup (and its await).
      const transcode =
        !local &&
        mayNeedWebTranscode(book, chapterData) &&
        (await resolveWebTranscode(connectionId, api, book, chapterData));
      // A downloaded book given no chapters (its chapters read failed) plays its download's
      // files and chapters, the order its manifest holds, so the engine never holds an order
      // the manifest does not (`adoptStartedChapters`).
      const own = dl && !chapterData ? dl.manifest : undefined;
      const queueChapters = chapterData ?? own?.chapters ?? undefined;
      const queue = buildBookQueue(
        api,
        libraryId,
        own ? { ...book, files: own.book.files, chapters: own.book.chapters } : book,
        queueChapters,
        local,
        useSettings.getState().virtualChapterInterval,
        transcode,
      );
      const nowPlaying = nowPlayingOf(ref, book, queue, api, local);
      const svc = await ensureService();

      let startAt = startBookPosition ?? 0;
      /** The resumed save's own file and the seconds in it (fe#188), when the queue has it. */
      let startFile: { index: number; positionInTrack: number } | null = null;
      // Why the first span begins: an explicit place is a deliberate move (0: starting again).
      let start: ListeningStart =
        startBookPosition === undefined && startTrack === undefined
          ? 'resume'
          : startBookPosition === 0 || (startBookPosition === undefined && startTrack === 0)
            ? 'restart'
            : 'jump';
      let unfinish = false;
      const askedSpeed = startSpeed !== undefined && startSpeed > 0;
      // 1x for a kids profile, else the listener's setting (`listenerSettings`).
      const { defaultRate } = listenerSettings();
      let speed = clampRate(askedSpeed ? startSpeed : defaultRate);
      if (startBookPosition === undefined && startTrack === undefined) {
        const r = await loadInitialProgress(api, connectionId, libraryId, book.rel_path);
        if (!current()) return;
        if (r.kind === 'progress') {
          // An unfinished book resumes where it left off, a finished one starts again at 0
          // (`resumeStart`). resumeFloor is derived from startAt below, so a restart's floor
          // is 0 and the slip guard won't block its early low-position saves.
          startAt = resumeStart(r.progress);
          if (!askedSpeed) speed = bookSpeed(r.progress.playback_speed, defaultRate);
          if (r.progress.finished) {
            // Starting a finished book again: unfinished first, then a span from 0.
            start = 'restart';
            unfinish = true;
          } else if (r.file) {
            // This device's own place by its file: the same file in the order the queue
            // plays now, even when the place was saved on another order (fe#188).
            const index = trackIndexById(queue, trackIdOf(libraryId, r.file.path));
            if (index >= 0) {
              const end = queue.offsets[index + 1] ?? queue.total;
              const length = end - queue.offsets[index];
              startFile = {
                index,
                positionInTrack: length > 0 ? Math.min(r.file.pos, length) : r.file.pos,
              };
            }
          }
          // Resumed from the server's row (this device's own records read as version 0):
          // its version is the one this device has seen. Stored before the book plays: a
          // span's base is read when it closes (`closeSpan`).
          if (r.progress.version > 0) {
            await ackVersion(
              connectionId,
              libraryId,
              book.rel_path,
              r.progress.version,
              r.progress,
            ).catch(() => undefined);
          }
        } else if (r.kind === 'failed' && !dl) {
          // Streaming book whose resume position couldn't be confirmed (server unreachable,
          // no local record). Starting at 0 here would restart an in-progress book AND a
          // later save could overwrite the real place. Fail safe: surface a recoverable
          // error (the player offers Retry, which re-runs this lookup) instead of playing.
          resumeLookupFailed = true;
          // Fully stop the previous book first: clear playback intent (so the error hold
          // in `subscribe` isn't defeated by leftover `wantsPlayback`) and reset the engine
          // (so the previous book's audio + ticks stop). Without this the old book keeps
          // playing while the UI shows the new one, and its ticks save under the new path.
          clearPlaybackIntent();
          await svc.reset();
          if (!current()) return;
          set({
            rate: speed,
            nowPlaying,
            snapshot: { ...INITIAL_SNAPSHOT, state: 'error', rate: speed },
          });
          restoreOutputGain(svc);
          return;
        }
        // kind 'empty' (server reachable, genuinely new) or 'failed' for a downloaded book
        // (offline-first, never started) → startAt stays 0, which is correct.
      } else {
        // An explicit place (a chapter tap, a bookmark, a deep link) skips the resume lookup,
        // so what it gives comes from what this device knows of the book: the saved speed
        // (starting at the default would save the default over the book's own), and on Sync
        // v2 whether it is finished (a listen never unfinishes it: played again, it is
        // unfinished first, as a PUT save from the place did) and the server's row the
        // listener saw (its version acknowledged, so a move back from there applies).
        const known = await knownProgress(connectionId, libraryId, book.rel_path);
        const saved = known.newest?.playback_speed ?? 0;
        if (!askedSpeed && saved > 0) speed = clampRate(saved);
        if (known.newest?.finished) unfinish = true;
        if (known.cached && known.cached.version > 0 && usesListeningSync(connectionId)) {
          await ackVersion(
            connectionId,
            libraryId,
            book.rel_path,
            known.cached.version,
            known.cached,
          ).catch(() => undefined);
        }
      }

      if (!current()) return;
      const { index, positionInTrack } =
        startTrack !== undefined
          ? {
              index: Math.max(0, Math.min(startTrack, queue.tracks.length - 1)),
              positionInTrack: 0,
            }
          : (startFile ?? locate(queue.offsets, startAt));
      // The position we actually resumed from (covers resume, bookmark jump and startTrack);
      // the save guard won't let progress regress below it without a deliberate seek.
      resumeFloor = toBookPosition(queue.offsets, index, positionInTrack);
      // A different book's place is not known until its load lands (`loadingBook`).
      const key = contentKey(connectionId, libraryId, book.rel_path);
      const prev = get();
      const loadingBook = selectBookKey(prev) === key ? prev.loadingBook : key;
      set({ rate: speed, nowPlaying, loadingBook });
      nextStart = start;
      unfinishDue = unfinish && usesListeningSync(connectionId);
      finishSent = null;
      restoreOutputGain(svc); // only now can the old book's fade no longer write over it
      beginPlaybackAttempt(); // intent + start window + watchdog armed from here
      try {
        await svc.load(
          queue.tracks,
          index,
          positionInTrack,
          queue.chapterClips,
          bookRefOf(nowPlaying),
        );
      } finally {
        // Also when the load failed: a `loadingBook` left behind would hold every save and
        // every remote move of whatever plays next.
        if (get().loadingBook === key) set({ loadingBook: null });
      }
      if (!current()) {
        // Switched away while it loaded: the switch's `stop` reset the engine before this
        // load landed in it, so reset again (a set `nowPlaying` means `stop` has not yet).
        if (!get().nowPlaying) await svc.reset();
        return;
      }
      // Another book was started while this one loaded (a second tap, Up next): that start
      // owns the engine now, so this one neither sets its speed nor plays.
      if (selectBookKey(get()) !== key) return;
      // The engine holds the queue built from these chapters now: a download takes them,
      // with a new file order when its server re-ordered the files (`adoptStartedChapters`).
      if (dl && queueChapters) adoptStartedChapters(ref, queueChapters);
      await svc.setRate(speed);
      if (!current()) return;
      await startEngine(svc);
      // The save loop is started by the engine 'playing' transition (see subscribe).
      void flushQueue();
      // Fire-and-forget AFTER playback is initiated (never before/awaited, so it can't delay
      // or break starting the book): download the book we just started, if the user opted in.
      void maybeAutoDownloadCurrent(connectionId, libraryId, book, chapterData);
    } finally {
      startsInFlight--;
    }
  },

  toggle: async () => {
    const svc = await ensureService();
    // persist + save-loop start/stop are handled by the engine state transition.
    // `loading` counts as "trying to play" here so a tap on the spinner (slow start
    // or mid-playback stall) cancels the attempt instead of re-arming a new one.
    const st = get().snapshot.state;
    if (st === 'playing' || st === 'loading') {
      clearPlaybackIntent();
      await svc.pause();
    } else {
      beginPlaybackAttempt();
      await startLoadedEngine(svc);
    }
  },

  pause: async () => {
    clearPlaybackIntent();
    const svc = await ensureService();
    // Also pause while still `loading`: an in-flight start would otherwise resolve
    // to `playing` and silently defeat the pause (e.g. the sleep timer firing while
    // the stream is buffering). The engine pause is idempotent in either state.
    const st = get().snapshot.state;
    if (st === 'playing' || st === 'loading') await svc.pause();
  },

  retry: async () => {
    // If the failure was at the resume-lookup stage, re-run the resume path (re-fetch
    // progress) rather than reloading at a stale 0 - this is the recovery for the
    // fail-safe in playBook.
    if (resumeLookupFailed && lastPlayRequest) {
      const { connectionId, libraryId, book, chapterData } = lastPlayRequest;
      resumeLookupFailed = false;
      // Like the reload below, never rejects (its callers are presses): a start that fails
      // shows where the book is, in its error state.
      await get()
        .playBook(connectionId, libraryId, book, chapterData)
        .catch((err: unknown) => console.warn('[player] could not start playback', err));
      return;
    }
    const np = get().nowPlaying;
    if (!np) return;
    // Rebuild the engine's items from the known-good book position so a failed/
    // unreachable stream is re-requested (a dead AVPlayerItem can't recover via
    // play() alone), then resume. Never reload below the resume floor, so a transient
    // bad 0 in the snapshot can't be re-loaded. The watchdog is armed from here, so
    // even if the reload's event stream is noisy it still surfaces an error if it
    // never plays.
    beginPlaybackAttempt();
    const svc = await ensureService();
    const bookPos = Math.max(resumeFloor, selectBookPosition(get()));
    const { index, positionInTrack } = locate(np.queue.offsets, bookPos);
    await svc.load(np.queue.tracks, index, positionInTrack, np.queue.chapterClips, bookRefOf(np));
    await svc.setRate(get().rate);
    await startLoadedEngine(svc);
  },

  seekBook: async (bookPosition) => {
    const np = get().nowPlaying;
    if (!np || !Number.isFinite(bookPosition)) return;
    const clamped =
      np.queue.total > 0
        ? Math.max(0, Math.min(bookPosition, np.queue.total))
        : Math.max(0, bookPosition);
    const svc = await ensureService();
    const target = locate(np.queue.offsets, clamped);
    moveListeningSpan(endAt(np, target.index, target.positionInTrack));
    userMoved(clamped); // a deliberate user seek may legitimately move backward
    if (target.index === get().snapshot.trackIndex) {
      await svc.seekTo(target.positionInTrack);
    } else {
      await svc.skipToTrack(target.index, target.positionInTrack);
    }
    void persist();
  },

  seekInTrack: async (positionInTrack) => {
    if (!Number.isFinite(positionInTrack)) return;
    const dur = get().snapshot.duration;
    const pos = Math.max(0, dur > 0 ? Math.min(positionInTrack, dur) : positionInTrack);
    const svc = await ensureService();
    const np = get().nowPlaying;
    if (np) moveListeningSpan(endAt(np, get().snapshot.trackIndex, pos));
    userMoved(np ? toBookPosition(np.queue.offsets, get().snapshot.trackIndex, pos) : undefined);
    await svc.seekTo(pos);
    void persist();
  },

  goToTrack: async (index) => {
    const np = get().nowPlaying;
    if (!np) return;
    const i = Math.max(0, Math.min(index, np.queue.tracks.length - 1));
    const svc = await ensureService();
    moveListeningSpan(endAt(np, i, 0));
    userMoved(toBookPosition(np.queue.offsets, i, 0));
    await svc.skipToTrack(i, 0);
    void persist();
  },

  skipSeconds: async (delta) => {
    const np = get().nowPlaying;
    if (!np) return;
    // No reliable whole-book timeline (file durations unknown): seek within the
    // current track using the engine's reported position instead.
    if (np.queue.total <= 0) {
      await get().seekInTrack(get().snapshot.position + delta);
      return;
    }
    const pos = toBookPosition(
      np.queue.offsets,
      get().snapshot.trackIndex,
      get().snapshot.position,
    );
    await get().seekBook(Math.max(0, Math.min(np.queue.total, pos + delta)));
  },

  setRate: async (rate) => {
    const clamped = clampRate(rate);
    const changed = clamped !== get().rate;
    set({ rate: clamped });
    // The span at the old speed ends here; the next runs at the new one.
    if (changed) cutListeningSpan();
    if (service) await service.setRate(clamped);
    void persist();
  },

  setOutputVolume: async (volume) => {
    const gain = clampVolume(volume);
    // Nothing to do when the engine is already at this gain. With no engine at all there
    // is nothing to remember either - a fresh one starts at full volume (and `playBook`
    // re-asserts that), so the cache must not run ahead of an engine that doesn't exist.
    if (!service || gain === outputVolume) return;
    outputVolume = gain;
    await service.setVolume(gain);
  },

  stop: async () => {
    const stopping = selectBookKey(get());
    clearPlaybackIntent();
    stopSaveLoop();
    closeListeningSpan();
    await persist();
    // Another book was started while the place saved (a switch of person whose route
    // starts the new person's book at once): it owns the engine now, and a reset would cut
    // it off and leave the player with nothing.
    if (selectBookKey(get()) !== stopping) return;
    invalidateProgressLists();
    if (service) await service.reset();
    if (selectBookKey(get()) !== stopping) return;
    set({ nowPlaying: null, snapshot: { ...INITIAL_SNAPSHOT, rate: get().rate } });
  },

  finishBook: () => {
    const np = get().nowPlaying;
    if (!np) return null;
    const finished: FinishedBook = {
      connectionId: np.connectionId,
      libraryId: np.libraryId,
      path: np.path,
      title: np.title,
      author: np.author,
      cover: np.cover,
      ...(np.episode ? { episode: true as const } : {}),
    };
    // Mirror stop()'s teardown, but the forced-finished save must be the LAST write for
    // this book (the server is last-write-wins), so we do NOT call stop()'s ordinary
    // persist. `persist({ forceFinished })` captures nowPlaying synchronously before we
    // null it below, so the finished save carries the right identity even as state clears.
    clearPlaybackIntent();
    stopSaveLoop();
    sendFinish(np);
    void persist({ forceFinished: true });
    // Refresh the "continue listening" / "finished" lists for this book's connection,
    // plus the book's own progress entry so a book screen mounted above the docked
    // player (tablet/desktop) re-reads its finished state instead of staying stale. nowPlaying is
    // nulled just below, so invalidate against the captured identity directly.
    void queryClient.invalidateQueries({ queryKey: qk.allProgress(finished.connectionId) });
    void queryClient.invalidateQueries({
      queryKey: qk.progress(finished.connectionId, finished.libraryId, finished.path),
    });
    set({ nowPlaying: null, snapshot: { ...INITIAL_SNAPSHOT, rate: get().rate } });
    // Tear the engine down first, THEN delete the local copy (if enabled) so the files
    // aren't in use by the player when they're removed. Fully best-effort.
    void (async () => {
      if (service) await service.reset();
      if (!useSettings.getState().autoDeleteFinished) return;
      const key = downloadKey(finished.connectionId, finished.libraryId, finished.path);
      if (useDownloads.getState().entries[key]?.status !== 'downloaded') return;
      await useDownloads
        .getState()
        .remove(finished.connectionId, finished.libraryId, finished.path)
        .catch(() => undefined);
    })();
    return finished;
  },

  showRoutePicker: async () => {
    const svc = service ?? (await ensureService());
    await svc.showRoutePicker?.();
  },

  adoptLoaded: (book, reread) => adoptLoadedBook(book, reread),
}));

/**
 * Hold `persist` (see `saveHold`) and return the release. `flush` (the default) saves
 * the place once on release, so listening done while held is not lost; pass false when
 * the hold ended in a move to another device's place (that place is already saved, and
 * the engine may not have reported the move yet). Ends by itself after
 * `SAVE_HOLD_MAX_MS`, flushing: by its timer, or by the next save past that deadline when
 * the timer cannot fire (see `persist`). A second hold replaces the first.
 */
export function holdSaves(): (opts?: { flush?: boolean }) => void {
  if (saveHold) clearTimeout(saveHold.timer);
  const hold = {
    timer: setTimeout(() => release(), SAVE_HOLD_MAX_MS),
    expiresAt: Date.now() + SAVE_HOLD_MAX_MS,
  };
  saveHold = hold;
  function release(opts?: { flush?: boolean }) {
    if (saveHold !== hold) return; // already released, or replaced
    clearTimeout(hold.timer);
    saveHold = null;
    if (opts?.flush ?? true) void persist();
  }
  return release;
}

/** The listener's own moves so far (`localMoves`). */
export const localMoveCount = (): number => localMoves;

/** Be told when the loaded book is played again after `LONG_PAUSE_MS` or more of pause
 * (one listener: `place-reconcile.ts`). Called synchronously from the engine
 * subscription, before the play's save loop starts. Returns the unsubscribe. */
export function onPickedUpAgain(listener: () => void): () => void {
  pickedUpAgainListener = listener;
  return () => {
    if (pickedUpAgainListener === listener) pickedUpAgainListener = null;
  };
}

/**
 * Stop playback (persisting the final position) when the playing book was loaded
 * through the given connection. Books playing through another connection keep going:
 * their token stays valid. Matched by the stable connection id, so it works regardless
 * of ApiClient instances being rebuilt when the connection list changes.
 */
export async function stopPlaybackForConnection(connectionId: string): Promise<void> {
  if (usePlayer.getState().nowPlaying?.connectionId === connectionId)
    await usePlayer.getState().stop();
}

/**
 * The shared teardown rule for every token-revoking path (sign-out in
 * use-sign-out.ts, remove-connection in connections-section.tsx): stop playback
 * through the connection first, so the final position persists while its token is
 * still valid, then flush THIS connection's offline replay queue so its queued saves
 * land before the connection (and with it, those saves) is purged. Uses
 * `flushConnection`, not `flushQueue`: the latter no-ops while the ACTIVE server is
 * offline, which would skip this last-chance sync when removing a still-reachable
 * background connection. One helper so a new step can't be added to one path and
 * forgotten in the other.
 */
export async function teardownBeforeTokenRevoke(connectionId: string): Promise<void> {
  await stopPlaybackForConnection(connectionId);
  await Promise.all([
    flushConnection(connectionId).catch(() => undefined),
    // Sync v2's listening outbox (the stop above closed its span).
    flushOutbox(connectionId),
    // The ebook reader's queued places too (Bridge Phase 3b).
    flushReadingConnection(connectionId).catch(() => undefined),
  ]);
}

/** The same track ids in the same order (a track's id is its file's path, `trackIdOf`). */
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
/** A queue's track ids, in its order. */
const idsOf = (queue: Pick<BookQueue, 'tracks'>) => queue.tracks.map((t) => t.id);
/** The track ids of a chapters answer's files (`bookFileSpecs`), in its order. */
const specIds = (specs: { path: string }[], libraryId: number) =>
  specs.map((s) => trackIdOf(libraryId, s.path));

/**
 * Hot-swap the currently-playing book onto its local files the moment its download
 * finishes, in the same file at the same place in it and in the same play state.
 * `playBook` already prefers local when a book is downloaded *before* playback starts;
 * this covers the other order - downloading while it streams - so playback keeps going
 * when the network drops instead of dying with the live stream. Shared by web + native.
 *
 * The download plays its files in the order the engine already plays them. One made in
 * another order (before the server's v2.4.0 natural order, retried while the new order
 * streams) takes the chapters this book was started from, as the start's own load would
 * have made it do (`adoptStartedChapters`): the engine streams that order, so the swap
 * changes only the files' urls. The track index, the place in the file and the whole-book
 * seconds stay what they were for everything that reads them: the saves and the resume
 * floor, the sleep timer, jump undo, the spoiler gates, a Cast receiver, the next start.
 * A download that can't be given that order (a book started with no chapters) leaves the
 * book streaming: moved onto its own order, the rest of the book would play in another
 * sequence, skipping files. Only a download holding other files moves the listener: to
 * the same file when it has it, else to the same whole-book place.
 */
async function switchCurrentBookToLocal() {
  const state = usePlayer.getState();
  const { nowPlaying, snapshot, rate } = state;
  if (!nowPlaying || !apiRef) return;
  const landed = downloadedEntryOf(nowPlaying);
  if (!landed || landed.manifest.files.length === 0) return;

  // Already playing from local? (every track points at a downloaded uri) → nothing to do.
  const localUris = new Set(landed.manifest.files.map((f) => f.localUri));
  if (nowPlaying.queue.tracks.every((t) => localUris.has(t.url))) return;

  // The order the manifest plays once it takes the start's chapters: its own book with
  // those chapters (`chaptersRefresh` reads it that way), which must be the engine's.
  const started = lastPlayRequest;
  const takenOrder = started?.chapterData
    ? bookFileSpecs(landed.manifest.book, started.chapterData)
    : [];
  if (
    started?.chapterData &&
    contentKey(started.connectionId, started.libraryId, started.book.rel_path) ===
      contentKeyOf(nowPlaying) &&
    sameIds(specIds(takenOrder, nowPlaying.libraryId), idsOf(nowPlaying.queue))
  ) {
    adoptStartedChapters(nowPlaying, started.chapterData);
  }
  const dl = downloadedEntryOf(nowPlaying) ?? landed; // with the chapters it took, if any
  const local = localFromManifest(dl.manifest);
  const queue = buildBookQueue(
    apiRef,
    nowPlaying.libraryId,
    dl.manifest.book,
    dl.manifest.chapters ?? undefined,
    local,
    useSettings.getState().virtualChapterInterval,
  );
  if (!sameIds(idsOf(queue), idsOf(nowPlaying.queue))) {
    const held = new Set(queue.tracks.map((t) => t.id));
    const sameFiles =
      queue.tracks.length === nowPlaying.queue.tracks.length &&
      nowPlaying.queue.tracks.every((t) => held.has(t.id));
    if (sameFiles) return; // the same files in an order the engine doesn't play
  }
  // The same file (track ids are path-keyed); whole-book seconds only for a file the
  // download doesn't hold.
  const playingId = nowPlaying.queue.tracks[snapshot.trackIndex]?.id;
  const sameFile = trackIndexById(queue, playingId);
  const { index, positionInTrack } =
    sameFile >= 0
      ? { index: sameFile, positionInTrack: snapshot.position }
      : locate(queue.offsets, selectBookPosition(state));
  // How far the place moves on the download's timeline (0 in the engine's order): the
  // resume floor moves with it, or the slip guard would refuse every later save of a place
  // that now reads lower.
  const shift = toBookPosition(queue.offsets, index, positionInTrack) - selectBookPosition(state);
  // Playing on means the listener's intent, not only an engine already at `playing`. A
  // short book downloads in under a second, while its stream is still starting (the
  // snapshot is `loading`, or the engine has just begun and its `playing` has not reached
  // JS yet). iOS's `load` pauses the player (Android's keeps playWhenReady), so a swap that
  // didn't play left the story stopped on a Play button after a single tap (8b-1, a kid's
  // first story on an iPhone).
  const wasPlaying = snapshot.state === 'playing' || wantsPlayback;
  const svc = await ensureService();

  // Commit only once the engine has actually moved onto the local files, and only while
  // this book is still the store's: a stop, a sign-out, a switch of person or another
  // start while the swap was out must not bring it back, nor move another book's floor.
  const commit = (): boolean => {
    if (swapHold?.nowPlaying === nowPlaying) swapHold = null;
    if (usePlayer.getState().nowPlaying !== nowPlaying) return false;
    resumeFloor = Math.max(0, resumeFloor + shift);
    usePlayer.setState({
      nowPlaying: { ...nowPlaying, cover: local.artwork ?? nowPlaying.cover, queue },
    });
    return true;
  };

  if (svc.isCasting?.()) {
    // Casting: the receiver streams the book from the server whatever the phone holds (a
    // cast builds server URLs from the tracks' paths), so a reload would only interrupt
    // it. The route keeps the phone's copy for when the book comes back to the phone.
    svc.rememberLoad?.({
      tracks: queue.tracks,
      chapters: queue.chapterClips,
      book: bookRefOf(nowPlaying),
    });
    commit();
    return;
  }

  // The engine reports the download's track index before its swap or load returns.
  if (index !== snapshot.trackIndex) swapHold = { nowPlaying, trackIndex: snapshot.trackIndex };
  try {
    if (svc.swapTo) {
      // Gapless: keep streaming until the local file is buffered at this position. The
      // swap can be refused (e.g. the local source isn't servable on web) - in that
      // case leave nowPlaying on the streaming queue so playback keeps going.
      const swapped = await svc.swapTo(
        queue.tracks,
        index,
        positionInTrack,
        queue.chapterClips,
        bookRefOf(nowPlaying),
      );
      if (swapped) commit();
    } else {
      await svc.load(
        queue.tracks,
        index,
        positionInTrack,
        queue.chapterClips,
        bookRefOf(nowPlaying),
      );
      // Committed before the rate and the play, so the play's `playing` (and the save loop
      // it starts) reads the engine's index through the download's queue.
      if (!commit()) return;
      await svc.setRate(rate);
      if (wasPlaying) await svc.play();
    }
  } finally {
    // A refused swap or a failed load: the hold must not outlive it.
    if (swapHold?.nowPlaying === nowPlaying) swapHold = null;
  }
}

/**
 * `adoptLoaded` (Android): the playback service can hold a book JS never loaded (a
 * downloaded book the car started with no JS running, from the car snapshot's play spec), or
 * keep playing one after the app's JS restarted. Adopting it gives the store that book
 * exactly as `playBook` would have built it, without `svc.load` (the engine is already
 * playing it; a reload would cut the audio) unless the engine plays another file order:
 * - the item and chapters from `bookSourceOf` (the download manifest when it is downloaded:
 *   the queue the service built came from it; else through the query cache);
 * - `buildBookQueue` as `playBook` calls it (native never transcodes);
 * - in the engine's file order (`LoadedBook.files`, fe#134), since every later tick counts in
 *   it: none reported (iOS, Cast, older binaries) or the queue's own order changes nothing; a
 *   downloaded book in another order asks the server's chapters (for `SERVED_ORDER_WAIT_MS` at
 *   most), and when they come back in exactly the engine's order the queue is built from
 *   them, as the start JS lost built it (the download's files, streaming any it lacks), and
 *   the download takes them when it holds those files (`adoptStartedChapters`); anything else
 *   (offline, no answer, the server's in another order or with other files than the
 *   engine's) reloads the engine in the queue's order at the same file and in-file place
 *   (whole-book seconds for a file the queue lacks), the resume floor at that place and the
 *   play state kept (`reloadAdopted`: the one case that cuts the audio, briefly);
 * - the speed, place and play state the engine reports, read again once the source is read
 *   when the caller can (`reread`: the engine played on meanwhile, and a pause, a move or a
 *   speed change made then stands): `resumeFloor` is that place, so a stray low position
 *   can't be saved over it, and the bridge's snapshot is seeded (`adoptPlace`) so the next
 *   tick maps onto the right file;
 * - the intent from `playing`: a playing book starts the save loop and a listening span; a
 *   paused one saves nothing until it plays (its place is the engine's, already saved by
 *   whoever played it, and a save now would date that place as new);
 * - the place reconcile's pick-up check (`onPickedUpAgain`): at once for a playing book,
 *   before its first save, and on the next play for a paused one, since the engine's place
 *   was never checked against the server (a car start plays its snapshot's place).
 * A different book already loaded is switched out the way `playBook` switches
 * (`switchBook`: none of its saves can land under the new path, and its stall timer can't
 * turn the adopted book into an error), and the output gain is restored to full after the
 * swap (`restoreOutputGain`: the engine's volume is sticky, and a fade cut off by the
 * switch or a JS restart would otherwise leave the adopted book quiet).
 * Gives up, changing nothing, when another book started while the item was being read, the
 * service plays another book or file order once read again, or a start is still on its way
 * (`startsInFlight`).
 */
async function adoptLoadedBook(
  service: LoadedBook,
  reread?: () => Promise<LoadedBook | null>,
): Promise<boolean> {
  // The service's book can name an old connection id (a play spec from a car snapshot
  // written before the identity migration): the store keeps the new one.
  let loaded = { ...service, connectionId: resolveConnectionId(service.connectionId) };
  // Another person's book (a car play spec of an older snapshot, a receiver's book of a
  // Cast session resumed after a switch) is never adopted: nothing of it saves to their
  // account (`mayActFor`).
  if (!mayActFor(loaded.connectionId)) return false;
  const before = usePlayer.getState().nowPlaying;
  const api = resolveClient(loaded.connectionId);
  let source: Awaited<ReturnType<typeof bookSourceOf>>;
  let id: string;
  let svc: PlaybackService;
  try {
    [source, id, svc] = await Promise.all([bookSourceOf(loaded), getDeviceId(), ensureService()]);
  } catch (err) {
    console.warn('[player] could not adopt the loaded book', err);
    return false;
  }
  if (!source) return false;

  const { connectionId, libraryId } = loaded;
  const ref = bookRefOf(loaded);
  const { book, local } = source;
  let chapterData = source.chapters;
  // The service's own file order (fe#134), when it reports one: a start in the server's new
  // order that Android's JS lost while it loaded leaves the engine in that order while the
  // download keeps its own. Every later tick counts in the engine's order, so the queue must
  // be in it: the server's chapters when they come back in exactly that order (a download
  // asks them once, here), else the engine is reloaded in the queue's order below. A queue's
  // track ids are its chapters' files' (`bookFileSpecs`).
  const engineIds = loaded.files?.length
    ? loaded.files.map((path) => trackIdOf(libraryId, path))
    : null;
  const inEngineOrder = (chapters: ChaptersResponse | undefined) =>
    engineIds !== null && sameIds(specIds(bookFileSpecs(book, chapters), libraryId), engineIds);
  let otherOrder = engineIds !== null && !inEngineOrder(chapterData);
  const served = otherOrder && local ? await serverChaptersOf(ref, api) : null;
  if (reread) {
    // The engine played on while the book was read: where it is, whether it plays and at what
    // speed now (a pause, a move or a speed change made meanwhile stands), and nothing to
    // adopt once it plays another book or file order.
    const again = await reread().catch(() => null);
    if (!again || !sameLoad(again, service)) return false;
    loaded = { ...again, connectionId: loaded.connectionId };
  }

  // Asked again: the person may have switched while the source was read.
  if (!mayActFor(loaded.connectionId)) return false;
  // Another book started (or the same one was adopted) while we read, or a start is still
  // on its way (it switches the book after its awaits): theirs stands.
  const now = usePlayer.getState();
  if (now.nowPlaying !== before || now.loadingBook !== null || startsInFlight > 0) return false;

  if (served && inEngineOrder(served)) {
    // The engine plays the server's order: the queue is built from those chapters, as the lost
    // start built it (the download's files, streaming any it lacks), and the download takes
    // them when it holds those files (`adoptStartedChapters`). Nothing is reloaded.
    adoptStartedChapters(ref, served);
    chapterData = served;
    otherOrder = false;
  }
  const queue = buildBookQueue(
    api,
    libraryId,
    book,
    chapterData,
    local,
    useSettings.getState().virtualChapterInterval,
  );
  // Still another order (offline, no answer, the server's in another order or with other
  // files than the engine's): the engine is reloaded in the queue's order at the same file
  // and in-file place, or, for a file the queue lacks, at the same whole-book place. Not
  // while casting: the receiver streams the book and a load would cut it (fe#145).
  const reload =
    engineIds && otherOrder && !svc.isCasting?.()
      ? landingOf(queue, engineIds, loaded, fileDurations(libraryId, book, chapterData, served))
      : null;

  const { index: trackIndex, positionInTrack: position } = reload ?? {
    index: Math.max(0, Math.min(loaded.trackIndex, queue.tracks.length - 1)),
    positionInTrack: Math.max(0, loaded.position),
  };
  const rate = clampRate(loaded.rate > 0 ? loaded.rate : now.rate);
  const snapshot: PlaybackSnapshot = {
    state: loaded.playing ? (reload ? 'loading' : 'playing') : 'paused',
    trackIndex,
    position,
    duration: queue.tracks[trackIndex]?.duration ?? 0,
    rate,
  };

  switchBook(api, { connectionId, libraryId, book, chapterData });
  clearPlaybackIntent();
  deviceId = id;
  resumeFloor = toBookPosition(queue.offsets, trackIndex, position);
  // The engine's place was never checked against the server (no resume lookup here), and it
  // can be old: a book the car started with no JS starts at the place its snapshot was built
  // with, and another device may have played on since. So the adopted book counts as picked
  // up again: a paused one on its next play (how long it has been paused is unknown), a
  // playing one at once, below (a reloaded one on its next `playing`).
  pausedAt = loaded.playing && !reload ? null : 0;
  svc.adoptPlace?.(snapshot);
  const nowPlaying = nowPlayingOf(loaded, book, queue, api, local);
  // A reload holds every save and remote move until it lands (`loadingBook`): until then a
  // tick still counts in the engine's old order.
  usePlayer.setState({
    nowPlaying,
    rate,
    loadingBook: reload ? contentKeyOf(nowPlaying) : null,
    snapshot,
  });
  restoreOutputGain(svc);
  if (reload) {
    await reloadAdopted(svc, nowPlaying, reload, rate, loaded.playing);
    return true;
  }
  // And its queue: a Cast session started later hands this book to the receiver (never
  // taking the route with the phone still playing it), and an ended one hands it back (a
  // reload's `load` records its own).
  svc.rememberLoad?.({ tracks: queue.tracks, chapters: queue.chapterClips, book: ref });
  // A speed outside the app's range (set by another controller while no JS listened) goes
  // back to the engine clamped, as `onRateChange` does: the store says what plays.
  if (rate !== loaded.rate) void svc.setRate(rate);
  if (loaded.playing) {
    wantsPlayback = true;
    // Before the first save: the place reconcile holds the saves while it asks the server,
    // so this place can't overwrite another device's newer one (last-write-wins).
    pickedUpAgainListener?.();
    startSaveLoop();
    beginHistory();
    // The store set this `playing` itself, so no engine transition opens its span.
    openListeningSpan();
  }
  return true;
}

/** The same book in the same file order: the service's book read again against an earlier
 * read of it. */
function sameLoad(a: LoadedBook, b: LoadedBook): boolean {
  return (
    contentKey(resolveConnectionId(a.connectionId), a.libraryId, a.path) ===
      contentKey(resolveConnectionId(b.connectionId), b.libraryId, b.path) &&
    sameIds(a.files ?? [], b.files ?? [])
  );
}

/** How long an adoption waits for the server's chapters before it reloads the engine in the
 * download's order, as a downloaded book's start waits for its server (`FRESH_SOURCE_WAIT_MS`):
 * the store has no book meanwhile, and the car's snapshot and kept bookmarks wait on it. */
const SERVED_ORDER_WAIT_MS = 3_000;

/** The server's chapters for a book, asked afresh (a cached copy can be the download's own,
 * `seedQueryCache`), or null when it can't be asked (no connection, known unreachable), does
 * not answer, or is slower than `SERVED_ORDER_WAIT_MS`. */
async function serverChaptersOf(
  ref: BookRef,
  api: ApiClient | null,
): Promise<ChaptersResponse | null> {
  if (!api || !isReachable(ref.connectionId)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchChapters(ref, api, 0),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SERVED_ORDER_WAIT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Each file's duration by track id: the queue's own files', and the server's for a file only
 * it knows (the engine's timeline can hold one the download lacks). */
function fileDurations(
  libraryId: number,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  served: ChaptersResponse | null,
): Map<string, number> {
  const durations = new Map<string, number>();
  const specs = [
    ...(served ? bookFileSpecs(book, served) : []),
    ...bookFileSpecs(book, chapterData),
  ];
  for (const s of specs) durations.set(trackIdOf(libraryId, s.path), s.duration);
  return durations;
}

/** Where the engine's place lands in `queue`: the same file (by track id) at the same place
 * in it, else (a file the queue lacks) the same whole-book seconds, read on the engine's own
 * timeline (`durations`), short of the queue's end (a place there would finish the book). When
 * an earlier file's length is not known (a streamed book whose files were renamed since it
 * loaded, a download whose server can't be asked), the seconds can't be read: the engine's
 * file index, at the same place in the file. */
function landingOf(
  queue: BookQueue,
  engineIds: string[],
  loaded: Pick<LoadedBook, 'trackIndex' | 'position'>,
  durations: Map<string, number>,
): { index: number; positionInTrack: number } {
  const inFile = Math.max(0, loaded.position);
  const same = trackIndexById(queue, engineIds[loaded.trackIndex]);
  if (same >= 0) return { index: same, positionInTrack: inFile };
  let seconds = inFile;
  const before = Math.max(0, Math.min(loaded.trackIndex, engineIds.length));
  for (let i = 0; i < before; i++) {
    const duration = durations.get(engineIds[i]);
    if (!(duration && duration > 0)) {
      const index = Math.max(0, Math.min(loaded.trackIndex, queue.tracks.length - 1));
      return { index, positionInTrack: inFile };
    }
    seconds += duration;
  }
  const lastPlace = Math.max(0, queue.total - FINISHED_TOLERANCE - 1);
  return locate(queue.offsets, queue.total > 0 ? Math.min(seconds, lastPlace) : seconds);
}

/**
 * The engine reloaded in the adopted queue's order (`adoptLoaded`, fe#134), at `landing`. Its
 * place is the engine's and was never checked against the server, so nothing saves it until
 * it plays (`quietAdopted`: the play's pick-up check holds the saves first) or the listener
 * moves it. A playing book starts as `playBook` starts one (the spinner and the stall
 * watchdog, then the save loop and the pick-up check from its `playing`), unless the listener
 * paused it while it loaded. A paused one is paused again once loaded: an engine that ended
 * or failed still wants to play, and Android's load keeps that, so it would play by itself;
 * unless the listener pressed play while it loaded, which then starts it the same way.
 * Gives the engine back to whoever took the store meanwhile (a stop).
 */
async function reloadAdopted(
  svc: PlaybackService,
  nowPlaying: NowPlaying,
  landing: { index: number; positionInTrack: number },
  rate: number,
  playing: boolean,
): Promise<void> {
  const current = () => usePlayer.getState().nowPlaying === nowPlaying;
  const key = contentKeyOf(nowPlaying);
  quietAdopted = key;
  if (playing) beginPlaybackAttempt();
  const attempts = playAttempts;
  try {
    await svc.load(
      nowPlaying.queue.tracks,
      landing.index,
      landing.positionInTrack,
      nowPlaying.queue.chapterClips,
      bookRefOf(nowPlaying),
    );
  } catch (err) {
    console.warn('[player] could not reload the adopted book in its order', err);
    if (current()) {
      clearPlaybackIntent();
      const { snapshot } = usePlayer.getState();
      usePlayer.setState({ snapshot: { ...snapshot, state: 'error' } });
    }
    return;
  } finally {
    // The hold is this load's, unless a start of the same book took the store while it ran:
    // `playBook` keeps the hold it finds on its book, and releases it once its own load lands.
    const s = usePlayer.getState();
    if (
      s.loadingBook === key &&
      (s.nowPlaying === nowPlaying || s.nowPlaying === null || startsInFlight === 0)
    ) {
      usePlayer.setState({ loadingBook: null });
    }
  }
  if (!current()) {
    // Stopped while it loaded: the stop's reset ran before this load landed in the engine.
    if (!usePlayer.getState().nowPlaying) await svc.reset();
    return;
  }
  // Never before the load: a start made while it was out could load first, and this load
  // would then replace that start's book in the engine.
  // A play the listener asked for meanwhile (still wanted) stands like the adopted one.
  const wanted = playing || (playAttempts !== attempts && wantsPlayback);
  if (!wanted) await svc.pause();
  await svc.setRate(rate);
  // Paused while it loaded (or given up by the stall watchdog): that stands.
  if (wanted && current() && wantsPlayback) {
    await startLoadedEngine(svc);
    // A `playing` reported while the load held the store left `quietAdopted` set, and no
    // transition may follow now: the play stands from here.
    if (current() && quietAdopted === key && usePlayer.getState().snapshot.state === 'playing') {
      quietAdopted = null;
      openListeningSpan();
    }
  }
}

// A pick-up check due while a load held the store (`pickUpDue`) runs once that hold is
// released, synchronously, so its save hold is in place before the book's first save. A book
// no longer playing then (paused or stalled meanwhile) checks on its next play instead.
usePlayer.subscribe((state, prev) => {
  if (pickUpDue === null || !prev.loadingBook || state.loadingBook) return;
  const due = pickUpDue;
  pickUpDue = null;
  if (!state.nowPlaying || contentKeyOf(state.nowPlaying) !== due) return;
  if (state.snapshot.state === 'playing') pickedUpAgainListener?.();
  else pausedAt = 0;
});

// When a download completes for the book that's currently playing, switch it to the
// local copy (see above).
useDownloads.subscribe((state, prev) => {
  const np = usePlayer.getState().nowPlaying;
  if (!np) return;
  // Scope by the playing book's own connection so a completing download on ANOTHER
  // server with the same (libraryId, path) can't hot-swap this book to its files.
  const key = downloadKey(np.connectionId, np.libraryId, np.path);
  if (state.entries[key]?.status === 'downloaded' && prev.entries[key]?.status !== 'downloaded') {
    switchCurrentBookToLocal().catch((err) =>
      console.warn('[player] could not move onto the downloaded copy', err),
    );
  }
});

// --- selectors -------------------------------------------------------------
export const selectBookPosition = (s: PlayerState): number =>
  s.nowPlaying
    ? toBookPosition(s.nowPlaying.queue.offsets, s.snapshot.trackIndex, s.snapshot.position)
    : 0;

export const selectCurrentChapter = (s: PlayerState): Chapter | null =>
  s.nowPlaying ? chapterAt(s.nowPlaying.queue.chapters, selectBookPosition(s)) : null;

/** Memo for `selectBookKey`, keyed on the `nowPlaying` OBJECT. */
let bookKeyMemo: { nowPlaying: NowPlaying; key: string } | null = null;

/**
 * Identity of the book playing right now (`contentKey`, so two servers that each have a
 * "library 1 / Book" can never look like the same book), or null when nothing is loaded.
 *
 * The ONE definition of that identity for playback: the sleep timer scopes its timer to
 * it and auto sleep keys its per-book anti-nag sets on it, and those two must agree -
 * a second hand-rolled copy drifting would break "never re-arm what you cancelled" with
 * no type error and no failing test.
 *
 * Memoized on the `nowPlaying` object identity, which is exactly the right key: the
 * store replaces that object when the book changes (and when a book hot-swaps to its
 * local files), and never mutates it in place. Building the template string fresh
 * instead would run several times a second for the whole life of a timer, and would
 * make every `===` against the result a full character walk.
 */
export const selectBookKey = (s: PlayerState): string | null => {
  const np = s.nowPlaying;
  if (!np) return null;
  if (bookKeyMemo?.nowPlaying !== np) {
    bookKeyMemo = { nowPlaying: np, key: contentKey(np.connectionId, np.libraryId, np.path) };
  }
  return bookKeyMemo.key;
};

/** Is audio coming out of the speaker? The strict reading - see `isPlayingState`, and
 * `selectIsTransportLive` for the looser one. Drives the play/pause button. */
export const selectIsPlaying = (s: PlayerState): boolean => isPlayingState(s.snapshot.state);

/** Is the transport running, counting a book that is buffering with playback intended?
 * The looser reading - see `isTransportLiveState` for which to use when. */
export const selectIsTransportLive = (s: PlayerState): boolean =>
  isTransportLiveState(s.snapshot.state);

/** The current book has reached its natural end (its files finished). Drives the
 * UI-layer end-of-book flow; nowPlaying stays populated in this state. */
export const selectIsEnded = (s: PlayerState): boolean => s.snapshot.state === 'ended';
