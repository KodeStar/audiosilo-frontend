import type { RefObject } from 'react';
import type { View } from 'react-native';

import type { BookDragPayload } from './up-next-model';

/**
 * A cover as a drag source for Up next's drop zone. Only the web desktop drags covers
 * (HTML5 drag and drop, `drag-source.web.ts`); everywhere else this does nothing and
 * there is no drag in progress.
 */
export function useBookDragSource(
  _ref: RefObject<View | null>,
  _payload: BookDragPayload & { title: string },
) {}

/** The book being dragged in this window right now, if any. */
export function activeBookDrag(): BookDragPayload | null {
  return null;
}
