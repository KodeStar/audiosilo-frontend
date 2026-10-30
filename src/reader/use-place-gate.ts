import { useCallback, useEffect, useRef } from 'react';

/**
 * What both reader hosts wait on before handing the book over (fe#164): resolves at once
 * while `known` (the screen knows where the book opens), else once it turns true. The host
 * starts fetching the EPUB (and the reader document loading) meanwhile, so the place lookup
 * and the book's bytes no longer come one after the other. A wait the host no longer needs
 * (a newer open, an unmount) is simply left: the host checks for that after it.
 */
export function usePlaceGate(known: boolean): () => Promise<void> {
  const isKnown = useRef(known);
  const waiting = useRef<(() => void)[]>([]);
  useEffect(() => {
    isKnown.current = known;
    if (!known) return;
    const released = waiting.current;
    waiting.current = [];
    for (const resolve of released) resolve();
  }, [known]);
  return useCallback(
    () =>
      isKnown.current
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.current.push(resolve);
          }),
    [],
  );
}
