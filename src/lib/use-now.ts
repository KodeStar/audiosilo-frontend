import { useEffect, useState } from 'react';
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
