import { type RefObject, useEffect, useRef } from 'react';
import type { View } from 'react-native';

import { useLayout } from '@/lib/layout';

import { BOOK_DRAG_TYPE, type BookDragPayload, serializeDragPayload } from './up-next-model';

// The drag in progress, for the drop zone's dragover: the browser hides a drag's data
// until the drop, but the zone has to say beforehand whether this book can go there.
let active: BookDragPayload | null = null;

/** The book being dragged in this window right now, if any. */
export function activeBookDrag(): BookDragPayload | null {
  return active;
}

/**
 * Makes the view behind `ref` (a cover) an HTML5 drag source carrying its book, so it
 * can be dropped on Up next. Desktop only: that is where the drawer and its drop zone
 * are. A drag never presses the tile: the browser cancels the pointer when it starts.
 */
export function useBookDragSource(
  ref: RefObject<View | null>,
  payload: BookDragPayload & { title: string },
) {
  const desktop = useLayout() === 'desktop';
  const latest = useRef(payload);
  useEffect(() => {
    latest.current = payload;
  });
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!desktop || !node || typeof node.addEventListener !== 'function') return;
    node.draggable = true;
    const onStart = (e: DragEvent) => {
      const { title, ...book } = latest.current;
      active = book;
      e.dataTransfer?.setData(BOOK_DRAG_TYPE, serializeDragPayload(book));
      e.dataTransfer?.setData('text/plain', title);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    };
    const onEnd = () => {
      active = null;
    };
    node.addEventListener('dragstart', onStart);
    node.addEventListener('dragend', onEnd);
    return () => {
      node.draggable = false;
      node.removeEventListener('dragstart', onStart);
      node.removeEventListener('dragend', onEnd);
    };
  }, [ref, desktop]);
}
