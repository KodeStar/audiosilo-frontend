import { Platform } from 'react-native';
import { createStore } from 'zustand';

import type { ApiClient } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import { invalidateFinishedProgress, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { isReachable, noteFailure, noteSuccess } from '@/api/reachability';
import type { Book, Chapter, ChaptersResponse, ListeningStart, Progress } from '@/api/types';
import {
  adoptStartedChapters,
  downloadedEntryOf,
  downloadKey,
  noteDownloadEnd,
  useDownloads,
} from '@/downloads/store';
import type { DownloadManifest } from '@/downloads/types';
import { isAway, onAppStateEdge } from '@/lib/app-activity';
import { resolveConnectionId } from '@/lib/connection-id';
import { contentKey, contentKeyOf } from '@/lib/content-key';
import { isDeviceOnline } from '@/lib/device-online';
import { canAutoDownload } from '@/lib/network';
import { quietly } from '@/lib/quietly';
import { flushReadingConnection } from '@/reader/reading-progress';
import { quietOffScreen } from '@/lib/visible-store';
import { withTimeout } from '@/lib/with-timeout';
import { mayActFor } from '@/stores/profiles';
import { tellOtherTabsGoing } from '@/stores/session';
import { useSettings } from '@/stores/settings';

import type { LoadedBook } from '../../modules/audiosilo-player/src/AudiosiloPlayer.types';

import {
  bookFileSpecs,
  buildBookQueue,
  chapterAt,
  endsShortOfBook,
  fileDurationOf,
  FINISHED_TOLERANCE,
  locate,
  shortOfFileEnd,
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
import { type FinishRef, finishedSave, setFinishRecorder, type UndoRef } from './finish-route';
import {
  appendInTurn,
  closeSpan,
  connectionGeneration,
  finishEvent,
  flushOutbox,
  movesNowhere,
  newEventId,
  type OpenSpan,
  type OutboxEntry,
  sendOnPageHide,
  type SpanEnd,
  spanIsBareMove,
  spanSaysSomething,
  spanToEvent,
  storeOpenSpan,
  usesListeningStay,
  usesListeningSync,
  waitingInTurn,
  withdrawFinish,
} from './listening-outbox';
import {
  ackVersion,
  cachedDeviceId,
  flushConnection,
  flushQueue,
  getDeviceId,
  guardSettled,
  type LatePlace,
  loadInitialProgress,
  mirrorIsNewest,
  mirrorTimeOf,
  noteUndoneFinish,
  type PlacedProgress,
  type ProgressSave,
  readMirror,
  saveProgress,
  tellUndoneElsewhere,
  updateMirror,
  writeFinishedMirror,
  writeMirror,
} from './progress-sync';
import { listenerSettings } from './listener-settings';
import { type GaveWay, givesWayTo, type PlayingClaim, tabClaims } from './playing-claim';
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
  type SwapOutcome,
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
/** When the play this tab makes (or means to) was asked for (ms): a press here
 * (`beginPlaybackAttempt`), else the moment the engine began by itself (the OS media
 * controls). What the tabs of the web player compare (`playing-claim.ts`): the newest wins. */
let playAskedAt = 0;
/** The play request (`playAttempts`) that gave way to another tab's claim (`giveWayTo`):
 * until a play is asked for again, a start still loading does not play once it has loaded
 * (`startEngine`). */
let yieldedAttempt = -1;
/** Pending stall→error timer and its deadline (see armStallWatchdog). */
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let stallDeadline: number | null = null;
/** Until when a `playing` report may be older than the stall watchdog's pause (`fireStallWatchdog`):
 * sent before the pause reached the engine, and the pause wins. A time, not the pause's
 * promise: Android's resolves before the engine has paused. */
let stallPauseUntil = 0;
/** A play asked of the engine from outside the app that the store follows
 * (`playAskedFromOutside`) while it is still starting, else null: over once it plays, is
 * given up (`clearPlaybackIntent`) or another play is asked for (`beginPlaybackAttempt`), so
 * a later stall is the store's book's own. The store's book, where it stood and the
 * listener's moves (`localMoves`) when the play was asked. `other`: the engine holds another
 * book, one the service started: its report named that book (`reportedOtherBook`), or its
 * adoption began (`adoptLoadedBook`). */
let outsidePlay: {
  np: NowPlaying;
  snapshot: PlaybackSnapshot;
  moves: number;
  other: boolean;
} | null = null;
/**
 * The engine holds another book than the store's, asked to play from outside the app and not
 * adopted yet (`outsidePlay.other`): what the engine reports is that book's. The store acts
 * on none of it for its own book (no place shown, no listening span, no save, no pick-up
 * check, no move of the listener's), and nothing of the store's book is saved, until the
 * adoption lands (the adopted book takes the engine's place and state as they are then) or
 * the play is over: an adoption that gave up leaves it to the stall watchdog, which stops the
 * engine and says playback stopped, the store's book where it stood (`fireStallWatchdog`).
 */
const engineIsAnothers = (): boolean => outsidePlay?.other === true;
/** Whether the store follows a play asked of the engine from outside the app that has not
 * played yet (`outsidePlay`). The car sync then asks whose book the engine holds
 * (`mayBeServiceChange`); a Retry or a play of the store's own asks nothing. */
export const followsOutsidePlay = (): boolean => outsidePlay !== null;
/** Adoptions of the engine's book under way (`adoptLoadedBook`). */
let adoptions = 0;

/**
 * The content key of the book the engine's last report named, when that is not the store's
 * book, else null: Android's car or a resumption started another book, not adopted yet, or
 * the book the store's own load replaces reports a moment late. Such a report is never the
 * store's book's place, state, move or speed (`createService`). Null too for a report that
 * names no book (the web, a Cast receiver, a binary that predates it, a queue loaded without
 * one) and while the store holds no book: those are taken as before.
 */
function reportedOtherBook(svc: PlaybackService): string | null {
  const named = svc.reportedBook?.();
  const own = selectBookKey(usePlayer.getState());
  if (!named || own === null) return null;
  const key = resolvedKeyOf(named);
  return key === own ? null : key;
}
/** Whether the engine's last report named another book than the store's
 * (`reportedOtherBook`): no listening of the store's book opens then. */
const engineHoldsAnother = (): boolean => service !== null && reportedOtherBook(service) !== null;
/**
 * The book the engine plays when it is not the store's (`reportedOtherBook`: Android's car or
 * a resumption started it and it was not adopted; after `otherBookNotAdopted` the store's book
 * shows paused while this one plays on), its connection id resolved; else null. Null too
 * while a load or a start of the store's holds it, when the engine still reports the book that
 * load replaces, and once that book played to its end (a finished book never resumes, as the
 * store's own does not). The car sync names it for a playback resumption (`resumableBook`).
 */
export function engineOtherBook(): BookRef | null {
  if (!service || usePlayer.getState().loadingBook || startsInFlight > 0) return null;
  const named = service.reportedBook?.();
  if (!named || reportedOtherBook(service) === null) return null;
  if (service.getSnapshot().state === 'ended') return null;
  return { ...bookRefOf(named), connectionId: resolveConnectionId(named.connectionId) };
}
/** The other book's report the car sync was last told of (`otherBookReported`), else null. */
let otherReport: { key: string; trackIndex: number; playing: boolean } | null = null;
let otherBookListener: (() => void) | null = null;

/** A report of another book than the store's (`reportedOtherBook`): a play the store follows
 * from outside is that book's (`outsidePlay.other`), and the car sync is told when it is new,
 * moved to another file or began playing (not when it plays again after buffering), as it is
 * of those changes of the store's own book (Android: the service may have started that book,
 * and the car sync adopts it). Not while a load of the store's holds it: that is the book the
 * load replaces. */
function otherBookReported(key: string, raw: PlaybackSnapshot) {
  if (outsidePlay) outsidePlay.other = true;
  if (usePlayer.getState().loadingBook || startsInFlight > 0) return;
  // The store's book stopped playing here: its listening ends now, where it was last heard
  // (the store's snapshot, which took none of this book's reports), not when the adoption
  // lands seconds later. None opens again while the engine holds this book
  // (`engineHoldsAnother`).
  endHistory();
  closeListeningSpan();
  // Nor is its place saved again while that book plays, each save dating it now: saved here
  // once, where it was last heard, and its save loop stops (an adopted book starts its own).
  if (saveLoop.running()) haltAndPersist();
  armOtherBookDeadline();
  const was = otherReport;
  const same = was?.key === key && was.trackIndex === raw.trackIndex;
  // A book heard playing that buffers stays playing here: its return to `playing` is no news.
  const playing = raw.state === 'playing' || (same && was.playing && raw.state === 'loading');
  otherReport = { key, trackIndex: raw.trackIndex, playing };
  if (same && (was.playing || !playing)) return;
  otherBookListener?.();
}

/** How long the store's book may still show playing once the engine plays another book
 * (`otherBookReported`) and that book was not adopted: the car sync's adoption reads it
 * within a couple of seconds, waiting up to `SERVED_ORDER_WAIT_MS` more for the server's
 * chapters. */
const OTHER_BOOK_ADOPT_MS = 6_000;
/** The store's book shown playing when the engine began playing another book, while the
 * deadline for that book's adoption runs (`otherBookAdoption`), else null. Compared by book,
 * never by object: a `NowPlaying` replaced for the same book meanwhile (a chapters refresh, a
 * hot swap's commit) is still the book shown playing. */
let otherBookShown: NowPlaying | null = null;
/** That deadline: an `engineTicker`, so a held report runs it where Android has paused the
 * JS timers (screen off), and stopped at its first run. */
const otherBookAdoption = engineTicker(otherBookNotAdopted, OTHER_BOOK_ADOPT_MS);

/** The store's book was shown playing as the engine began playing another book: once that
 * book's adoption is overdue, it shows paused (`otherBookNotAdopted`). */
function armOtherBookDeadline() {
  const { nowPlaying, snapshot } = usePlayer.getState();
  if (!nowPlaying || snapshot.state !== 'playing') return;
  if (otherBookShown && sameBook(otherBookShown, nowPlaying)) return;
  cancelOtherBookDeadline();
  otherBookShown = nowPlaying;
  otherBookAdoption.start();
}

function cancelOtherBookDeadline() {
  otherBookAdoption.stop();
  otherBookShown = null;
}

/**
 * The other book the engine plays was never adopted (the car sync gave up, or never read it):
 * the store's book, shown playing at a place frozen since, shows paused there, its last place
 * heard. Its intent to play is over (that book plays on, never paused from here), and nothing
 * is saved: its place was saved once at the switch (`otherBookReported`), and saved again it
 * would be dated now. Not when the store holds another book by now (an adoption landed), a
 * load holds it, it no longer shows playing, or the engine's last report is its own again.
 * The same book under a new `NowPlaying` (a chapters refresh) still shows paused.
 */
function otherBookNotAdopted() {
  const shown = otherBookShown;
  cancelOtherBookDeadline();
  const { nowPlaying, snapshot, loadingBook } = usePlayer.getState();
  if (!shown || !nowPlaying || !sameBook(nowPlaying, shown)) return;
  if (loadingBook || snapshot.state !== 'playing') return;
  if (!engineHoldsAnother()) return;
  // An adoption still under way (a slow server's chapters) lands or gives up first.
  if (adoptions > 0) {
    otherBookShown = nowPlaying;
    otherBookAdoption.start();
    return;
  }
  clearPlaybackIntent();
  stopSaveLoop();
  // Paused from now, so a play after a long pause checks its place first (`pickUpBeforePlay`).
  pausedAt ??= Date.now();
  usePlayer.setState({ snapshot: { ...snapshot, state: 'paused' } });
}

/** Be told when the engine reports another book than the store's (`otherBookReported`; one
 * listener: the car sync, which reads the engine's book and adopts it). Returns the
 * unsubscribe. */
export function onOtherBookReported(listener: () => void): () => void {
  otherBookListener = listener;
  return () => {
    if (otherBookListener === listener) otherBookListener = null;
  };
}
/** How long the engine's reports sent before the watchdog's pause can take to arrive. */
const STALL_PAUSE_FENCE_MS = 1_000;
/** The whole-book position the current book resumed from, kept as a running high-water
 * mark. `persist` refuses to save a position far below this unless the user deliberately
 * seeked back (which lowers it) - so a slipped-through restart-at-0 can never overwrite
 * real saved progress. Reset per book in `playBook`. */
let resumeFloor = 0;
/** The book (`contentKey`) whose session began at a place not checked against its server
 * (`ResumeLookup.unchecked`): on the legacy PUT path its saves carry the replay guard
 * (`ProgressSave.guard`, fe#198) until one of them is PUT. Set per session in `playBook`,
 * with a new id each time (`guardFor`), so an earlier session's save PUT late never lifts a
 * later one's. */
let placeGuard: { key: string; id: string } | null = null;
/** A guarded session for the book `key`, with an id its saves carry (`guard_session`), so a
 * queued one PUT later lifts it (`guardSettled`, fe#198). */
const guardFor = (key: string) => ({ key, id: newEventId() });
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
 * holds other files than the stream, `switchCurrentBookToLocal`): the book, the file's
 * index in the stream's queue, and the download's queue. The engine reports the download's
 * index before its swap or load returns, while the store still holds the stream's queue: the
 * engine's reports are read back through the download's queue onto the stream's
 * (`throughSwap`), so the saves, the sleep timer and jump undo keep reading the playing
 * file's place. Only once the engine is on the download (`live`): a load is from the call,
 * while a gapless swap (`swapTo`) goes on reporting the stream, in the stream's order, until
 * it switches. A place at another index of that book is still refused meanwhile: by
 * `persist`, one the stream moved to while the copy buffered or the mapping put on another
 * file (the download's engine moved on), and by `onRemoteMove`, whose index is the engine's
 * own, never mapped. Released at the commit, or when the swap is refused or fails.
 */
let swapHold: {
  nowPlaying: NowPlaying;
  trackIndex: number;
  queue: BookQueue;
  live: boolean;
} | null = null;
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
/**
 * A snapshot's place in one queue read onto another queue of the same book, by its file
 * (track ids are path-keyed): the same file's index there, or `lost` for a file that queue
 * lacks.
 */
function ontoQueue(
  s: PlaybackSnapshot,
  from: BookQueue,
  to: BookQueue,
  lost: Pick<PlaybackSnapshot, 'trackIndex' | 'position' | 'duration'>,
): PlaybackSnapshot {
  const at = trackIndexById(to, from.tracks[s.trackIndex]?.id);
  if (at === s.trackIndex) return s;
  return at >= 0 ? { ...s, trackIndex: at } : { ...s, ...lost };
}
/**
 * An engine report read onto the queue the store holds while the hot-swap moves the playing
 * file (`swapHold`): one at another index is the download's, so it becomes the same file's
 * index in the stream's queue, and one in a file the stream lacks keeps the store's place
 * (`prev`) until the commit moves it.
 */
function throughSwap(s: PlaybackSnapshot, prev: PlaybackSnapshot): PlaybackSnapshot {
  const hold = swapHold;
  if (!hold || !hold.live || s.trackIndex === hold.trackIndex) return s;
  const np = usePlayer.getState().nowPlaying;
  if (np !== hold.nowPlaying) return s;
  return ontoQueue(s, hold.queue, np.queue, {
    trackIndex: prev.trackIndex,
    position: prev.position,
    duration: prev.duration,
  });
}
/** When the transport last settled out of `playing` (a pause, from any source), else
 * null. A play after `LONG_PAUSE_MS` of it is a book picked up again, which is when
 * another device may have moved its place on (`onPickedUpAgain`). */
let pausedAt: number | null = null;
export const LONG_PAUSE_MS = 60_000;
/** How long a Play press of a book picked up again waits for the pick-up check before the
 * engine starts (`toggle`, fe#158): a check that answers by then moves the book before a
 * sound of the old place; a slower one goes on while the book plays, as a lock-screen play's
 * does. */
export const PICK_UP_WAIT_MS = 1_500;
let pickedUpAgainListener: (() => unknown) | null = null;
/** A pick-up check due while a load held the store (`loadingBook`, by its content key): the
 * place reconcile skips while that hold is set, so the check waits for its release (the
 * subscription beside the download hot-swap's) instead of being used up by a `playing`
 * reported during the load. */
let pickUpDue: string | null = null;
/** The download hot-swap of the book (its content key) whose download landed while a load
 * held the store (`loadingBook`) or a start was on its way (`startsInFlight`: a start of the
 * book already loaded holds nothing): the snapshot is the previous place until that load
 * lands, and a swap's own load made meanwhile would land after the start's, at that place.
 * Also one that landed before a start made the book the store's (nothing saw it land).
 * It runs once both are over (`runDueSwap`), and is dropped by a start or a reload that
 * placed nothing (a failed load releases the hold too). */
let swapDue: string | null = null;

/** The pick-up wait out now (`pickUpBeforePlay`): a press made while it is out waits for it
 * too, never past it. */
let pickUpWait: Promise<unknown> | null = null;

/**
 * A Play press of a book picked up again (paused `LONG_PAUSE_MS` or more) in the foreground:
 * the pick-up check runs before the engine starts, for up to `PICK_UP_WAIT_MS`, so a newer
 * place another device left is moved to before any of the old place sounds (fe#158). The
 * player shows `loading` meanwhile, as for a book loading, so a second Play is not offered;
 * a press that reaches the store anyway waits for the same check (`pickUpWait`), and the
 * latest press is the one that starts the engine. The play is then no pick-up of its own
 * (`pausedAt` cleared): a check still out goes on while it plays. The stall watchdog's grace
 * starts again once the engine is asked. In the background (a press from the car or a headset
 * reaching the store, where Android may hold the JS timers) nothing waits: the check runs once
 * the engine plays, as before. Resolves true when the press no longer stands (paused, or
 * pressed again, while it waited). A book left paused by that is paused from now (the engine
 * never left `paused`, so no transition marks it), so a play after another long pause is a
 * pick-up again.
 */
async function pickUpBeforePlay(): Promise<boolean> {
  const attempt = playAttempts;
  if (!pickUpWait) {
    const listener = pickedUpAgainListener;
    if (!listener || pausedAt === null || Date.now() - pausedAt < LONG_PAUSE_MS) return false;
    if (isAway() || usePlayer.getState().loadingBook) return false;
    pausedAt = null;
    const wait = withTimeout(Promise.resolve(listener()), PICK_UP_WAIT_MS, 'pick-up check')
      .catch(() => undefined)
      .finally(() => {
        if (pickUpWait === wait) pickUpWait = null;
      });
    pickUpWait = wait;
  }
  const { snapshot } = usePlayer.getState();
  if (snapshot.state !== 'loading')
    usePlayer.setState({ snapshot: { ...snapshot, state: 'loading' } });
  await pickUpWait;
  if (attempt !== playAttempts || !wantsPlayback) {
    if (!wantsPlayback) settlePickUpWaitPaused();
    // Pressed again, or another start (a Retry) took over: until that one plays, the book
    // is paused from now, so a play after another long pause is still a pick-up.
    else if (!isPlayingState(usePlayer.getState().snapshot.state)) pausedAt ??= Date.now();
    return true;
  }
  cancelStallWatchdog();
  armStallWatchdog();
  return false;
}

/** A press paused while the pick-up wait was out: the `loading` it showed (no engine event
 * follows: the engine never left `paused`) is `paused` again, and the book is paused from
 * now, so a play after another long pause is a pick-up again. */
function settlePickUpWaitPaused() {
  const { snapshot } = usePlayer.getState();
  if (snapshot.state === 'loading')
    usePlayer.setState({ snapshot: { ...snapshot, state: 'paused' } });
  if (!isPlayingState(usePlayer.getState().snapshot.state)) pausedAt ??= Date.now();
}

/** Tell the pick-up listener now, or once the load holding the store lands (`pickUpDue`). */
function pickUp() {
  const { loadingBook } = usePlayer.getState();
  if (loadingBook) pickUpDue = loadingBook;
  else void pickedUpAgainListener?.();
}
/** Counts the listener's own moves in the loaded book (seeks, track jumps, a book
 * started): a reconcile that sees it change while its check was out stands back. */
let localMoves = 0;

/** `playBook`s running now. An adoption that read while one ran stands back: the start
 * switches the book only after its own awaits, so an adoption landing between would take
 * the connection, the retry request and the save loop out from under it. */
let startsInFlight = 0;

/** A book's start (`playBook`), as `retry()` runs it again. */
type PlayRequest = {
  connectionId: string;
  libraryId: number;
  book: Book;
  chapterData?: ChaptersResponse;
};

/** Captured so `retry()` can re-run the resume path after a lookup failure. */
let lastPlayRequest: PlayRequest | null = null;

/** `lastPlayRequest` when it was a start of `ref`'s book, else null. */
function lastPlayRequestFor(ref: ContentRef): PlayRequest | null {
  const r = lastPlayRequest;
  return r && contentKey(r.connectionId, r.libraryId, r.book.rel_path) === contentKeyOf(ref)
    ? r
    : null;
}

const MIN_HISTORY_MS = 20_000; // ignore listening spans shorter than this
const STALL_GRACE_MS = 3_000; // a 'loading' that outlasts this is treated as a dead stream
/** How long a downloaded book waits for its server's place before it starts from this
 * device's records (`loadInitialProgress`), well inside a car's 10 s wait for a start. A start
 * from the saved place reads it beside its item and chapters (`readPlaceEarly`), so this wait
 * and theirs (`FRESH_SOURCE_WAIT_MS`, 3 s) run together. */
export const DOWNLOADED_PLACE_WAIT_MS = 3_000;

// The periodic save's two paces (`saveIntervalMs`, perf P4). The server derives listening
// sessions from these saves and the spans cut with them (audiosilo-server
// internal/catalog/sessions.go: a session reads as playing for 60 s after one, `livePlaying`,
// and as ended after 10 min without one, though a later one whose position advanced by about
// the elapsed time still continues it). The slower pace sits ON that 60 s window, so a
// session saved at it can read as paused for the moment before its next save lands;
// changing either pace means revisiting those windows (CROSS-REPO.md section 20).
// The faster one is also the pace of this device's own record of the place, which never
// slows (`placeLoop`).
const SAVE_INTERVAL_MS = 15_000;
/** The pace of what the save sends while nobody is looking or nothing is streaming: each
 * save is a request that wakes the radio by itself. */
const QUIET_SAVE_INTERVAL_MS = 60_000;
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
 * the resume floor lowered to it (`lowerFloorTo`). The place is theirs from here, whatever
 * another tab played meanwhile (`otherTabPlayed`). */
function userMoved(bookPosition?: number) {
  localMoves++;
  quietAdopted = null;
  otherTabPlayed = null;
  placeChosen = true;
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
   * keep-ahead (it downloads only when asked, or started with `autoDownloadEpisodes` on). A
   * view field only. */
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
    wanted?: () => boolean,
    superseded?: () => boolean,
  ) => Promise<void>;
  toggle: () => Promise<void>;
  pause: () => Promise<void>;
  /** Re-load the current track at the current position and resume - recovery after
   * the engine reports an `error` (e.g. the stream became unreachable). */
  retry: () => Promise<void>;
  /** Seek to a whole-book place. `track`: the file it is in, when the caller knows it (a
   * chapter's), else the playing one: among files that share a start (lengths unknown,
   * `locate`) it is that file, not the first. */
  seekBook: (bookPosition: number, track?: number) => Promise<void>;
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
 * completion) and records the whole-book duration so the book reads as 100% done.
 * `local`: only this device's own record of the place, with no request (`placeLoop`).
 * Resolves the whole-book place saved (this device's record of it, and its server's save
 * when one goes), else undefined: none saved, or the server held it back or refused it. */
async function persist(opts?: {
  forceFinished?: boolean;
  local?: boolean;
}): Promise<number | undefined> {
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
  // Nor while the engine holds another book on its way to being adopted
  // (`engineIsAnothers`): nothing of this book was heard since it stopped.
  if (engineIsAnothers() && !opts?.forceFinished) return;
  // Nor a place another tab has played past (`otherTabPlayed`), nor one on its way to that
  // tab's (`catchingUp`): dated now, it would be the newest in the mirror the tabs share.
  if (behindOtherTab(nowPlaying) && !opts?.forceFinished) return;
  // A downloaded book started while its connection wasn't there (a session that could not
  // be read yet: a CarPlay launch with the phone locked) keeps this device's record of its
  // place meanwhile, and sends from when it is back (below).
  // A switch takes the next book's client before that book is `nowPlaying` (`switchBook`;
  // its resume lookup and load are awaits away): a save meanwhile (a lock-screen pause, the
  // sleep timer) is still the previous book's, and goes to its own server.
  const api =
    apiRefFor !== null && apiRefFor !== nowPlaying.connectionId
      ? resolveClient(nowPlaying.connectionId)
      : (apiRef ??= resolveClient(nowPlaying.connectionId));
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
  // An engine reporting NaN (a stream with no length yet) has no place to save; a finish
  // still saves (at the book's end).
  if (!Number.isFinite(position)) {
    if (!forceFinished) return;
    position = 0;
  }
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
  const key = contentKeyOf(nowPlaying);
  // A queued save of this session PUT since (a replay): the guard is over.
  if (placeGuard && guardSettled(placeGuard.id)) placeGuard = null;
  const guard = placeGuard;
  // A finish is the listener's own: never held back.
  const guarded = guard?.key === key && !forceFinished;
  const save = {
    connectionId: nowPlaying.connectionId,
    libraryId: nowPlaying.libraryId,
    path: nowPlaying.path,
    position,
    // A partial queue's is the book's length on its server when known (`partialQueues`), so a
    // percent read from the save is of the book, not of the downloaded part.
    duration: partialQueues.get(nowPlaying.queue) || total,
    // The end of a download that lacks the rest of its book is not the book's (D3, fe#185).
    finished:
      forceFinished ||
      (total > 0 && position >= total - FINISHED_TOLERANCE && !endsPartial(nowPlaying)),
    playback_speed: rate,
    device_id: deviceId || cachedDeviceId(),
    updated_at: new Date().toISOString(),
    // The file place (fe#188), the mirror's only (a PUT never sends it), on both paths: an
    // older capture's file place never outlives the place it was taken at.
    ...(forceFinished || !end?.file ? {} : { file: end.file, file_pos: end.filePos }),
    // Its queue ends before the book (D3): a span recovered past this save never reads its
    // end as the book's (`mirrorSpanEnd`).
    ...(!forceFinished && endsPartial(nowPlaying) ? { partial: true as const } : {}),
    ...(guarded ? { guard: true, guard_session: guard.id } : {}),
  };
  // Sync v2 (`listening_sync`): the place reaches the server as listening events (the
  // spans below); the capture only keeps this device's mirror.
  if (usesListeningSync(nowPlaying.connectionId)) {
    await writeMirror(save);
    if (span && sameBook(span, nowPlaying) && !forceFinished && end) span.to = end;
    return position;
  }
  // The legacy PUT path's own record alone (`placeLoop`): the mirror, and no request. A
  // server known to be away is sent nothing either way (`saveProgress` writes the mirror
  // and queues the save), so that capture goes whole and the queue holds the same place.
  // No client (the connection not there yet): the mirror alone, so the device record does
  // not stand still while the download plays (fe#265).
  if (!api || (opts?.local && isReachable(nowPlaying.connectionId))) {
    await writeMirror(save);
    return position;
  }
  const outcome = await saveProgress(api, save);
  // Once a guarded save is PUT, the server had nothing further on: the session's saves go
  // straight on from here.
  if (guarded && outcome === 'saved' && placeGuard === guard) placeGuard = null;
  return outcome === 'saved' || outcome === 'queued' ? position : undefined;
}

/** Save the loaded book's place now: the listener answered Stay to a place its server held
 * a save back for. That is their choice of this device's place, so the session's guard is
 * lifted, not asked again: the other device may have saved since the offer was made (it is
 * still playing), and its new row, not the one answered, would hold this save and every
 * later one with no further offer. */
export function saveLoadedPlace(): void {
  placeGuard = null;
  void persist();
}

/** The loaded book `bookKey`'s place was checked against its server after all: a late answer
 * for a start that could not wait for it (`onLatePlace`) that holds nothing further on, or
 * that the book moved to. Its saves go unguarded from here, as a checked resume's do, with
 * no read of the server's row before the first of them. */
export function placeChecked(bookKey: string): void {
  if (placeGuard?.key === bookKey) placeGuard = null;
}

/** Nudge the Home/Browse "continue listening" + "finished" lists to re-read from
 * the server after playback halts. The live in-card position covers the actively-
 * playing book while it plays; this refreshes the other cards (finished state,
 * other-device progress) once it stops, without invalidating on every periodic save. */
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
 * and the network policy (`canAutoDownload`), a podcast episode only with
 * `autoDownloadEpisodes` on too (fe#166, D4b: off by default; one not on its server yet
 * waits there first, `episode-ready.ts`), and skips a book already downloaded or
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
    // An episode only when the listener asked for episodes too (fe#166, D4b).
    if (book.episode && !useSettings.getState().autoDownloadEpisodes) return;
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
 * must not wait on it): the place the app has cached (the book page reads it: the server's
 * row, or this device's own newer record with that row beside it, `bookPlace`), the
 * server's row of it (`row`; a cache that holds only this device's record, read offline,
 * hands that record, whose version is 0), and the newer of the cached place and the local
 * mirror of the last save. */
