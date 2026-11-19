import { resolveConnectionId } from '@/lib/connection-id';

import type { BookRef } from './types';

/**
 * The book the native module names in an event (an engine report's `book`, a remote
 * bookmark's own fields), its connection id resolved (`resolveConnectionId`: the Android
 * service can hold a book loaded under a legacy id), or null when the event names none (a
 * binary that predates it, a queue loaded without a book) or a malformed one.
 */
export function nativeBookOf(v: unknown): BookRef | null {
  if (typeof v !== 'object' || v === null) return null;
  const { connectionId, libraryId, path } = v as Partial<Record<keyof BookRef, unknown>>;
  if (typeof connectionId !== 'string' || connectionId === '') return null;
  if (typeof path !== 'string' || path === '') return null;
  if (typeof libraryId !== 'number' || !Number.isSafeInteger(libraryId)) return null;
  return { connectionId: resolveConnectionId(connectionId), libraryId, path };
}
