import { create } from 'zustand';

import { chapterAt } from './book-queue';
import { selectBookPosition, usePlayer } from './store';

let interval: ReturnType<typeof setInterval> | null = null;

function stopInterval() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
function startInterval() {
  stopInterval();
  interval = setInterval(() => useSleepTimer.getState().tick(), 1000);
}

type SleepTimerState = {
  active: boolean;
  label: string;
  /** Epoch ms when a duration timer fires. */
  endsAt: number | null;
  /** Whole-book position at which an end-of-chapter timer fires. */
  pauseAtPosition: number | null;
  /** Seconds left, for display. */
  remaining: number | null;

  startDuration: (minutes: number) => void;
  startEndOfChapter: () => void;
  extend: (minutes: number) => void;
  cancel: () => void;
  /** Internal 1s tick. */
  tick: () => void;
};

export const useSleepTimer = create<SleepTimerState>()((set, get) => ({
  active: false,
  label: '',
  endsAt: null,
  pauseAtPosition: null,
  remaining: null,

  startDuration: (minutes) => {
    set({
      active: true,
      label: `${minutes} min`,
      endsAt: Date.now() + minutes * 60_000,
      pauseAtPosition: null,
      remaining: minutes * 60,
    });
    startInterval();
  },

  startEndOfChapter: () => {
    const player = usePlayer.getState();
    const np = player.nowPlaying;
    if (!np) return;
    const pos = selectBookPosition(player);
    const ch = chapterAt(np.queue.chapters, pos);
    const target = ch ? ch.book_offset + Math.max(0, ch.end - ch.start) : np.queue.total;
    set({
      active: true,
      label: 'End of chapter',
      endsAt: null,
      pauseAtPosition: target,
      remaining: Math.max(0, Math.round(target - pos)),
    });
    startInterval();
  },

  extend: (minutes) => {
    const { endsAt } = get();
    const base = endsAt && endsAt > Date.now() ? endsAt : Date.now();
    const next = base + minutes * 60_000;
    set({
      active: true,
      label: `${Math.round((next - Date.now()) / 60_000)} min`,
      endsAt: next,
      pauseAtPosition: null,
      remaining: Math.round((next - Date.now()) / 1000),
    });
    startInterval();
  },

  cancel: () => {
    stopInterval();
    set({ active: false, label: '', endsAt: null, pauseAtPosition: null, remaining: null });
  },

  tick: () => {
    const { endsAt, pauseAtPosition } = get();
    const player = usePlayer.getState();
    if (endsAt !== null) {
      const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      set({ remaining });
      if (remaining <= 0) {
        void player.pause();
        get().cancel();
      }
      return;
    }
    if (pauseAtPosition !== null) {
      const pos = selectBookPosition(player);
      set({ remaining: Math.max(0, Math.round(pauseAtPosition - pos)) });
      if (pos >= pauseAtPosition) {
        void player.pause();
        get().cancel();
      }
    }
  },
}));
