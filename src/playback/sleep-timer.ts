import { create } from 'zustand';

import { wallClockSeconds } from './rate';
import { selectBookPosition, usePlayer } from './store';

let interval: ReturnType<typeof setInterval> | null = null;

/** Whole seconds of real time until the book reaches `target`, for display: the
 * content gap (`target - pos`) converted at the playback `rate`, then rounded. */
function remainingSeconds(target: number, pos: number, rate?: number): number {
  return Math.round(wallClockSeconds(target - pos, rate));
}

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
  /** Pause when the whole-book timeline reaches `position`; `label` is shown
   * while the timer is active (e.g. "End of Chapter 12"). */
  startUntilPosition: (position: number, label: string) => void;
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

  startUntilPosition: (position, label) => {
    const player = usePlayer.getState();
    if (!player.nowPlaying) return;
    const pos = selectBookPosition(player);
    set({
      active: true,
      label,
      endsAt: null,
      pauseAtPosition: position,
      // The pause fires by position, but the displayed countdown is wall-clock:
      // content-seconds remaining shrink by the playback rate (2x → half the time).
      remaining: remainingSeconds(position, pos, player.rate),
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
      set({ remaining: remainingSeconds(pauseAtPosition, pos, player.rate) });
      if (pos >= pauseAtPosition) {
        void player.pause();
        get().cancel();
      }
    }
  },
}));