async function knownProgress(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<{
  row: Progress | null;
  newest: Pick<Progress, 'playback_speed' | 'finished'> | null;
}> {
  const cached =
    queryClient.getQueryData<PlacedProgress | null>(qk.progress(connectionId, libraryId, path)) ??
    null;
  const mirror = await readMirror(connectionId, libraryId, path).catch(() => null);
  // By one clock (`mirrorIsNewest`): the cached place may be the server's row, stamped by
  // its server's clock, and the mirror's record a capture of this device's.
  const newest =
    cached && mirror
      ? (await mirrorIsNewest(mirror, cached).catch(() => false))
        ? mirror
        : cached
      : (cached ?? mirror);
  return { row: cached && (cached.server ?? cached), newest };
}

/**
 * How long after the last periodic save the next is due: 15 s while the app is in front
 * AND the playing file streams from the server (the radio is up for the stream anyway),
 * 60 s otherwise: the app away (`isAway`: a locked phone, another app in front, a hidden
 * tab), or the file one this device holds (a download's, `PlaybackTrack.local`; owner
 * decision D5: in front too), where every save would wake the radio for itself. A Cast
 * receiver streams whatever the phone holds. Read at each check of the loop, so a change
 * mid-play (the hot-swap onto a download, a file of another kind, the app leaving or
 * coming back) sets the pace from the last save on, with none dropped and none doubled.
 *
 * This is the pace of what uses the NETWORK only: Sync v2's span cut and its send, and on
 * a server without `listening_sync` the legacy PUT. This device's own record of the place
 * (the mirror) is written every 15 s whatever this says (`placeLoop`), and the open span is
 * stored every 5 s (`OPEN_SPAN_KEEP_MS`): neither is a request, so slowing them would save
 * no radio and only leave a kill further behind. And only the periodic save slows: a
 * pause, a move, a stop, the end, a give-way and the app leaving the front still save at
 * once. So what waits up to a minute is what OTHER devices and the server see; after a
 * kill this device resumes from its own record, at most 15 s of playing behind (5 s once
 * the span the kill left open is recovered: `recoverOpenSpan` brings the mirror up to it).
 */
function saveIntervalMs(): number {
  if (isAway()) return QUIET_SAVE_INTERVAL_MS;
  const { nowPlaying: np, snapshot } = usePlayer.getState();
  const local = np?.queue.tracks[snapshot.trackIndex]?.local === true;
  return local && !service?.isCasting?.() ? QUIET_SAVE_INTERVAL_MS : SAVE_INTERVAL_MS;
}

/** The periodic save (what of it uses the network), and with it the Sync v2 span cut, at
 * `saveIntervalMs`'s pace. An `engineTicker`, so the engine's events keep it going where
 * Android has paused the interval (screen off, app in the background). `playBook` stops it
 * before a book switch, so a late event of the old book never saves under the new one.
 * A save writes this device's own record too, so `placeLoop`'s next is due 15 s from it. */
const saveLoop = engineTicker(
  () => {
    void persist();
    tickListeningSpan();
    rebase(placeLoop);
  },
  SAVE_INTERVAL_MS,
  saveIntervalMs,
);
/** This device's own record of the place (the mirror, `persist`'s `local`), every 15 s
 * while the book plays, whatever the save's pace: it is a storage write, not a request, and
 * it is what a start with no server to ask resumes from (a downloaded book, offline, after
 * a kill). At the save's 60 s pace that place was up to a minute of playing behind, and at
 * more than 1x a resume from it could end over 60 book seconds behind the span the kill
 * left open: the server's `resume_behind` backstop (CROSS-REPO section 25). While the save
 * itself runs every 15 s this never writes: each save re-bases it, and a save due at the
 * moment this is goes in its place (`check`). This loop's interval starts again at each
 * save and the save's own never does, so once an engine event has run a save this one's
 * comes due a moment before the check that would run the next, and both would write the
 * record for one tick.
 * Not on the 5 s keeper: the mirror is ONE document holding every book's record, read and
 * written whole (synchronously on the web's `localStorage`), where the open span is a few
 * hundred bytes; 15 s is the pace it was always written at. */
const placeLoop = engineTicker(() => {
  if (!saveLoop.check()) void persist({ local: true });
}, SAVE_INTERVAL_MS);
/** How often the open span is written to storage while playing, online or offline: a
 * kill (a force-stop, the OS ending the app) loses at most this much listening, since
 * `recoverOpenSpan` closes what was stored at the next launch. Without it an online span
 * lived only in memory between two cuts (W2 F1), which are now up to a minute apart
 * (`saveIntervalMs`). */
const OPEN_SPAN_KEEP_MS = 5_000;
const spanKeeper = engineTicker(() => keepOpenSpan(), OPEN_SPAN_KEEP_MS);
/** Started as playing starts: the first save comes one period after that. Never re-based
 * while it runs (`start()` leaves a running one alone): `loading` does not stop the loop, so
 * a play back from a buffer, or the web's next file, would otherwise put the save off by a
 * whole period each time, and a book that buffers (or changes file) more often than the
 * period, a minute at the slower pace, would never save. */
function startSaveLoop() {
  // In this order: on an engine event each runs in the order it was started, so a save
  // that is due goes before `placeLoop`, which it re-bases (`placeLoop` gives way to a due
  // save by itself too, where its own interval is the first to come).
  saveLoop.start();
  placeLoop.start();
  spanKeeper.start();
}
function stopSaveLoop() {
  saveLoop.stop();
  placeLoop.stop();
  spanKeeper.stop();
}
/** A running loop's next run is due a whole period from now (its work was just done). */
function rebase(loop: ReturnType<typeof engineTicker>) {
  if (!loop.running()) return;
  loop.stop();
  loop.start();
}

/**
 * The app left the front (`away`) or came back, while a book plays. Leaving, the place is
 * saved now and the loop re-based: the pace is 60 s from here, and the save the 15 s pace
 * owed must not wait for it (Sync v2's span is cut at the same moment, by
 * `listening-sync.ts` and on the web by `flushHistoryOnHide`). Coming back, a save the
 * 15 s pace already owes goes now rather than on the next engine event.
 */
function onAwayChange(away: boolean) {
  if (!saveLoop.running()) return;
  if (!away) {
    saveLoop.check();
    return;
  }
  void persist();
  rebase(saveLoop);
  rebase(placeLoop);
}
onAppStateEdge(isAway, onAwayChange);

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
// acknowledged (`base_version`). A span OPENS when the engine starts playing; it is CUT (closed
// into an event, a new one opening at once with `continue`) on each tick of the save loop
// (`saveIntervalMs`) while the server is reachable, a speed change, the server coming back, the
// app going to the background and the web page hiding; it is CLOSED on a pause (any settling
// out of `playing`), a move (the new place opens the next span with the move's reason), a stop,
// a book switch and the end. Offline, a tick leaves the span open (cut only after an hour,
// `MAX_SPAN_MS`), so a day offline is a handful of events. Online or offline, the open span is
// stored every 5 s (`OPEN_SPAN_KEEP_MS`), so a kill loses at most that, and a move's span as it
// opens, so a kill never loses the move. The persist guards
// above (the load, the hot-swap, an adoption's reload, the resume floor) keep a suspicious
// place out of a span too: a span then ends where it was last seen.

/** The longest a span stays open (wall clock) before it is cut, online or offline: well
 * under the server's 24 h bound on one span. */
const MAX_SPAN_MS = 60 * 60_000;

/** The span being played, else null. */
let span: OpenSpan | null = null;
/** Why the next span begins: a book started or resumed (`resume`), a move (`jump`,
 * `moved_back`), starting again (`restart`), a Stay while playing (`stay`). Back to `resume`
 * once a span takes it. */
let nextStart: ListeningStart = 'resume';
/** A finished book started again owes an `unfinish` before its first span. */
let unfinishDue = false;
/** The book (`contentKey`) whose `finish` was sent: the natural end and the end credits'
 * "mark finished" send one between them. Cleared when the book plays again. */
let finishSent: string | null = null;

type ContentRef = { connectionId: string; libraryId: number; path: string };
const sameBook = (a: ContentRef, b: ContentRef) => contentKeyOf(a) === contentKeyOf(b);
/** `contentKey` of a book the engine names, its connection id resolved (an old id the Android
 * service or a car snapshot still holds, `resolveConnectionId`). */
const resolvedKeyOf = (b: ContentRef) =>
  contentKey(resolveConnectionId(b.connectionId), b.libraryId, b.path);

/** The audio file (its rel path) of the track at `index`, from its id (`trackIdOf`). */
function fileOf(np: NowPlaying, index: number): string | undefined {
  const id = np.queue.tracks[index]?.id;
  const prefix = `${np.libraryId}:`;
  return id?.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

/** A saved place by its file (`file`: its rel path, `pos` seconds into it) in the order
 * `queue` plays now, never past the file's end; null when the queue has no such file. */
function filePlaceIn(
  queue: Pick<BookQueue, 'tracks' | 'offsets' | 'total'>,
  libraryId: number,
  file: string,
  pos: number,
): { index: number; positionInTrack: number } | null {
  const index = trackIndexById(queue, trackIdOf(libraryId, file));
  if (index < 0) return null;
  const length = (queue.offsets[index + 1] ?? queue.total) - queue.offsets[index];
  return { index, positionInTrack: length > 0 ? Math.min(pos, length) : pos };
}

/** A place in the loaded book as a span end, or null when it is not one: an engine that
 * reports NaN (a stream with no length yet) never puts one in a span or an event. */
function endAt(np: NowPlaying, trackIndex: number, positionInTrack: number): SpanEnd | null {
  const pos = toBookPosition(np.queue.offsets, trackIndex, positionInTrack);
  if (!Number.isFinite(pos)) return null;
  const file = fileOf(np, trackIndex);
  return {
    pos: Math.max(0, pos),
    ...(file ? { file, filePos: Math.max(0, positionInTrack) } : {}),
  };
}

/** Where the engine is in the loaded book, or null while that place can't be trusted (the
 * persist guards: a load, the hot-swap, an adoption's reload, a slip below the floor). */
function engineEnd(): SpanEnd | null {
  const { nowPlaying: np, snapshot, loadingBook } = usePlayer.getState();
  if (!np || loadingBook || heldBySwap(np, snapshot.trackIndex)) return null;
  if (quietAdopted === contentKeyOf(np)) return null;
  const end = endAt(np, snapshot.trackIndex, snapshot.position);
  if (!end || end.pos < resumeFloor - SLIP_TOLERANCE) return null;
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
    duration: bookAudioOf(np.queue),
    speed: usePlayer.getState().rate,
    startedAt: now,
    endedAt: now,
    start,
    baseVersion,
    // Its event's id, chosen now: a span closed twice is one event (`OpenSpan.id`).
    id: newEventId(),
  };
}

/** Open a span at `at` (else where the engine is) when the loaded book's server takes
 * listening events and none is open. */
function openListeningSpan(at?: SpanEnd) {
  const np = usePlayer.getState().nowPlaying;
  if (!np || !usesListeningSync(np.connectionId)) return;
  // Not from a place on its way to another tab's (`catchUpPlaying` opens it there), nor while
  // the engine plays another book (`otherBookReported`).
  if (catchingUp || engineHoldsAnother()) return;
  if (span) {
    if (sameBook(span, np)) return;
    closeListeningSpan();
  }
  const here = at ?? engineEnd();
  if (!here) return;
  const now = new Date().toISOString();
  const start = nextStart;
  nextStart = 'resume';
  const opened = spanAt(np, here, start, now);
  span = opened;
  // A move's span (a seek, a Stay, starting again) is stored now, not at the next keep
  // (`OPEN_SPAN_KEEP_MS`): a kill in between would lose the move itself (fe#321). Behind the
  // close of the span before it (`spanOps` keeps the order), so the stored one is this.
  if (spanSaysSomething(opened)) void storeOpenSpan({ ...opened });
  if (finishSent === contentKeyOf(np)) finishSent = null;
  void baseVersionOf(np).then((base) => {
    opened.baseVersion = base;
  });
  // A finished book started again: unfinished first, then the span from 0. In turn
  // (`appendInTurn`), behind a finish still waiting its own (a Mark as finished, then Play at
  // once): overtaking it, the unfinish went first and the book ended finished.
  if (unfinishDue) {
    unfinishDue = false;
    const unfinish = finishEvent('unfinish', np, now);
    void appendInTurn(np.connectionId, [unfinish], () => baseVersionOf(np))
      .catch(() => undefined)
      .then(() => flushOutbox(np.connectionId));
  }
}

/**
 * Close the open span at `at` (else where the engine is, else where it was last seen) into
 * the outbox, then send. Returns the closed span (null when none was open).
 */
function closeListeningSpan(opts: { at?: SpanEnd; endedAt?: number } = {}): OpenSpan | null {
  const closing = takeSpan(opts.at, opts.endedAt);
  if (!closing) return null;
  const cid = closing.connectionId;
  // Waiting its turn from here (`closeSpan`): what is appended after it (`appendInTurn`: a
  // finish, a paused move) goes after it.
  void closeSpan(closing)
    .catch(() => undefined)
    // An event behind it (a finish, a paused move) sends both, in one batch, once it is in.
    .finally(() => {
      if (!waitingInTurn(cid)) void flushOutbox(cid);
    });
  return closing;
}

/** Take the open span (none open from here), ended now at `at`, else where the engine is,
 * else where it was last seen. `endedAt` (ms): the time it ends when that is before now
 * (another tab began playing then: `giveWayTo`). */
function takeSpan(at?: SpanEnd, endedAt?: number): OpenSpan | null {
  const closing = span;
  span = null;
  if (!closing) {
    // A Stay still waiting for its span (`standByPlace`, playing with none open) does not
    // outlive the play: one that ends first leaves the next a `jump` (`carriedStart`).
    nextStart = carriedStart(nextStart);
    return null;
  }
  const np = usePlayer.getState().nowPlaying;
  const loaded = np !== null && sameBook(closing, np);
  closing.to = at ?? (loaded ? engineEnd() : null) ?? closing.to;
  const now = Date.now();
  const ended = endedAt !== undefined && Number.isFinite(endedAt) ? Math.min(now, endedAt) : now;
  // Never before it began (a span cut since the other tab's claim was made).
  closing.endedAt = new Date(Math.max(ended, Date.parse(closing.startedAt) || 0)).toISOString();
  // Like a paused move: the loaded book's next play begins with the same reason.
  if (carriesMove(closing)) nextStart = carriedStart(closing.start);
  return closing;
}

/** Whether a span closing is a bare move of the loaded book (`spanIsBareMove`), whose
 * reason the book's next span takes too. Another book's move is not carried to this one. */
function carriesMove(closing: OpenSpan): boolean {
  const np = usePlayer.getState().nowPlaying;
  return np !== null && sameBook(closing, np) && spanIsBareMove(closing);
}

/** The reason a bare move sent already gives the book's next play: its own, but a Stay's as
 * a `jump`. That play may come hours later, and the server measures a Stay's slack from its
 * span's end (`staysWin`): a second `stay` then would beat what another device chose since
 * the first one (Jump on its offer, then listening on). */
function carriedStart(start: ListeningStart): ListeningStart {
  return start === 'stay' ? 'jump' : start;
}

/** Cut the span (close it, a span opening where it ended, for `start`) while playing. */
function cutListeningSpan(start: ListeningStart = 'continue') {
  // None open: nothing to cut, and a Stay waiting for its span goes on waiting (`takeSpan`).
  if (!span) return;
  const closed = closeListeningSpan();
  if (!closed || !isPlayingState(usePlayer.getState().snapshot.state)) return;
  // A bare move's reason is already there (`takeSpan`); a reason asked for (Stay) still wins.
  if (start !== 'continue' || !carriesMove(closed)) nextStart = start;
  openListeningSpan(closed.to);
}

/** The save loop's tick (`saveIntervalMs`): cut while the server is reachable (live
 * sessions), else keep the span.
 * Playing with none open, one opens here or at the 5 s keep, whichever comes first
 * (`openMissingSpan`): the play's own could not (its place was held by a load, the hot-swap
 * or an adoption's reload), or the server took listening events only since (its `/server`
 * read while the book played; the history the PUT path began goes by `POST /history` up to
 * here). */
function tickListeningSpan() {
  if (!span) {
    openMissingSpan();
    return;
  }
  // Online, every tick cuts (live sessions). Offline, a span is cut once it has run an
  // hour of wall clock, so a day of nonstop playing never becomes one span past the
  // server's 24 h bound (refused `invalid`): a handful of events a day, each a whole hour.
  if (isReachable(span.connectionId) || Date.now() - Date.parse(span.startedAt) >= MAX_SPAN_MS) {
    cutListeningSpan();
  }
  // Offline the span stays open: `spanKeeper` stores it.
}

/** Playing with no span open: open one where the engine is (see `tickListeningSpan`). Not
 * for a play on its way to a pause (the intent dropped, the engine yet to report it): a tab
 * that gave way has ended its span where the other tab's begins, and one opened in that
 * moment would cover the other tab's listening. */
function openMissingSpan() {
  if (!wantsPlayback || engineHoldsAnother()) return;
  const np = usePlayer.getState().nowPlaying;
  if (!np || !usesListeningSync(np.connectionId)) return;
  if (!isPlayingState(usePlayer.getState().snapshot.state)) return;
  if (historyStart && !historyStart.sync) {
    endHistory();
    beginHistory();
  }
  openListeningSpan();
}

/** Bring the open span up to where the engine is now and store it (`OPEN_SPAN_KEEP_MS`), so
 * a kill loses only what played since. With none open while the book plays, one opens here
 * too: what plays before a span opens is in no listening event, and the save loop's tick
 * may be a minute away (`saveIntervalMs`). */
function keepOpenSpan() {
  const kept = span;
  if (!kept) {
    openMissingSpan();
    return;
  }
  const np = usePlayer.getState().nowPlaying;
  if (!np || !sameBook(kept, np)) return;
  const here = engineEnd();
  // Never back: a native lock-screen move's landed place could reach the store before the
  // move (`onRemoteMove`), which ends the span at its last place, `span.to`. The native
  // service holds a tick that jumped for its move (fe#211); this stays for what that misses
  // (a jump under its thresholds, a move told after the hold).
  if (here && here.pos >= kept.to.pos - 1) kept.to = here;
  kept.endedAt = new Date().toISOString();
  void storeOpenSpan({ ...kept }).then((stored) => {
    // Another tab took its last copy (and sent it): it plays on under the new id it was
    // stored with, so what played since is an event of its own.
    if (stored && span === kept) {
      Object.assign(kept, {
        id: stored.id,
        from: stored.from,
        startedAt: stored.startedAt,
        start: stored.start,
      });
    }
  });
}

/** Where the last move sent the loaded book (`moveListeningSpan`), null until one does. */
let movedTo: SpanEnd | null = null;

/**
 * A move of the place (a seek, a chapter, a bookmark, Undo, a lock-screen scrub) to
 * `target`: the span ends where it was (`from`, else the engine's place now, else where it
 * was last seen; `from: null`, the engine has moved already and where it was is not known)
 * and the next one begins at the target with the move's reason. Paused, the move is sent at
 * once as a span of its own that moved nowhere (the place syncs as a PUT did), and the next
 * play begins with the same reason.
 */
function moveListeningSpan(target: SpanEnd | null, opts: { from?: SpanEnd | null } = {}) {
  const np = usePlayer.getState().nowPlaying;
  if (!np || !usesListeningSync(np.connectionId)) return;
  const before = opts.from !== undefined ? opts.from : (engineEnd() ?? span?.to ?? null);
  // A move to where the place already is (Previous at the book's start) is none: the span
  // goes on and no event says it. The engine's place alone is not enough: a seek still on
  // its way reads as where it left, so the last move must have gone there too.
  if (movesNowhere(before, target) && (!movedTo || movesNowhere(movedTo, target))) return;
  const closed = closeListeningSpan(before ? { at: before } : {});
  // A place that is not one (NaN) moves nothing: the span just ends where it was.
  if (!target) return;
  movedTo = target;
  const reason: ListeningStart = before && target.pos < before.pos - 1 ? 'moved_back' : 'jump';
  if (closed && isPlayingState(usePlayer.getState().snapshot.state)) {
    nextStart = reason;
    openListeningSpan(target);
    return;
  }
  sendStill(np, target, reason, closed?.baseVersion);
}

/** A move made while paused, or a Stay (`start`, to `at`): sent at once as a span of its own
 * that moved nowhere (the place syncs as a PUT did), and the next span begins with the same
 * reason (a Stay's as a `jump`: `carriedStart`). `base`: the base of the span just closed
 * (`closeListeningSpan`), for the copy waiting its turn. */
function sendStill(np: NowPlaying, at: SpanEnd, start: ListeningStart, base?: number) {
  const now = new Date().toISOString();
  // After the span a close just ended (still on its way into the outbox, `closeSpan` waits
  // its turn): the outbox's order is the order a sync sends (`appendInTurn`). The copy
  // waiting meanwhile carries the closed span's base, which the web's `pagehide` sends: on
  // base 0 the server read a `moved_back` or a `stay` as made before every write it holds.
  // With no span closed (paused with none open) the outbox gives that copy the base it
  // reads at the call.
  const event = spanToEvent(spanAt(np, at, start, now, base));
  void appendInTurn(np.connectionId, [event], () => baseVersionOf(np))
    .catch(() => undefined)
    .then(() => flushOutbox(np.connectionId));
  nextStart = carriedStart(start);
}

/**
 * Close `closing` (when any) into the outbox, then put the book's `finish` (at `at`) after
 * it and after any close of its book already on its way (the web reports `paused` before
 * `ended`), then send: the outbox's order is the order a sync sends, so a book's last span
 * always goes before its finish (server#359, `appendInTurn`). Both wait their turn from this
 * call, in the outbox's memory, so the web's `pagehide` carries them, and nothing holds the
 * finish here meanwhile. Resolves once the finish waits in the outbox (not sent); `onSent`
 * runs once that send is over.
 */
async function finishAfter(
  closing: OpenSpan | null,
  ref: ContentRef,
  at: string,
  onSent?: () => void,
): Promise<void> {
  // Its event could not be stored: the finish still goes.
  if (closing) void closeSpan(closing).catch(() => undefined);
  const finish = finishEvent('finish', ref, at, closing?.baseVersion);
  try {
    await appendInTurn(ref.connectionId, [finish], () => baseVersionOf(ref));
  } finally {
    if (closing && closing.connectionId !== ref.connectionId) {
      void flushOutbox(closing.connectionId);
    }
    void flushOutbox(ref.connectionId).then(onSent);
  }
}

/** What a finish moves, read again once the server has it: the caller (`useMarkFinished`)
 * refreshed them as the finish went into the outbox, before it was sent, so they would
 * otherwise keep the book unfinished. Only while its server is reachable (else nothing was
 * sent, and the read would only fail). */
function refreshAfterFinish(ref: ContentRef) {
  if (!isReachable(ref.connectionId)) return;
  invalidateFinishedProgress(queryClient, ref.connectionId, ref.libraryId, ref.path);
}

/** The book's last span closed, then its `finish` (the natural end, "Mark finished"):
 * once between them, and in that order (`finishAfter`). */
function sendFinish(np: NowPlaying) {
  const key = contentKeyOf(np);
  if (!usesListeningSync(np.connectionId) || finishSent === key) {
    closeListeningSpan();
    return;
  }
  finishSent = key;
  const closing = takeSpan();
  void finishAfter(closing, np, new Date().toISOString()).catch(() => undefined);
}

/**
 * "Mark as finished" outside the player (the book page; `finish-route.ts`, fe#208), on a
 * server that takes listening events: a `finish` event, queued offline like any other.
 * The caller has stopped and unloaded the loaded book first (`leaveFinishedBook`), its span
 * closed ahead of the finish; one loaded again since has its open span closed first all the
 * same, and the player's own end does not send a second finish until the book plays again.
 * The finish waits its turn behind that close from the start (`finishAfter`), before this
 * reads or writes anything. This device's mirror records the book finished at its end, so
 * offline it reads finished and Play starts it again; not once its connection was signed out
 * meanwhile (the record would outlive the purge and stand for the next sign-in).
 */
async function recordFinish(ref: FinishRef): Promise<void> {
  const since = connectionGeneration(ref.connectionId);
  const np = usePlayer.getState().nowPlaying;
  const loaded = !!np && sameBook(np, ref);
  const closing = span && sameBook(span, ref) ? takeSpan() : null;
  // Dated after the span's end (`takeSpan` stamps it), as `sendFinish` does: the server
  // applies a batch in time order, and a finish dated before its book's last span went first.
  const at = new Date().toISOString();
  if (loaded) finishSent = contentKeyOf(ref);
  const queued = finishAfter(closing, ref, at, () => refreshAfterFinish(ref));
  // Awaited below, after the mirror: one that failed meanwhile is not an unhandled rejection.
  void queued.catch(() => undefined);
  // The book page gives no speed: the book's own stays in the mirror (an offline Listen
  // again reads it), never 1x.
  const prior = await readMirror(ref.connectionId, ref.libraryId, ref.path).catch(() => null);
  const speed = ref.playback_speed ?? prior?.playback_speed;
  const id = deviceId || (await getDeviceId());
  if (connectionGeneration(ref.connectionId) === since) {
    notePlaceBefore(ref, prior);
    await writeFinishedMirror(finishedSave({ ...ref, playback_speed: speed }, id, at)).catch(
      () => undefined,
    );
  }
  try {
    await queued;
  } catch (e) {
    // Never queued, so never sent: this device's record goes back to the one before the
    // finish, as on an Undo of a finish that never left, and the player's end may send one.
    // Left finished, the book loaded again after the failure (`reloadLeftBook`) started
    // over at 0, and its next play sent that restart over the place the server holds.
    if (prior && !prior.finished) await restorePlaceBefore(ref, since);
    // No record before it: the finish's own record goes (only it: one written since stands).
    else if (!prior && connectionGeneration(ref.connectionId) === since) {
      await updateMirror(ref.connectionId, ref.libraryId, ref.path, (now) =>
        now.finished && now.device_id === id && now.updated_at === at ? null : now,
      ).catch(() => undefined);
      invalidateFinishedProgress(queryClient, ref.connectionId, ref.libraryId, ref.path);
    }
    placeBefore.delete(contentKeyOf(ref));
    if (finishSent === contentKeyOf(ref)) finishSent = null;
    throw e;
  }
}

/** The start of the book a Mark as finished stopped and unloaded (`leaveFinishedBook`), once
 * its place is saved: for a finish that then failed (`reloadLeftBook`). */
let leftForFinish: PlayRequest | null = null;

/** A start of a book the listener marked finished while it was on its way
 * (`leaveFinishedBook`): it loads nothing (`playBook`). */
let finishedStart: PlayRequest | null = null;

/**
 * "Mark as finished" outside the player of the loaded book (the book page, fe#258): it stops
 * and unloads, as the book's own end does (`finishBook`). Left loaded, the playing book went
 * on recording listening past its finish (the server ended finished at a later place), any
 * later save of the engine's place stamped after the finish put the book back in progress
 * (the device record after an offline finish was delivered, a PUT over the finish), and its
 * page went on reading "Resume". Its place is saved first, as a stop saves it (resolves once
 * that save is over, so the finish the caller records next comes after it, a PUT included,
 * with the place saved: the one an Undo goes back to, which the page's progress, read before
 * that listening, can be behind), and its span closes there (a finish waits for that close:
 * `finishAfter`). A start of the book still on its way (its place being looked up, its
 * files loading) is called off: it loads nothing, or what it loaded is reset (`playBook`).
 * Nothing for another book.
 */
function leaveFinishedBook(ref: ContentRef): Promise<number | undefined> {
  const { nowPlaying: np, rate } = usePlayer.getState();
  leftForFinish = null;
  const starting = startsInFlight > 0 ? lastPlayRequestFor(ref) : null;
  if (starting) finishedStart = starting;
  if (!np || !sameBook(np, ref)) return Promise.resolve(undefined);
  const request = lastPlayRequestFor(np);
  clearPlaybackIntent();
  stopSaveLoop();
  closeListeningSpan();
  endHistory();
  // Reads the book synchronously, before it is unloaded below.
  const saved = persist().catch(() => undefined);
  usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL_SNAPSHOT, rate } });
  void service?.reset();
  return saved.then((position) => {
    leftForFinish = request;
    return position;
  });
}

