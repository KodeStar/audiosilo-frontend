import { useEffect, useState } from 'react';

/**
 * The time now, as epoch ms, refreshed every `periodMs`. For a label that reads the wall
 * clock ("ends 22:01"): a component must not read the clock while rendering (the React
 * Compiler rejects it), and a value that only moves every few seconds re-renders no
 * more than that.
 */
export function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}
