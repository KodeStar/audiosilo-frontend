import { useId } from 'react';

/** A stable per-instance id that is safe in the DOM: React's `useId` contains colons,
 * which break `label[for]` lookups and `url(#id)` references in some browsers. */
export function useDomId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
