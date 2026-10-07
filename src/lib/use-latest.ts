import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

/** A ref that always holds the latest `value` (kept current in a layout effect, never
 * during render), for a listener attached once that must read this render's props. */
export function useLatestRef<T>(value: T): RefObject<T> {
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  });
  return latest;
}

/** A stable function that calls the latest `fn`, so a memo or an effect can list it
 * without rebuilding when the caller's closure changes. */
export function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useLatestRef(fn);
  return useCallback((...args: A) => latest.current(...args), [latest]);
}