/** A start called off as its book was marked finished (`finishedStart`), before it loaded
 * anything: no intent to play, the engine reset (it may still hold the book played before),
 * and nothing loaded. Nothing at all once another start has taken the player since: the
 * engine and the intent to play are that start's (reset, a book it loaded went silent). */
async function callOff(svc: PlaybackService, request: PlayRequest): Promise<void> {
  finishedStart = null;
  if (lastPlayRequest !== request) return;
  clearPlaybackIntent();
  await svc.reset();
  if (lastPlayRequest !== request) return;
  const { rate } = usePlayer.getState();
  usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL_SNAPSHOT, rate } });
}

/**
 * The finish a book was left for (`leaveFinishedBook`) failed (a progress edit or a PUT
 * refused, the server away): the book is loaded again, paused at the place it was left at
 * (saved as it was left, so its resume finds it), as it was before the Mark. Resumed, not
 * started at that place: an explicit place is a `jump`, which the next play here sent over
 * a place another device reached meanwhile. Not when anything was loaded since (the
 * listener moved on).
 */
async function reloadLeftBook(ref: ContentRef): Promise<void> {
  const left = leftForFinish;
  leftForFinish = null;
  // A start on its way counts too: loaded beside it, the slower of the two took the player.
  if (!left || usePlayer.getState().nowPlaying || startsInFlight > 0) return;
  const { connectionId, libraryId, book, chapterData } = left;
  if (contentKey(connectionId, libraryId, book.rel_path) !== contentKeyOf(ref)) return;
  await usePlayer
    .getState()
    .playBook(
      connectionId,
      libraryId,
      book,
      chapterData,
      undefined,
      undefined,
      undefined,
      () => false,
    );
}

/**
 * The place each book had before its latest Mark as finished in this tab (`recordFinish`),
 * for its Undo (`unrecordFinish`). The mirror's finished record carries it too
 * (`ProgressSave.before`), but only until another record replaces that one: the server's row
 * for the finish, read back a moment after it was sent, is not this device's Mark and
 * carries none, and an Undo after it went back to the position alone, its file place lost
 * (a downloaded book then opened at the wrong file offline). In memory, so only for the tab
 * that marked it, as long as its Undo toast can be pressed.
 */
const placeBefore = new Map<string, ProgressSave>();

/** Keep `prior` (the mirror's record a Mark as finished is about to replace) for the Undo,
 * when it is a place; forget the book's earlier one otherwise. */
function notePlaceBefore(ref: ContentRef, prior: ProgressSave | null): void {
  const key = contentKeyOf(ref);
  if (!prior || prior.finished) return void placeBefore.delete(key);
  const { before: _before, ...place } = prior;
  placeBefore.set(key, place);
}

/**
 * A Mark as finished that never reached the server was undone (`undoFinish`: taken back from
 * the outbox unsent; or never queued, `recordFinish`): the mirror goes back to the record
 * the finish replaced (`ProgressSave.before`, `writeFinishedMirror`), the place the server
 * still holds, with its own stamp: a place another device saved after it, read from the
 * server next, is newer and wins. Resolves whether it did: only while the mirror holds a
 * finished record carrying that place, decided under the mirror's lock (`updateMirror`), so
 * another tab's finish or a place saved since is never undone from a look taken before it.
 * Nothing once the connection was signed out since the Undo began (`since`).
 */
async function restorePlaceBefore(ref: ContentRef, since: number): Promise<boolean> {
  if (connectionGeneration(ref.connectionId) !== since) return false;
  let restored = false;
  // Its lock refused (Web Locks): held off in this tab alone, and the record still goes back.
  await noteUndoneFinish(ref.connectionId, ref.libraryId, ref.path).catch(() => undefined);
  await updateMirror(ref.connectionId, ref.libraryId, ref.path, (now) => {
    if (!now.finished || !now.before || now.before.finished) return now;
    restored = true;
    // Its Sync v2 fields stay the mirror's own: an ack since is newer.
    return { ...now.before, ack_version: now.ack_version, answered: now.answered };
  }).catch(() => undefined);
  if (!restored) return false;
  placeBefore.delete(contentKeyOf(ref));
  if (finishSent === contentKeyOf(ref)) finishSent = null;
  invalidateFinishedProgress(queryClient, ref.connectionId, ref.libraryId, ref.path);
  tellUndoneElsewhere(ref);
  return true;
}

/**
 * A Mark as finished was undone by the progress edit that unfinished it on the server
 * (`undoFinish`), or one never sent had no place before it to go back to: the mirror goes
 * back to the record before the finish (`ProgressSave.before`; not for Mark as not
 * finished, `atPosition`), else to this device's at `ref.position`, unfinished, and the
 * player's end may send a finish again. Under the mirror's lock (`updateMirror`), so a read
 * of the server's row landing meanwhile never writes between the look and the change; one
 * still on its way lands after, and the mirror holds off a finished record stamped before
 * the Undo for a while (`noteUndoneFinish`). Nothing once the connection was signed out
 * since the Undo began (`since`).
 */
async function unrecordFinish(ref: UndoRef, since: number): Promise<void> {
  const key = contentKeyOf(ref);
  // Taken either way: a Mark as not finished later must not go back to it (`atPosition`).
  const kept = placeBefore.get(key);
  placeBefore.delete(key);
  if (finishSent === key) finishSent = null;
  if (connectionGeneration(ref.connectionId) !== since) return;
  // Its lock refused (Web Locks): held off in this tab alone, and the record still goes back.
  await noteUndoneFinish(ref.connectionId, ref.libraryId, ref.path).catch(() => undefined);
  await updateMirror(ref.connectionId, ref.libraryId, ref.path, (now) => {
    // Only the finish's record: a place saved since it (newer, unfinished) is not undone.
    if (!now.finished) return now;
    // Stamped as the record it replaces: the mirror keeps the newest, so the record from
    // before the finish (older) would be refused. That record's time, not the finish's: once
    // the server answered, a downloaded book's record is the server's row for the finish,
    // stamped by its clock after the request's delay, and a record stamped with the finish's
    // own time is refused too. One millisecond later (fe#258): a read of the finished row
    // still on its way (the finish's own refresh) lands after this with that same stamp, and
    // a tie goes to the later write, so the mirror was finished again, and with the device's
    // clock ahead of the server's the unfinished row read next was older and lost to it. Its
    // Sync v2 fields stay the mirror's own: an ack since is newer.
    const stamp = Date.parse(now.updated_at);
    const at = Number.isFinite(stamp) ? new Date(stamp + 1).toISOString() : now.updated_at;
    const sync = { ack_version: now.ack_version, answered: now.answered };
    // The record's own, else this tab's (`placeBefore`): the server's row for the finish,
    // read back since, replaced the record that carried it.
    const prior = ref.atPosition ? undefined : (now.before ?? kept);
    // By the clock of the stamp it took (`localTimeOf`): `now`'s `server_clock`.
    if (prior && !prior.finished) {
      return { ...prior, ...sync, server_clock: now.server_clock, updated_at: at };
    }
    // The finished record at the place before it: its file place was the book's end.
    const { file: _file, file_pos: _filePos, before: _before, ...rest } = now;
    return { ...rest, finished: false, position: ref.position, updated_at: at };
  }).catch(() => undefined);
  invalidateFinishedProgress(queryClient, ref.connectionId, ref.libraryId, ref.path);
  tellUndoneElsewhere(ref);
}

setFinishRecorder({
  takesEvent: usesListeningSync,
  generation: connectionGeneration,
  leave: leaveFinishedBook,
  reload: reloadLeftBook,
  record: recordFinish,
  withdraw: withdrawFinish,
  unrecord: unrecordFinish,
  restoreBefore: restorePlaceBefore,
});

/**
 * After the listener answered an offer of another device's place with Stay: this device's
 * place stands, sent at once as a span that moved nowhere (a paused move's, `sendStill`, on
 * the version the answer acknowledged): a `stay` on a `listening_stay` server
 * (`usesListeningStay`), which the server applies over the other device's writes since the
 * offer, else a `jump`, which it applies over the other place under its usual rule. Sent at
 * once while playing too: a Stay that waited for the next cut would let the other device's
 * sync answers offer this device's place from before it meanwhile. Playing, the span ends
 * here and the next one begins here as a `jump` (`carriedStart`), so nothing is heard twice;
 * paused, the next play begins as a `jump`: a `stay` sent at a play that may come much later
 * would beat what another device chose since. With no place to send now (a load holds it),
 * the next span is the Stay: the one cut now while playing, else the one that opens
 * (`openMissingSpan`) while this play goes on (`takeSpan`); paused, the next play is a `jump`.
 */
