import { create } from 'zustand';

import type { ApiClient } from '@/api/client';
import { queryClient } from '@/api/provider';
import { isReachable, noteError } from '@/api/reachability';
import type { Book, Chapter, ChaptersResponse } from '@/api/types';
import { downloadKey, useDownloads } from '@/downloads/store';
import { useSettings } from '@/stores/settings';

import { buildBookQueue, chapterAt, locate, toBookPosition, type BookQueue } from './book-queue';
import { flushQueue, getDeviceId, loadInitialProgress, saveProgress } from './progress-sync';
import { createPlaybackService } from './service';
import { INITIAL_SNAPSHOT, type PlaybackService, type PlaybackSnapshot } from './types';

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

const MIN_HISTORY_MS = 20_000; // ignore listening spans shorter than this
const STALL_GRACE_MS = 3_000; // a 'loading' that outlasts this is treated as a dead stream

const SAVE_INTERVAL_MS = 15_000;
const FINISHED_TOLERANCE = 5; // treat within 5s of the end as finished

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

  /** Start a book. Omit startBookPosition to resume from saved progress; pass
   * startTrack to begin at a specific file (used when file durations are
   * unknown, so a whole-book position can't address a track). */
  playBook: (
    api: ApiClient,
    libraryId: number,
    book: Book,
    chapterData?: ChaptersResponse,
    startBookPosition?: number,
    startTrack?: number,
  ) => Promise<void>;
  toggle: () => Promise<void>;
  pause: () => Promise<void>;
  /** Re-load the current track at the current position and resume — recovery after
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
};

/** Persist the current whole-book position (offline-safe). */
async function persist() {
  const { nowPlaying, snapshot, rate } = usePlayer.getState();
  if (!apiRef || !nowPlaying) return;
  const position = toBookPosition(nowPlaying.queue.offsets, snapshot.trackIndex, snapshot.position);
  if (position <= 0) return;
  const total = nowPlaying.queue.total;
  await saveProgress(apiRef, {
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
  void queryClient.invalidateQueries({ queryKey: ['progress', 'all'] });
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

/** Capture the current position then stop the periodic save loop — shared by the
 * engine's terminal states (pause/end/error) and the stall watchdog. Refreshes the
 * progress lists on both outcomes so a queued-offline save still re-reads server state. */
function haltAndPersist() {
  void persist().then(invalidateProgressLists, invalidateProgressLists);
  stopSaveLoop();
}

/** Surface an `error` if we wanted to play but haven't reached `playing` within the
 * grace — a dead/stalled stream then offers a retry instead of an endless spinner. The
 * watchdog is armed by the play/retry actions (and by a mid-playback stall's `loading`),
 * NOT by trying to interpret the native bridge's noisy resume/retry event stream — so no
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
    wantsPlayback = false;
    startingPlayback = false;
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
  // Listening spans are best-effort; don't fire at a server we know is unreachable.
  if (!isReachable()) return;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np) return;
  void apiRef
    .addHistory(np.libraryId, np.path, {
      from_pos: start.position,
      to_pos: selectBookPosition(player),
      started_at: new Date(start.at).toISOString(),
      ended_at: new Date().toISOString(),
    })
    .then(() => queryClient.invalidateQueries({ queryKey: ['history'] }))
    .catch((err) => {
      noteError(err);
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
    // bridge emits while rebuilding the queue — `ready`, `paused`, `idle`, `ended`,
    // `loading` — is "still connecting" → `loading`. This is what makes the spinner and
    // watchdog robust regardless of event ordering (the spurious `paused` used to clear
    // intent and strand the spinner). A genuine user/lock-screen pause arrives AFTER
    // `playing` (startingPlayback already false), so it stays `paused`. Outside a fresh
    // start, a `ready` while intending to play is also a spinner.
    let state = raw.state;
    if (startingPlayback && state !== 'playing' && state !== 'error') state = 'loading';
    else if (state === 'ready' && wantsPlayback) state = 'loading';
    const snapshot: PlaybackSnapshot = state === raw.state ? raw : { ...raw, state };
    const prev = usePlayer.getState().snapshot;
    // After the stall watchdog (or an engine error) surfaces an `error`, the engine
    // keeps re-reporting around the dead stream — iOS: frozen `onProgress` ticks
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
    // after pause/stop/end — including a lock-screen pause or a book that simply
    // finishes, neither of which calls stop().
    if (snapshot.state !== prev.state) {
      // A lock-screen play/pause arrives here (the engine state), not through the store
      // actions — so keep intent + the start window in sync with it.
      if (snapshot.state === 'playing') {
        // Reached playback — the stream is alive and we're no longer "connecting".
        wantsPlayback = true;
        startingPlayback = false;
        cancelStallWatchdog();
        startSaveLoop();
      } else if (snapshot.state === 'loading') {
        // A mid-playback stall (or the ongoing start attempt): arm the watchdog so a
        // buffer that outlasts the grace surfaces an error. Idempotent — already armed
        // when an attempt began. Only when we intend to play.
        if (wantsPlayback) armStallWatchdog();
      } else if (
        snapshot.state === 'paused' ||
        snapshot.state === 'ended' ||
        snapshot.state === 'error'
      ) {
        // Genuine terminal (a start-window transient was normalized to `loading`
        // above): a real pause, a finished book, or a dead stream the web/Android
        // engines report directly. Clear intent, halt the loop.
        wantsPlayback = false;
        startingPlayback = false;
        cancelStallWatchdog();
        haltAndPersist();
      }
    }
  });
  service = svc;
  return svc;
}

export const usePlayer = create<PlayerState>()((set, get) => ({
  nowPlaying: null,
  snapshot: { ...INITIAL_SNAPSHOT },
  rate: 1,

  playBook: async (api, libraryId, book, chapterData, startBookPosition, startTrack) => {
    endHistory(); // flush any prior book's listening span before switching
    cancelStallWatchdog(); // drop any stale stall timer from the previous book
    apiRef = api;
    deviceId = await getDeviceId();

    // Play from local files when the book is downloaded (works fully offline).
    const dl = useDownloads.getState().entries[downloadKey(libraryId, book.rel_path)];
    const local =
      dl?.status === 'downloaded'
        ? {
            files: new Map(dl.manifest.files.map((f) => [f.relPath, f.localUri] as const)),
            artwork: dl.manifest.coverUri ?? undefined,
          }
        : undefined;

    const queue = buildBookQueue(api, libraryId, book, chapterData, local);
    const svc = await ensureService();

    let startAt = startBookPosition ?? 0;
    let speed = clampRate(useSettings.getState().defaultRate);
    if (startBookPosition === undefined && startTrack === undefined) {
      const saved = await loadInitialProgress(api, libraryId, book.rel_path);
      if (saved && !saved.finished && saved.position > 0) startAt = saved.position;
      if (saved?.playback_speed && saved.playback_speed > 0)
        speed = clampRate(saved.playback_speed);
    }

    const { index, positionInTrack } =
      startTrack !== undefined
        ? { index: Math.max(0, Math.min(startTrack, queue.tracks.length - 1)), positionInTrack: 0 }
        : locate(queue.offsets, startAt);
    set({
      rate: speed,
      nowPlaying: {
        libraryId,
        path: book.rel_path,
        title: book.title,
        author: book.author || book.narrator || '',
        cover: local?.artwork ?? api.coverUrl(libraryId, book.rel_path),
        queue,
      },
    });
    beginPlaybackAttempt(); // intent + start window + watchdog armed from here
    await svc.load(queue.tracks, index, positionInTrack);
    await svc.setRate(speed);
    await svc.play();
    // The save loop is started by the engine 'playing' transition (see subscribe).
    void flushQueue(api);
  },

  toggle: async () => {
    const svc = await ensureService();
    // persist + save-loop start/stop are handled by the engine state transition.
    if (get().snapshot.state === 'playing') {
      wantsPlayback = false;
      startingPlayback = false;
      cancelStallWatchdog();
      await svc.pause();
    } else {
      beginPlaybackAttempt();
      await svc.play();
    }
  },

  pause: async () => {
    wantsPlayback = false;
    startingPlayback = false;
    cancelStallWatchdog();
    const svc = await ensureService();
    if (get().snapshot.state === 'playing') await svc.pause();
  },

  retry: async () => {
    const np = get().nowPlaying;
    if (!np) return;
    // Rebuild the engine's items from the current track + position so a failed/
    // unreachable stream is re-requested (a dead AVPlayerItem can't recover via
    // play() alone), then resume. The watchdog is armed from here, so even if the
    // reload's event stream is noisy it still surfaces an error if it never plays.
    beginPlaybackAttempt();
    const svc = await ensureService();
    const index = get().snapshot.trackIndex;
    const positionInTrack = Math.max(0, get().snapshot.position);
    await svc.load(np.queue.tracks, index, positionInTrack);
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
    await svc.seekTo(pos);
    void persist();
  },

  goToTrack: async (index) => {
    const np = get().nowPlaying;
    if (!np) return;
    const i = Math.max(0, Math.min(index, np.queue.tracks.length - 1));
    const svc = await ensureService();
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
    wantsPlayback = false;
    startingPlayback = false;
    cancelStallWatchdog();
    stopSaveLoop();
    await persist();
    invalidateProgressLists();
    if (service) await service.reset();
    set({ nowPlaying: null, snapshot: { ...INITIAL_SNAPSHOT, rate: get().rate } });
  },
}));

/**
 * Hot-swap the currently-playing book onto its local files the moment its download
 * finishes, preserving position + play state. `playBook` already prefers local when
 * a book is downloaded *before* playback starts; this covers the other order —
 * downloading while it streams — so playback keeps going when the network drops
 * instead of dying with the live stream. Shared by web + native.
 */
async function switchCurrentBookToLocal() {
  const { nowPlaying, snapshot, rate } = usePlayer.getState();
  if (!nowPlaying || !apiRef) return;
  const dl = useDownloads.getState().entries[downloadKey(nowPlaying.libraryId, nowPlaying.path)];
  if (dl?.status !== 'downloaded' || dl.manifest.files.length === 0) return;

  // Already playing from local? (every track points at a downloaded uri) → nothing to do.
  const localUris = new Set(dl.manifest.files.map((f) => f.localUri));
  if (nowPlaying.queue.tracks.every((t) => localUris.has(t.url))) return;

  const bookPos = toBookPosition(nowPlaying.queue.offsets, snapshot.trackIndex, snapshot.position);
  const local = {
    files: new Map(dl.manifest.files.map((f) => [f.relPath, f.localUri] as const)),
    artwork: dl.manifest.coverUri ?? undefined,
  };
  const queue = buildBookQueue(
    apiRef,
    nowPlaying.libraryId,
    dl.manifest.book,
    dl.manifest.chapters ?? undefined,
    local,
  );
  const { index, positionInTrack } = locate(queue.offsets, bookPos);
  const wasPlaying = snapshot.state === 'playing';
  const svc = await ensureService();

  if (svc.swapTo) {
    // Gapless: keep streaming until the local file is buffered at this position. The
    // swap can be refused (e.g. the local source isn't servable on web) — in that
    // case leave nowPlaying on the streaming queue so playback keeps going.
    const swapped = await svc.swapTo(queue.tracks, index, positionInTrack);
    if (!swapped) return;
  } else {
    await svc.load(queue.tracks, index, positionInTrack);
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
  const key = downloadKey(np.libraryId, np.path);
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
