import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

/**
 * The time now, as epoch ms, refreshed every `periodMs` and whenever the app comes back
 * to the foreground. For a label that reads the wall clock ("ends 22:01", "last played
 * 12 days ago"): a component must not read the clock while rendering (the React Compiler
 * rejects it), and a value that only moves every few seconds re-renders no more than
 * that. The foreground refresh matters because a suspended app runs no timers: a screen
 * kept alive across a warm resume days later would otherwise read the clock it was
 * suspended with until the next period.
 *
 * `enabled: false` stops the ticks (a countdown with nothing to count): the value stays
 * what it last read until it is enabled again and the next period passes.
 */
export function useNow(periodMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(Date.now());
    });
    return () => {
      clearInterval(timer);
      appState?.remove();
    };
  }, [periodMs, enabled]);
  return now;
}

/** The minute clock `useMinuteClock` shares: one interval and one AppState listener
 * however many read it, running only while one does. */
const MINUTE_MS = 60_000;
const minute = { now: 0, readers: new Set<() => void>(), stop: null as (() => void) | null };

function tickMinute() {
  minute.now = Date.now();
  for (const reader of minute.readers) reader();
}

function subscribeMinute(reader: () => void): () => void {
  minute.readers.add(reader);
  if (!minute.stop) {
    const timer = setInterval(tickMinute, MINUTE_MS);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') tickMinute();
    });
    minute.stop = () => {
      clearInterval(timer);
      appState?.remove();
    };
  }
  return () => {
    minute.readers.delete(reader);
    if (minute.readers.size > 0) return;
    minute.stop?.();
    minute.stop = null;
  };
}

const noSubscribe = () => () => {};

/** The shared minute. While the clock stands still (nobody reads it) it is read afresh,
 * so a reader never starts from the minute it stopped at; never twice within a second,
 * so React reads the same value for one render. */
function minuteNow(): number {
  if (!minute.stop && Math.abs(Date.now() - minute.now) >= 1000) minute.now = Date.now();
  return minute.now;
}

/**
 * The time now, as epoch ms, to the minute: `useNow(60_000)` for a list of many readers
 * (a grid of "added 5 minutes ago" captions), which share one clock, so they tick
 * together and a reader that starts late (`enabled` turned on, a tile mounted later)
 * reads the shared minute rather than the time it mounted at.
 */
export function useMinuteClock(enabled = true): number {
  return useSyncExternalStore(enabled ? subscribeMinute : noSubscribe, minuteNow, minuteNow);
}
