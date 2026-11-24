import { resolveConnectionId } from '@/lib/connection-id';
import { onConnectionRemoved } from '@/stores/session';

/** The sign-in a playback write belongs to. A token refresh keeps it, a removal ends it,
 * even if the same connection id has signed in again by the time a request answers. */
const removals = new Map<string, number>();

export function connectionGeneration(connectionId: string): number {
  return removals.get(resolveConnectionId(connectionId)) ?? 0;
}

/** Each connection's generation as it is now, read later: a sweep learns which connections
 * it touches only after reading the shared span list. */
export function captureConnectionGenerations(): (connectionId: string) => number {
  const at = new Map(removals);
  return (connectionId) => at.get(resolveConnectionId(connectionId)) ?? 0;
}

onConnectionRemoved((id) => {
  removals.set(resolveConnectionId(id), connectionGeneration(id) + 1);
});
