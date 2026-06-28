import { create } from 'zustand';

import type { ApiClient } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { isReachable, noteError } from '@/api/reachability';
import type { Book, Chapter, ChaptersResponse } from '@/api/types';
import { downloadKey, useDownloads } from '@/downloads/store';
import type { DownloadManifest } from '@/downloads/types';
import { useSettings } from '@/stores/settings';

import { buildBookQueue, chapterAt, locate, toBookPosition, type BookQueue } from './book-queue';
import {
  flushConnection,
  flushQueue,
  getDeviceId,
  loadInitialProgress,
  saveProgress,
} from './progress-sync';
import { createPlaybackService } from './service';
import { INITIAL_SNAPSHOT, type PlaybackService, type PlaybackSnapshot } from './types';

/** The `local` files map + artwork a downloaded book plays from, derived from its
 * manifest. Shared by `playBook` (downloaded-before-play) and `switchCurrentBookToLocal`
 * (downloaded-while-streaming), whose `buildBookQueue` calls take the same shape. */
function localFromManifest(manifest: DownloadManifest): {
  files: Map<string, string>;
  artwork?: string;
} {
  return {
    files: new Map(manifest.files.map((f) => [f.relPath, f.localUri] as const)),
    artwork: manifest.coverUri ?? undefined,
  };
}

let service: PlaybackService | null = null;
let apiRef: ApiClient | null = null;
let deviceId = '';
let saveTimer: ReturnType<typeof setInterval> | null = null;
let historyStart: { position: number; at: number } | null = null;
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
/** Captured so `retry()` can re-run the resume path after a lookup failure. */
let lastPlayRequest: {
  connectionId: string;
  libraryId: number;
  book: Book;
  chapterData?: ChaptersResponse;
} | null = null;

const MIN_HISTORY_MS = 20_000; // ignore listening spans shorter than this
const STALL_GRACE_MS = 3_000; // a 'loading' that outlasts this is treated as a dead stream

const SAVE_INTERVAL_MS = 15_000;
const FINISHED_TOLERANCE = 5; // treat within 5s of the end as finished
const SLIP_TOLERANCE = 60; // a save more than this far below the resume floor is suspect

/** Lower the resume floor after a deliberate user seek/jump, so a legitimate backward
 * move (or a restart) is allowed to save instead of being blocked by the guard. */
function lowerFloorTo(bookPosition: number) {
  if (Number.isFinite(bookPosition)) resumeFloor = Math.min(resumeFloor, Math.max(0, bookPosition));
}

const MIN_RATE = 0.5;
const MAX_RATE = 2; // engines support more; the product caps speed at 2x
const clampRate = (r: number) => Math.max(MIN_RATE, Math.min(MAX_RATE, r));

