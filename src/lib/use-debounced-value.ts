import { useEffect, useState } from 'react';

/** `value`, once it has stopped changing for `ms` (the first render returns it as is).
 * For search fields: query on a pause, not on every keystroke. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms]);
  return debounced;
}
