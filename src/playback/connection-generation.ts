import { resolveConnectionId } from '@/lib/connection-id';
import { onConnectionRemoved } from '@/stores/session';

/** The sign-in a playback write belongs to. A token refresh keeps it, a removal ends it,
 * even if the same connection id has signed in again by the time a request answers. */
const removals = new Map<string, number>();

export function connectionGeneration(
  connectionId: string,
  at: ReadonlyMap<string, number> = removals,
): number {
  return at.get(resolveConnectionId(connectionId)) ?? 0;
}

/** A sweep learns which connections it touches only after reading the shared span list. */
export function captureConnectionGenerations(): ReadonlyMap<string, number> {
  return new Map(removals);
}

onConnectionRemoved((id) => {
  removals.set(resolveConnectionId(id), connectionGeneration(id) + 1);
});
