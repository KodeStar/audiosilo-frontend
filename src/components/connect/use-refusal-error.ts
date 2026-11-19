import { useCallback, useEffect, useState } from 'react';

import type { WaitOver } from './sign-in-error';

/**
 * A failure's words on screen, and what they become once the wait they name is over
 * (`refusalWaitOver`): one re-render then, no countdown. Setting new words (or none) drops
 * the timer of the ones before, so a swap never lands on another failure's words.
 */
export function useRefusalError(): [
  string | null,
  (text: string | null, waitOver?: WaitOver) => void,
] {
  const [shown, setShown] = useState<{ text: string; waitOver?: WaitOver } | null>(null);
  useEffect(() => {
    const over = shown?.waitOver;
    if (!over) return;
    const id = setTimeout(() => setShown({ text: over.text }), Math.max(0, over.at - Date.now()));
    return () => clearTimeout(id);
  }, [shown]);
  const set = useCallback(
    (text: string | null, waitOver?: WaitOver) =>
      setShown(text === null ? null : { text, waitOver }),
    [],
  );
  return [shown?.text ?? null, set];
}