export function standByPlace(): void {
  const np = usePlayer.getState().nowPlaying;
  const start: ListeningStart = np && usesListeningStay(np.connectionId) ? 'stay' : 'jump';
  const playing = isPlayingState(usePlayer.getState().snapshot.state);
  const here = np && usesListeningSync(np.connectionId) ? engineEnd() : null;
  if (np && here) {
    // The open span (a playing one, or one a stall left open) ends where the Stay is.
    const closed = closeListeningSpan({ at: here });
    sendStill(np, here, start, closed?.baseVersion);
    if (playing && closed) openListeningSpan(here);
    return;
  }
  if (playing) {
    if (span) cutListeningSpan(start);
    else nextStart = start;
    return;
  }
  closeListeningSpan();
  nextStart = carriedStart(start);
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

// --- One tab plays at a time (web; `playing-claim.ts`, fe#123) ----------------------------

/** Tell the other tabs of the web player this one plays the loaded book's connection. */
function claimPlaying() {
  // This tab plays now: the others follow its place from here.
  otherTabPlayed = null;
  const { nowPlaying: np, snapshot } = usePlayer.getState();
  if (!np) {
    ownPlay = null;
    return;
  }
  const { sentAt } = tabClaims().announce(np.connectionId, playAskedAt);
  // The play already claimed, going on (a buffer moments after it began, the next file):
  // it is kept as it was first claimed, so the answer to that claim still finds it.
  if (ownPlay?.connectionId === np.connectionId && ownPlay.askedAt === playAskedAt) return;
  // Kept, with where this play began: the tab that gives way answers it with where it
  // stopped (`onGaveWayAnswer`).
  ownPlay = {
    connectionId: np.connectionId,
    askedAt: playAskedAt,
    since: sentAt,
    pos: toBookPosition(np.queue.offsets, snapshot.trackIndex, snapshot.position),
  };
}

/**
 * Another tab began playing (its `claim`). When this tab plays on the same connection, or
 * means to, and that play is the newer one (`givesWayTo`), this one gives way: its span
 * ends where the engine is, dated no later than the other tab's began, then it pauses (the
 * intent dropped; the place was saved before the note below, so the save the pause makes
 * writes nothing, and the pause finds no span left to close, so the span is one event) and
 * the listener is told (`onGaveWayToTab`). The book
 * stays loaded: a play here claims the connection back, from where the other tab left the
 * book when it played the same one (`otherTabsPlace`).
 *
 * A tab whose stream died is not playing, so it has nothing to give way with; its engine is
 * stopped all the same, so the stream cannot come back by itself and play over the other tab.
 *
 * Either way, and paused too, a tab with a book of that connection loaded notes that
 * another tab plays (`otherTabPlayed`): its own place may be behind from here. Once per
 * play: a tab claims on every move into `playing`, so the play it noted claims again as it
 * goes on (the next file, a stall it came back from, a transcoded stream requested again),
 * and that is no new play (`notedPlay`). The note is left as it stands, so a seek the
 * listener made here since is still the place this tab plays from. That holds for a tab
 * still pausing for the play too (it gave way a moment ago and its engine has not reported
 * the pause, so it still reads as playing): the play's next claim is not a second give-way.
 *
 * A tab that gives way answers the play with the place it stopped at (`GaveWay`), which is
 * where its span ended: the other tab began from this tab's last save in the mirror they
 * share, up to 15 s behind (`placeLoop`, whatever the save's own pace), and plays
 * on from here instead (`onGaveWayAnswer`). Not a tab that was itself behind another's play
 * (a press still reading the shared place, a play that began by itself still moving there:
 * `catchingUp`): its place is not the latest. And once per play: a claim of
 * a play this tab noted before (it gave way to it already, or was not playing then) is
 * never answered, so the other tab is told one place, the one its first claim stopped.
 */
function giveWayTo(claim: PlayingClaim) {
  const { nowPlaying: np, snapshot } = usePlayer.getState();
  const mine = {
    tab: tabClaims().tab,
    connectionId: np?.connectionId ?? null,
    live: isPlayingState(snapshot.state) || wantsPlayback,
    askedAt: playAskedAt,
  };
  const gives = givesWayTo(claim, mine);
  const wasBehind = catchingUp !== null || otherTabPlayed?.connectionId === claim.connectionId;
  // The play already noted, going on: by its tab and when it was asked for, which only a new
  // play changes (a press, the OS media controls).
  const noted =
    notedPlay?.connectionId === claim.connectionId &&
    notedPlay.tab === claim.tab &&
    notedPlay.askedAt === claim.askedAt;
  // It gave way to that play already and no play was asked for here since (`own`): its
  // engine has not reported the pause yet, so the snapshot still reads `playing`. Nothing
  // is new: no second note (a seek the listener made here meanwhile stands), pause or
  // notice.
  if (gives && noted && notedPlay?.own === playAskedAt) return;
  const goesOn = !gives && noted;
  // Not when it plays on (the newer play is this tab's: the other tab follows it).
  if (np && np.connectionId === claim.connectionId && (gives || !mine.live) && !goesOn) {
    notedPlay = {
      connectionId: claim.connectionId,
      tab: claim.tab,
      askedAt: claim.askedAt,
      own: playAskedAt,
    };
    // The place it gives way at is saved first: nothing of its own is saved after the note.
    if (gives) void persist();
    // Whatever place the listener chose here, the other tab's listening is the latest.
    placeChosen = false;
    // The earliest claim not caught up with yet: every save since may be past this place.
    if (otherTabPlayed?.connectionId !== claim.connectionId) {
      otherTabPlayed = {
        connectionId: claim.connectionId,
        since: Math.min(claim.sentAt, Date.now()),
      };
    }
  }
  if (!gives) {
    // A stream that died here (`error`, no Retry out) is not playing, but its engine may
    // still bring it back by itself (the error hold lets a `playing` through), and that
    // `playing` would read as a new play and take the connection back from the tab that
    // plays now. So its engine is stopped: the error stays, and a Retry here plays again.
    const died = !mine.live && snapshot.state === 'error';
    if (died && mine.connectionId === claim.connectionId) {
      void service?.pause().catch(() => undefined);
    }
    return;
  }
  yieldedAttempt = playAttempts;
  const closed = closeListeningSpan({ endedAt: claim.sentAt });
  if (np && !wasBehind && !noted) {
    // Where its span ended, so the other tab's begins there: one chain, no gap.
    const at = closed && sameBook(closed, np) ? closed.to : engineEnd();
    const { total } = np.queue;
    if (at) {
      tabClaims().answer(claim, {
        connectionId: np.connectionId,
        libraryId: np.libraryId,
        path: np.path,
        position: at.pos,
        ...(at.file !== undefined ? { file: at.file, filePos: at.filePos } : {}),
        finished: total > 0 && at.pos >= total - FINISHED_TOLERANCE && !endsPartial(np),
      });
    }
  }
  // The engine is paused whatever the snapshot says, where the `pause` action pauses only
  // one seen `playing` or `loading`: a play just asked for, whose first engine event has not
  // arrived, would go on to `playing` with the intent dropped, read as a new play and take
  // the connection back.
  clearPlaybackIntent();
  void service
    ?.pause()
    .catch((e: unknown) => console.warn('[player] could not pause for another tab', e));
  gaveWayNotice.tell();
}

/**
 * One listener for something the store has to say, told of it as it registers when it
 * happened with nobody to tell yet (the root's services, which show the notices, start
 * after the store can: after the first paint on the web, with the root layout on a car
 * start with no activity).
 */
function lateListener() {
  let listener: (() => void) | null = null;
  let untold = false;
  return {
    tell() {
      if (listener) listener();
      else untold = true;
    },
    /** Register the listener (one at a time); returns the unsubscribe. */
    on(next: () => void): () => void {
      listener = next;
      if (untold) {
        untold = false;
        next();
      }
      return () => {
        if (listener === next) listener = null;
      };
    },
  };
}

/** This tab gave way to another tab's play. */
const gaveWayNotice = lateListener();

/** Queues built from a download that ends before its book does, without the rest (an
 * adoption offline, `adoptLoadedBook`; a `playBook` from the download's own copy with no
 * server to stream from): their end is the downloaded part's, not the book's (D3, fe#185).
 * By queue, so any other start of the book (a new queue) is a whole one unless it adds
 * itself. Each with the book's length on its server (`DownloadManifest.bookDuration`, 0 when
 * unknown): the queue's own audio is only the downloaded part's. */
const partialQueues = new WeakMap<BookQueue, number>();

/** Whether `np`'s queue ends where its download does, short of the book's end. */
const endsPartial = (np: NowPlaying | null): boolean => !!np && partialQueues.has(np.queue);

/** The book's audio length a span of `queue` reports (Sync v2's `duration`): the queue's own,
 * but for a partial queue the book's on its server, 0 when unknown (the server then checks
 * nothing). The downloaded part's length is more than 10 s off the indexed book's whenever a
 * whole file is missing, and every such listen was refused `duration_mismatch`. */
const bookAudioOf = (queue: BookQueue): number => partialQueues.get(queue) ?? queue.audio;

/** The book's length on its server for a partial queue over `manifest`: what the download
 * kept from the answer that said where the book ends, else a server chapters answer the start
 * was given that names that end (a cold start's cached one), else 0 (unknown). */
function serverLengthOf(
  manifest: DownloadManifest | undefined,
  chapters?: ChaptersResponse,
): number {
  const kept = manifest?.bookDuration ?? 0;
  if (kept > 0) return kept;
  const end = manifest?.endsBefore;
  if (!end || !chapters || !(chapters.duration > 0)) return 0;
  const names = bookFileSpecs(manifest.book, chapters).some((f) => f.path === end);
  return names ? chapters.duration : 0;
}

/** The engine last reported the end of such a queue (the store reads it as `paused`): a
 * play there has nothing to play. False again with the engine's next other state (a move
 * back, another book). */
let atPartialEnd = false;

/** Where the store last asked the engine to be (a load, a seek, a track jump), in file
 * coordinates, until the engine has played on from there (`PLAYED_ON` seconds into that file)
 * or another move: a later ask, the listener's own from the lock screen or the car
 * (`onRemoteMove`). While the ask stands the engine has not played: a later file reported
 * from a place clearly inside the asked one (`shortOfFileEnd`), or an end short of the book's
 * (`endsShortOfBook`), is the engine running off the end of a file it measured short (a resume
 * or a Retry past Media3's first-frame guess at a header-less VBR MP3), a fault of the
 * engine's (`engineFault`), never the listener's place. Once it has played on, its moves and
 * its end are the book's: a server length that overestimates the audio ends it early.
 *
 * Each ask is its own record, and the engine call that makes its move tells when the engine
 * took it (`engineTakes`). `landed`: that call resolved, so every report from then on is from
 * after the move (the services resolve once the engine took it and report the asked place as
 * they do, a report sent before it out by then; the native module ships with this bundle, no
 * over-the-air update ever pairing it with a binary that resolves sooner). Only a landed
 * ask's file can show that the engine played on from it: a progress tick sent before a seek
 * back of `PLAYED_ON` or more took is still in that file, past the asked place. And only
 * before the ask lands can a report from another file be one from before the move
 * (`engineFault`). A call that never settles (a Cast receiver that never answers) leaves its
 * ask unlanded: `ASK_SETTLE_MAX_MS` after the ask (`at`) no such tick is out any more, so its
 * file shows the engine played on as a landed one's does.
 *
 * `seq`: the ask's number, counting every ask the store made, for the fault it may have called
 * off (`calledOff`).
 *
 * `faultShown`: the engine went where the book is not on this very ask, and its fault shows the
 * asked place already (`engineFault`), before the move's call settled (a seek Media3 took
 * clamped at its short measure, reported inside the call): the move has no place left to show
 * (`listenerMove`).
 *
 * `playing`: the engine reported the asked file `PLAYING_PAST` beyond the asked place, so it
 * holds that place in its measure (one run off a short measure reports at most its own end,
 * short of the place) and a later file from then on is a move, not a run off its end: the
 * listener's own next from the lock screen, a headset or the car, whose file change Android
 * reports before `onRemoteMove`.
 *
 * `held`: before that, the engine reported a later file (since `since`). That is the listener's
 * own next as often (a headset press soon after a paused scrub or while it buffered), which
 * Android tells up to 300 ms after the file change, so the fault waits `FAULT_HOLD_MS` for that
 * `onRemoteMove`, the engine's reports held back meanwhile. `report`: the latest as the engine
 * sent it, which decides it when no other comes in time (`timer`, at `until`; `due` once it
 * fired); `seen`, the same report read onto the store's queue (`throughSwap`), which the next
 * one is measured from (`heldMove`). `until` moves out to `ASK_SETTLE_MAX_MS` once a report
 * places the engine where no run off the asked file reaches.
 *
 * `before`: the file of the ask this one took the place of while that still stood (else -1),
 * whose move the engine may report yet. `elsewhere`: the engine's first report from another
 * file since the ask, which bounds how long such a report reads as one from before the move
 * landed (`engineFault`). */
type EngineAsk = {
  np: NowPlaying;
  trackIndex: number;
  position: number;
  at: number;
  landed: boolean;
  seq: number;
  faultShown: boolean;
  playing: boolean;
  held: {
    since: number;
    report: PlaybackSnapshot;
    seen: PlaybackSnapshot;
    timer: ReturnType<typeof setTimeout> | null;
    due: boolean;
    until: number;
  } | null;
  before: number;
  elsewhere: { trackIndex: number; position: number } | null;
};
let askedPlace: EngineAsk | null = null;
const PLAYED_ON = 3;
const PLAYING_PAST = 0.5;
/** Longer than an engine move takes to settle when it does (`EngineAsk.at`). */
export const ASK_SETTLE_MAX_MS = 10_000;
/** How long a run into a later file waits for its `onRemoteMove` before it is a fault
 * (`EngineAsk.held`): Android's module sends the move at most 300 ms after the file change, the
 * same wait as the native service's for a jumped tick (`LANDING_HOLD_MS`), and iOS tells the
 * file and the move in two events, the file first. Not on the web (`faultHoldMs`). */
export const FAULT_HOLD_MS = 600;
/** The wait this platform needs. None on the web: nothing there moves the engine into another
 * file but the store's own asks (Media Session has no track handlers and its scrubber stays in
 * the file; a Cast receiver's move is told before its place, `cast-service.ts`), so a later
 * file under a standing ask is a run off it, paused at once, not 600 ms into the wrong file. */
const faultHoldMs = () => (Platform.OS === 'web' ? 0 : FAULT_HOLD_MS);
/** How far one report of a run into a later file can be past the one before it
 * (`EngineAsk.held`, `runOnStep`): iOS tells the new file at 0, then ticks a second of the
 * media's own time apart (whatever the speed), each tick telling the media's time as it is
 * delivered: one delivered late (a busy main thread) is past its beat by the lateness times the
 * speed. A second of lateness is allowed at any speed (2 s of media at 1x, 4 s at 3x). */
const RUN_ON_TICK_S = 1;
const RUN_ON_LATE_S = 1;
/** The step `heldMove` allows at speed `rate`. */
const runOnStep = (rate: number): number =>
  RUN_ON_TICK_S + RUN_ON_LATE_S * Math.max(1, Number.isFinite(rate) ? rate : 1);
/** Does `s`, a report of a later file, place the engine past what a run into that file
 * explains, from `last`, the run's report before it (null for its first)? Only iOS's remote
 * move does so: a lock-screen, headset or car move into a later file at a non-zero place tells
 * the file and that place at once, and `onRemoteMove` only once the deferred seek lands, which
 * on a slow stream is longer than `FAULT_HOLD_MS`. Android tells the move within 300 ms
 * whatever the place. Measured by the engine's own clock, the place from report to report,
 * never by when the reports reach JS: a run's ticks queued while JS was busy come in a burst. */
function heldMove(s: PlaybackSnapshot, last: PlaybackSnapshot | null): boolean {
  if (Platform.OS !== 'ios') return false;
  const from = last?.trackIndex === s.trackIndex ? last.position : 0;
  return s.position - from > runOnStep(Math.max(s.rate, usePlayer.getState().rate));
}
/** The book whose engine faulted (`engineFault`): its reports are dropped, and a play the
 * engine makes by itself is paused again, until the store asks it for a place again.
 * `faultPause`: the fault's pause, one record per fault. It has landed once its call resolved
 * (`resolved`) and the engine told `paused` or `ended` since it was asked, or faulted so
 * (`stopped`). The call alone does not say so: a native one resolves before its engine has
 * paused, and the web's pause tells the place once more before its `paused`, each report
 * still a `playing` one. A `playing` from then on is the listener's own (the lock screen, a
 * headset, the car), never the engine still playing on, or done buffering, before the pause
 * lands. */
let faultedBook: NowPlaying | null = null;
let faultPause = { resolved: false, stopped: false };
/** Does `state` say the engine stopped: neither playing nor about to (a load's `ready` with
 * its play on the way, a buffer)? */
const stoppedState = (state: PlaybackState) => state === 'paused' || state === 'ended';
/** Has the loaded book's engine faulted (`faultedBook`)? */
const loadedFaulted = () => faultedBook !== null && faultedBook === usePlayer.getState().nowPlaying;

/** Is the loaded book's snapshot a place its fault shows (`faultedBook`): the place asked for
 * when the engine went where the book is not, or a move made on the book in error
 * (`showPlace`), never the engine's own (it may sit clamped at a short measure)? Jump undo
 * takes such an `error` as a settled place. */
export const showsFaultPlace = loadedFaulted;

/** Is the snapshot an error only a play replaces: no play wanted, so `onReport` holds it
 * against every report but a `playing` one? */
const errorHeld = () => usePlayer.getState().snapshot.state === 'error' && !wantsPlayback;

/** Do the engine's reports stay off the loaded book's snapshot: its engine faulted
 * (`faultedBook`), or its error is held (`errorHeld`)? A move made then shows its place itself
 * (`showPlace`: `listenerMove`, `onRemoteMove`): the place saved, the screen and a Retry's
 * reload all follow it, never the place the error was at. */
const reportsUnheard = () => loadedFaulted() || errorHeld();

/** The engine's own length of each file of `np`'s queue, as it last reported it (the snapshot's
 * `duration` before the store reads the server's over a short measure, `fileDurationOf`), by
 * file index. Only the engine that plays `np` now measured them: a new book, or the download
 * hot-swap's new `NowPlaying`, starts with none, and so does the other route (`casting`: a
 * Cast receiver measures a file its own way, and the phone's engine the route switch loads the
 * book back into never took the receiver's measure). */
let engineLengths: { np: NowPlaying; casting: boolean; byFile: Map<number, number> } | null = null;

/** Is the store's engine a Cast receiver, or on its way to one (`engineLengths`)? */
const castRouted = () => service?.isCasting?.() ?? false;

/** Note the engine's length of file `trackIndex` of `np`'s queue. */
function noteEngineLength(np: NowPlaying, trackIndex: number, duration: number) {
  if (!(duration > 0)) return;
  const casting = castRouted();
  if (engineLengths?.np !== np || engineLengths.casting !== casting) {
    engineLengths = { np, casting, byFile: new Map() };
  }
  engineLengths.byFile.set(trackIndex, duration);
}

/** The engine's length of file `trackIndex` of `np`'s queue as it last reported it
 * (`engineLengths`), 0 when unknown. */
const engineLength = (np: NowPlaying, trackIndex: number): number =>
  engineLengths?.np === np && engineLengths.casting === castRouted()
    ? (engineLengths.byFile.get(trackIndex) ?? 0)
    : 0;

/** Is `position` in file `trackIndex` of `np`'s queue past `measure`, the engine's own length of
 * that file, while the server's length goes on past the place (`shortOfFileEnd`)? An engine put
 * there clamps at its measure and runs on into the next file: it can't play the place. False
 * with no measure known. */
function pastMeasure(
  np: NowPlaying,
  trackIndex: number,
  position: number,
  measure: number,
): boolean {
  return (
    measure > 0 &&
    position >= measure - PLAYING_PAST &&
    shortOfFileEnd(np.queue, trackIndex, position)
  );
}

/** The snapshot shows `(trackIndex, position)` of `np`'s queue, its state kept, at the file's
 * server length (the engine's may be a short measure). A file the server has no length for
 * keeps the engine's when it is the snapshot's own (`fileDurationOf`).
 *
 * The engine may not be where the book now shows (it took the move clamped at its short
 * measure), so the book is faulted from here (`faultedBook`): a play the engine makes is a
 * reload at this place, as a press is, never a run from the clamped one, and a move puts the
 * engine in its file by index. `faulted`: the move called off a fault, whose pause
 * (`faultPause`) may not have landed yet, so a late `playing` of the engine's is still paused
 * again; else none is out, and a `playing` from now on is the listener's. */
function showPlace(np: NowPlaying, trackIndex: number, position: number, faulted: boolean) {
  const { snapshot } = usePlayer.getState();
  const engine = trackIndex === snapshot.trackIndex ? snapshot.duration : 0;
  const duration = fileDurationOf(np.queue, trackIndex, engine);
  // Faulted before the snapshot is told: its subscribers read the place as the fault's
  // (`showsFaultPlace`).
  markFaulted(np, faulted);
  usePlayer.setState({ snapshot: { ...snapshot, trackIndex, position, duration } });
}

/** `np`'s engine faulted from here (`faultedBook`). `pauseOut`: a fault's pause (`faultPause`)
 * may not have landed yet, so a late `playing` of the engine's is still paused again; else none
 * is out, and a `playing` from now on is the listener's. */
function markFaulted(np: NowPlaying, pauseOut: boolean) {
  if (!pauseOut) faultPause = { resolved: true, stopped: true };
  faultedBook = np;
}

/** Where a reload of the loaded book `np` puts the engine (`retry`, and a press on a book in
 * error): the place of an ask the engine has not taken yet (`askedPlace`, unlanded: a skip on a
 * book in error, which Android takes up to a second to rebuild), the move the listener made
 * last; else the place the book shows, never below the resume floor, in the playing file when
 * files share its start (`locate`). */
function reloadPlace(np: NowPlaying): { index: number; positionInTrack: number } {
  const ask = askedPlace;
  if (ask?.np === np && !ask.landed)
    return { index: ask.trackIndex, positionInTrack: ask.position };
  const player = usePlayer.getState();
  const bookPos = Math.max(resumeFloor, selectBookPosition(player));
  return locate(np.queue.offsets, bookPos, player.snapshot.trackIndex);
}

/** Would a reload of `np` put its engine past its own measure of the file (`pastMeasure`), where
 * it clamps and runs on into the next file, heard before the fault stops it? Not when the reload
 * would be of a download that landed meanwhile (another engine's measure, `retry`), nor at the
 * place another tab played the book on to (read as the reload starts). */
function stuckPastMeasure(np: NowPlaying): boolean {
  if (otherTabPlayed?.connectionId === np.connectionId || streamsDownloadedFile(np)) return false;
  const at = reloadPlace(np);
  return pastMeasure(np, at.index, at.positionInTrack, engineLength(np, at.index));
}

/** The fault of `np` an ask called off (`askEngineTo` on a faulted book), while the engine may
 * still be where it faulted: no ask of the book made since (`from` on) has been taken, and every
 * ask since was of the book, so the store's last (`askSeq`) is one of them, standing or given up
 * on (`withdrawAsk`: a move to another tab's place past `TAB_MOVE_MAX_MS`, whose call may still
 * settle). The engine refusing that ask's move (`engineTakes`) is the engine still where it
 * faulted, so the fault stands again; one of them taken clears it, and so does the ask's end any
 * other way (`setAsk(null)`: the engine played on from it or ran off it, the listener moved), or
 * an ask made after one given up on (none standing: the engine may have gone anywhere since).
 * One record for the book, re-pointed with the asks at the download hot-swap's commit
 * (`moveAsk`). */
let calledOff: { np: NowPlaying; from: number } | null = null;
/** The number of the store's last ask (`EngineAsk.seq`). */
let askSeq = 0;

/** `askedPlace` is `next` from here; a fault the one before it held back is called off. With
 * none, the asks are over, and so is any fault they called off (`calledOff`). */
function setAsk(next: EngineAsk | null) {
  if (askedPlace) dropHeld(askedPlace);
  askedPlace = next;
  if (next === null) calledOff = null;
}

/** The engine is back where `ask` put it, or the ask is over: no fault is held for it. */
function dropHeld(ask: EngineAsk) {
  if (ask.held?.timer) clearTimeout(ask.held.timer);
  ask.held = null;
}

/** The store asks the engine for `(trackIndex, position)` of `np`'s queue (`askedPlace`).
 * Returns the ask, for the engine call that makes the move (`engineTakes`), and for a caller
 * that may give up on it (`withdrawAsk`). */
function askEngineTo(np: NowPlaying, trackIndex: number, position: number): EngineAsk {
  const before = askedPlace?.np === np ? askedPlace.trackIndex : -1;
  const seq = ++askSeq;
  const ask: EngineAsk = {
    np,
    trackIndex,
    position,
    at: Date.now(),
    landed: false,
    seq,
    faultShown: false,
    playing: false,
    held: null,
    before,
    elsewhere: null,
  };
  // The ask calls the book's fault off, or is the latest of the asks since one did while one of
  // them still stands: the engine may still be where it faulted, so the fault stands again if
  // this one is refused. After one given up on (`withdrawAsk`), none stands: a later move is
  // the listener's from wherever the engine went meanwhile.
  if (faultedBook === np) calledOff = { np, from: seq };
  else if (askedPlace?.np !== np) calledOff = null;
  setAsk(ask);
  faultedBook = null;
  return ask;
}

/** Does `ask` hold off a fault it may have to bring back (`calledOff`): the store's last ask
 * (`askSeq`), so the latest since? By its number only: the record follows the book onto the
 * download's queue (`moveAsk`), and a given-up ask's `np` does not. */
const holdsFault = (ask: EngineAsk) => calledOff !== null && ask.seq === askSeq;

/** `move` is the engine call that makes `ask`'s move: once it resolves the engine took it
 * (`EngineAsk.landed`); one that rejects was refused, and its ask stands no longer, while a
 * fault it called off stands again (`calledOff`): the engine is still where it faulted. */
async function engineTakes<T>(ask: EngineAsk, move: Promise<T>): Promise<T> {
  try {
    const taken = await move;
    if (askedPlace === ask) ask.landed = true;
    // Taken, replaced or not: the engine left the place it faulted at, so no later ask of the
    // book brings the fault back when refused. Not an ask from before the fault was called
    // off (its move landed before the place the engine faulted at).
    if (calledOff && ask.seq >= calledOff.from) calledOff = null;
    return taken;
  } catch (err) {
    // Refused while no ask came since (standing, or given up on): the engine is where it
    // faulted. Not for a book no longer loaded (the player closed, another book started): its
    // fault went with it.
    const off = holdsFault(ask) ? calledOff : null;
    if (off && faultedBook === null && usePlayer.getState().nowPlaying === off.np) {
      faultedBook = off.np;
    }
    if (off) calledOff = null;
    if (askedPlace === ask) setAsk(null);
    throw err;
  }
}

/** The store asks the engine for `(trackIndex, position)` of `np`'s queue, and `move` is the
 * engine call that makes it (`engineTakes`). With no book loaded there is nothing to ask. */
function engineMove<T>(
  np: NowPlaying | null,
  trackIndex: number,
  position: number,
  move: () => Promise<T>,
): Promise<T> {
  if (!np) return move();
  const ask = askEngineTo(np, trackIndex, position);
  return engineTakes(ask, move());
}

/** `engineMove` for the listener's own move in the app (a seek, a skip, a track jump). On a
 * book whose engine reports don't reach its snapshot (`reportsUnheard`) once the engine took
 * the move, the move shows its place itself (`showPlace`), so the screen, the place saved and
 * a Retry's reload follow it: not when the engine refused it (it is still where the book
 * shows), nor once the listener moved again meanwhile, another book loaded or a play began.
 * Read once the move landed, not as it was made: an error surfacing meanwhile (the stall
 * watchdog, while a seek waits on a stalled stream) holds off the engine's report of it. */
async function listenerMove<T>(
  np: NowPlaying | null,
  trackIndex: number,
  position: number,
  move: () => Promise<T>,
): Promise<T> {
  if (!np) return move();
  const moves = localMoves;
  const ask = askEngineTo(np, trackIndex, position);
  // Did the move call off a fault (whose pause may not have landed yet)?
  const faulted = holdsFault(ask);
  const taken = await engineTakes(ask, move());
  // Not a move whose own fault shows its place already (`EngineAsk.faultShown`).
  const still = usePlayer.getState().nowPlaying === np && localMoves === moves && !ask.faultShown;
  if (still && reportsUnheard()) showPlace(np, trackIndex, position, faulted);
  return taken;
}

/** The store gave up on `ask`'s move (`moveToTabPlace`): it no longer stands. Left standing,
 * the engine's next file from where it stayed would read as a run off the asked one. A fault it
 * called off is kept (`calledOff`), for a refusal that comes later. A later ask is left alone. */
function withdrawAsk(ask: EngineAsk) {
  if (askedPlace !== ask) return;
  dropHeld(ask);
  askedPlace = null;
}

/** The engine's record of `from` is `to`'s from here, the same book on another queue (the
 * download hot-swap's commit, `commitLocalSwap`): its fault (`faultedBook`), a fault an ask
 * called off (`calledOff`: a late refusal brings it back there), and the ask standing, in the
 * same file, as the store's place moves (`ontoQueue`), and at `lost` for a file that queue
 * lacks. Left on `from` they would stand for nothing: a press would resume a faulted engine,
 * and a run off the asked file, one held for the listener's move included (`EngineAsk.held`),
 * would be taken as the book's place. */
function moveAsk(from: NowPlaying, to: NowPlaying, lost: { trackIndex: number; position: number }) {
  if (faultedBook === from) faultedBook = to;
  if (calledOff?.np === from) calledOff = { ...calledOff, np: to };
  const ask = askedPlace;
  if (ask?.np !== from) return;
  const onto = (i: number) => trackIndexById(to.queue, from.queue.tracks[i]?.id);
  const at = onto(ask.trackIndex);
  ask.np = to;
  ask.trackIndex = at >= 0 ? at : lost.trackIndex;
  if (at < 0) ask.position = lost.position;
  ask.before = ask.before >= 0 ? onto(ask.before) : -1;
  const seen = ask.elsewhere ? onto(ask.elsewhere.trackIndex) : -1;
  ask.elsewhere = ask.elsewhere && seen >= 0 ? { ...ask.elsewhere, trackIndex: seen } : null;
  // A held run's last report, read onto `to` as the next one will be (`heldMove`); -1 for a
  // file `to` lacks, measured as a new file's first report.
  if (ask.held) {
    ask.held.seen = { ...ask.held.seen, trackIndex: onto(ask.held.seen.trackIndex) };
  }
}

/**
 * The engine report `s` as an `error` at the asked place, when the engine went where the book
 * is not before it played on from the store's last ask (`askedPlace`): on to a later file from
 * an asked place inside its file, or to the end of the media short of the book's end
 * (`endsShortOfBook`), which would otherwise read as the book finished (the credits,
 * `finishBook`'s `finished: true` and Sync v2's `finish`). `'hold'` while a later file waits
 * for the listener's own move (`EngineAsk.held`): the report is not taken. Else null.
 *
 * `ended`: the engine reported the end of its media (`s` may read `loading`: an end while a
 * start shows its spinner). Such an end is a fault only from an ask inside its file: an ask at
 * a file's end, or at its start, can't land past a short measure.
 *
 * `prev` is the store's snapshot before `s`. Before the ask landed, a report still in the file
 * the store shows, when that is not the asked one, is from before the move (a native progress
 * tick or a Cast status sent before the seek or the track jump took): the ask stands, and
 * nothing ran off its file. So is one in the file of an ask this one replaced before the engine
 * reported it (a jump on, then a seek back, inside the engine's latency). Only until the engine
 * has moved `PLAYED_ON` seconds in that other file: it never took the move then (a seek it
 * refused, or a run off the asked file straight back into the one it came from), and the ask
 * stands no longer, or the engine's next file, minutes on, would read as a run off the asked
 * one. Once the ask landed, a later file is the engine's own, the one the store showed
 * included (a move back past a short measure runs on into it).
 * And an `ended` the engine already showed is no new end: the native and web services keep
 * their last state, so a seek or a track jump on a book that ended re-reports `ended` with the
 * place it asked for.
 */
function engineFault(
  np: NowPlaying,
  s: PlaybackSnapshot,
  prev: PlaybackSnapshot,
  ended: boolean,
): PlaybackSnapshot | 'hold' | null {
  const asked = askedPlace;
  if (asked?.np !== np) return null;
  if (s.trackIndex === asked.trackIndex) {
    // In the asked file: nothing ran off it (a report of a later file was from before).
    dropHeld(asked);
    const after = asked.landed || Date.now() - asked.at >= ASK_SETTLE_MAX_MS;
    if (after && s.position >= asked.position + PLAYED_ON) {
      setAsk(null);
      return null;
    }
    if (after && s.position > asked.position + PLAYING_PAST) asked.playing = true;
  } else if (!asked.landed && (s.trackIndex === prev.trackIndex || s.trackIndex === asked.before)) {
    const first = asked.elsewhere;
    if (first?.trackIndex !== s.trackIndex) {
      asked.elsewhere = { trackIndex: s.trackIndex, position: s.position };
    } else if (Math.abs(s.position - first.position) >= PLAYED_ON) {
      setAsk(null);
    }
    return null;
  }
  // From a file's start an engine can't run past its end (it measured the file at least that
  // long): only an ask inside a file can land past a short measure.
  const inside = asked.position > 0 && shortOfFileEnd(np.queue, asked.trackIndex, asked.position);
  const short =
    ended &&
    prev.state !== 'ended' &&
    (s.state === 'ended' || inside) &&
    endsShortOfBook(np.queue, s.trackIndex, s.position);
  // In the asked file at the end of its own measure, the asked place past it: the engine took
  // the move clamped there (Media3 on a VBR MP3 whose seek header measures it short), and from
  // there it can only run on into the next file. Told at once, paused or playing, landed or
  // not (Android reports a paused seek's clamped place once, inside the call), so nothing plays
  // into that file and the clamped place never shows. Not a landing at the asked place.
  const clamped =
    !short &&
    s.trackIndex === asked.trackIndex &&
    pastMeasure(np, asked.trackIndex, asked.position, s.duration) &&
    s.position >= s.duration - PLAYING_PAST &&
    s.position < asked.position - PLAYING_PAST;
  // A run already held was one while it played: a pause made during the wait never makes
  // its later file the place.
  const rolled =
    !short &&
    !clamped &&
    !asked.playing &&
    inside &&
    s.trackIndex > asked.trackIndex &&
    (asked.held !== null || wantsPlayback || startingPlayback);
  if (rolled) {
    const now = Date.now();
    // The run's report before this one, on the store's queue as `s` is (`holdFault` keeps the
    // engine's own to decide it with), none for its first.
    const last = asked.held?.seen ?? null;
    const held = asked.held ?? {
      since: now,
      report: s,
      seen: s,
      timer: null,
      due: false,
      until: now + faultHoldMs(),
    };
    held.seen = s;
    asked.held = held;
    // A move's deferred seek may land as late as any engine move settles.
    if (heldMove(s, last)) held.until = held.since + ASK_SETTLE_MAX_MS;
    if (!held.due && now < held.until) return 'hold';
  } else if (!short && !clamped) {
    // Not a run off the asked file after all: a run held for one is called off.
    dropHeld(asked);
    // On into a later file from the end of the asked one: it played that out.
    if (s.trackIndex > asked.trackIndex) setAsk(null);
    return null;
  }
  // The clamp is the engine's own measure of the asked file, whatever its file's first report
  // or a move still out keep from the lengths (`noteEngineLength`): a press then reloads
  // nothing past it (`stuckPastMeasure`).
  if (clamped) noteEngineLength(np, s.trackIndex, s.duration);
  faultedBook = np;
  asked.faultShown = true;
  setAsk(null);
  return {
    ...s,
    state: 'error',
    trackIndex: asked.trackIndex,
    position: asked.position,
    duration: fileDurationOf(
      np.queue,
      asked.trackIndex,
      s.trackIndex === asked.trackIndex ? s.duration : 0,
    ),
  };
}

/** "The rest of this book isn't downloaded": the player stopped at the end of a download
 * that lacks the rest of its book. */
const partialEndNotice = lateListener();
const tellPartialEnd = partialEndNotice.tell;

/** Be told each time the player stops at the end of a download that lacks the rest of its
 * book (D3, fe#185), and of a stop nobody was told of yet. One listener; returns the
 * unsubscribe. */
export const onPartialDownloadEnd = partialEndNotice.on;

/** Be told each time this tab gives way to another tab's play (the "Playing in another
 * tab" notice), and of one nobody was told of yet. One listener; returns the unsubscribe. */
export const onGaveWayToTab = gaveWayNotice.on;

/**
 * Another tab of the web player began playing on a connection while this tab, with a book
 * of that connection loaded, was not playing or gave way to it: since when (the earliest
 * such claim, ms). From then on this tab's place may be behind the one the tabs share (the
 * mirror of the last save, which every tab of a browser reads and writes), so:
 * - it saves nothing of its own (`persist`): its place dated now would be the newest there,
 *   over the other tab's;
 * - before it plays again it takes the shared place (`otherTabsPlace`), so the tabs are
 *   never at two places of one book.
 * Cleared once this tab plays (`claimPlaying`: the others follow it from here) and by a move
 * of the listener's own here (`userMoved`: the place they chose stands; every book switch
 * is one, and a book just loaded resumed from the shared place anyway).
 */
let otherTabPlayed: { connectionId: string; since: number } | null = null;
/** The other tab's play this tab noted last (`giveWayTo`), by its tab and when it was asked
 * for: the same play claiming again as it goes on is not noted a second time, so it never
 * takes back a place the listener chose here since (`userMoved`). Forgotten when a book is
 * started (`switchBook`): that book's place is the shared one as it was at its load, and
 * the other tab plays on from there, so its next claim is noted afresh. `own`: this tab's
 * own play as it stood then (`playAskedAt`), which tells a tab still pausing for that play
 * (the engine's pause not reported yet) from one that has played again since. */
let notedPlay: { connectionId: string; tab: string; askedAt: number; own: number } | null = null;
/** The engine may be playing while this tab moves to another tab's place (`moveWhilePlaying`:
 * a play that began by itself, `catchUpPlaying`, or the answer of the tab that gave way,
 * `onGaveWayAnswer`): no span opens and nothing is saved meanwhile. Dropped by a book switch
 * (`switchBook`): the move was the previous book's. */
let catchingUp: Promise<void> | null = null;
/** Whether the loaded book's place is not to be saved: another tab has played since. */
const behindOtherTab = (np: NowPlaying) =>
  catchingUp !== null || otherTabPlayed?.connectionId === np.connectionId;
/** The play this tab claimed last (`claimPlaying`), by when it was asked for (`askedAt`,
 * which every claim of the play carries: a play claims again on each move into `playing`):
 * an answer to it says where the tab that gave way stopped (`onGaveWayAnswer`). `since`:
 * when it was first claimed. `pos`: the whole-book place this play began at (the place of
 * another tab it took since, `adoptTabPlace`), which is what an answer is read against: by
 * the time one comes the tab has played on from there. */
let ownPlay: { connectionId: string; askedAt: number; since: number; pos: number } | null = null;
/** How long after a play's first claim a tab still takes the answer to it. The answer comes
 * within moments (the other tab pauses as it hears the claim); one later than this would
 * move a listener who has been listening here for seconds. */
export const GAVE_WAY_ANSWER_MS = 5_000;
/** Whether the loaded book's place is one the listener chose in this tab (an explicit
 * start, a move of their own: `userMoved`) with no other tab playing since: an answer never
 * moves it. Not one it resumed at or took from another tab. */
let placeChosen = false;
/** Places closer than this are one place: nothing moves for less. */
const SAME_PLACE_S = 2;

/** Where another tab left the loaded book: the track and the seconds into it, the
 * whole-book place (`pos`), and whether it finished the book there (then the start). */
type TabPlace = { index: number; positionInTrack: number; pos: number; finished: boolean };

/**
 * The place to take before this tab plays again, or null to stay: where the newest save of
 * the loaded book is (the mirror: what a fresh load of the book resumes from, by its file
 * when the queue holds it, fe#188), when a tab of this browser saved it after the other
 * tab's claim (`since`) and it is another place than the engine's (`SAME_PLACE_S`), earlier
 * or later: the other tab is the latest listening. Another device's record moves nothing
 * (that is the place reconcile's, which asks first), nor does another book's, which leaves
 * this book's record as it was.
 *
 * A book the other tab finished starts again from 0, as a fresh load of a finished book
 * does (`playBook`), unless this tab is at its end itself (`finished: false` leaves a
 * finished book where it is: the paused tab only shows the place).
 */
async function otherTabsPlace(
  since: number,
  opts?: { finished?: boolean },
): Promise<TabPlace | null> {
  const loaded = usePlayer.getState().nowPlaying;
  if (!loaded) return null;
  const moves = localMoves;
  const record = await readMirror(loaded.connectionId, loaded.libraryId, loaded.path).catch(
    () => null,
  );
  // By this device's clock: a server's row (this browser's own place read back) is stamped
  // by the server's, which may be ahead (fe#262).
  const savedAt = record ? await mirrorTimeOf(record).catch(() => Number.NaN) : Number.NaN;
  const { nowPlaying: np, snapshot, loadingBook } = usePlayer.getState();
  // Another book, a place not known yet (a load), or the listener moved meanwhile.
  if (!np || !sameBook(np, loaded) || loadingBook || localMoves !== moves) return null;
  if (!record || record.device_id !== (deviceId || cachedDeviceId())) return null;
  if (!(savedAt >= since)) return null;
  const stopped = { ...record, filePos: record.file_pos };
  const here = toBookPosition(np.queue.offsets, snapshot.trackIndex, snapshot.position);
  return tabPlaceOf(np, here, stopped, opts);
}

/**
 * A place another tab stopped the loaded book at (`stopped`: its save, or its answer) as
 * the place for this tab to take, null when it is this tab's own (`here`, within
 * `SAME_PLACE_S`): by its file when the queue holds it (fe#188), else by its whole-book
 * seconds. A finished one is the start (`finished: false`: null, the book stays where it
 * is).
 */
function tabPlaceOf(
  np: NowPlaying,
  here: number,
  stopped: { position: number; file?: string; filePos?: number; finished: boolean },
  { finished = true }: { finished?: boolean } = {},
): TabPlace | null {
  const { offsets, total } = np.queue;
  if (stopped.finished) {
    if (!finished || (total > 0 && here >= total - FINISHED_TOLERANCE)) return null;
    return { index: 0, positionInTrack: 0, pos: 0, finished: true };
  }
  const saved = Math.max(0, total > 0 ? Math.min(stopped.position, total) : stopped.position);
  const at =
    (stopped.file !== undefined
      ? filePlaceIn(np.queue, np.libraryId, stopped.file, stopped.filePos ?? 0)
      : null) ?? locate(offsets, saved);
  const pos = toBookPosition(offsets, at.index, at.positionInTrack);
  if (!Number.isFinite(pos) || Math.abs(pos - here) <= SAME_PLACE_S) return null;
  return { ...at, pos, finished: false };
}

/**
 * The loaded book is at `place` from here (`otherTabsPlace`), as a book just loaded is at
 * its resume place: the resume floor is that place, and the next span begins there as a
 * `resume` (a `restart` with the `unfinish` owed, for a book the other tab finished). Not a
 * move of the listener's own, so no listening event says they moved (`moveListeningSpan`):
 * the server never reads the place this tab was at as chosen. The place reconcile still
 * counts it (`localMoves`): a check out meanwhile stands back.
 */
function adoptTabPlace(np: NowPlaying, place: TabPlace) {
  resumeFloor = place.pos;
  localMoves++;
  nextStart = place.finished ? 'restart' : 'resume';
  unfinishDue = place.finished && usesListeningSync(np.connectionId);
  placeChosen = false;
  if (ownPlay) ownPlay.pos = place.pos;
}

/**
 * Move the loaded book to `place`, where another tab left it (`adoptTabPlace`): the engine
 * seeks there, which the Undo jump chip sees as any jump (`jump-undo.ts`), so the way back
 * is offered. Resolves the place taken, else null; never rejects (a play that waits on it
 * goes on from where the engine is: what `adoptTabPlace` set for the place is put back, or a
 * floor at a place far ahead that the engine never reached would refuse every save and
 * span of the play that follows, `SLIP_TOLERANCE`). A seek that has not settled within
 * `TAB_MOVE_MAX_MS` is taken as refused, until it lands after all (`landTabPlaceLate`).
 */
async function moveToTabPlace(svc: PlaybackService, place: TabPlace): Promise<TabPlace | null> {
  const { nowPlaying: np, snapshot } = usePlayer.getState();
  if (!np) return null;
  const before = { resumeFloor, nextStart, unfinishDue };
  const play = ownPlay;
  const playPos = play?.pos;
  adoptTabPlace(np, place);
  const moves = localMoves;
  let seek: Promise<void> | undefined;
  const ask = askEngineTo(np, place.index, place.positionInTrack);
  try {
    seek = engineTakes(
      ask,
      Promise.resolve(
        place.index === snapshot.trackIndex
          ? svc.seekTo(place.positionInTrack)
          : svc.skipToTrack(place.index, place.positionInTrack),
      ),
    );
    await withTimeout(seek, TAB_MOVE_MAX_MS, 'the move did not settle');
    return place;
  } catch (e) {
    console.warn('[player] could not take the place another tab left', e);
    withdrawAsk(ask);
    // Not once the listener moved or another book started meanwhile: the floor is theirs.
    if (localMoves === moves) {
      resumeFloor = before.resumeFloor;
      nextStart = before.nextStart;
      unfinishDue = before.unfinishDue;
      if (play && playPos !== undefined) play.pos = playPos;
      // Given up on, not refused: the seek may still land (a refused one never does).
      void seek?.then(
        () => landTabPlaceLate(np, place, moves),
        () => undefined,
      );
    }
    return null;
  }
}

/**
 * A move to another tab's place lands after it was given up (`TAB_MOVE_MAX_MS`): the engine
 * is at that place after all, so the book is at it as a move that landed in time leaves it
 * (`adoptTabPlace`). With the floor still where the engine was, a place more than
 * `SLIP_TOLERANCE` behind it would refuse every save and span of the play, and the span
 * opened where the engine was would run on over the audio between the two places, which
 * nobody heard. So the listening begun there is dropped, as an answer's move drops it
 * (`onGaveWayAnswer`), and begins again at the place while it plays.
 *
 * Not once the listener moved, another book started or another such move began meanwhile
 * (`localMoves`, `catchingUp`: the place is theirs), nor when the engine is not at the
 * place (a queue replaced under the seek).
 */
function landTabPlaceLate(np: NowPlaying, place: TabPlace, moves: number) {
  if (localMoves !== moves || catchingUp) return;
  const { nowPlaying, snapshot, loadingBook } = usePlayer.getState();
  if (nowPlaying !== np || loadingBook) return;
  const here = toBookPosition(np.queue.offsets, snapshot.trackIndex, snapshot.position);
  if (!(Math.abs(here - place.pos) <= SAME_PLACE_S)) return;
  dropListening();
  adoptTabPlace(np, place);
  if (!isPlayingState(snapshot.state)) return;
  beginHistory();
  openListeningSpan(endAt(np, place.index, place.positionInTrack) ?? undefined);
}

/** How long a move to another tab's place is waited for (`moveToTabPlace`). A seek that
 * never settled left `catchingUp` set, and with it no span, history or save until a book
 * switch (fe#262); past this the move counts as refused (one that lands later is taken
 * then: `landTabPlaceLate`). */
const TAB_MOVE_MAX_MS = 5_000;

/** Take the place the tabs share for the loaded book, when it is another one than the
 * engine's (`otherTabsPlace`, `moveToTabPlace`). Resolves the place taken, else null. */
async function catchUpWithOtherTab(
  svc: PlaybackService,
  since: number,
  opts?: { finished?: boolean },
): Promise<TabPlace | null> {
  const place = await otherTabsPlace(since, opts).catch(() => null);
  return place ? moveToTabPlace(svc, place) : null;
}

/**
 * Run `move` (to another tab's place) in a tab whose engine may be playing: no span opens
 * and nothing is saved until it is over (`catchingUp`), then, playing, its listening (the
 * span, the history) begins at the place taken, else where the engine is. Resolves once
 * over.
 */
function moveWhilePlaying(move: () => Promise<TabPlace | null>): Promise<void> {
  const moving: Promise<void> = Promise.resolve()
    .then(move)
    .then((place) => {
      if (catchingUp !== moving) return; // a later move took over: its end opens the span
      catchingUp = null;
      const { nowPlaying: np, snapshot } = usePlayer.getState();
      if (!np || !isPlayingState(snapshot.state)) return;
      beginHistory();
      openListeningSpan(
        place ? (endAt(np, place.index, place.positionInTrack) ?? undefined) : undefined,
      );
    });
  catchingUp = moving;
  return moving;
}

/**
 * The engine began playing by itself (the OS media controls; nothing in the page was
 * pressed) in a tab another tab has played past: it moves to that tab's place as it plays,
 * and its listening begins there, not at the place it left.
 */
function catchUpPlaying(svc: PlaybackService, since: number) {
  void moveWhilePlaying(() => catchUpWithOtherTab(svc, since));
}

/**
 * The tab that gave way to this tab's play says where it stopped (`GaveWay`). This tab
 * began from the shared save, which that tab made up to 15 s before it stopped (`placeLoop`),
 * so it moves on to the place the listener really was: the listening begun at the older
 * place is dropped (its span and history: nothing is recorded for a stretch nobody chose
 * to hear twice) and begins again at the place taken, as a `resume`, with no event that
 * says the listener moved. The place is saved at once.
 *
 * The answer is to a play, whichever of its claims the other tab heard: matched on when
 * the play was asked for (`askedAt`), never on one claim's `sentAt`, which the play's next
 * move into `playing` (a buffer moments after it began) would have replaced before the
 * answer crossed back.
 *
 * Ignored: an answer to an older play than this tab's last (a press since), or one that
 * comes later than `GAVE_WAY_ANSWER_MS` after the play's first claim; another connection's
 * or another book's; while a book
 * loads; when the listener chose the place here (`placeChosen`: an explicit start, a seek
 * since); when yet another tab plays by now (this tab is behind it); a place within
 * `SAME_PLACE_S` of the one this play began at; and a finished one (the book is not started
 * again under a listener who is hearing it: the next resume reads the save).
 */
function onGaveWayAnswer(answer: GaveWay) {
  // Still moving to the shared place (`catchUpPlaying`): read against where that lands.
  if (catchingUp) {
    void catchingUp.then(() => onGaveWayAnswer(answer));
    return;
  }
  const svc = service;
  const play = ownPlay;
  const { nowPlaying: np, loadingBook } = usePlayer.getState();
  if (!svc || !play || !np || loadingBook) return;
  if (answer.askedAt !== play.askedAt || answer.connectionId !== play.connectionId) return;
  if (Date.now() - play.since > GAVE_WAY_ANSWER_MS) return;
  if (!sameBook(np, answer) || placeChosen || behindOtherTab(np)) return;
  // Against where this play began, not where it has played to since.
  const place = tabPlaceOf(np, play.pos, answer, { finished: false });
  if (!place) return;
  dropListening();
  void moveWhilePlaying(() => moveToTabPlace(svc, place)).then(() => void persist());
}

/** Forget the listening begun where the engine was (the open span, stored or not, and the
 * history's start): no event, as if it had not begun. */
function dropListening() {
  historyStart = null;
  if (!span) return;
  span = null;
  void storeOpenSpan(null);
}

/**
 * Web: a paused tab is looked at again. When another tab has played its book on since, it
 * shows that tab's place (the engine moved there, paused) instead of the one it stopped at;
 * the play that follows looks again (`toggle`). A book finished meanwhile stays where it is.
 */
export function showOtherTabsPlace(): void {
  const { snapshot, nowPlaying: np } = usePlayer.getState();
  if (!service || !np || otherTabPlayed?.connectionId !== np.connectionId) return;
  if (wantsPlayback || (snapshot.state !== 'paused' && snapshot.state !== 'ready')) return;
  void catchUpWithOtherTab(service, otherTabPlayed.since, { finished: false });
}

/** Surface an `error` if we wanted to play but haven't reached `playing` within the
 * grace - a dead/stalled stream then offers a retry instead of an endless spinner. The
 * watchdog is armed by the play/retry actions (and by a mid-playback stall's `loading`),
 * NOT by trying to interpret the native bridge's noisy resume/retry event stream - so no
 * event ordering can prevent it from firing. Idempotent: one fixed window per attempt;
 * only reaching `playing` (or a user pause/stop) cancels it. The fire test is simply
 * "not playing", so it doesn't matter what transient state the bridge left us in. Lives
 * in shared JS so iOS, Android and web behave identically. The timer is not enough on its
 * own: Android pauses JS timers while the activity is paused (see `engineTicker`), so the
 * deadline is also checked on every engine event (`checkStallDeadline`, fe#158). */
function armStallWatchdog() {
  if (stallTimer) return;
  stallDeadline = Date.now() + STALL_GRACE_MS;
  stallTimer = setTimeout(fireStallWatchdog, STALL_GRACE_MS);
}

/** An engine event arrived: fire the watchdog if its deadline passed while the JS timer
 * could not (Android with the screen off). */
function checkStallDeadline() {
  if (stallDeadline !== null && Date.now() >= stallDeadline) fireStallWatchdog();
}

function fireStallWatchdog() {
  cancelStallWatchdog();
  if (!wantsPlayback) return; // attempt abandoned (user paused/stopped)
  // A play asked from outside while the engine's book is being adopted (the car, a headset or
  // a resumption started another book): the adoption takes it as its own asked play, or gives
  // up and leaves it to this watchdog, armed again. Stopped now, it was that other book that
  // was paused, as the store's.
  if (adoptions > 0 && outsidePlay) {
    armStallWatchdog();
    return;
  }
  const { snapshot } = usePlayer.getState();
  if (snapshot.state === 'playing') {
    // We made it. An attempt begun on a book already playing (the hot-swap's load) that
    // never left `playing` (its load failed, the stream plays on) had no transition to
    // end its start window: it ends here, or a later lock-screen pause would read as
    // still connecting.
    startingPlayback = false;
    return;
  }
  // A play asked from outside of another book the service started, never adopted (its
  // adoption gave up): the engine's reports since the play was asked were that book's.
  // Nothing of the store's book was heard, so it stands where it was when the play was asked
  // (shown there, and reloaded there by a Retry) and no place is written: that one was saved
  // as it stopped, and saved again it would be dated now. Unless the listener moved the book
  // since, or its queue is another by now (the download hot-swap: the place is of the queue
  // it was read in).
  const asked = outsidePlay;
  const stood =
    asked?.other && asked.moves === localMoves && asked.np === usePlayer.getState().nowPlaying
      ? asked.snapshot
      : null;
  clearPlaybackIntent();
  if (stood) {
    const { trackIndex, position, duration } = stood;
    usePlayer.setState({
      snapshot: { ...snapshot, state: 'error', trackIndex, position, duration },
    });
    stopSaveLoop();
  } else {
    usePlayer.setState({ snapshot: { ...snapshot, state: 'error' } });
    haltAndPersist();
  }
  // The engine plays another book now (`reportedOtherBook`: the car or a resumption started it
  // while this book still loaded or stalled), with no play from outside followed: this book's
  // attempt is over, and that book plays on for the car sync to adopt. Paused here, it was the
  // car's play that stopped.
  if (!asked && engineHoldsAnother()) return;
  // The engine stops waiting to play too: left buffering, it would start on its own once the
  // server answered again, with the listener told playback had stopped. Only a press (Retry,
  // play, the car, a headset) plays from here. Its report of the pause is held by the error,
  // and so is a `playing` it sent before the pause reached it (`stallPauseUntil`).
  stallPauseUntil = Date.now() + STALL_PAUSE_FENCE_MS;
  void service?.pause().catch(() => undefined);
}

/**
 * The engine was asked to play (Android: its playWhenReady turned on), told before the state
 * that comes with it. One the store asked for is already followed (`wantsPlayback`). One from
 * outside the app (the car, a headset, the notification) after playback stopped in `error` is
 * followed from here like a press in the app: `loading`, the stall watchdog, and `error`
 * ("Playback stopped") with the engine paused again when it never plays. Unfollowed, its
 * `loading` was held by the error, so it could hang with nothing said, or start whenever the
 * server answered. Not while a start of the store's is on its way (it owns the next play), nor
 * for a faulted engine (stopped again as it plays) or a book whose place could not be looked up
 * (its engine holds nothing of it). A play of another book the service started (Android: the
 * car, a resumption) is adopted as that book's asked play (the car sync's `checkLoadedBook`),
 * and this attempt's watchdog never stops it while the adoption is under way. Until that
 * adoption lands the engine's reports are held (`engineIsAnothers`), and one that is never
 * adopted is stopped by the watchdog, the store's book where it stood and nothing saved.
 */
function playAskedFromOutside() {
  if (wantsPlayback || startsInFlight > 0 || resumeLookupFailed || loadedFaulted()) return;
  const { snapshot, nowPlaying, loadingBook } = usePlayer.getState();
  if (snapshot.state !== 'error' || !nowPlaying || loadingBook) return;
  beginPlaybackAttempt();
  outsidePlay = { np: nowPlaying, snapshot, moves: localMoves, other: false };
}

/** Begin a playback attempt: we intend to play, we're "connecting" until the engine
 * reaches `playing`, and the stall watchdog is ticking from now (a dead/slow-to-start
 * stream surfaces an error after the grace, matching the old native behavior). */
function beginPlaybackAttempt() {
  // A play of its own from here: what the engine reports next is of it, not of a stalled
  // attempt's pause.
  stallPauseUntil = 0;
  outsidePlay = null;
  playAttempts++;
  playAskedAt = Date.now();
  wantsPlayback = true;
  startingPlayback = true;
  armStallWatchdog();
}

function cancelStallWatchdog() {
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
  stallDeadline = null;
}

/** Abandon the playback attempt/intent - the inverse of `beginPlaybackAttempt`. Shared
 * by every path that settles into not-playing (user pause/stop, the engine's terminal
 * states, the watchdog firing, a failed resume lookup) so no site can forget a piece
 * of the intent state. */
function clearPlaybackIntent() {
  wantsPlayback = false;
  startingPlayback = false;
  outsidePlay = null;
  cancelStallWatchdog();
}

/** Start the engine. The browser's autoplay refusal (web, no user gesture yet: a cold
 * `/player` deep link) is a plain pause, not a failure: drop the intent (so the stall
 * watchdog never turns it into `error`) and settle on `paused`, so the play button comes
 * back and a press (the gesture it wanted) plays. Every other failure rejects as a
 * `PlaybackStartError` saying why (`startFailure`).
 *
 * Not started at all (false) when this tab gave way to another tab's play since the play
 * was asked for (`giveWayTo`, while a start or a Retry was loading): loaded here, played
 * there. Played regardless, the engine's `playing` would read as a new play nobody asked
 * for and take the connection back from the newer tab.
 *
 * Nor played when its engine faulted while it loaded (`engineFault`): the error stands, and the
 * start goes on as one that played (true), so the error is what the listener sees. */
async function startEngine(svc: PlaybackService): Promise<boolean> {
  if (yieldedAttempt === playAttempts) return false;
  if (loadedFaulted()) return true;
  try {
    await svc.play();
  } catch (err) {
    if (!(err instanceof AutoplayBlockedError)) throw startFailure(err);
    clearPlaybackIntent();
    const { snapshot } = usePlayer.getState();
    usePlayer.setState({ snapshot: { ...snapshot, state: 'paused' } });
  }
  return true;
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
  // Not from a place on its way to another tab's, as no span opens from one
  // (`openListeningSpan`): the listening begins where the move lands (`moveWhilePlaying`).
  if (catchingUp) return;
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
  if (!start || Date.now() - start.at < MIN_HISTORY_MS) return;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np) return;
  // A switch takes the next book's client before that book is `nowPlaying` (`switchBook`), as
  // `persist` reads it: a span of the book still named goes to its own server, also when the
  // next book has no client (a download whose connection is gone).
  const api =
    apiRefFor !== null && apiRefFor !== np.connectionId ? resolveClient(np.connectionId) : apiRef;
  if (!api) return;
  // Listening spans are best-effort; don't fire at a server we know is unreachable
  // (reachability is per-connection, so key it on the playing book's own server).
  if (!isReachable(np.connectionId)) return;
  // A server taking listening events has them already (the spans above), when it took
  // them from the listening's start (`tickListeningSpan` ends a PUT path's history where a
  // span opens) and still does (not rolled back since).
  if (start.sync && usesListeningSync(np.connectionId)) return;
  void api
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
 * and its periodic save loop stopped (otherwise its tick, or the engine's continued ticks
 * after an early return, would map the OLD engine position through the NEW book's queue and
 * persist it under the new book's path, corrupting its progress; the loop restarts on the
 * engine's next `playing` transition for the new book), counted as the listener's own move,
 * and the new book's server (null for a downloaded book whose connection is gone: history
 * is then a no-op, and persist saves nothing until the connection is back) and retry
 * request taken.
 */
function switchBook(api: ApiClient | null, request: PlayRequest) {
  endHistory();
  closeListeningSpan();
  // The next book's first span begins as its start says (`playBook`), an adopted one's as a
  // resume.
  nextStart = 'resume';
  unfinishDue = false;
  movedTo = null;
  cancelStallWatchdog();
  cancelOtherBookDeadline();
  stopSaveLoop();
  userMoved();
  // A move to another tab's place still out was the previous book's: its end opens no span
  // of this one's (`moveWhilePlaying`), and holds none of its saves.
  catchingUp = null;
  // The play another tab made before this book was here is noted again as it goes on.
  notedPlay = null;
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
  // A report of a book the store does not hold, by its name (`reportedOtherBook`) or because
  // its adoption is under way (`engineIsAnothers`): none is the store's book's place, state,
  // move or speed. Read inside the service's listeners only: `reportedBook` is the book of
  // the report being handled.
  const heldForAnother = () => engineIsAnothers() || engineHoldsAnother();
  // A report held for another book: the watchdog still runs (re-armed while an adoption is
  // under way), and the adoption reads the engine itself when it lands.
  const holdReport = () => {
    checkStallDeadline();
    engineTick();
  };
  const onReport = (raw: PlaybackSnapshot) => {
    // Another book's report (`reportedOtherBook`): before the fault's stop below, as an
    // engine the car gave another book to plays that book.
    const other = reportedOtherBook(svc);
    if (other !== null) {
      otherBookReported(other, raw);
      holdReport();
      return;
    }
    otherReport = null;
    // The store's own book is heard again: the other book's adoption deadline is over, and a
    // later report of another book runs a whole one of its own.
    if (otherBookShown) cancelOtherBookDeadline();
    // Collapse the native bridge's noisy resume/retry event stream to a spinner. While
    // starting (after a play/retry, before we reach `playing`), the only real outcomes
    // are `playing` (success) and `error` (the watchdog gave up); every transient the
    // bridge emits while rebuilding the queue - `ready`, `paused`, `idle`, `ended`,
    // `loading` - is "still connecting" → `loading`. This is what makes the spinner and
    // watchdog robust regardless of event ordering (the spurious `paused` used to clear
    // intent and strand the spinner). A genuine user/lock-screen pause arrives AFTER
    // `playing` (startingPlayback already false), so it stays `paused`. Outside a fresh
    // start, a `ready` while intending to play is also a spinner.
    // A faulted engine (`engineFault`) is not heard from until the store asks it for a place
    // again (`askEngineTo`: a Retry, or a press, which reloads). A play it goes on with until
    // the fault's pause lands is stopped again; one after it landed is the listener's own (the
    // lock screen, a headset, the car), which reloads the book at its place, as a press does.
    if (loadedFaulted()) {
      if (raw.state !== 'playing') {
        if (stoppedState(raw.state)) faultPause.stopped = true;
        return;
      }
      void svc.pause().catch(() => undefined);
      if (faultPause.resolved && faultPause.stopped) {
        faultPause = { resolved: false, stopped: false };
        void usePlayer
          .getState()
          .retry()
          .catch((err: unknown) => console.warn('[player] could not reload the book', err));
      }
      return;
    }
    // Another book's reports, until it is adopted or its play is over (`engineIsAnothers`):
    // the watchdog ends one that gave up.
    if (engineIsAnothers()) {
      holdReport();
      return;
    }
    let state = raw.state;
    // The end of a download that lacks the rest of its book (an adoption offline, D3, fe#185)
    // is a pause there with a notice, never the book's end: no credits, no finish.
    const partialEnd = state === 'ended' && endsPartial(usePlayer.getState().nowPlaying);
    atPartialEnd = partialEnd;
    if (partialEnd) state = 'paused';
    else if (startingPlayback && state !== 'playing' && state !== 'error') state = 'loading';
    else if (state === 'ready' && wantsPlayback) state = 'loading';
    // When we're NOT intending to play (no attempt in flight), an engine `loading`
    // is not "connecting" - it's a stalled/failed item we have no watchdog for
    // (the watchdog only arms while wantsPlayback). iOS reports a failed item as
    // `loading` even while the user has the book paused; left as `loading` it would
    // strand an endless spinner with no retry. Read it as `paused` so the play
    // button comes back (tapping it starts a fresh attempt, which the watchdog covers).
    else if (state === 'loading' && !wantsPlayback && !startingPlayback) state = 'paused';
    const reported: PlaybackSnapshot = state === raw.state ? raw : { ...raw, state };
    const prev = usePlayer.getState().snapshot;
    // The watchdog's pause reached the engine (iOS, the web: it reports itself paused, after
    // whatever it sent before the pause): a `playing` from here is a new play (the car, a
    // headset), never an older report, so the fence below ends. Not on Android, whose pause of
    // a buffering engine reads `loading`: its engine says so itself (`onPauseAsked`).
    if (stallPauseUntil > 0 && raw.state === 'paused' && Platform.OS !== 'android') {
      stallPauseUntil = 0;
    }
    // After the stall watchdog (or an engine error) surfaces an `error`, the engine
    // keeps re-reporting around the dead stream - iOS: frozen `onProgress` ticks
    // carrying `loading`; Android: `onPlayerError` then `STATE_IDLE` → `idle`, plus its
    // own progress ticks. Any of those would overwrite the `error` and drop the UI back
    // to a spinner/play button (the flash→spinner loop seen on Android). So once we're
    // in `error` and NOT retrying, hold it against EVERY re-report except a genuine
    // recovery (`playing`). It's released by the user retrying (wantsPlayback flips true
    // → this guard is skipped) or a play from outside the app (the lock screen, the car, a
    // headset), never by the stream coming back on its own: the watchdog pauses the engine,
    // and a failed Android engine stays idle until a press. Enumerating the "noisy"
    // states bit us repeatedly (loading, ready, idle, paused…); suppress-all-but-playing
    // is the robust rule. A move made meanwhile shows its own place (`reportsUnheard`).
    if (errorHeld() && reported.state !== 'playing') {
      return;
    }
    // Nor a `playing` sent just before the watchdog's pause reached the engine: the pause
    // wins, and is asked again (a play pressed outside the app in that moment, on an engine
    // that does not say so, `onPlayAsked`, is pressed again).
    if (reported.state === 'playing' && !wantsPlayback && Date.now() < stallPauseUntil) {
      void svc.pause().catch(() => undefined);
      return;
    }
    let snapshot = throughSwap(reported, prev);
    // The file's length is the server's where the engine measured it short, and an engine that
    // went where the book is not stops there as an error (`engineFault`). Not for a report
    // while a load holds the store: that is still the previous book's.
    const { nowPlaying: np, loadingBook } = usePlayer.getState();
    if (np && !loadingBook) {
      // The engine's own length of the file, for a reload's check (`retry`). Not from the first
      // report of another file, which a service may send before the engine told that file's
      // length (the native one tells a file change with none, `NativePlaybackService.update`,
      // so no later report before the file's first tick keeps the old file's either), nor a
      // place the hot-swap could not map, which keeps the store's.
      // Nor while a move of the store's is out: a load is told with the server's length before
      // the engine measured anything (a clamp it took is noted with its fault, `engineFault`).
      const moving = askedPlace?.np === np && !askedPlace.landed;
      if (
        !moving &&
        snapshot.trackIndex === prev.trackIndex &&
        snapshot.duration === reported.duration
      ) {
        noteEngineLength(np, snapshot.trackIndex, snapshot.duration);
      }
      const fault = engineFault(np, snapshot, prev, raw.state === 'ended' && !partialEnd);
      if (fault === 'hold') {
        holdFault(raw);
        checkStallDeadline();
        engineTick();
        return;
      }
      if (fault) {
        const pause = { resolved: false, stopped: stoppedState(raw.state) };
        faultPause = pause;
        void svc.pause().then(
          () => {
            pause.resolved = true;
          },
          () => undefined,
        );
        snapshot = fault;
      } else {
        const duration = fileDurationOf(np.queue, snapshot.trackIndex, snapshot.duration);
        if (duration !== snapshot.duration) snapshot = { ...snapshot, duration };
      }
    }
    usePlayer.setState({ snapshot });
    // Reached online (the network came back while it played): it plays on, streaming the
    // rest, when its server answers; else the listener is told.
    if (partialEnd && prev.state !== 'paused') {
      const cid = usePlayer.getState().nowPlaying?.connectionId ?? '';
      if (isDeviceOnline() && isReachable(cid) && resolveClient(cid)) {
        void playOnPastPart(false).then((on) => {
          if (!on) tellPartialEnd();
        });
      } else {
        tellPartialEnd();
      }
    }
    // Listening spans use the STRICT reading (see `isPlayingState`): a span must cover
    // audio the listener actually heard, so a buffer is not the start of one.
    if (isPlayingState(snapshot.state) && !isPlayingState(prev.state)) {
      // A play nobody asked for here (the OS media controls start the engine themselves) is
      // asked for now. Claimed before its span opens: a tab that gives way ends its span
      // at the claim, so the two never cover the same time.
      const byItself = !wantsPlayback;
      if (byItself) playAskedAt = Date.now();
      // A press took the other tab's place before it played (`toggle`, `retry`); a play
      // that began by itself takes it now, and its listening begins there.
      const behind = byItself ? otherTabPlayed : null;
      claimPlaying();
      if (behind && behind.connectionId === usePlayer.getState().nowPlaying?.connectionId) {
        catchUpPlaying(svc, behind.since);
      } else {
        // Neither begins while a move to another tab's place is out (this play buffered and
        // came back during it): the listening begins where the move lands
        // (`moveWhilePlaying`).
        beginHistory();
        openListeningSpan();
      }
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
    // actually playing, so we don't keep re-saving the same position every period
    // after pause/stop/end - including a lock-screen pause or a book that simply
    // finishes, neither of which calls stop().
    if (snapshot.state !== prev.state) {
      // A lock-screen play/pause arrives here (the engine state), not through the store
      // actions - so keep intent + the start window in sync with it.
      if (snapshot.state === 'playing') {
        // Reached playback - the stream is alive and we're no longer "connecting".
        wantsPlayback = true;
        startingPlayback = false;
        outsidePlay = null;
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
        // state list - that list kept coming up short (an unhandled `idle` left the
        // save loop re-persisting the same position forever); like the error hold above,
        // anything that isn't `playing`/`loading` settles playback.
        pausedAt ??= Date.now();
        clearPlaybackIntent();
        haltAndPersist();
      }
    }
    // The engine's events drive the periodic work (the save, the sleep timer, the stall
    // watchdog) where Android has paused the JS timers: see `engineTicker`.
    checkStallDeadline();
    engineTick();
  };
  // A run into a later file waits for the listener's own move (`EngineAsk.held`): `raw`, the
  // latest report, decides it once the wait is over and no other report came.
  const holdFault = (raw: PlaybackSnapshot) => {
    const ask = askedPlace;
    const held = ask?.held;
    if (!ask || !held) return;
    held.report = raw;
    // Armed afresh on each report: a later one may have moved `until` out.
    if (held.timer) clearTimeout(held.timer);
    held.timer = setTimeout(
      () => {
        if (askedPlace !== ask || ask.held !== held) return;
        if (usePlayer.getState().nowPlaying !== ask.np) return;
        held.due = true;
        onReport(held.report);
      },
      Math.max(0, held.until - Date.now()),
    );
  };
  svc.subscribe(onReport);
  // The OS media controls' seeks (web Media Session) go through the store's own seek,
  // so a lock-screen scrub back lowers the resume floor and saves like any other seek.
  svc.onRemoteSeek?.((positionInTrack) =>
    quietly(usePlayer.getState().seekInTrack(positionInTrack)),
  );
  // Native: the engine already moved for the lock screen, a headset or the car (its
  // snapshot holds the landed place once this returns: `service.native.ts`; the Cast
  // receiver's moves come the same way, `cast-service.ts`). That is the
  // listener's own move: it lowers the floor (a scrub back past the slip tolerance would
  // otherwise never save) and counts for the place reconcile, which then stands back.
  svc.onRemoteMove?.((trackIndex, positionInTrack, checkpoint) => {
    const { nowPlaying: np, loadingBook } = usePlayer.getState();
    // A move reported while a book loads is the PREVIOUS queue's (a native move reported a
    // moment late): mapped through the new book's queue it would lower its floor to, and
    // save, a place that book never had. So is one at the download's index while the
    // hot-swap moves the playing file (`swapHold`).
    // And so is a move of another book the engine holds (`heldForAnother`).
    if (loadingBook || heldForAnother() || (np && heldBySwap(np, trackIndex))) return;
    // A checkpoint is no move, only the engine's place (Cast, as iOS suspends the app): a
    // faulted engine's, or one in a later file held as a run off the asked one, is not the
    // book's place, and the fault stands.
    if (checkpoint && (loadedFaulted() || askedPlace?.held)) return;
    // The listener's own move: no ask of the store's stands (`askedPlace`), and a run into a
    // later file held for it was this move.
    setAsk(null);
    // A faulted engine's reports, or an errored book's, are not heard (`reportsUnheard`): the
    // move's place is the one the book shows, so a Retry or a press reloads there, not at the
    // place the error was at. Not a checkpoint's, which is no move: an errored book keeps its
    // place (a faulted one's never gets here).
    if (np && !checkpoint && reportsUnheard()) {
      showPlace(np, trackIndex, positionInTrack, loadedFaulted());
    }
    userMoved(np ? toBookPosition(np.queue.offsets, trackIndex, positionInTrack) : undefined);
    // The engine has moved already: the span ends where it was last seen (paused, where it
    // was is not known, so no move is taken for one that moves nowhere).
    if (np) moveListeningSpan(endAt(np, trackIndex, positionInTrack), { from: span?.to ?? null });
    // The engine tells the move before its landed place reaches the snapshot (so no
    // save, cut or keep in between ends the span there, fe#211): the save waits for it.
    void Promise.resolve().then(() => persist());
  });
  // Native: a place the engine held back for its move landed with none told, after playing
  // stopped (fe#211). The save made as it stopped (`haltAndPersist`) has the place before
  // the jump, so the place is saved again, once the engine's event is over.
  // Not another book's tick (`heldForAnother`): nothing of this book moved.
  svc.onLanded?.(() => {
    if (!heldForAnother()) void Promise.resolve().then(() => persist());
  });
  // Native (Android): a play asked of the engine from outside the app is followed as a press.
  svc.onPlayAsked?.(playAskedFromOutside);
  // The route switch loaded the book into the phone's engine by itself (a Cast session ended,
  // or the book can't be cast): an engine move like the store's own, so it is asked for too,
  // and a file that engine measured short can't run off it unseen. Not a faulted book's (its
  // fault stands: a press reloads it), nor while a start holds the store.
  svc.onOwnLoad?.((trackIndex, positionInTrack, loaded) => {
    const { nowPlaying: np, loadingBook } = usePlayer.getState();
    if (!np || loadingBook || loadedFaulted()) return;
    void engineTakes(askEngineTo(np, trackIndex, positionInTrack), loaded).catch(() => undefined);
  });
  // Native (Android): the engine stopped wanting to play, so the watchdog's pause has reached
  // it: a `playing` from here is a new play (a car or headset play the engine did not tell
  // of), never a report from before the pause.
  svc.onPauseAsked?.(() => {
    stallPauseUntil = 0;
  });
  // Native: the OS changed the speed and the engine already runs at it. Only a speed
  // outside the app's range goes back to the engine, clamped.
  svc.onRateChange?.((raw) => {
    // Another book's speed, read with that book when it is adopted (`heldForAnother`).
    if (heldForAnother()) return;
    const rate = clampRate(raw);
    usePlayer.setState({ rate });
    if (rate !== raw) void svc.setRate(rate);
    cutListeningSpan();
    void persist();
  });
  // Smart Speed's running total, counted on the playing book (`time-saved.ts`). Another book's
  // tick (`heldForAnother`) moves the total on and counts on none: it is not the store's book.
  svc.onSilenceSaved?.((total) =>
    noteSilenceSaved(total, heldForAnother() ? null : selectBookKey(usePlayer.getState())),
  );
  // Web: another tab began playing (`playing-claim.ts`). Nothing is heard off the web.
  tabClaims().subscribe(giveWayTo, onGaveWayAnswer);
  service = svc;
  // Expose whether this platform/engine can show an audio-route picker so the player
  // can decide whether to render the cast button (web: only where the APIs exist).
  usePlayer.setState({ canRoutePick: svc.canShowRoutePicker?.() ?? false });
  return svc;
}

const playerStore = createStore<PlayerState>()((set, get) => ({
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
    wanted,
    superseded,
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
    // Whether this start put its book in the engine, at its place (`swapDue`).
    let placed = false;
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
      // save loop (up to a minute unsent, 15 s unsaved here), and once this book is
      // `nowPlaying` nothing saves it again. Here, not in `switchBook`: the engine still
      // holds the previous book (an adoption's engine already plays another, so its snapshot
      // is not that book's).
      void persist();
      const request = { connectionId, libraryId, book, chapterData };
      switchBook(api, request);
      // Called off (a car play its native side gave up on) with another start made since
      // (the play that took its place, the listener's own tap), or for a play native made in
      // its place (`superseded`: the car's tap on the loaded book, fe#350): that one owns the
      // player, so this one loads nothing over it (the car takes the engine's book back). Called
      // off with the player still its own (its wait ran out), it goes on to load, paused
      // (below): the previous book's saves and span already ended above.
      const replaced = () =>
        (!!wanted && !wanted() && lastPlayRequest !== request) || !!superseded?.();
      // Marked finished while it started (`leaveFinishedBook`): it loads nothing, and the
      // engine is left with nothing (the previous book's place and span ended above), so the
      // book just finished is never heard, nor left loaded.
      const markedFinished = () => finishedStart === request;
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
      // the manifest does not (`adoptStartedChapters`). So does one that ends before its book
      // (`endsBefore`, D3, fe#185) started with the device offline, whatever chapters it was
      // given (a cold start's cached server chapters name the files it lacks): a queue
      // streaming those would stall into a stream error at the downloaded part's end instead
      // of pausing there. So does one with no server to stream from: no client (its token
      // gone this launch) or one marked unreachable (a LAN server from the car's mobile
      // data). Online it streams on.
      const offlineShort =
        !!local &&
        !!dl?.manifest.endsBefore &&
        (!api || !isDeviceOnline() || !isReachable(connectionId));
      const own = dl && (!chapterData || offlineShort) ? dl.manifest : undefined;
      const queueChapters = own ? (own.chapters ?? undefined) : chapterData;
      const queue = buildBookQueue(
        api,
        libraryId,
        own ? { ...book, files: own.book.files, chapters: own.book.chapters } : book,
        queueChapters,
        local,
        useSettings.getState().virtualChapterInterval,
        transcode,
      );
      // A download that ends before its book does (`endsBefore`, D3, fe#185), played without
      // the rest (offline, from the download's own copy): its end is a pause, as an adopted
      // one's (`partialQueues`). A queue streaming the rest from the server holds that file.
      const endsBefore = local ? dl?.manifest.endsBefore : undefined;
      if (endsBefore && trackIndexById(queue, trackIdOf(libraryId, endsBefore)) < 0) {
        partialQueues.set(queue, serverLengthOf(dl?.manifest, chapterData));
      }
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
      // The replay guard (fe#198): set below when the resume could not be checked.
      let unchecked = false;
      // The server's place still to come for a downloaded book that stopped waiting for it.
      let late: Promise<LatePlace | null> | undefined;
      if (startBookPosition === undefined && startTrack === undefined) {
        // A downloaded book never waits long on its server: not asked at all when it is known
        // to be unreachable, else for `DOWNLOADED_PLACE_WAIT_MS` (a frozen server held a car's
        // start for the whole request timeout, and the car gave up on it). Started from this
        // device's records, as offline: its saves go guarded (`unchecked`, fe#198). A server
        // that answers later is followed once the book is loaded (`followLatePlace`).
        const placeApi = dl && (!isDeviceOnline() || !isReachable(connectionId)) ? null : api;
        const r = await loadInitialProgress(
          placeApi,
          connectionId,
          libraryId,
          book.rel_path,
          dl ? DOWNLOADED_PLACE_WAIT_MS : undefined,
        );
        if (!current() || replaced()) return;
        if (markedFinished()) return await callOff(svc, request);
        late = r.late;
        // Not reached (a downloaded book's 'failed' starts at 0), or resumed behind it.
        unchecked = r.kind === 'failed' || (r.kind === 'progress' && !!r.unchecked);
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
            startFile = filePlaceIn(queue, libraryId, r.file.path, r.file.pos);
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
        // The server's own row, also when the page showed this device's newer place (a
        // record of this device's reads as version 0, and would acknowledge nothing).
        if (known.row && known.row.version > 0 && usesListeningSync(connectionId)) {
          await ackVersion(
            connectionId,
            libraryId,
            book.rel_path,
            known.row.version,
            known.row,
          ).catch(() => undefined);
        }
      }

      if (!current() || replaced()) return;
      if (markedFinished()) return await callOff(svc, request);
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
      // An explicit place is the listener's own: unguarded, like a resume checked against
      // the server.
      placeGuard = unchecked ? guardFor(key) : null;
      nextStart = start;
      // A resume is the place the book was left at; an explicit place is the listener's own.
      placeChosen = startBookPosition !== undefined || startTrack !== undefined;
      unfinishDue = unfinish && usesListeningSync(connectionId);
      finishSent = null;
      restoreOutputGain(svc); // only now can the old book's fade no longer write over it
      beginPlaybackAttempt(); // intent + start window + watchdog armed from here
      const ask = askEngineTo(nowPlaying, index, positionInTrack);
      // Called off already (a car play its native side gave up on while its place was looked
      // up): the engine is set not to play before the load, so the book is never heard for a
      // moment. One called off during the load is paused after it (below). A failed pause
      // never skips the load: its `finally` is what releases `loadingBook`.
      if (wanted && !wanted()) await svc.pause().catch(() => undefined);
      try {
        await engineTakes(
          ask,
          svc.load(queue.tracks, index, positionInTrack, queue.chapterClips, bookRefOf(nowPlaying)),
        );
      } catch (err) {
        // Nothing plays: the book shows the place its start asked for, where a Retry loads it
        // (`resumeFloor`), in its error state at once. Never the snapshot it had, which is
        // another book's place, or Part 1 at 0:00 for the first book since the app opened.
        // Not once another start took the player (a chapter tap of this same book): its intent
        // and its place stand.
        if (current() && get().nowPlaying === nowPlaying) {
          clearPlaybackIntent();
          set({
            snapshot: {
              ...get().snapshot,
              state: 'error',
              trackIndex: index,
              position: positionInTrack,
              duration: fileDurationOf(queue, index, 0),
            },
          });
        }
        throw err;
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
      // owns the engine now, so this one neither sets its speed nor plays. Unloaded while it
      // loaded instead (`stop`, a Mark as finished: `leaveFinishedBook`), with nothing loaded
      // since: their reset came before this load landed in the engine, which would otherwise
      // stay loaded with the book, so it is reset again.
      if (selectBookKey(get()) !== key) {
        if (!get().nowPlaying) await svc.reset();
        return;
      }
      placed = true;
      // The engine holds this book at its place now: a place its server answers with later
      // (another device's, newer) is moved to or offered from here.
      if (late) followLatePlace(late, key);
      // A download that landed before this book was the store's (while its place was looked
      // up) was seen by nothing: the book streams, and is swapped in as this start ends.
      if (!dl && downloadedEntryOf(ref)) swapDue = key;
      // The engine holds the queue built from these chapters now: a download takes them,
      // with a new file order when its server re-ordered the files (`adoptStartedChapters`).
      if (dl && queueChapters) adoptStartedChapters(ref, queueChapters);
      await svc.setRate(speed);
      if (!current()) return;
      // Unloaded while its speed was set (`stop`, a Mark as finished: their reset came after
      // this load), or another book started: not played on the engine they reset.
      if (selectBookKey(get()) !== key) return;
      // Called off while it was looked up or loaded (a car play its native side gave up on):
      // loaded, never played. Android had released that start's foreground service, so a
      // play now would be heard with no notification and no controls. Paused outright: the
      // engine may still be set to play, so the load alone would start it (the module's
      // `stop` keeps playWhenReady from the queue it replaced, and Media3 presses play on the
      // empty player when a resumption it waited on fails).
      if (wanted && !wanted()) {
        clearPlaybackIntent();
        await svc.pause();
        return;
      }
      // False: gave way to another tab while it loaded (`giveWayTo`).
      if (!(await startEngine(svc))) return;
      // The save loop is started by the engine 'playing' transition (see subscribe).
      void flushQueue();
      // Fire-and-forget AFTER playback is initiated (never before/awaited, so it can't delay
      // or break starting the book): download the book we just started, if the user opted in.
      void maybeAutoDownloadCurrent(connectionId, libraryId, book, chapterData);
    } finally {
      startsInFlight--;
      // The book's download landed meanwhile: it is swapped in now, from the place this
      // start put it at, or not at all when the start placed nothing (a failed load, a
      // failed resume lookup: the snapshot is not this book's place).
      if (!placed && swapDue === contentKey(connectionId, libraryId, book.rel_path)) {
        swapDue = null;
      }
      runDueSwap();
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
      if (playingOn) playOnStopped = true;
      // Before the engine is asked: its `paused` is then no transition (nothing to save).
      if (pickUpWait) settlePickUpWaitPaused();
      await svc.pause();
    } else {
      // At the end of a partial download (D3, fe#185) nothing plays: the engine, ended,
      // reports no `playing`, and the stall watchdog would call the attempt an error. The
      // listener is told again instead.
      // Online again since the queue was built offline, it plays on, streaming the rest.
      if (atPartialEnd && endsPartial(get().nowPlaying)) {
        if (!(await playOnPastPart(true))) tellPartialEnd();
        return;
      }
      // A faulted engine is never just resumed (it sits where the book is not), nor one in
      // error (a dead stream; or the engine took a move clamped at its short measure, and
      // the book shows the place asked for, `showPlace`), nor one that plays another book
      // (the car's, never adopted: `otherBookNotAdopted`), whose play would be that book's:
      // the press reloads the book at its place, as Retry does.
      if (loadedFaulted() || st === 'error' || engineHoldsAnother()) {
        await get().retry();
        return;
      }
      beginPlaybackAttempt();
      // Another tab played on meanwhile: from where it left the book, when it is this one.
      const behind = otherTabPlayed;
      if (behind && behind.connectionId === get().nowPlaying?.connectionId) {
        const attempt = playAttempts;
        await catchUpWithOtherTab(svc, behind.since);
        // Paused, or pressed again, while that was read: the later press stands.
        if (attempt !== playAttempts || !wantsPlayback) return;
      } else if (await pickUpBeforePlay()) {
        return;
      }
      await startLoadedEngine(svc);
    }
  },

  pause: async () => {
    clearPlaybackIntent();
    if (playingOn) playOnStopped = true;
    const svc = await ensureService();
    // Also pause while still `loading`: an in-flight start would otherwise resolve
    // to `playing` and silently defeat the pause (e.g. the sleep timer firing while
    // the stream is buffering). The engine pause is idempotent in either state.
    const st = get().snapshot.state;
    if (pickUpWait) settlePickUpWaitPaused();
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
    const asked = get().nowPlaying;
    if (!asked) return;
    // A place the engine can't play (past its own measure of the file, `pastMeasure`): it would
    // clamp there and run on into the next file, heard before its fault stops it. The book stays
    // in error at its place, nothing played, until the listener moves it back. Not when a
    // download of the book landed meanwhile (the reload would be of its files, another
    // engine's measure), nor where another tab played it on (`otherTabPlayed`, read below).
    if (stuckPastMeasure(asked)) {
      clearPlaybackIntent();
      // Faulted: a play the engine makes by itself is paused again (and asks this again), as
      // the engine sits paused at its measure; its pause, if one is out, is of no play of ours.
      markFaulted(asked, false);
      const { snapshot } = get();
      if (snapshot.state !== 'error') set({ snapshot: { ...snapshot, state: 'error' } });
      return;
    }
    // Rebuild the engine's items from the known-good book position so a failed/
    // unreachable stream is re-requested (a dead AVPlayerItem can't recover via
    // play() alone), then resume. Never reload below the resume floor, so a transient
    // bad 0 in the snapshot can't be re-loaded. The watchdog is armed from here, so
    // even if the reload's event stream is noisy it still surfaces an error if it
    // never plays.
    beginPlaybackAttempt();
    const svc = await ensureService();
    // Reloaded where another tab left the book, when one played it on meanwhile.
    const behind = otherTabPlayed;
    const place =
      behind && behind.connectionId === asked.connectionId
        ? await otherTabsPlace(behind.since).catch(() => null)
        : null;
    // The book as it stands after those awaits: a hot-swap that landed meanwhile replaced it
    // (its queue is the one to reload), and a stop or another book leaves nothing to retry.
    const np = get().nowPlaying;
    if (!np || !sameBook(np, asked)) return;
    if (place) adoptTabPlace(np, place);
    let at: { index: number; positionInTrack: number } = place ?? reloadPlace(np);
    let loaded = np;
    // A download of this book that landed while it failed, one the hot-swap could not take
    // (a dead stream refuses a gapless swap): the reload is of the download's files, at
    // the same file and place in it (fe#278). The same press otherwise: the floor, the
    // place another tab left, and the pick-up check of a book left for long all stand. In
    // whatever order the download plays: nothing is playing for a new order to cut into.
    // Not while a load holds the store, whose place is not this book's yet (`loadingBook`).
    const onto =
      !get().loadingBook && startsInFlight === 0 && streamsDownloadedFile(np)
        ? localSwapOf(np, { trackIndex: at.index, position: at.positionInTrack }, true)
        : null;
    // A book another tab finished starts again from its start, which in another order is
    // not where its first file is (the floor stays 0: `adoptTabPlace`).
    const local =
      onto && place?.finished ? { ...onto, index: 0, positionInTrack: 0, shift: 0 } : onto;
    const moved = local && commitLocalSwap(np, local);
    if (moved) {
      loaded = moved;
      at = local;
    }
    await engineMove(loaded, at.index, at.positionInTrack, () =>
      svc.load(
        loaded.queue.tracks,
        at.index,
        at.positionInTrack,
        loaded.queue.chapterClips,
        bookRefOf(loaded),
      ),
    );
    await svc.setRate(get().rate);
    await startLoadedEngine(svc);
  },

  seekBook: async (bookPosition, track) => {
    const np = get().nowPlaying;
    if (!np || !Number.isFinite(bookPosition)) return;
    const clamped =
      np.queue.total > 0
        ? Math.max(0, Math.min(bookPosition, np.queue.total))
        : Math.max(0, bookPosition);
    const svc = await ensureService();
    const target = locate(np.queue.offsets, clamped, track ?? get().snapshot.trackIndex);
    moveListeningSpan(endAt(np, target.index, target.positionInTrack));
    userMoved(clamped); // a deliberate user seek may legitimately move backward
    // A faulted engine sits in another file than the snapshot's (`engineFault`): it is put in
    // the target's by its index, never sought within whatever file it is in. So is one in
    // error: a failed item may never settle a seek (iOS), while a rebuild settles at once.
    const unheard = reportsUnheard();
    await listenerMove(np, target.index, target.positionInTrack, () =>
      target.index === get().snapshot.trackIndex && !unheard
        ? svc.seekTo(target.positionInTrack)
        : svc.skipToTrack(target.index, target.positionInTrack),
    );
    void persist();
  },

  seekInTrack: async (positionInTrack) => {
    if (!Number.isFinite(positionInTrack)) return;
    const dur = get().snapshot.duration;
    const pos = Math.max(0, dur > 0 ? Math.min(positionInTrack, dur) : positionInTrack);
    const svc = await ensureService();
    const np = get().nowPlaying;
    const { trackIndex } = get().snapshot;
    if (np) moveListeningSpan(endAt(np, trackIndex, pos));
    userMoved(np ? toBookPosition(np.queue.offsets, trackIndex, pos) : undefined);
    // A faulted engine sits in another file than the snapshot's (`engineFault`): put in it.
    // So is one in error, rebuilt (`seekBook`).
    const unheard = reportsUnheard();
    await listenerMove(np, trackIndex, pos, () =>
      unheard ? svc.skipToTrack(trackIndex, pos) : svc.seekTo(pos),
    );
    void persist();
  },

  goToTrack: async (index) => {
    const np = get().nowPlaying;
    if (!np) return;
    const i = Math.max(0, Math.min(index, np.queue.tracks.length - 1));
    const svc = await ensureService();
    moveListeningSpan(endAt(np, i, 0));
    userMoved(toBookPosition(np.queue.offsets, i, 0));
    await listenerMove(np, i, 0, () => svc.skipToTrack(i, 0));
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
    cancelOtherBookDeadline();
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
    cancelOtherBookDeadline();
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
 * The player store. `usePlayer.getState()`, `setState` and `subscribe` are the live state,
 * for the store's own logic and every reader outside React (the car, the widgets, Cast, the
 * sleep timer, the reader's narration; the lock screen, Now Playing and the watch are fed by
 * the native side and never read this at all). `usePlayer(selector)`, the hook components
 * read, is what is SHOWN (`quietOffScreen`): the same in front, but off screen (the app in
 * the background, a hidden tab) a tick of the place is not shown, so a player left open
 * does not redraw once a second for nobody. Everything else is shown at once, the place
 * with it: a play or a pause, another file, another speed, another book, a load, an error.
 * Back on screen the live place shows at once.
 */
export const usePlayer = quietOffScreen(playerStore, 'snapshot', isPlaceTick);

/** Whether `live` is the snapshot `shown` only further on: the engine's progress tick
 * (about once a second while playing), or a seek. Its state, its file and its speed are
 * the same; only the place in the file and that file's length may differ. */
function isPlaceTick(shown: PlaybackSnapshot, live: PlaybackSnapshot): boolean {
  return (
    shown.state === live.state && shown.trackIndex === live.trackIndex && shown.rate === live.rate
  );
}

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

/** The listener told of a downloaded book's late place (`onLatePlace`). */
let latePlaceListener: ((bookKey: string, late: LatePlace, moves: number) => unknown) | null = null;

/** Be told when a downloaded book that started without its server's place (the server had
 * not answered within `DOWNLOADED_PLACE_WAIT_MS`) gets that place after all (one listener:
 * `place-reconcile.ts`, which applies its rule to it as to a check's answer). Told only while
 * the book is still the loaded one and the listener has not moved in it since its load
 * landed (`moves`, the `localMoveCount` then, for the listener to check again after its own
 * awaits). Returns the unsubscribe. */
export function onLatePlace(
  listener: (bookKey: string, late: LatePlace, moves: number) => unknown,
): () => void {
  latePlaceListener = listener;
  return () => {
    if (latePlaceListener === listener) latePlaceListener = null;
  };
}

/** Tell the late place listener of `late`, the server's answer for the book `key` just loaded,
 * when it comes and nothing has moved the book since (a seek of the listener's own, another
 * book, a start again: each counts in `localMoves`). */
function followLatePlace(late: Promise<LatePlace | null>, key: string) {
  const moves = localMoves;
  void late.then((answer) => {
    if (!answer || localMoves !== moves) return;
    const now = usePlayer.getState();
    if (selectBookKey(now) !== key || now.loadingBook) return;
    void latePlaceListener?.(key, answer, moves);
  });
}

/** Be told when the loaded book is played again after `LONG_PAUSE_MS` or more of pause
 * (one listener: `place-reconcile.ts`). Called synchronously from the engine
 * subscription, before the play's save loop starts; or, for a Play press in the foreground,
 * before the engine starts, which waits up to `PICK_UP_WAIT_MS` for the promise it returns
 * (`pickUpBeforePlay`). Returns the unsubscribe. */
export function onPickedUpAgain(listener: () => unknown): () => void {
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
 * Stop playback through the connection and wait out the stop's span close, which waits its
 * turn into the outbox (`closeSpan`): past that turn (`appendInTurn` of nothing, behind it),
 * the outbox holds the span. Run before a removal's purges, by the removing tab
 * (`teardownBeforeTokenRevoke`) and by a tab playing through the connection when told of it,
 * or when a sign-in retires it (`removed-in-other-tab.ts`): done after them, the place and
 * the span landed once they were purged.
 */
export async function stopPlaybackAndCloseSpan(connectionId: string): Promise<void> {
  await stopPlaybackForConnection(connectionId);
  await appendInTurn(connectionId, []).catch(() => undefined);
}

/**
 * The shared teardown rule for every token-revoking path (sign-out in
 * use-sign-out.ts, remove-connection in connections-section.tsx): stop playback
 * through the connection first, so the final position persists while its token is
 * still valid, then flush THIS connection's saves so they land before the connection
 * (and with it, those saves) is purged (`flushConnectionSaves`). One helper so a new step
 * can't be added to one path and forgotten in the other. The outbox is sent only once the
 * stop's span is in it (`stopPlaybackAndCloseSpan`): sent at once, the send found the outbox
 * without the span, which then landed after the token was revoked and went with the
 * connection's purge. On the web, a tab playing through the connection stops and sends its
 * own meanwhile, while the token still works (`tellOtherTabsGoing`, a bounded wait;
 * `removed-in-other-tab.ts`).
 */
export async function teardownBeforeTokenRevoke(connectionId: string): Promise<void> {
  // The other tabs' wait (at least its answer window) runs beside this tab's own stop.
  await Promise.all([stopPlaybackAndCloseSpan(connectionId), tellOtherTabsGoing(connectionId)]);
  await flushConnectionSaves(connectionId);
}

/**
 * Send a connection's waiting saves: its offline replay queue (`flushConnection`, not
 * `flushQueue`: the latter no-ops while the ACTIVE server is offline, which would skip this
 * last-chance sync when removing a still-reachable background connection), Sync v2's
 * listening outbox and the ebook reader's queued places. Run before its token is revoked,
 * by the removing tab and by another tab playing through it (`removed-in-other-tab.ts`).
 */
export async function flushConnectionSaves(connectionId: string): Promise<void> {
  await Promise.all([
    flushConnection(connectionId).catch(() => undefined),
    // Sync v2's listening outbox (the stop before this closed its span).
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

/** The loaded book on its download's queue (`localSwapOf`): the queue, the local cover, the
 * place on it, how far that place moved on the whole-book timeline (`shift`), and whether
 * the queue plays the loaded one's files in its order. */
type LocalSwap = {
  queue: BookQueue;
  cover: string | undefined;
  index: number;
  positionInTrack: number;
  shift: number;
  sameOrder: boolean;
};

/**
 * Where the loaded book lands on its download's files, from `at` (a track of its queue and
 * the seconds into it), or null when there is nothing to move onto: no download, every
 * track local already, or a download of the same files in an order the engine doesn't play
 * (unless `anyOrder`: a reload, with nothing playing for a new order to cut into). The
 * download takes the chapters the book was started from when they give it the loaded
 * queue's order (`adoptStartedChapters`). See `switchCurrentBookToLocal`.
 */
function localSwapOf(
  nowPlaying: NowPlaying,
  at: { trackIndex: number; position: number },
  anyOrder = false,
): LocalSwap | null {
  const landed = downloadedEntryOf(nowPlaying);
  if (!landed || landed.manifest.files.length === 0) return null;

  // Already playing from local? (every track points at a downloaded uri) → nothing to do.
  const localUris = new Set(landed.manifest.files.map((f) => f.localUri));
  if (nowPlaying.queue.tracks.every((t) => localUris.has(t.url))) return null;

  // The order the manifest plays once it takes the start's chapters: its own book with
  // those chapters (`chaptersRefresh` reads it that way), which must be the engine's.
  const started = lastPlayRequest;
  const takenOrder = started?.chapterData
    ? bookFileSpecs(landed.manifest.book, started.chapterData)
    : [];
  if (
    started?.chapterData &&
    lastPlayRequestFor(nowPlaying) === started &&
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
  const sameOrder = sameIds(idsOf(queue), idsOf(nowPlaying.queue));
  if (!sameOrder && !anyOrder) {
    const held = new Set(queue.tracks.map((t) => t.id));
    const sameFiles =
      queue.tracks.length === nowPlaying.queue.tracks.length &&
      nowPlaying.queue.tracks.every((t) => held.has(t.id));
    if (sameFiles) return null; // the same files in an order the engine doesn't play
  }
  // The same file (track ids are path-keyed); whole-book seconds only for a file the
  // download doesn't hold.
  const from = toBookPosition(nowPlaying.queue.offsets, at.trackIndex, at.position);
  const sameFile = trackIndexById(queue, nowPlaying.queue.tracks[at.trackIndex]?.id);
  const { index, positionInTrack } =
    sameFile >= 0 ? { index: sameFile, positionInTrack: at.position } : locate(queue.offsets, from);
  // How far the place moves on the download's timeline (0 in the engine's order): the
  // resume floor moves with it, or the slip guard would refuse every later save of a place
  // that now reads lower.
  const shift = toBookPosition(queue.offsets, index, positionInTrack) - from;
  return { queue, cover: local.artwork, index, positionInTrack, shift, sameOrder };
}

/**
 * The store moves onto the download's queue (`swap`), only while `nowPlaying` is still its
 * book: a stop, a sign-out, a switch of person or another start while the swap was out
 * must not bring it back, nor move another book's floor. The book as committed, or null
 * when it is no longer the store's.
 */
function commitLocalSwap(nowPlaying: NowPlaying, swap: LocalSwap): NowPlaying | null {
  if (swapHold?.nowPlaying === nowPlaying) swapHold = null;
  const { nowPlaying: now, snapshot: at } = usePlayer.getState();
  if (now !== nowPlaying) return null;
  resumeFloor = Math.max(0, resumeFloor + swap.shift);
  const committed = { ...nowPlaying, cover: swap.cover ?? nowPlaying.cover, queue: swap.queue };
  // A faulted engine is still one on the download's queue (`engineFault`): the swap put it at
  // the place the store shows, and a press must still reload it there, never just resume it.
  // So is a fault an ask called off (a late refusal brings it back), and an ask still
  // standing: the engine has not played on from it yet (`moveAsk`).
  moveAsk(nowPlaying, committed, { trackIndex: swap.index, position: swap.positionInTrack });
  // The store's place moves onto the download's queue with it, by the file: the engine's
  // report of the download's index can be held back (a stream in `error` holds every
  // report but `playing`), and the stream's index read through the download's queue is
  // another file's place. A file the download lacks lands where the swap put it.
  const moved = ontoQueue(at, nowPlaying.queue, swap.queue, {
    trackIndex: swap.index,
    position: swap.positionInTrack,
    duration: swap.queue.tracks[swap.index]?.duration ?? at.duration,
  });
  usePlayer.setState({ nowPlaying: committed, snapshot: moved });
  return committed;
}

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
 *
 * A web swap refused because the stream moved while the copy buffered (`'moved'`: the copy
 * sat at the place before) runs again from the new place, each time, while the same book is
 * still the store's and its download complete. Every such refusal needs a real move of the
 * stream: the listener's seek, skip or auto-rewinding play, the stream's own advance to its
 * next file or a transcoded stream's early-end reload (both move it on through the book),
 * or a one-off move the store makes (the pick-up's place, another tab's): none comes from
 * the swap itself, so it ends. A stop, a reset, another book or a copy that never became
 * playable (`'refused'`) is not retried.
 */
async function switchCurrentBookToLocal() {
  const state = usePlayer.getState();
  const { nowPlaying, snapshot } = state;
  if (!nowPlaying || !apiRef) return;
  // A load holding the store (a start, an adoption's reload: `loadingBook`) leaves the
  // snapshot the PREVIOUS place until it lands, and so does a start of this same book at
  // another place, which holds nothing (`startsInFlight`): the swap runs once they are
  // over (`swapDue`).
  if (state.loadingBook || startsInFlight > 0) {
    swapDue = contentKeyOf(nowPlaying);
    return;
  }
  // The engine plays another book (the car's, not adopted: `otherBookReported`): a load of
  // this book would cut that one off, and this book's own report would end its adoption
  // deadline. Nothing of this book plays to move onto the download: a play press reloads it
  // from there (`retry`), and an adoption replaces it.
  if (engineIsAnothers() || engineHoldsAnother()) return;
  const swap = localSwapOf(nowPlaying, snapshot);
  if (!swap) return;
  const { queue, index, positionInTrack, sameOrder } = swap;
  // Playing on means the listener's intent, not an engine at `playing`. A short book
  // downloads in under a second, while its stream is still starting (the snapshot is
  // `loading`, or the engine has just begun and its `playing` has not reached JS yet).
  // iOS's `load` pauses the player (Android's keeps playWhenReady), so a swap that didn't
  // play left the story stopped on a Play button after a single tap (8b-1, a kid's first
  // story on an iPhone). And an engine still at `playing` with the intent gone is a pause or
  // a stop it has not reported yet (a stop saves the place first): playing on would undo it.
  const wasPlaying = wantsPlayback;
  const svc = await ensureService();

  // Committed (`commitLocalSwap`) only once the engine has actually moved onto the local
  // files.

  if (svc.isCasting?.()) {
    // Casting: the receiver streams the book from the server whatever the phone holds (a
    // cast builds server URLs from the tracks' paths), so a reload would only interrupt
    // it. The route keeps the phone's copy for when the book comes back to the phone. The
    // receiver's track indices read through the store's queue, so only a download in the
    // order it plays is taken; the next start uses one holding other files.
    if (!sameOrder) return;
    svc.rememberLoad?.({
      tracks: queue.tracks,
      chapters: queue.chapterClips,
      book: bookRefOf(nowPlaying),
    });
    commitLocalSwap(nowPlaying, swap);
    return;
  }

  // The engine reports the download's track index before its swap or load returns: a load
  // from its call, a gapless swap from its switch (the stream reports its own until then).
  const hold =
    index !== snapshot.trackIndex
      ? { nowPlaying, trackIndex: snapshot.trackIndex, queue, live: !svc.swapTo }
      : null;
  if (hold) swapHold = hold;
  let outcome: SwapOutcome | undefined;
  try {
    if (svc.swapTo) {
      // Gapless: keep streaming until the local file is buffered at this position. The
      // swap can be refused (e.g. the local source isn't servable on web) - in that
      // case leave nowPlaying on the streaming queue so playback keeps going.
      outcome = await svc.swapTo(
        queue.tracks,
        index,
        positionInTrack,
        queue.chapterClips,
        bookRefOf(nowPlaying),
        () => {
          if (hold) hold.live = true;
        },
      );
      if (outcome === 'swapped') commitLocalSwap(nowPlaying, swap);
    } else {
      // A play goes on through the load as a start's does: iOS's `load` pauses the player,
      // and that pause must read as the load's, not the listener's (`reloadAdopted`).
      if (wasPlaying) beginPlaybackAttempt();
      const load = () =>
        svc.load(queue.tracks, index, positionInTrack, queue.chapterClips, bookRefOf(nowPlaying));
      // The load puts the engine at the place afresh, as a Retry does, and an engine that
      // measures the download's file short runs off it the same way: it is asked for the
      // place, in the queue the store holds until the commit (which moves the ask with the
      // place, `moveAsk`). Not a faulted book's: its fault stands, and an ask would end it.
      const asks = usePlayer.getState().nowPlaying === nowPlaying && faultedBook !== nowPlaying;
      await (asks ? engineMove(nowPlaying, snapshot.trackIndex, snapshot.position, load) : load());
      // Committed before the rate and the play, so the play's `playing` (and the save loop
      // it starts) reads the engine's index through the download's queue.
      const committed = commitLocalSwap(nowPlaying, swap);
      if (!committed) return;
      // The speed and the intent as they stand now: a speed set or a pause made while the
      // load was out reached the engine before it landed, and stands. So does a play asked
      // for while a paused book's load was out: iOS's `load` paused it again.
      await svc.setRate(usePlayer.getState().rate);
      if (wantsPlayback && usePlayer.getState().nowPlaying === committed) await svc.play();
    }
  } finally {
    // A refused swap or a failed load: the hold must not outlive it.
    if (swapHold?.nowPlaying === nowPlaying) swapHold = null;
  }
  // Again from where the listener moved to (the download is read again there, so one
  // removed meanwhile ends it).
  const now = usePlayer.getState().nowPlaying;
  // Returned, not awaited: this attempt's queue and download map are freed while the
  // next one buffers.
  if (outcome === 'moved' && now && sameBook(now, nowPlaying)) {
    return switchCurrentBookToLocal();
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
 * - the intent from `playing`: a playing book starts the save loop and a listening span; one
 *   asked to play that still loads (the engine's last report `loading`: the car, a headset or
 *   a resumption started it a moment ago) is that asked play, followed as a press is
 *   (`loading`, the stall watchdog), its span and save loop from its `playing`; a paused one
 *   saves nothing until it plays (its place is the engine's, already saved by whoever played
 *   it, and a save now would date that place as new);
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
  adoptions++;
  // A play asked from outside that the store follows as its own book's is this other book's:
  // the engine's reports are held from here (`engineIsAnothers`).
  const followed = outsidePlay;
  const loadedKey = resolvedKeyOf(service);
  if (followed && contentKeyOf(followed.np) !== loadedKey) followed.other = true;
  let adopted = false;
  try {
    adopted = await adoptNow(service, reread);
    return adopted;
  } finally {
    adoptions--;
    // Gave up with the play still followed: the watchdog ends it, after its whole grace from
    // here, so the engine's book by now (another again) can be adopted first (the car sync
    // reads the engine once more).
    if (!adopted && adoptions === 0 && outsidePlay === followed && followed?.other) {
      cancelStallWatchdog();
      armStallWatchdog();
    }
  }
}

/** `adoptLoadedBook` itself. */
async function adoptNow(
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

  /** The track ids of the files `chapters` hold. */
  const idsIn = (chapters: ChaptersResponse | undefined) =>
    new Set(specIds(bookFileSpecs(book, chapters), libraryId));
  const servedIds = served ? idsIn(served) : null;
  if (served && inEngineOrder(served)) {
    // The engine plays the server's order: the queue is built from those chapters, as the lost
    // start built it (the download's files, streaming any it lacks), and the download takes
    // them when it holds those files (`adoptStartedChapters`). Nothing is reloaded.
    adoptStartedChapters(ref, served);
    chapterData = served;
    otherOrder = false;
  } else if (served && servedIds && engineIds) {
    // Online, the engine played files the download lacks, in an order that is no longer the
    // server's: the queue streams the server's files the download lacks, as a start online
    // builds it, and the engine is reloaded into that order, so the book plays on past the
    // downloaded part (D3, fe#185). The download keeps its own chapters (it doesn't hold
    // those files).
    const own = idsIn(chapterData);
    if (engineIds.some((id) => servedIds.has(id) && !own.has(id))) chapterData = served;
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
  // A download that lacks the book's last file as the engine played it, offline or with no
  // answer from the server: its end is the downloaded part's, not the book's (D3, fe#185).
  // One that lacks only an earlier file (an intro) still ends where the book does. With an
  // answer the queue holds every file the server has, and one it lacks is gone from the
  // book. The download keeps the fact for a later start of it (`noteDownloadEnd`), and an
  // engine loaded from the download's own copy (a cold offline Resume, then a JS restart)
  // ends early by the fact a server answer kept (`endsBefore`), as `playBook` reads it.
  let partial = false;
  if (local && !served) {
    if (loaded.files?.length) noteDownloadEnd(ref, loaded.files);
    const last = engineIds?.[engineIds.length - 1];
    const endsBefore = downloadedEntryOf(ref)?.manifest.endsBefore;
    partial =
      (last !== undefined && trackIndexById(queue, last) < 0) ||
      (!!endsBefore && trackIndexById(queue, trackIdOf(libraryId, endsBefore)) < 0);
    if (partial) partialQueues.set(queue, serverLengthOf(downloadedEntryOf(ref)?.manifest));
  }
  // The engine's place is past the downloaded part: it stays paused at that part's end, and
  // the listener is told why (a play there would end at once).
  const pastPart = partial && !!reload?.beyond;
  const playing = loaded.playing && !pastPart;
  // Asked to play and not playing yet (the car, a headset or a resumption started it a moment
  // ago, and it still loads): the asked play, followed as a press of this book's (`loading`,
  // the stall watchdog from here), not a `playing` with nothing heard and no watchdog. The
  // engine's own last report says so (none before JS listened: then as before).
  const asked = playing && !reload && svc.getSnapshot().state === 'loading';
  // Reloaded or asked: it plays from its next `playing`.
  const startsLoading = !!reload || asked;

  const { index: trackIndex, positionInTrack: position } = reload ?? {
    index: Math.max(0, Math.min(loaded.trackIndex, queue.tracks.length - 1)),
    positionInTrack: Math.max(0, loaded.position),
  };
  const rate = clampRate(loaded.rate > 0 ? loaded.rate : now.rate);
  const snapshot: PlaybackSnapshot = {
    state: playing ? (startsLoading ? 'loading' : 'playing') : 'paused',
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
  pausedAt = playing && !startsLoading ? null : 0;
  svc.adoptPlace?.(snapshot);
  const nowPlaying = nowPlayingOf(loaded, book, queue, api, local);
  // Nor checked for the replay guard (fe#198): offline, a place the car started from an
  // old snapshot must not move another device's further one back. Its PUT saves are
  // guarded until one is PUT, as an unchecked resume's.
  placeGuard = guardFor(contentKeyOf(nowPlaying));
  // A reload holds every save and remote move until it lands (`loadingBook`): until then a
  // tick still counts in the engine's old order.
  usePlayer.setState({
    nowPlaying,
    rate,
    loadingBook: reload ? contentKeyOf(nowPlaying) : null,
    snapshot,
  });
  restoreOutputGain(svc);
  if (pastPart) tellPartialEnd();
  if (reload) {
    await reloadAdopted(svc, nowPlaying, reload, rate, playing);
    return true;
  }
  // And its queue: a Cast session started later hands this book to the receiver (never
  // taking the route with the phone still playing it), and an ended one hands it back (a
  // reload's `load` records its own).
  svc.rememberLoad?.({ tracks: queue.tracks, chapters: queue.chapterClips, book: ref });
  // A speed outside the app's range (set by another controller while no JS listened) goes
  // back to the engine clamped, as `onRateChange` does: the store says what plays.
  if (rate !== loaded.rate) void svc.setRate(rate);
  if (asked) {
    // Its `playing` opens the span and runs the pick-up check, as a press's does.
    beginPlaybackAttempt();
  } else if (playing) {
    wantsPlayback = true;
    // Before the first save: the place reconcile holds the saves while it asks the server,
    // so this place can't overwrite another device's newer one (last-write-wins).
    void pickedUpAgainListener?.();
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
  return resolvedKeyOf(a) === resolvedKeyOf(b) && sameIds(a.files ?? [], b.files ?? []);
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
  /** Ask even a server marked unreachable (a mark left from before the network came back). */
  evenMarkedDown = false,
): Promise<ChaptersResponse | null> {
  if (!api || (!evenMarkedDown && !isReachable(ref.connectionId))) return null;
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

/**
 * The loaded book at the end of its downloaded part (a partial queue, D3, fe#185) plays on
 * from there, streaming the rest, when its server answers now: the device back online in the
 * same session (the queue was built offline, from the download's own copy). The book starts
 * again (`playBook`) with the server's chapters, at the place in them where the downloaded
 * part ends. False, with the book left as it is, when there is no network, no server answer
 * (within `SERVED_ORDER_WAIT_MS`), or the server's book ends where the download does now:
 * the caller tells the listener why nothing plays. `evenMarkedDown`: a press asks a server
 * marked unreachable too (the mark can predate the network coming back); the engine's own
 * end does not.
 */
async function playOnPastPart(evenMarkedDown: boolean): Promise<boolean> {
  // One at a time: the engine re-reports its end while one asks (a press joins it). The
  // first caller alone tells the listener when it can't, so the notice comes once.
  if (playingOn) return playingOn.then(() => true);
  playOnStopped = false;
  playingOn = playOnNow(evenMarkedDown).finally(() => {
    playingOn = null;
  });
  return playingOn;
}

/** The `playOnPastPart` on its way, if any. */
let playingOn: Promise<boolean> | null = null;
/** The listener paused while that asked its server (a press on its spinner): it stands. */
let playOnStopped = false;

async function playOnNow(evenMarkedDown: boolean): Promise<boolean> {
  const np = usePlayer.getState().nowPlaying;
  if (!np || !endsPartial(np) || !isDeviceOnline()) return false;
  const api = resolveClient(np.connectionId);
  const manifest = downloadedEntryOf(np)?.manifest;
  if (!api || !manifest) return false;
  const ref = bookRefOf(np);
  const before = usePlayer.getState().snapshot;
  usePlayer.setState({ snapshot: { ...before, state: 'loading' } });
  const served = await serverChaptersOf(ref, api, evenMarkedDown);
  // Another book (or another start of this one) since: it stands.
  if (usePlayer.getState().nowPlaying !== np) return true;
  /** Back to the state before the spinner, unless the engine has reported since. */
  const settle = () => {
    const now = usePlayer.getState().snapshot;
    if (now.state === 'loading') usePlayer.setState({ snapshot: { ...now, state: before.state } });
  };
  // Moved off the end meanwhile (a seek back), or paused on the spinner: that stands.
  if (!atPartialEnd || playOnStopped) {
    settle();
    return true;
  }
  const book =
    queryClient.getQueryData<Book>(qk.item(np.connectionId, np.libraryId, np.path)) ??
    manifest.book;
  const specs = served ? bookFileSpecs(book, served) : [];
  const ids = specs.map((f) => trackIdOf(np.libraryId, f.path));
  const last = np.queue.tracks[np.queue.tracks.length - 1]?.id;
  const at = ids.indexOf(last ?? '');
  // The server's book goes on past the queue's last file: start where that file ends.
  if (!served || at < 0 || at === ids.length - 1) {
    settle();
    return false;
  }
  // It answered: reachable, so the start streams the rest (`playBook`'s `offlineShort`).
  noteSuccess(np.connectionId);
  // By the file, not a book position: a file the server has not measured yet (duration 0)
  // shares its offset with the next, and a position there would start past it.
  await usePlayer
    .getState()
    .playBook(np.connectionId, np.libraryId, book, served, undefined, at + 1)
    .catch((err: unknown) => console.warn('[player] could not play on past the download', err));
  return true;
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

/** Where an adopted engine's place lands in its queue (`landingOf`); `beyond` when the place
 * was past the queue's end, so it lands short of it. */
type Landing = { index: number; positionInTrack: number; beyond: boolean };

/** Where the engine's place lands in `queue`: the same file (by track id) at the same place
 * in it, else (a file the queue lacks) the same whole-book seconds, read on the engine's own
 * timeline (`durations`), short of the queue's end (a place there would finish the book). When
 * an earlier file's length is not known (a streamed book whose files were renamed since it
 * loaded, a download whose server can't be asked), the seconds can't be read: the engine's
 * file index, at the same place in the file, within that file's length (fe#185), and short of
 * the queue's end too. */
export function landingOf(
  queue: Pick<BookQueue, 'tracks' | 'offsets' | 'total'>,
  engineIds: string[],
  loaded: Pick<LoadedBook, 'trackIndex' | 'position'>,
  durations: Map<string, number>,
): Landing {
  const inFile = Math.max(0, loaded.position);
  const same = trackIndexById(queue, engineIds[loaded.trackIndex]);
  if (same >= 0) return { index: same, positionInTrack: inFile, beyond: false };
  const lastPlace = Math.max(0, queue.total - FINISHED_TOLERANCE - 1);
  const shortOfEnd = (seconds: number): Landing =>
    queue.total > 0 && seconds > lastPlace
      ? { ...locate(queue.offsets, lastPlace), beyond: true }
      : { ...locate(queue.offsets, seconds), beyond: false };
  let seconds = inFile;
  const before = Math.max(0, Math.min(loaded.trackIndex, engineIds.length));
  for (let i = 0; i < before; i++) {
    const duration = durations.get(engineIds[i]);
    if (!(duration && duration > 0)) {
      const index = Math.max(0, Math.min(loaded.trackIndex, queue.tracks.length - 1));
      // That index can be another file, shorter than the place in the engine's.
      const length = queue.tracks[index]?.duration ?? 0;
      const positionInTrack = length > 0 ? Math.min(inFile, length) : inFile;
      const known = queue.offsets[index] !== undefined && queue.total > 0;
      return known
        ? shortOfEnd(toBookPosition(queue.offsets, index, positionInTrack))
        : { index, positionInTrack, beyond: false };
    }
    seconds += duration;
  }
  return shortOfEnd(seconds);
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
    await engineMove(nowPlaying, landing.index, landing.positionInTrack, () =>
      svc.load(
        nowPlaying.queue.tracks,
        landing.index,
        landing.positionInTrack,
        nowPlaying.queue.chapterClips,
        bookRefOf(nowPlaying),
      ),
    );
  } catch (err) {
    console.warn('[player] could not reload the adopted book in its order', err);
    if (swapDue === key) swapDue = null; // no place landed to swap from
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
  if (state.snapshot.state === 'playing') void pickedUpAgainListener?.();
  else pausedAt = 0;
});

/** Whether `np`'s queue streams a file its download holds (a download that landed and was
 * not swapped in). */
function streamsDownloadedFile(np: NowPlaying): boolean {
  const files = downloadedEntryOf(np)?.manifest.files;
  if (!files?.length) return false;
  const held = new Set(files.map((f) => trackIdOf(np.libraryId, f.relPath)));
  return np.queue.tracks.some((t) => !t.local && held.has(t.id));
}

function moveOntoDownload() {
  switchCurrentBookToLocal().catch((err) =>
    console.warn('[player] could not move onto the downloaded copy', err),
  );
}

/** Run the hot-swap that waited (`swapDue`) once no load holds the store and no start is on
 * its way, on the book it waited for (its own place in the snapshot by then). Asked at both
 * ends: the hold's release (below) and a start's end (`playBook`). */
function runDueSwap() {
  if (swapDue === null || startsInFlight > 0) return;
  const { nowPlaying, loadingBook } = usePlayer.getState();
  if (loadingBook) return;
  const due = swapDue;
  swapDue = null;
  if (nowPlaying && contentKeyOf(nowPlaying) === due) moveOntoDownload();
}
usePlayer.subscribe((state, prev) => {
  if (prev.loadingBook && !state.loadingBook) runDueSwap();
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
    moveOntoDownload();
  }
});

// --- selectors -------------------------------------------------------------
export const selectBookPosition = (s: PlayerState): number =>
  s.nowPlaying
    ? toBookPosition(s.nowPlaying.queue.offsets, s.snapshot.trackIndex, s.snapshot.position)
    : 0;

/** The chapter playing. Chapters that share a start (files of unknown length) are told
 * apart by the file playing (`chapterAt`). */
export const selectCurrentChapter = (s: PlayerState): Chapter | null => {
  const np = s.nowPlaying;
  if (!np) return null;
  // The playing file is read only for tied chapters: this runs on every position tick.
  return chapterAt(
    np.queue.chapters,
    selectBookPosition(s),
    (filePath) => filePath === fileOf(np, s.snapshot.trackIndex),
  );
};

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

/** The loaded book's queue ends where its download does, short of the book's end (an
 * adoption offline, D3, fe#185): reaching that end is never the book's end. */
export const selectEndsPartial = (s: PlayerState): boolean => endsPartial(s.nowPlaying);
/** The loaded book's length for a percent heard: the queue's, but a partial queue's is the
 * book's on its server when known (`partialQueues`), as its saves send, so the player's
 * percent is Home's. */
export const selectBookLength = (s: PlayerState): number =>
  s.nowPlaying ? partialQueues.get(s.nowPlaying.queue) || s.nowPlaying.queue.total : 0;
