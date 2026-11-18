/**
 * Fire and forget a call whose failure the caller has nothing to add to: a press that moves
 * the player (`seekBook`, `seekInTrack`, `goToTrack`, `skipSeconds`), which rejects when the
 * engine refused the move (Android's `ERR_MOVE_NOT_TAKEN`, a Cast receiver that failed it)
 * once the store has put itself right. Left bare, `void` makes that an unhandled rejection.
 * Takes any value (a test's `jest.fn()` returns none).
 */
export function quietly(result: unknown): void {
  void Promise.resolve(result).catch(() => undefined);
}