/** Engine tunables derived from the settings store. */
function currentConfig() {
  const s = useSettings.getState();
  return {
    autoRewindMax: s.autoRewindMax,
    jumpForward: s.skipForward,
    jumpBackward: s.skipBackward,
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
};

type PlayerState = {
  nowPlaying: NowPlaying | null;
  snapshot: PlaybackSnapshot;
  rate: number;
  /** Whether the engine can show an OS audio-route / casting picker on this platform
   * (set when the engine is created). Drives whether the player shows the cast button. */
  canRoutePick: boolean;

  /** Start a book. Omit startBookPosition to resume from saved progress; pass
   * startTrack to begin at a specific file (used when file durations are
   * unknown, so a whole-book position can't address a track). `connectionId` is the
   * server this book is loaded through - it scopes saves, downloads and invalidations. */
  playBook: (
    connectionId: string,
    libraryId: number,
    book: Book,
    chapterData?: ChaptersResponse,
    startBookPosition?: number,
    startTrack?: number,
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
  stop: () => Promise<void>;
  /** Present the OS audio-route / casting picker (AirPlay, Android output switcher, web
   * Remote Playback). No-op if the engine doesn't support it. */
  showRoutePicker: () => Promise<void>;
};

/** Persist the current whole-book position (offline-safe). */
async function persist() {
  const { nowPlaying, snapshot, rate } = usePlayer.getState();
  if (!apiRef || !nowPlaying) return;
  const position = toBookPosition(nowPlaying.queue.offsets, snapshot.trackIndex, snapshot.position);
  if (position <= 0) return;
  // Guard against a slipped-through restart corrupting real progress: a position far
  // below the resume floor (without a deliberate backward seek, which lowers the floor)
  // is treated as a spurious reset and not saved. The server is last-write-wins, so a
  // small-position save with a newer timestamp would otherwise permanently overwrite the
  // user's place.
  if (position < resumeFloor - SLIP_TOLERANCE) return;
  if (position > resumeFloor) resumeFloor = position; // advance the high-water mark
  const total = nowPlaying.queue.total;
  await saveProgress(apiRef, {
    connectionId: nowPlaying.connectionId,
    libraryId: nowPlaying.libraryId,
    path: nowPlaying.path,
    position,
    duration: total,
    finished: total > 0 && position >= total - FINISHED_TOLERANCE,
    playback_speed: rate,
    device_id: deviceId,
    updated_at: new Date().toISOString(),
  });
}

/** Nudge the Home/Browse "continue listening" + "finished" lists to re-read from
 * the server after playback halts. The live in-card position covers the actively-
 * playing book while it plays; this refreshes the other cards (finished state,
 * other-device progress) once it stops, without invalidating on every 15s save. */
function invalidateProgressLists() {
  // The playing book's connection scopes the invalidation (stop() invalidates
  // before it nulls nowPlaying, so the id is still in hand at every call site).
  const cid = usePlayer.getState().nowPlaying?.connectionId;
  if (!cid) return;
  void queryClient.invalidateQueries({ queryKey: qk.allProgress(cid) });
}

function startSaveLoop() {
  stopSaveLoop();
  saveTimer = setInterval(() => void persist(), SAVE_INTERVAL_MS);
}
function stopSaveLoop() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
}

/** Capture the current position then stop the periodic save loop - shared by the
 * engine's terminal states (pause/end/error) and the stall watchdog. Refreshes the
 * progress lists on both outcomes so a queued-offline save still re-reads server state. */
function haltAndPersist() {
  void persist().then(invalidateProgressLists, invalidateProgressLists);
  stopSaveLoop();
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

/** Mark the start of a listening span when playback begins. */
function beginHistory() {
  if (historyStart) return;
  const player = usePlayer.getState();
  if (!player.nowPlaying) return;
  historyStart = { position: selectBookPosition(player), at: Date.now() };
}

/** Record the listening span (from→to over the elapsed time) when playback
 * stops, ignoring brief spans. */
function endHistory() {
  const start = historyStart;
  historyStart = null;
  if (!start || !apiRef || Date.now() - start.at < MIN_HISTORY_MS) return;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np) return;
  // Listening spans are best-effort; don't fire at a server we know is unreachable
  // (reachability is per-connection, so key it on the playing book's own server).
  if (!isReachable(np.connectionId)) return;
  void apiRef
    .addHistory(np.libraryId, np.path, {
      from_pos: start.position,
      to_pos: selectBookPosition(player),
      started_at: new Date(start.at).toISOString(),
      ended_at: new Date().toISOString(),
    })
    .then(() => queryClient.invalidateQueries({ queryKey: qk.historyAll(np.connectionId) }))
    .catch((err) => {
      noteError(np.connectionId, err);
      console.warn('[history] failed to save listening span', err);
    });
}

async function ensureService(): Promise<PlaybackService> {
  if (service) return service;
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
    if (snapshot.state === 'playing' && prev.state !== 'playing') beginHistory();
    else if (prev.state === 'playing' && snapshot.state !== 'playing') endHistory();
    // Close + reopen a span when the track advances mid-playback (e.g. a
    // multi-file book auto-advancing), so each file is logged as it finishes.
    else if (snapshot.state === 'playing' && snapshot.trackIndex !== prev.trackIndex) {
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
        startSaveLoop();
      } else if (snapshot.state === 'loading') {
        // A mid-playback stall (or the ongoing start attempt): arm the watchdog so a
        // buffer that outlasts the grace surfaces an error. Idempotent - already armed
        // when an attempt began. Only when we intend to play.
        if (wantsPlayback) armStallWatchdog();
      } else {
        // Any other settled state (a start-window transient was normalized to `loading`
        // above): a real pause, a finished book, a dead stream the web/Android engines
        // report directly, Android's STATE_IDLE after a stop-like failure, or a stray
        // `ready`. All clear intent and halt the loop. Deliberately NOT an enumerated
        // state list - that list kept coming up short (an unhandled `idle` left the 15s
        // save loop re-persisting the same position forever); like the error hold above,
        // anything that isn't `playing`/`loading` settles playback.
        clearPlaybackIntent();
        haltAndPersist();
      }
    }
  });
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
  canRoutePick: false,

  playBook: async (connectionId, libraryId, book, chapterData, startBookPosition, startTrack) => {
    // Resolve the client from the connection id (single source of truth), mirroring the
    // downloads store - so a caller can't pass an `api` that disagrees with `connectionId`.
    const api = resolveClient(connectionId);

    // Play from local files when the book is downloaded (works fully offline).
    const dl = useDownloads.getState().entries[downloadKey(connectionId, libraryId, book.rel_path)];
    const local = dl?.status === 'downloaded' ? localFromManifest(dl.manifest) : undefined;

    // A fully-downloaded book plays entirely from `local` files, so it can start even when
    // the connection is gone (e.g. its secure-store token failed to hydrate this launch,
    // dropping it from the session while its download entry survives). Only a book that
    // still needs the server (not downloaded) requires a live client.
    if (!api && !local) return; // connection gone and nothing local; nothing to play

    endHistory(); // flush any prior book's listening span before switching
    cancelStallWatchdog(); // drop any stale stall timer from the previous book
    // Stop the prior book's periodic save loop before we switch nowPlaying: otherwise
    // a 15s tick (or the engine's continued ticks after an early return below) would
    // map the OLD engine position through the NEW book's queue and persist it under the
    // new book's path - corrupting the new book's progress. The loop restarts on the
    // engine's next `playing` transition for this book.
    stopSaveLoop();
    apiRef = api; // null for an offline downloaded book => persist()/history no-op (no server)
    deviceId = await getDeviceId();
    lastPlayRequest = { connectionId, libraryId, book, chapterData }; // so retry() can re-run resume
    resumeLookupFailed = false;

    const queue = buildBookQueue(
      api,
      libraryId,
      book,
      chapterData,
      local,
      useSettings.getState().virtualChapterInterval,
    );
    const nowPlaying: NowPlaying = {
      connectionId,
      libraryId,
      path: book.rel_path,
      title: book.title,
      author: book.author || book.narrator || '',
      // A downloaded book uses its local cover; with no client and no local cover there's
      // simply no cover (offline, connection gone) - the player falls back to a placeholder.
      cover: local?.artwork ?? api?.coverUrl(libraryId, book.rel_path) ?? '',
      queue,
    };
    const svc = await ensureService();

    let startAt = startBookPosition ?? 0;
    let speed = clampRate(useSettings.getState().defaultRate);
    if (startBookPosition === undefined && startTrack === undefined) {
      const r = await loadInitialProgress(api, connectionId, libraryId, book.rel_path);
      if (r.kind === 'progress') {
        const p = r.progress;
        if (!p.finished && p.position > 0) startAt = p.position;
        if (p.playback_speed > 0) speed = clampRate(p.playback_speed);
      } else if (r.kind === 'failed' && dl?.status !== 'downloaded') {
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
        set({
          rate: speed,
          nowPlaying,
          snapshot: { ...INITIAL_SNAPSHOT, state: 'error', rate: speed },
        });
        return;
      }
      // kind 'empty' (server reachable, genuinely new) or 'failed' for a downloaded book
      // (offline-first, never started) → startAt stays 0, which is correct.
    }

    const { index, positionInTrack } =
      startTrack !== undefined
        ? { index: Math.max(0, Math.min(startTrack, queue.tracks.length - 1)), positionInTrack: 0 }
        : locate(queue.offsets, startAt);
    // The position we actually resumed from (covers resume, bookmark jump and startTrack);
    // the save guard won't let progress regress below it without a deliberate seek.
    resumeFloor = toBookPosition(queue.offsets, index, positionInTrack);
    set({ rate: speed, nowPlaying });
    beginPlaybackAttempt(); // intent + start window + watchdog armed from here
    await svc.load(queue.tracks, index, positionInTrack, queue.chapterClips);
    await svc.setRate(speed);
    await svc.play();
    // The save loop is started by the engine 'playing' transition (see subscribe).
    void flushQueue();
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
      await svc.play();
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
      await get().playBook(connectionId, libraryId, book, chapterData);
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
    await svc.load(np.queue.tracks, index, positionInTrack, np.queue.chapterClips);
    await svc.setRate(get().rate);
    await svc.play();
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
    lowerFloorTo(clamped); // a deliberate user seek may legitimately move backward
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
    if (np) lowerFloorTo(toBookPosition(np.queue.offsets, get().snapshot.trackIndex, pos));
    await svc.seekTo(pos);
    void persist();
  },

  goToTrack: async (index) => {
    const np = get().nowPlaying;
    if (!np) return;
    const i = Math.max(0, Math.min(index, np.queue.tracks.length - 1));
    const svc = await ensureService();
    lowerFloorTo(toBookPosition(np.queue.offsets, i, 0));
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
    set({ rate: clamped });
    if (service) await service.setRate(clamped);
    void persist();
  },

  stop: async () => {
    clearPlaybackIntent();
    stopSaveLoop();
    await persist();
    invalidateProgressLists();
    if (service) await service.reset();
    set({ nowPlaying: null, snapshot: { ...INITIAL_SNAPSHOT, rate: get().rate } });
  },

  showRoutePicker: async () => {
    const svc = service ?? (await ensureService());
    await svc.showRoutePicker?.();
  },
}));

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
  await flushConnection(connectionId).catch(() => undefined);
}

