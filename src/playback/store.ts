import { create } from 'zustand';

import type { ApiClient } from '@/api/client';
import type { Book, Chapter, ChaptersResponse } from '@/api/types';

import { buildBookQueue, chapterAt, locate, toBookPosition, type BookQueue } from './book-queue';
import { createPlaybackService } from './service';
import { INITIAL_SNAPSHOT, type PlaybackService, type PlaybackSnapshot } from './types';

let service: PlaybackService | null = null;

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

  playBook: (
    api: ApiClient,
    libraryId: number,
    book: Book,
    chapterData?: ChaptersResponse,
    startBookPosition?: number,
  ) => Promise<void>;
  toggle: () => Promise<void>;
  seekBook: (bookPosition: number) => Promise<void>;
  skipSeconds: (delta: number) => Promise<void>;
  setRate: (rate: number) => Promise<void>;
  stop: () => Promise<void>;
};

async function ensureService(): Promise<PlaybackService> {
  if (service) return service;
  const svc = createPlaybackService();
  await svc.setup();
  svc.subscribe((snapshot) => usePlayer.setState({ snapshot }));
  service = svc;
  return svc;
}

export const usePlayer = create<PlayerState>()((set, get) => ({
  nowPlaying: null,
  snapshot: { ...INITIAL_SNAPSHOT },
  rate: 1,

  playBook: async (api, libraryId, book, chapterData, startBookPosition = 0) => {
    const queue = buildBookQueue(api, libraryId, book, chapterData);
    const svc = await ensureService();
    const { index, positionInTrack } = locate(queue.offsets, startBookPosition);
    set({
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
    await svc.setRate(get().rate);
    await svc.play();
  },

  toggle: async () => {
    const svc = await ensureService();
    if (get().snapshot.state === 'playing') await svc.pause();
    else await svc.play();
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
  },

  stop: async () => {
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
