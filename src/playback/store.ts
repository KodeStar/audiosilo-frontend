import { create } from 'zustand';

import type { ApiClient } from '@/api/client';
import { queryClient } from '@/api/provider';
import type { Book, Chapter, ChaptersResponse } from '@/api/types';
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

const MIN_HISTORY_MS = 20_000; // ignore listening spans shorter than this

const SAVE_INTERVAL_MS = 15_000;
const FINISHED_TOLERANCE = 5; // treat within 5s of the end as finished

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

  /** Start a book. Omit startBookPosition to resume from saved progress. */
  playBook: (
    api: ApiClient,
    libraryId: number,
    book: Book,
    chapterData?: ChaptersResponse,
    startBookPosition?: number,
  ) => Promise<void>;
  toggle: () => Promise<void>;
  pause: () => Promise<void>;
  seekBook: (bookPosition: number) => Promise<void>;
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
  void apiRef
    .addHistory(np.libraryId, np.path, {
      from_pos: start.position,
      to_pos: selectBookPosition(player),
      started_at: new Date(start.at).toISOString(),
      ended_at: new Date().toISOString(),
    })
    .then(() => queryClient.invalidateQueries({ queryKey: ['history'] }))
    .catch(() => {});
}

async function ensureService(): Promise<PlaybackService> {
  if (service) return service;
  const svc = createPlaybackService();
  await svc.setup();
  svc.subscribe((snapshot) => {
    const prev = usePlayer.getState().snapshot.state;
    usePlayer.setState({ snapshot });
    if (snapshot.state === 'playing' && prev !== 'playing') beginHistory();
    else if (prev === 'playing' && snapshot.state !== 'playing') endHistory();
    if (snapshot.state === 'ended') void persist();
  });
  service = svc;
  return svc;
}

export const usePlayer = create<PlayerState>()((set, get) => ({
  nowPlaying: null,
  snapshot: { ...INITIAL_SNAPSHOT },
  rate: 1,

  playBook: async (api, libraryId, book, chapterData, startBookPosition) => {
    endHistory(); // flush any prior book's listening span before switching
    apiRef = api;
    deviceId = await getDeviceId();
    const queue = buildBookQueue(api, libraryId, book, chapterData);
    const svc = await ensureService();

    let startAt = startBookPosition ?? 0;
    let speed = useSettings.getState().defaultRate;
    if (startBookPosition === undefined) {
      const saved = await loadInitialProgress(api, libraryId, book.rel_path);
      if (saved && !saved.finished && saved.position > 0) startAt = saved.position;
      if (saved?.playback_speed && saved.playback_speed > 0) speed = saved.playback_speed;
    }

    const { index, positionInTrack } = locate(queue.offsets, startAt);
    set({
      rate: speed,
      nowPlaying: {
        libraryId,
        path: book.rel_path,
        title: book.title,
        author: book.author || book.narrator || '',
        cover: api.coverUrl(libraryId, book.rel_path),
        queue,
      },
    });
    await svc.load(queue.tracks, index, positionInTrack);
    await svc.setRate(speed);
    await svc.play();
    startSaveLoop();
    void flushQueue(api);
  },

  toggle: async () => {
    const svc = await ensureService();
    if (get().snapshot.state === 'playing') {
      await svc.pause();
      void persist();
    } else {
      await svc.play();
    }
  },

  pause: async () => {
    const svc = await ensureService();
    if (get().snapshot.state === 'playing') {
      await svc.pause();
      void persist();
    }
  },

  seekBook: async (bookPosition) => {
    const np = get().nowPlaying;
    if (!np) return;
    const svc = await ensureService();
    const target = locate(np.queue.offsets, bookPosition);
    if (target.index === get().snapshot.trackIndex) {
      await svc.seekTo(target.positionInTrack);
    } else {
      await svc.skipToTrack(target.index, target.positionInTrack);
    }
    void persist();
  },

  skipSeconds: async (delta) => {
    const np = get().nowPlaying;
    if (!np) return;
    const pos = toBookPosition(np.queue.offsets, get().snapshot.trackIndex, get().snapshot.position);
    const max = np.queue.total > 0 ? np.queue.total : pos + delta;
    await get().seekBook(Math.max(0, Math.min(max, pos + delta)));
  },

  setRate: async (rate) => {
    set({ rate });
    if (service) await service.setRate(rate);
    void persist();
  },

  stop: async () => {
    stopSaveLoop();
    await persist();
    if (service) await service.reset();
    set({ nowPlaying: null, snapshot: { ...INITIAL_SNAPSHOT, rate: get().rate } });
  },
}));

// --- selectors -------------------------------------------------------------
export const selectBookPosition = (s: PlayerState): number =>
  s.nowPlaying ? toBookPosition(s.nowPlaying.queue.offsets, s.snapshot.trackIndex, s.snapshot.position) : 0;

export const selectCurrentChapter = (s: PlayerState): Chapter | null =>
  s.nowPlaying ? chapterAt(s.nowPlaying.queue.chapters, selectBookPosition(s)) : null;

export const selectIsPlaying = (s: PlayerState): boolean => s.snapshot.state === 'playing';