/**
 * Hot-swap the currently-playing book onto its local files the moment its download
 * finishes, preserving position + play state. `playBook` already prefers local when
 * a book is downloaded *before* playback starts; this covers the other order -
 * downloading while it streams - so playback keeps going when the network drops
 * instead of dying with the live stream. Shared by web + native.
 */
async function switchCurrentBookToLocal() {
  const { nowPlaying, snapshot, rate } = usePlayer.getState();
  if (!nowPlaying || !apiRef) return;
  const dl =
    useDownloads.getState().entries[
      downloadKey(nowPlaying.connectionId, nowPlaying.libraryId, nowPlaying.path)
    ];
  if (dl?.status !== 'downloaded' || dl.manifest.files.length === 0) return;

  // Already playing from local? (every track points at a downloaded uri) → nothing to do.
  const localUris = new Set(dl.manifest.files.map((f) => f.localUri));
  if (nowPlaying.queue.tracks.every((t) => localUris.has(t.url))) return;

  const bookPos = toBookPosition(nowPlaying.queue.offsets, snapshot.trackIndex, snapshot.position);
  const local = localFromManifest(dl.manifest);
  const queue = buildBookQueue(
    apiRef,
    nowPlaying.libraryId,
    dl.manifest.book,
    dl.manifest.chapters ?? undefined,
    local,
    useSettings.getState().virtualChapterInterval,
  );
  const { index, positionInTrack } = locate(queue.offsets, bookPos);
  const wasPlaying = snapshot.state === 'playing';
  const svc = await ensureService();

  if (svc.swapTo) {
    // Gapless: keep streaming until the local file is buffered at this position. The
    // swap can be refused (e.g. the local source isn't servable on web) - in that
    // case leave nowPlaying on the streaming queue so playback keeps going.
    const swapped = await svc.swapTo(queue.tracks, index, positionInTrack, queue.chapterClips);
    if (!swapped) return;
  } else {
    await svc.load(queue.tracks, index, positionInTrack, queue.chapterClips);
    await svc.setRate(rate);
    if (wasPlaying) await svc.play();
  }
  // Commit only once the engine has actually moved onto the local files. The old and
  // new queues share file count/durations, so the (index, position) stays valid
  // across the brief window before this lands.
  usePlayer.setState({
    nowPlaying: { ...nowPlaying, cover: local.artwork ?? nowPlaying.cover, queue },
  });
}

// When a download completes for the book that's currently playing, switch it to the
// local copy (see above).
useDownloads.subscribe((state, prev) => {
  const np = usePlayer.getState().nowPlaying;
  if (!np) return;
  // Scope by the playing book's own connection so a completing download on ANOTHER
  // server with the same (libraryId, path) can't hot-swap this book to its files.
  const key = downloadKey(np.connectionId, np.libraryId, np.path);
  if (state.entries[key]?.status === 'downloaded' && prev.entries[key]?.status !== 'downloaded') {
    void switchCurrentBookToLocal();
  }
});

// --- selectors -------------------------------------------------------------
export const selectBookPosition = (s: PlayerState): number =>
  s.nowPlaying
    ? toBookPosition(s.nowPlaying.queue.offsets, s.snapshot.trackIndex, s.snapshot.position)
    : 0;

export const selectCurrentChapter = (s: PlayerState): Chapter | null =>
  s.nowPlaying ? chapterAt(s.nowPlaying.queue.chapters, selectBookPosition(s)) : null;

export const selectIsPlaying = (s: PlayerState): boolean => s.snapshot.state === 'playing';
